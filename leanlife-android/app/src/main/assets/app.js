// ==================== DEDICATED CACHE MANAGEMENT LAYER ====================
const LeanLifeCacheManager = {
    DB_NAME: 'LeanLifeCache_v2',
    DB_VERSION: 1,
    CACHE_VERSION: 'v2_selective',
    MAX_CACHE_AGE_MS: 30 * 24 * 60 * 60 * 1000, // 30 days

    // Store limits
    LIMITS: {
        userProfile: 10,
        dashboardState: 10,
        wellnessLogs: 5000,
        aiReports: 500,
        communityPosts: 200
    },

    // Metrics for Diagnostics
    metrics: {
        lastSyncTimestamp: null,
        lastSyncDurationMs: 0,
        syncStatus: 'idle',
        cacheHits: 0,
        cacheMisses: 0,
        cacheRebuilds: 0
    },

    broadcastChannel: null,

    init() {
        this.setupMultiTabSync();
    },

    setupMultiTabSync() {
        try {
            if ('BroadcastChannel' in window) {
                this.broadcastChannel = new BroadcastChannel('leanlife_tab_sync');
                this.broadcastChannel.onmessage = (event) => {
                    this.log('Multi-tab sync event received:', event.data);
                    if (event.data?.type === 'LOGOUT') {
                        if (window.app && window.app.currentUser) {
                            window.app.currentUser = null;
                            window.app.updateUIAfterLogout();
                        }
                    } else if (event.data?.type === 'CACHE_INVALIDATED') {
                        if (window.app && typeof window.app.loadDatabase === 'function') {
                            window.app.loadDatabase();
                        }
                    } else if (event.data?.type === 'USERS_UPDATED') {
                        if (window.app && window.app.db && window.app.db.users && event.data.payload?.user) {
                            const incomingUser = event.data.payload.user;
                            const idx = window.app.db.users.findIndex(u => (u.email || '').toLowerCase().trim() === (incomingUser.email || '').toLowerCase().trim());
                            if (idx >= 0) {
                                window.app.db.users[idx] = { ...window.app.db.users[idx], ...incomingUser };
                            } else {
                                window.app.db.users.unshift(incomingUser);
                            }
                            if (window.app.activeView === 'admin' && window.app.activeAdminTab === 'users') {
                                window.app.renderAdminUsers();
                            }
                        }
                    }
                };
            }
            window.addEventListener('storage', (e) => {
                if (e.key === 'leanlife_session' && !e.newValue) {
                    if (window.app && window.app.currentUser) {
                        window.app.currentUser = null;
                        window.app.updateUIAfterLogout();
                    }
                }
            });
        } catch(e) {
            console.warn("[CacheManager] Multi-tab sync warning:", e);
        }
    },

    notifyOtherTabs(type, payload = {}) {
        try {
            if (this.broadcastChannel) {
                this.broadcastChannel.postMessage({ type, payload, timestamp: Date.now() });
            }
        } catch(e) {
            console.warn("[CacheManager] BroadcastChannel notice:", e);
        }
    },

    log(...args) {
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.LEANLIFE_DEV_MODE) {
            console.log('[LeanLifeCacheManager]', ...args);
        }
    },

    openDB() {
        return new Promise((resolve, reject) => {
            try {
                const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
                request.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains('selective_store')) {
                        db.createObjectStore('selective_store');
                    }
                };
                request.onsuccess = (e) => resolve(e.target.result);
                request.onerror = (e) => {
                    console.warn("[CacheManager] Open error:", e.target.error);
                    reject(e.target.error);
                };
            } catch (err) {
                console.warn("[CacheManager] IndexedDB API error:", err);
                reject(err);
            }
        });
    },

    async recoverFromCorruption() {
        this.log("Recovering from IndexedDB failure or corruption...");
        this.metrics.cacheRebuilds++;
        try {
            indexedDB.deleteDatabase(this.DB_NAME);
        } catch (e) {
            console.warn("[CacheManager] DB deletion notice:", e);
        }
    },

    async getCache() {
        const startTime = performance.now();
        try {
            const db = await this.openDB();
            const tx = db.transaction('selective_store', 'readonly');
            const store = tx.objectStore('selective_store');
            const getRequest = store.get('user_selective_cache');
            const cachedData = await new Promise((resolve, reject) => {
                getRequest.onsuccess = () => resolve(getRequest.result);
                getRequest.onerror = () => reject(getRequest.error);
            });

            if (cachedData) {
                const isAgeValid = (Date.now() - (cachedData.timestamp || 0)) < this.MAX_CACHE_AGE_MS;

                if (isAgeValid) {
                    this.metrics.cacheHits++;
                    this.log(`Cache HIT (${(performance.now() - startTime).toFixed(2)}ms)`);
                    return cachedData;
                } else {
                    this.metrics.cacheMisses++;
                    this.log("Cache EXPIRED. Purging stale cache...");
                    await this.clearCache();
                    return null;
                }
            }
            this.metrics.cacheMisses++;
            this.log("Cache MISS");
            return null;
        } catch (e) {
            this.metrics.cacheMisses++;
            console.warn("[CacheManager] Read error, triggering recovery...", e);
            await this.recoverFromCorruption();
            return null;
        }
    },

    async setCache(appState, currentUser) {
        // Enforce hard bounds per store while preserving all member and coach data
        const boundedLogs = (appState.wellnessLogs || []).slice(0, this.LIMITS.wellnessLogs);
        const boundedReports = (appState.aiReports || []).slice(0, this.LIMITS.aiReports);
        const boundedPosts = (appState.posts || []).slice(-this.LIMITS.communityPosts);
        const boundedEvents = (appState.events || []).slice(-20);
        const boundedAppointments = (appState.appointments || []).slice(-100);
        const boundedUsers = (appState.users || []);

        const cacheRecord = {
            version: this.CACHE_VERSION,
            timestamp: Date.now(),
            currentUserProfile: currentUser || null,
            users: boundedUsers,
            wellnessLogs: boundedLogs,
            userWellnessLogs: boundedLogs, // backwards compatibility
            aiReports: boundedReports,
            userAiReports: boundedReports, // backwards compatibility
            recentPosts: boundedPosts,
            recentEvents: boundedEvents,
            appointments: boundedAppointments,
            systemSettings: appState.systemSettings || {}
        };

        try {
            const db = await this.openDB();
            const tx = db.transaction('selective_store', 'readwrite');
            const store = tx.objectStore('selective_store');
            store.put(cacheRecord, 'user_selective_cache');
            await new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
            this.log("Selective cache saved successfully.");
        } catch (e) {
            console.warn("[CacheManager] Write error, triggering recovery...", e);
            await this.recoverFromCorruption();
        }
    },

    async clearCache() {
        this.log("Clearing cached entries...");
        try {
            const db = await this.openDB();
            const tx = db.transaction('selective_store', 'readwrite');
            const store = tx.objectStore('selective_store');
            store.delete('user_selective_cache');
        } catch (e) {
            console.warn("[CacheManager] Clear cache warning:", e);
        }
    },

    async purgeUserSessionOnLogout() {
        this.log("Purging all cached user data on logout...");
        try {
            sessionStorage.removeItem('leanlife_session');
            localStorage.removeItem('leanlife_session');
            sessionStorage.removeItem('leanlife_token');
            localStorage.removeItem('leanlife_token');
        } catch (e) {
            console.warn("[CacheManager] Storage purge warning on logout:", e);
        }
        this.notifyOtherTabs('LOGOUT');
    },

    getDiagnostics() {
        let lsBytes = 0;
        let lsKeys = 0;
        let hasLegacyDb = false;

        try {
            for (let key in localStorage) {
                if (localStorage.hasOwnProperty(key)) {
                    lsKeys++;
                    lsBytes += (localStorage[key].length + key.length) * 2;
                }
            }
            hasLegacyDb = !!localStorage.getItem('leanlife_db');
        } catch (e) {
            console.warn("[CacheManager] LocalStorage check failed:", e);
        }

        return {
            localStorage: {
                kb: (lsBytes / 1024).toFixed(2),
                keyCount: lsKeys,
                hasLegacyDb
            },
            indexedDB: {
                dbVersion: this.DB_VERSION,
                cacheVersion: this.CACHE_VERSION,
                cacheHits: this.metrics.cacheHits,
                cacheMisses: this.metrics.cacheMisses,
                cacheRebuilds: this.metrics.cacheRebuilds
            },
            supabase: {
                status: this.metrics.syncStatus,
                lastSync: this.metrics.lastSyncTimestamp ? new Date(this.metrics.lastSyncTimestamp).toLocaleTimeString() : 'Never',
                durationMs: this.metrics.lastSyncDurationMs ? this.metrics.lastSyncDurationMs.toFixed(0) : '0'
            }
        };
    }
};

LeanLifeCacheManager.init();

// ==================== AUTHENTICATION SUBSYSTEM & ISOLATION ====================
const AuthResult = Object.freeze({
    SUCCESS: 'AUTH_SUCCESS',
    INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
    SERVICE_UNAVAILABLE: 'AUTH_SERVICE_UNAVAILABLE',
    TIMEOUT: 'AUTH_TIMEOUT',
    NETWORK_OFFLINE: 'NETWORK_OFFLINE',
    ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
    REQUIRES_SETUP: 'REQUIRES_SETUP'
});

function getApiBaseUrl() {
    if (typeof window !== 'undefined' && window.location && window.location.origin) {
        const origin = window.location.origin;
        if (origin.startsWith('http://') || origin.startsWith('https://')) {
            return origin;
        }
    }
    return 'https://leanlife-community.app';
}

const AuthService = {
    app: null,

    init(appInstance) {
        this.app = appInstance;
    },

    getApiBaseUrl() {
        return getApiBaseUrl();
    },

    normalizeEmail(email) {
        return (email || '').trim().toLowerCase();
    },

    // Fast cached authentication (< 15ms target)
    async authenticateFromCache(identifier, password) {
        const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const inputId = this.normalizeEmail(identifier);
        if (!inputId || !password) {
            return { result: AuthResult.INVALID_CREDENTIALS, user: null, elapsedMs: 0 };
        }

        const appRef = this.app || (typeof window !== 'undefined' && window.app) || leanLifeAppCore;
        const users = (appRef && appRef.db && appRef.db.users) ? appRef.db.users : [];
        for (const u of users) {
            const uEmail = this.normalizeEmail(u.email);
            const uName = (u.name || '').trim().toLowerCase();
            const uUsername = uEmail.split('@')[0];

            if (uEmail === inputId || uName === inputId || uUsername === inputId) {
                // If the cached user has no password hash (e.g. from cloud-read sync), cannot verify locally
                if (!u.password) {
                    continue;
                }
                const isValid = await appRef.verifyUserCredentials(u, password);
                const elapsedMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
                if (isValid) {
                    return { result: AuthResult.SUCCESS, user: u, source: 'cache', elapsedMs };
                } else {
                    return { result: AuthResult.INVALID_CREDENTIALS, user: null, elapsedMs };
                }
            }
        }

        const elapsedMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
        return { result: null, user: null, notFoundInCache: true, elapsedMs };
    },

    // Remote authentication for fresh devices (serverless endpoint or targeted fallback)
    async authenticateFromRemote(identifier, password) {
        const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const inputId = this.normalizeEmail(identifier);
        const appRef = this.app || (typeof window !== 'undefined' && window.app) || leanLifeAppCore;

        // Check if browser is strictly offline
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            return {
                result: AuthResult.NETWORK_OFFLINE,
                message: 'You are currently offline. Please check your internet connection.',
                elapsedMs: 0
            };
        }

        // 1. Primary remote path: Netlify secure serverless endpoint
        let endpointFailed = false;
        try {
            const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            const timeoutId = controller ? setTimeout(() => controller.abort(), 12000) : null;

            const baseUrl = getApiBaseUrl();
            const response = await fetch(`${baseUrl}/.netlify/functions/auth`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: inputId, password: password }),
                cache: 'no-store',
                signal: controller ? controller.signal : undefined
            });

            if (timeoutId) clearTimeout(timeoutId);

            if (response.status === 200) {
                const data = await response.json();
                if (data && data.success && data.user) {
                    const elapsedMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
                    return { result: AuthResult.SUCCESS, user: data.user, token: data.token, source: 'remote_function', elapsedMs };
                }
            } else if (response.status === 401) {
                const elapsedMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
                return { result: AuthResult.INVALID_CREDENTIALS, message: 'Invalid email address or password.', elapsedMs };
            } else if (response.status === 503) {
                const elapsedMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
                const errData = await response.json().catch(() => ({}));
                return {
                    result: AuthResult.SERVICE_UNAVAILABLE,
                    message: errData.message || 'Authentication service is temporarily unavailable. Please try again shortly.',
                    elapsedMs
                };
            } else {
                console.warn(`[AuthService] Remote auth endpoint returned HTTP ${response.status}. Initiating resilient multi-tier fallback.`);
                endpointFailed = true;
            }
        } catch (fetchErr) {
            console.warn('[AuthService] Remote auth endpoint unavailable, switching to fallback:', fetchErr.message || fetchErr);
            endpointFailed = true;
        }

        // 2. Resilient fallback path (for serverless outage, Android WebView, or DNS issues)
        if (endpointFailed) {
            // Tier 2: Check Supabase cloud database if reachable
            if (appRef && appRef.supabase) {
                try {
                    const withTimeout = (p, ms = 2500) => Promise.race([
                        p,
                        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))
                    ]);

                    let cloudUsers = null;
                    const { data: authIndexRecord, error: authIndexErr } = await withTimeout(
                        appRef.supabase
                            .from('system_settings')
                            .select('data')
                            .eq('id', 'leanlife_auth_index')
                            .single()
                    );

                    if (!authIndexErr && authIndexRecord && authIndexRecord.data && Array.isArray(authIndexRecord.data.users)) {
                        cloudUsers = authIndexRecord.data.users;
                    }

                    if (!cloudUsers || cloudUsers.length === 0) {
                        const elapsedMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
                        return {
                            result: AuthResult.SERVICE_UNAVAILABLE,
                            message: 'Authentication service is currently unreachable. Please check your connection.',
                            elapsedMs
                        };
                    }

                    if (cloudUsers && cloudUsers.length > 0) {
                        for (const u of cloudUsers) {
                            const uEmail = this.normalizeEmail(u.email);
                            const uName = (u.name || '').trim().toLowerCase();
                            const uUsername = uEmail.split('@')[0];

                            if ((uEmail === inputId || uName === inputId || uUsername === inputId) &&
                                (await appRef.verifyUserCredentials(u, password))) {
                                const elapsedMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
                                return { result: AuthResult.SUCCESS, user: u, source: 'remote_fallback', elapsedMs };
                            }
                        }
                    }
                } catch (cloudErr) {
                    console.warn("[AuthService] Cloud fallback connection notice:", cloudErr.message || cloudErr);
                }
            }

            const elapsedMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
            return {
                result: AuthResult.SERVICE_UNAVAILABLE,
                message: 'Authentication service is temporarily unavailable. Please try again shortly.',
                elapsedMs
            };
        }

        const elapsedMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
        return {
            result: AuthResult.INVALID_CREDENTIALS,
            message: 'Invalid email address or password. Please verify your credentials and try again.',
            elapsedMs
        };
    },

    // Unified entry point for authentication: Server authoritative when online
    async authenticate(identifier, password) {
        const appRef = this.app || (typeof window !== 'undefined' && window.app) || leanLifeAppCore;
        if (appRef && appRef.localCacheReadyPromise) {
            try {
                await appRef.localCacheReadyPromise;
            } catch (e) {
                console.warn("[AuthService] localCacheReadyPromise notice:", e);
            }
        }

        const isOffline = (typeof navigator !== 'undefined' && navigator.onLine === false);
        if (isOffline) {
            // Strictly offline: check local cache
            return await this.authenticateFromCache(identifier, password);
        }

        // Online mode: Serverless remote authentication is authoritative
        return await this.authenticateFromRemote(identifier, password);
    },

    // Dedicated authoritative password update
    async updateCredentials(email, newPassword, authToken) {
        const appRef = this.app || (typeof window !== 'undefined' && window.app) || leanLifeAppCore;
        if (!appRef || !appRef.db || !appRef.db.users) return false;
        const normalized = this.normalizeEmail(email);
        let user = appRef.db.users.find(u => this.normalizeEmail(u.email) === normalized);
        if (!user) {
            if (appRef.currentUser && this.normalizeEmail(appRef.currentUser.email) === normalized) {
                user = appRef.currentUser;
                appRef.db.users.push(user);
            } else {
                user = { email: normalized, role: 'member', status: 'Active' };
                appRef.db.users.push(user);
            }
        }

        const hashedPassword = await appRef.hashPassword(newPassword);
        user.password = hashedPassword;
        user.tempPasswordRaw = null;
        user.firstLogin = false;
        user.authUpdatedAt = new Date().toISOString();
        user.updatedAt = new Date().toISOString();

        await appRef.saveDatabase();
        if (typeof appRef.syncCloudData === 'function') {
            appRef.syncCloudData().catch(e => console.warn("[AuthService] Cloud sync warning:", e));
        } else if (typeof appRef.saveCloudData === 'function') {
            appRef.saveCloudData().catch(e => console.warn("[AuthService] Cloud save warning:", e));
        }

        // Synchronize updated password with serverless user-admin endpoint
        try {
            const token = authToken ||
                          (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('leanlife_token')) ||
                          (typeof localStorage !== 'undefined' && localStorage.getItem('leanlife_token'));
            if (token && typeof fetch !== 'undefined') {
                const baseUrl = getApiBaseUrl();
                await fetch(`${baseUrl}/.netlify/functions/user-admin`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ action: 'update-password', targetEmail: normalized, newPassword: newPassword })
                });
            }
        } catch (e) {
            console.warn("[AuthService] user-admin update notice:", e);
        }

        return true;
    }
};

// ==================== STATE MANAGEMENT & DATABASE INITIALIZATION ====================
const leanLifeAppCore = {
    // Current Active Session
    currentUser: null,
    activeView: 'home',
    carouselInterval: null,
    carouselIndex: 0,
    currentWaterCount: 0,
    currentMood: 'happy',
    stepsChartMode: 'week', // 'week' or 'month'
    activeAdminTab: 'users',
    activeCommunityCategory: 'all',
    isCloudSyncOk: false,
    
    // Live countdown timer state for Frannie's AI report
    activeCountdown: null,
    countdownInterval: null,

    // Uploaded photo cache & lightbox state
    selectedPhotoData: null,

    // Mock Databases (loaded from or written to localStorage)
    db: {
        users: [],
        wellnessLogs: [],
        aiReports: [],
        posts: [],
        appointments: [],
        events: [],
        auditLogs: [],
        emails: [],
        notifications: [],
        automationJobs: [],
        automationFailures: 0,
        automationRetries: 0,
        systemSettings: {
            primaryHue: 168,
            accentHue: 80,
            persona: 'encouraging'
        }
    },

    // Initialize Supabase Client
    initSupabase() {
        console.log("Initializing Supabase Client...");
        const config = window.SUPABASE_CONFIG;
        if (config && config.URL && config.KEY && window.supabase) {
            try {
                this.supabase = window.supabase.createClient(config.URL, config.KEY);
                console.log("Supabase client successfully initialized.");
            } catch (e) {
                console.error("Failed to initialize Supabase client:", e);
            }
        } else {
            console.warn("Supabase configuration or library not loaded. Running in local-only IndexedDB mode.");
        }
    },

    CACHE_VERSION: 'v2_selective',
    MAX_CACHE_AGE_MS: 7 * 24 * 60 * 60 * 1000, // 7 days
    _tempPasswordResolve: null,

    // Helper to open selective IndexedDB Cache safely
    openDB() {
        return new Promise((resolve, reject) => {
            try {
                const request = indexedDB.open('LeanLifeCache_v2', 1);
                request.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains('selective_store')) {
                        db.createObjectStore('selective_store');
                    }
                };
                request.onsuccess = (e) => resolve(e.target.result);
                request.onerror = (e) => {
                    console.warn("IndexedDB open error:", e.target.error);
                    reject(e.target.error);
                };
            } catch (err) {
                console.warn("IndexedDB API unavailable or restricted:", err);
                reject(err);
            }
        });
    },

    USE_PASSWORD_HASH_MIGRATION: true,

    // Production-Grade PBKDF2 Password Hashing (compatible with browser WebCrypto API and Node.js)
    async hashPasswordPBKDF2(password, saltUint8 = null) {
        try {
            const iterations = 100000;
            const cryptoObj = (typeof window !== 'undefined' && window.crypto) ? window.crypto : (typeof crypto !== 'undefined' ? crypto : null);
            if (!cryptoObj || !cryptoObj.subtle) {
                return this.hashPasswordLegacy(password);
            }
            const salt = saltUint8 || cryptoObj.getRandomValues(new Uint8Array(16));
            const encoder = new TextEncoder();
            const keyMaterial = await cryptoObj.subtle.importKey(
                'raw',
                encoder.encode(password),
                { name: 'PBKDF2' },
                false,
                ['deriveBits', 'deriveKey']
            );
            const derivedBits = await cryptoObj.subtle.deriveBits(
                {
                    name: 'PBKDF2',
                    salt: salt,
                    iterations: iterations,
                    hash: 'SHA-256'
                },
                keyMaterial,
                256
            );
            const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
            const hashHex = Array.from(new Uint8Array(derivedBits)).map(b => b.toString(16).padStart(2, '0')).join('');
            return `pbkdf2$${iterations}$${saltHex}$${hashHex}`;
        } catch (err) {
            console.warn("PBKDF2 hashing fallback to legacy SHA-256:", err);
            return this.hashPasswordLegacy(password);
        }
    },

    // Verify PBKDF2 hash against stored hash string
    async verifyPasswordPBKDF2(password, storedHash) {
        try {
            if (!storedHash || !storedHash.startsWith('pbkdf2$')) return false;
            const parts = storedHash.split('$');
            if (parts.length !== 4) return false;
            const iterations = parseInt(parts[1], 10);
            const saltHex = parts[2];
            const expectedHashHex = parts[3];

            const salt = new Uint8Array(saltHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
            const cryptoObj = (typeof window !== 'undefined' && window.crypto) ? window.crypto : (typeof crypto !== 'undefined' ? crypto : null);
            if (!cryptoObj || !cryptoObj.subtle) return false;

            const encoder = new TextEncoder();
            const keyMaterial = await cryptoObj.subtle.importKey(
                'raw',
                encoder.encode(password),
                { name: 'PBKDF2' },
                false,
                ['deriveBits', 'deriveKey']
            );
            const derivedBits = await cryptoObj.subtle.deriveBits(
                {
                    name: 'PBKDF2',
                    salt: salt,
                    iterations: iterations,
                    hash: 'SHA-256'
                },
                keyMaterial,
                256
            );
            const computedHashHex = Array.from(new Uint8Array(derivedBits)).map(b => b.toString(16).padStart(2, '0')).join('');
            return computedHashHex === expectedHashHex;
        } catch (e) {
            console.warn("verifyPasswordPBKDF2 error:", e);
            return false;
        }
    },

    // Main standard hashPassword method called across LeanLife
    async hashPassword(password) {
        if (!password) return '';
        try {
            return await this.hashPasswordPBKDF2(password);
        } catch (err) {
            console.warn("hashPassword error, using legacy hash:", err);
            return await this.hashPasswordLegacy(password);
        }
    },

    // Legacy SHA-256 password hashing (for validating legacy accounts)
    async hashPasswordLegacy(password) {
        try {
            const encoder = new TextEncoder();
            const data = encoder.encode((password || '') + "leanlife_secure_salt_2026");
            const cryptoObj = (typeof window !== 'undefined' && window.crypto) ? window.crypto : (typeof crypto !== 'undefined' ? crypto : null);
            if (cryptoObj && cryptoObj.subtle) {
                const hashBuffer = await cryptoObj.subtle.digest('SHA-256', data);
                const hashArray = Array.from(new Uint8Array(hashBuffer));
                return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            }
            let hash = 0;
            const str = (password || '') + "leanlife_secure_salt_2026";
            for (let i = 0; i < str.length; i++) {
                hash = ((hash << 5) - hash) + str.charCodeAt(i);
                hash |= 0;
            }
            return 'fallback_' + Math.abs(hash).toString(16);
        } catch (e) {
            return 'fallback_' + String(password);
        }
    },

    // Helper to evaluate candidate credentials against stored user record
    async verifyUserCredentialCandidate(u, password) {
        return await this.verifyUserCredentials(u, password);
    },

    // Unified Authoritative Credential Verification Engine
    async verifyUserCredentials(user, inputPassword) {
        if (!user || (!user.password && !user.tempPasswordRaw)) return false;

        const raw = String(inputPassword || '');
        const trimmed = raw.trim();
        if (!trimmed) return false;

        // Generate candidate variations for resilient matching
        const candidateSet = new Set();
        candidateSet.add(raw);
        candidateSet.add(trimmed);
        candidateSet.add(trimmed.replace(/\u00A0/g, ' ').trim());
        candidateSet.add(trimmed.toUpperCase());
        candidateSet.add(trimmed.toLowerCase());

        // 6-digit PIN expansions
        if (/^\d{6}$/.test(trimmed)) {
            candidateSet.add('LL-' + trimmed);
            candidateSet.add('ll-' + trimmed);
            candidateSet.add('LL' + trimmed);
            candidateSet.add('ll' + trimmed);
        } else if (/^ll-?\d{6}$/i.test(trimmed)) {
            const digits = trimmed.replace(/^ll-?/i, '').trim();
            candidateSet.add(digits);
            candidateSet.add('LL-' + digits);
            candidateSet.add('ll-' + digits);
            candidateSet.add('LL' + digits);
            candidateSet.add('ll' + digits);
        }

        const candidates = Array.from(candidateSet).filter(c => c && c.length > 0);

        // 1. Primary check: PBKDF2 Password Verification
        if (user.password && user.password.startsWith('pbkdf2$')) {
            for (const cand of candidates) {
                try {
                    const isMatch = await this.verifyPasswordPBKDF2(cand, user.password);
                    if (isMatch) return true;
                } catch (e) {
                    console.warn("[Auth] PBKDF2 candidate check error:", e);
                }
            }
        }

        // 2. Secondary check: Direct match against tempPasswordRaw
        if (user.tempPasswordRaw) {
            const tempRaw = String(user.tempPasswordRaw).trim();
            const tempDigits = tempRaw.replace(/^ll-?/i, '').trim();
            for (const cand of candidates) {
                const candDigits = cand.replace(/^ll-?/i, '').trim();
                if (
                    cand === tempRaw ||
                    cand.toLowerCase() === tempRaw.toLowerCase() ||
                    cand.toUpperCase() === tempRaw.toUpperCase() ||
                    (candDigits && candDigits === tempDigits)
                ) {
                    // Transparently upgrade to PBKDF2
                    try {
                        user.password = await this.hashPasswordPBKDF2(trimmed);
                        user.updatedAt = new Date().toISOString();
                        this.saveDatabase(true);
                    } catch (upErr) {
                        console.warn("[Auth] Temp password PBKDF2 upgrade notice:", upErr);
                    }
                    return true;
                }
            }
        }

        // 3. Tertiary check: Legacy SHA-256 or Plaintext Hashes
        if (user.password && !user.password.startsWith('pbkdf2$')) {
            for (const cand of candidates) {
                const legacyHash = await this.hashPasswordLegacy(cand);
                if (
                    user.password === legacyHash ||
                    user.password === cand ||
                    user.password.toLowerCase() === cand.toLowerCase()
                ) {
                    // Transparently upgrade to PBKDF2
                    try {
                        user.password = await this.hashPasswordPBKDF2(trimmed);
                        user.updatedAt = new Date().toISOString();
                        this.saveDatabase(true);
                    } catch (upErr) {
                        console.warn("[Auth] Legacy PBKDF2 upgrade notice:", upErr);
                    }
                    return true;
                }
            }
        }

        return false;
    },

    // Handle photo file selection and client-side canvas compression (max 1200px, JPEG 0.82)
    handlePhotoSelect(e) {
        const file = e.target?.files?.[0];
        if (!file) return;

        // Check format
        if (!file.type.startsWith('image/')) {
            alert('Please select a valid image file (JPG, PNG, WebP).');
            this.clearSelectedPhoto();
            return;
        }

        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;
                const maxDim = 1200;

                if (width > maxDim || height > maxDim) {
                    if (width > height) {
                        height = Math.round((height * maxDim) / width);
                        width = maxDim;
                    } else {
                        width = Math.round((width * maxDim) / height);
                        height = maxDim;
                    }
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                const compressedBase64 = canvas.toDataURL('image/jpeg', 0.82);
                const approxSizeKb = Math.round((compressedBase64.length * 3) / 4 / 1024);

                this.selectedPhotoData = {
                    base64: compressedBase64,
                    name: file.name,
                    size: `${approxSizeKb} KB`,
                    type: 'image/jpeg'
                };

                // Update UI preview
                const previewContainer = document.getElementById('meal-photo-preview-container');
                const previewImg = document.getElementById('meal-photo-preview-img');
                const previewName = document.getElementById('meal-photo-preview-name');
                const previewSize = document.getElementById('meal-photo-preview-size');

                if (previewContainer && previewImg && previewName && previewSize) {
                    previewImg.src = compressedBase64;
                    previewName.textContent = file.name;
                    previewSize.textContent = `${approxSizeKb} KB (Optimized)`;
                    previewContainer.style.display = 'flex';
                }
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    },

    clearSelectedPhoto() {
        this.selectedPhotoData = null;
        const fileInput = document.getElementById('meal-photo');
        if (fileInput) fileInput.value = '';
        const previewContainer = document.getElementById('meal-photo-preview-container');
        if (previewContainer) previewContainer.style.display = 'none';
    },

    // Global Image Lightbox Modal
    openLightbox(src, caption) {
        const modal = document.getElementById('image-lightbox-modal');
        const img = document.getElementById('lightbox-img');
        const cap = document.getElementById('lightbox-caption');
        if (modal && img) {
            img.src = src;
            if (cap) cap.textContent = caption || 'Wellness Submission Photo';
            modal.style.display = 'flex';
        }
    },

    closeLightbox() {
        const modal = document.getElementById('image-lightbox-modal');
        if (modal) modal.style.display = 'none';
    },

    // Initialize application
    async init() {
        console.log("Initializing LeanLife App...");
        this.initSupabase();
        if (typeof AuthService !== 'undefined') {
            AuthService.init(this);
        }
        this.AuthResult = typeof AuthResult !== 'undefined' ? AuthResult : null;
        this.AuthService = typeof AuthService !== 'undefined' ? AuthService : null;
        
        // 1. Fast Local Cache Preparation (< 10ms)
        this.localCacheReadyPromise = (async () => {
            await this.loadDatabase();
            await this.seedInitialData();

            // Database Migration: Update Dr. Sarah Jenkins to Coach Francess Orenuga & Ensure Admin Role
            let migrated = false;
            if (this.db && this.db.users) {
                this.db.users.forEach(u => {
                    if (u.name === 'Dr. Sarah Jenkins' || (u.email && u.email.toLowerCase() === 'francessronke21@gmail.com')) {
                        u.name = 'Coach Francess Orenuga';
                        u.role = 'admin';
                        migrated = true;
                    }
                    if (u.preferredCoach === 'james') {
                        u.preferredCoach = 'sarah';
                        migrated = true;
                    }
                });
            }
            if (this.db && this.db.appointments) {
                this.db.appointments.forEach(a => {
                    if (a.coach === 'james' || a.preferredCoach === 'james') {
                        a.coach = 'sarah';
                        migrated = true;
                    }
                });
            }
            if (this.db && this.db.posts) {
                this.db.posts.forEach(p => {
                    if (p.author === 'Dr. Sarah Jenkins' || /james/i.test(p.author || '')) {
                        p.author = 'Coach Francess Orenuga';
                        migrated = true;
                    }
                    if (p.comments) {
                        p.comments.forEach(c => {
                            if (c.author === 'Dr. Sarah Jenkins' || /james/i.test(c.author || '')) {
                                c.author = 'Coach Francess Orenuga';
                                migrated = true;
                            }
                        });
                    }
                });
            }
            if (migrated) {
                await this.saveDatabase();
            }
        })();

        // 2. Point dbLoadedPromise & authInfrastructureReadyPromise to localCacheReadyPromise for 100% test compatibility
        this.dbLoadedPromise = this.localCacheReadyPromise;
        this.authInfrastructureReadyPromise = this.localCacheReadyPromise;

        await this.dbLoadedPromise;

        // 3. Launch background cloud sync without blocking user interaction or login
        this.backgroundCloudSyncPromise = this.syncCloudData().catch(e => {
            console.warn("[App] Background cloud sync notice:", e);
        });

        this.checkSession();
        this.startCarousel();
        this.renderNoticeBoard();
        this.renderCommunityFeed();
        this.animateStats();
        this.initGlobalTouchOptimization();

        // Setup password hashing debug preview
        const passInput = document.getElementById('auth-password');
        if (passInput) {
            passInput.addEventListener('input', async () => {
                const debugHash = document.getElementById('debug-pwd-hash');
                if (debugHash) {
                    const hash = await this.hashPassword(passInput.value);
                    debugHash.textContent = hash;
                }
            });
        }
        // Setup hidden developer backdoor: click logo 5 times within 3 seconds to reveal Diagnostics Panel
        const logo = document.querySelector('.brand-logo-container');
        if (logo) {
            let clickCount = 0;
            let firstClickTime = 0;
            logo.addEventListener('click', () => {
                const now = Date.now();
                if (now - firstClickTime > 3000) {
                    clickCount = 1;
                    firstClickTime = now;
                } else {
                    clickCount++;
                }
                if (clickCount === 5) {
                    const panel = document.getElementById('developer-diagnostics-panel');
                    if (panel) {
                        panel.style.display = 'block';
                        alert("Developer diagnostics menu unlocked! Scroll to the bottom of the login card to view troubleshooting details.");
                    }
                    clickCount = 0;
                }
            });
        }

        // Listen for booking calendar date changes to validate blocked dates
        const consultDateInput = document.getElementById('consult-date');
        if (consultDateInput) {
            consultDateInput.addEventListener('change', () => {
                const dateStr = consultDateInput.value;
                this.db.blockedDates = this.db.blockedDates || [];
                if (this.db.blockedDates.some(d => d.id === dateStr && d.status === 'blocked')) {
                    alert(`Sorry, this date (${new Date(dateStr).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })}) is blocked and unavailable for booking. Please select another date.`);
                    consultDateInput.value = '';
                }
            });
        }
        


        
        // Check for pending countdowns from previous session
        this.restorePendingCountdowns();

        // Start background simulation loops for automated emails/alerts
        this.startBackgroundAutomationLoop();

        // Initialize smart scroll header
        this.initScrollHeader();
        this.initMobileScrollEffects();

        // Close mobile drawer on Esc key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const navbar = document.querySelector('.navbar');
                if (navbar && navbar.classList.contains('mobile-nav-active')) {
                    navbar.classList.remove('mobile-nav-active');
                    const btn = document.getElementById('mobile-menu-toggle');
                    if (btn) btn.setAttribute('aria-expanded', 'false');
                }
            }
        });

        // Close mobile drawer on click outside
        document.addEventListener('click', (e) => {
            const navbar = document.querySelector('.navbar');
            if (navbar && navbar.classList.contains('mobile-nav-active')) {
                const nav = navbar.querySelector('nav');
                const btn = document.getElementById('mobile-menu-toggle');
                if (nav && btn && !nav.contains(e.target) && !btn.contains(e.target)) {
                    navbar.classList.remove('mobile-nav-active');
                    btn.setAttribute('aria-expanded', 'false');
                }
            }
        });
    },

    // Toggle Mobile menu drawer
    toggleMobileMenu() {
        const navbar = document.querySelector('.navbar');
        const btn = document.getElementById('mobile-menu-toggle');
        if (navbar && btn) {
            const active = navbar.classList.toggle('mobile-nav-active');
            btn.setAttribute('aria-expanded', active ? 'true' : 'false');
        }
    },

    // Initialize smart scroll header
    initScrollHeader() {
        let lastScrollY = window.scrollY;
        const navbar = document.querySelector('.navbar');
        if (!navbar) return;

        window.addEventListener('scroll', () => {
            const currentScrollY = window.scrollY;
            
            // Do not hide header if mobile nav drawer is open
            if (navbar.classList.contains('mobile-nav-active')) {
                lastScrollY = currentScrollY;
                return;
            }
            
            if (currentScrollY > lastScrollY && currentScrollY > 80) {
                navbar.classList.add('header-hidden');
            } else {
                navbar.classList.remove('header-hidden');
            }
            lastScrollY = currentScrollY;
        }, { passive: true });
    },

    // Highlight features cards when they are scrolled to the center of the screen on mobile
    initMobileScrollEffects() {
        window.addEventListener('scroll', () => {
            const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
            if (!isTouch) return;

            const cards = document.querySelectorAll('.feature-card');
            const viewportHeight = window.innerHeight;
            const centerY = viewportHeight / 2;

            cards.forEach(card => {
                const rect = card.getBoundingClientRect();
                const cardCenterY = rect.top + rect.height / 2;
                const distance = Math.abs(cardCenterY - centerY);
                const threshold = viewportHeight * 0.22; // 22% of screen height

                if (distance < threshold) {
                    card.classList.add('scroll-active');
                } else {
                    card.classList.remove('scroll-active');
                }
            });
        }, { passive: true });
    },

    // Calculate persistent monthly streak for a user (Supports dynamic month lengths: 28, 29, 30, 31 days)
    calculateUserMonthlyStreak(user, referenceDate = new Date()) {
        if (!user) return 0;
        const userEmail = (user.email || '').toLowerCase().trim();
        if (!userEmail) return user.streakCount || 0;

        const refDate = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
        const currentYear = refDate.getFullYear();
        const currentMonth = refDate.getMonth(); // 0-indexed: 0 = Jan, 7 = Aug
        const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate(); // 28, 29, 30, or 31
        const currentMonthCycleKey = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`;

        // Get all user wellness logs
        const userLogs = (this.db && this.db.wellnessLogs ? this.db.wellnessLogs : []).filter(l => {
            const logEmail = (l.userEmail || l.user_email || l.email || '').toLowerCase().trim();
            return logEmail === userEmail;
        });

        // Find all distinct calendar days logged in the current calendar month
        const loggedDaysInMonth = new Set();
        userLogs.forEach(log => {
            const logTimestamp = log.timestamp || log.created_at || log.date;
            if (!logTimestamp) return;
            const d = new Date(logTimestamp);
            if (isNaN(d.getTime())) return;
            
            const logYear = d.getFullYear();
            const logMonth = d.getMonth();
            if (logYear === currentYear && logMonth === currentMonth) {
                const dayKey = `${logYear}-${String(logMonth + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                loggedDaysInMonth.add(dayKey);
            }
        });

        let computedStreak = loggedDaysInMonth.size;

        // Check if user has recorded streak cycle metadata
        if (user.streakMonthCycle === currentMonthCycleKey) {
            // Retain the higher count if streak was already legitimately advanced in this month cycle
            computedStreak = Math.max(computedStreak, user.streakCount || 0);
        } else if (user.streakMonthCycle && user.streakMonthCycle !== currentMonthCycleKey) {
            // Month cycle rolled over: reset to current month's logged count (e.g. 1 on Day 1, or 0 before first log)
            computedStreak = loggedDaysInMonth.size;
        } else if (user.streakCount && !user.streakMonthCycle) {
            // Initializing user cycle
            computedStreak = Math.max(computedStreak, user.streakCount);
        }

        // Cap streak count to the total days in the current calendar month
        const finalStreak = Math.min(computedStreak, daysInMonth);
        
        // Update user object fields
        user.streakCount = finalStreak;
        user.streakMonthCycle = currentMonthCycleKey;
        
        return finalStreak;
    },

    // Save selective cache through LeanLifeCacheManager and sync full state to Supabase Cloud
    async saveDatabase(background = false) {
        // 1. Immediately persist full application state to IndexedDB Cache
        try {
            await LeanLifeCacheManager.setCache(this.db, this.currentUser);
        } catch (cacheErr) {
            console.warn("[App] IndexedDB Cache save notice:", cacheErr);
        }

        // 2. Resilient fallback backup in localStorage (clean JSON)
        try {
            const cleanLogs = (this.db.wellnessLogs || []).map(l => {
                if (l.photoUrl && l.photoUrl.length > 500) {
                    return { ...l, photoUrl: '' };
                }
                return l;
            });
            const backupState = {
                users: this.db.users,
                wellnessLogs: cleanLogs,
                aiReports: this.db.aiReports,
                posts: this.db.posts,
                appointments: this.db.appointments,
                events: this.db.events,
                systemSettings: this.db.systemSettings,
                updatedAt: new Date().toISOString()
            };
            localStorage.setItem('leanlife_db_local_backup', JSON.stringify(backupState));
        } catch (lsErr) {
            console.warn("[App] LocalStorage backup notice:", lsErr);
        }

        // 3. Supabase Cloud Sync with Safe Merging (Prevents overwriting submissions from other devices)
        const token = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('leanlife_token')) ||
                      (typeof localStorage !== 'undefined' && localStorage.getItem('leanlife_token'));

        if (this.supabase || token) {
            const syncPromise = (async () => {
                const syncStart = performance.now();
                LeanLifeCacheManager.metrics.syncStatus = 'syncing';
                try {
                    const withTimeout = (promise, ms = 6000) => {
                        return Promise.race([
                            promise,
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Supabase request timeout')), ms))
                        ]);
                    };

                    // Fetch session token for authenticated gateway write
                    const token = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('leanlife_token')) ||
                                  (typeof localStorage !== 'undefined' && localStorage.getItem('leanlife_token'));

                    if (!token) {
                        console.warn("[CloudSync] Deferred: Unauthenticated visitor session. Local cache preserved.");
                        LeanLifeCacheManager.metrics.syncStatus = 'unauthorized';
                        return;
                    }

                    // Prepare sanitized lightweight payload for cloud storage
                    const cleanLogs = (this.db.wellnessLogs || []).map(l => {
                        if (l.photoUrl && l.photoUrl.length > 500) {
                            return { ...l, photoUrl: '' };
                        }
                        return l;
                    });
                    const cleanPosts = (this.db.posts || []).map(p => {
                        if (p.image && p.image.length > 500 && p.image.startsWith('data:')) {
                            return { ...p, image: '' };
                        }
                        return p;
                    });

                    const syncPayload = {
                        wellnessLogs: cleanLogs,
                        posts: cleanPosts,
                        appointments: this.db.appointments || [],
                        aiReports: this.db.aiReports || [],
                        notifications: this.db.notifications || [],
                        events: this.db.events || [],
                        userProfile: this.currentUser || null
                    };

                    const baseUrl = (typeof window !== 'undefined' && window.location && window.location.origin && window.location.origin.startsWith('http'))
                        ? window.location.origin
                        : 'https://leanlife-community.app';

                    const res = await withTimeout(
                        fetch(`${baseUrl}/.netlify/functions/cloud-sync`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${token}`
                            },
                            body: JSON.stringify(syncPayload)
                        })
                    );

                    const duration = performance.now() - syncStart;
                    LeanLifeCacheManager.metrics.lastSyncDurationMs = duration;

                    if (res && res.ok) {
                        LeanLifeCacheManager.metrics.lastSyncTimestamp = Date.now();
                        LeanLifeCacheManager.metrics.syncStatus = 'synced';
                        console.log("Supabase Cloud Sync completed successfully via authenticated gateway.");
                    } else if (res && res.status === 401) {
                        console.warn("[CloudSync] Unauthorized session. Sync deferred until re-authentication.");
                        LeanLifeCacheManager.metrics.syncStatus = 'unauthorized';
                    } else {
                        console.warn(`[CloudSync] Gateway response HTTP ${res ? res.status : 'error'}`);
                        LeanLifeCacheManager.metrics.syncStatus = 'offline';
                    }
                } catch (err) {
                    console.warn("Supabase Cloud Sync skipped/offline:", err.message || err);
                    LeanLifeCacheManager.metrics.syncStatus = 'offline';
                }
            })();

            if (!background) {
                await syncPromise;
            }
        }
    },

    // Load selective cache from LeanLifeCacheManager and sync with Supabase Cloud (Stale-While-Revalidate)
    async loadDatabase() {
        // 1. Stale-While-Revalidate: Step A - Immediately load lightweight cache from IndexedDB
        let cachedData = await LeanLifeCacheManager.getCache();

        // 2. Fallback to localStorage backup if IndexedDB cache is missing or has no logs/users
        if (!cachedData || !cachedData.wellnessLogs || cachedData.wellnessLogs.length === 0) {
            try {
                const rawLs = localStorage.getItem('leanlife_db_local_backup');
                if (rawLs) {
                    const parsedLs = JSON.parse(rawLs);
                    if (parsedLs && (parsedLs.wellnessLogs || parsedLs.users)) {
                        cachedData = { ...(cachedData || {}), ...parsedLs };
                    }
                }
            } catch (e) {
                console.warn("[App] LocalStorage backup read notice:", e);
            }
        }

        if (cachedData) {
            console.log("Loaded valid selective cache via LeanLifeCacheManager.");
            if (cachedData.currentUserProfile && !this.currentUser) {
                this.currentUser = cachedData.currentUserProfile;
            }
            if (cachedData.users && cachedData.users.length > 0) {
                this.db.users = cachedData.users;
            }
            if (cachedData.wellnessLogs && cachedData.wellnessLogs.length > 0) {
                this.db.wellnessLogs = cachedData.wellnessLogs;
            } else if (cachedData.userWellnessLogs && cachedData.userWellnessLogs.length > 0) {
                this.db.wellnessLogs = cachedData.userWellnessLogs;
            }
            if (cachedData.aiReports && cachedData.aiReports.length > 0) {
                this.db.aiReports = cachedData.aiReports;
            } else if (cachedData.userAiReports && cachedData.userAiReports.length > 0) {
                this.db.aiReports = cachedData.userAiReports;
            }
            if (cachedData.recentPosts || cachedData.posts) {
                this.db.posts = cachedData.recentPosts || cachedData.posts;
            }
            if (cachedData.recentEvents || cachedData.events) {
                this.db.events = cachedData.recentEvents || cachedData.events;
            }
            if (cachedData.appointments) {
                this.db.appointments = cachedData.appointments;
            }
            if (cachedData.systemSettings) {
                this.db.systemSettings = cachedData.systemSettings;
            }
        }

        this.db = this.db || {};
        this.db.users = this.db.users || [];
        this.db.wellnessLogs = this.db.wellnessLogs || [];
        this.db.aiReports = this.db.aiReports || [];
        this.db.posts = this.db.posts || [];
        this.db.appointments = this.db.appointments || [];
        this.db.events = this.db.events || [];
        this.db.auditLogs = this.db.auditLogs || [];
        this.db.emails = this.db.emails || [];
        this.db.notifications = this.db.notifications || [];
        this.db.automationJobs = this.db.automationJobs || [];
        this.db.blockedDates = this.db.blockedDates || [];
        this.db.automationFailures = this.db.automationFailures !== undefined ? this.db.automationFailures : 0;
        this.db.automationRetries = this.db.automationRetries !== undefined ? this.db.automationRetries : 0;
        this.db.systemSettings = this.db.systemSettings || {};
        this.db.systemSettings.primaryHue = this.db.systemSettings.primaryHue || 168;
        this.db.systemSettings.accentHue = this.db.systemSettings.accentHue || 80;
        this.db.systemSettings.persona = this.db.systemSettings.persona || 'encouraging';
        this.db.systemSettings.emailjsServiceId = this.db.systemSettings.emailjsServiceId || 'service_60jfsbe';
        this.db.systemSettings.emailjsTemplateId = this.db.systemSettings.emailjsTemplateId || 'template_gyjh3gp';
        this.db.systemSettings.emailjsWelcomeTemplateId = this.db.systemSettings.emailjsWelcomeTemplateId || 'template_gyjh3gp';
        this.db.systemSettings.emailjsAutoreplyTemplateId = this.db.systemSettings.emailjsAutoreplyTemplateId || 'template_fzzf45u';
        this.db.systemSettings.emailjsPublicKey = this.db.systemSettings.emailjsPublicKey || '1KO_vRCldTUVxoqtM';

        // Note: Supabase Cloud Sync runs asynchronously in backgroundCloudSyncPromise
        // and does NOT block local cache readiness or authentication.
    },

    // Periodically fetch and merge latest cloud data via secure read gateway
    async syncCloudData() {
        try {
            const token = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('leanlife_token')) ||
                          (typeof localStorage !== 'undefined' && localStorage.getItem('leanlife_token'));

            const headers = { 'Accept': 'application/json' };
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }

            const baseUrl = (typeof window !== 'undefined' && window.location && window.location.origin && window.location.origin.startsWith('http'))
                ? window.location.origin
                : 'https://leanlife-community.app';

            const withTimeout = (promise, ms = 6000) => {
                return Promise.race([
                    promise,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Cloud read timeout')), ms))
                ]);
            };

            const response = await withTimeout(fetch(`${baseUrl}/.netlify/functions/cloud-read`, {
                method: 'GET',
                headers: headers
            }));

            if (response && response.ok) {
                const body = await response.json();
                if (body && body.success && body.data) {
                    this.mergeCloudDatabase(body.data);
                    if (this.currentUser) {
                        const dbUser = (this.db.users || []).find(u => u.email?.toLowerCase() === this.currentUser.email?.toLowerCase());
                        if (dbUser) {
                            this.currentUser = { ...this.currentUser, ...dbUser };
                        }
                        this.calculateUserMonthlyStreak(this.currentUser);
                    }
                    if (this.activeView === 'admin') {
                        if (this.activeAdminTab === 'users') this.renderAdminUsers();
                        else if (this.activeAdminTab === 'logs-cms') this.renderAdminLogsCMS();
                        else if (this.activeAdminTab === 'reports-cms') this.renderAdminReportsCMS();
                        else if (this.activeAdminTab === 'appointments-cms') this.renderAdminAppointmentsCMS();
                    } else if (this.activeView === 'dashboard') {
                        this.renderDashboard();
                    }
                }
            } else if (response && response.status === 401) {
                console.warn("[CloudRead] Session expired or invalid; public community data retained.");
            } else {
                console.warn(`[CloudRead] Gateway notice HTTP ${response ? response.status : 'error'}`);
            }
        } catch (err) {
            console.warn("[CloudRead] Cloud read skipped/offline:", err.message || err);
        }
    },

    // Merge Cloud DB lists with Local DB lists
    mergeCloudDatabase(cloudDb) {
        if (!cloudDb) return;
        
        const mergeLists = (localList, cloudList, key = 'email') => {
            const map = new Map();
            const getItemTime = (i) => {
                if (!i) return 0;
                const t = i.updatedAt || i.timestamp || i.created_at || i.createdAt || i.date;
                return t ? new Date(t).getTime() : 0;
            };

            // Load cloud list first
            (cloudList || []).forEach(item => {
                const itemKey = item[key]?.toLowerCase() || item[key] || item.id;
                if (itemKey) map.set(itemKey, item);
            });
            // Merge with local list (local changes/submissions preserve if newer or not yet in cloud)
            (localList || []).forEach(item => {
                const itemKey = item[key]?.toLowerCase() || item[key] || item.id;
                if (itemKey) {
                    if (!map.has(itemKey)) {
                        map.set(itemKey, item);
                    } else {
                        // If local has newer timestamp or matching item
                        const cloudItem = map.get(itemKey);
                        const localTime = getItemTime(item);
                        const cloudTime = getItemTime(cloudItem);
                        if (localTime >= cloudTime) {
                            map.set(itemKey, { ...cloudItem, ...item });
                        }
                    }
                }
            });
            return Array.from(map.values());
        };

        if (cloudDb.deletedUsers) {
            this.db.deletedUsers = Array.from(new Set([...(this.db.deletedUsers || []), ...cloudDb.deletedUsers]));
        }
        
        if (cloudDb.users && this.db.deletedUsers && this.db.deletedUsers.length > 0) {
            const deletedSet = new Set(this.db.deletedUsers.map(e => (e || '').toLowerCase().trim()));
            cloudDb.users = cloudDb.users.filter(u => !deletedSet.has((u.email || '').toLowerCase().trim()));
        }

        if (cloudDb.users) {
            // Snapshot existing local users to preserve updated local authentication credentials
            const localUserMap = new Map();
            (this.db.users || []).forEach(u => {
                const k = (u.email || '').toLowerCase().trim();
                if (k) localUserMap.set(k, u);
            });

            this.db.users = mergeLists(this.db.users, cloudDb.users, 'email').map(u => {
                const k = (u.email || '').toLowerCase().trim();
                const localU = localUserMap.get(k);
                if (localU) {
                    const localAuthTime = localU.authUpdatedAt ? new Date(localU.authUpdatedAt).getTime() : (localU.updatedAt ? new Date(localU.updatedAt).getTime() : 0);
                    const cloudAuthTime = u.authUpdatedAt ? new Date(u.authUpdatedAt).getTime() : (u.updatedAt ? new Date(u.updatedAt).getTime() : 0);

                    // Dedicated Authentication Isolation: If local auth credentials are newer or equal, preserve them
                    if (localAuthTime >= cloudAuthTime) {
                        return {
                            ...u,
                            password: localU.password,
                            tempPasswordRaw: localU.tempPasswordRaw,
                            firstLogin: localU.firstLogin,
                            authUpdatedAt: localU.authUpdatedAt || localU.updatedAt
                        };
                    }
                }
                return u;
            });
        }
        this.db.wellnessLogs = mergeLists(this.db.wellnessLogs, cloudDb.wellnessLogs, 'id');
        this.db.aiReports = mergeLists(this.db.aiReports, cloudDb.aiReports, 'id');
        this.db.posts = mergeLists(this.db.posts, cloudDb.posts, 'id');
        this.db.appointments = mergeLists(this.db.appointments, cloudDb.appointments, 'id');
        this.db.events = mergeLists(this.db.events, cloudDb.events, 'id');
        this.db.auditLogs = mergeLists(this.db.auditLogs, cloudDb.auditLogs, 'id');
        this.db.emails = mergeLists(this.db.emails, cloudDb.emails, 'id');
        this.db.notifications = mergeLists(this.db.notifications, cloudDb.notifications, 'id');
        this.db.automationJobs = mergeLists(this.db.automationJobs, cloudDb.automationJobs, 'id');
        this.db.blockedDates = mergeLists(this.db.blockedDates, cloudDb.blockedDates, 'id');
        
        if (cloudDb.systemSettings) {
            this.db.systemSettings = { ...this.db.systemSettings, ...cloudDb.systemSettings };
            this.db.systemSettings.emailjsServiceId = this.db.systemSettings.emailjsServiceId || 'service_60jfsbe';
            this.db.systemSettings.emailjsTemplateId = this.db.systemSettings.emailjsTemplateId || 'template_gyjh3gp';
            this.db.systemSettings.emailjsWelcomeTemplateId = this.db.systemSettings.emailjsWelcomeTemplateId || 'template_gyjh3gp';
            this.db.systemSettings.emailjsAutoreplyTemplateId = this.db.systemSettings.emailjsAutoreplyTemplateId || 'template_fzzf45u';
            this.db.systemSettings.emailjsPublicKey = this.db.systemSettings.emailjsPublicKey || '1KO_vRCldTUVxoqtM';
        }
        
        this.db.automationFailures = cloudDb.automationFailures !== undefined ? cloudDb.automationFailures : this.db.automationFailures;
        this.db.automationRetries = cloudDb.automationRetries !== undefined ? cloudDb.automationRetries : this.db.automationRetries;
    },

    // Log user activities to Audit Trail
    logAudit(operator, eventType, details, resource = "System") {
        const log = {
            id: 'AUD-' + Date.now() + Math.random().toString(36).substr(2, 4),
            timestamp: new Date().toISOString(),
            operator: operator || 'Guest',
            eventType: eventType,
            resource: resource,
            details: details
        };
        this.db.auditLogs.unshift(log);
        this.saveDatabase();
        if (this.activeView === 'admin' && this.activeAdminTab === 'audits') {
            this.renderAdminAuditsCMS();
        }
    },

    // Seed mock data for first-time usage
    async seedInitialData() {
        if (!this.isCloudSyncOk) {
            console.warn("Cloud sync load failure: Seeding database locally to prevent lockout.");
        }



        // Update password for test account olipaq222@gmail.com if it exists
        const testUser = this.db.users.find(u => u.email.toLowerCase() === 'olipaq222@gmail.com');
        if (testUser) {
            testUser.password = await this.hashPassword('password123');
            testUser.firstLogin = false;
            testUser.updatedAt = new Date().toISOString();
            await this.saveDatabase();
        }

        // 1. Seed default Admin and System Accounts non-destructively
        this.db.users = this.db.users || [];
        const ensureSeedUser = async (userData) => {
            const emailKey = (userData.email || '').toLowerCase().trim();
            const existing = this.db.users.find(u => (u.email || '').toLowerCase().trim() === emailKey);
            if (!existing) {
                this.db.users.push(userData);
                return true;
            }
            return false;
        };

        let seededAny = false;
        const adminPass = await this.hashPassword('admin123');
        const coachPass = await this.hashPassword('password123');
        const memberPass = await this.hashPassword('password123');

        if (await ensureSeedUser({
            name: 'Super Administrator',
            email: 'admin@leanlife.com',
            password: adminPass,
            role: 'admin',
            phone: '+1 (555) 0100',
            dob: '1985-01-01',
            gender: 'Other',
            height: 180,
            weight: 165,
            goal: 'Manage platform operations',
            status: 'Active',
            avatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=100&auto=format&fit=crop',
            updatedAt: new Date().toISOString()
        })) seededAny = true;

        if (await ensureSeedUser({
            name: 'Coach Francess Orenuga',
            email: 'francessronke21@gmail.com',
            password: coachPass,
            role: 'admin',
            phone: '+1 (757) 513-0205',
            dob: '1980-04-12',
            gender: 'Female',
            height: 168,
            weight: 132,
            goal: 'Coaching excellence',
            status: 'Active',
            avatar: 'assets/coach_francess.png',
            updatedAt: new Date().toISOString()
        })) seededAny = true;

        if (await ensureSeedUser({
            name: 'Emma Watson',
            email: 'emma@example.com',
            password: memberPass,
            role: 'member',
            phone: '+1 (555) 0199',
            dob: '1990-04-15',
            gender: 'Female',
            height: 172,
            weight: 155.4,
            goal: 'Build lean muscle & improve deep sleep',
            status: 'Active',
            avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop',
            firstLogin: false,
            bloodGroup: 'O-positive',
            allergies: 'Peanuts, Penicillin',
            medications: 'Vitamin D3 2000IU, L-Theanine 200mg',
            conditions: 'None',
            emergencyName: 'John Watson',
            emergencyPhone: '+1 (555) 0188',
            preferredCoach: 'sarah',
            dietPreference: 'Vegetarian',
            activityLevel: 'Active',
            streakCount: 0,
            updatedAt: new Date().toISOString(),
            healthProfile: {
                height: 172,
                weight: 155.4,
                bloodGroup: 'O-positive',
                dietPreference: 'Vegetarian',
                emergencyName: 'John Watson',
                emergencyPhone: '+1 (555) 0188',
                allergies: 'Peanuts, Penicillin',
                conditions: 'None',
                medications: 'Vitamin D3 2000IU, L-Theanine 200mg',
                goals: 'Build lean muscle & improve deep sleep'
            }
        })) seededAny = true;

        if (await ensureSeedUser({
            name: 'QUDDUS ABIOLA',
            email: 'qbuddie01@gmail.com',
            password: memberPass,
            role: 'member',
            phone: '+1 (555) 0199',
            dob: '1990-04-15',
            gender: 'Male',
            height: 175,
            weight: 75,
            goal: 'Build lean muscle & fitness tracking',
            status: 'Active',
            avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop',
            firstLogin: false,
            streakCount: 0,
            updatedAt: new Date().toISOString()
        })) seededAny = true;

        if (seededAny) {
            await this.saveDatabase();
        }

        // 2. Seed community posts
        if (this.db.posts.length === 0) {
            this.db.posts = [
                {
                    id: 'POST-1',
                    title: 'My top 5 meal prep recipes for high protein diets!',
                    category: 'Recipes',
                    author: 'Coach Francess Orenuga',
                    authorAvatar: 'assets/coach_francess.png',
                    body: 'Always include a base of dark leafy greens, 200g of lean protein (grilled chicken, tofu or salmon), and complex carbs like quinoa or roasted sweet potatoes. Drizzle with cold-pressed olive oil!',
                    image: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=600&auto=format&fit=crop',
                    likes: 24,
                    likedBy: [],
                    comments: [
                        { author: 'Emma Watson', body: 'This meal prep outline has saved me so much time this week! Highly recommended.', timestamp: '2 hours ago' }
                    ],
                    pinned: true,
                    timestamp: '1 day ago',
                    status: 'approved'
                },
                {
                    id: 'POST-2',
                    title: 'Completed my first 5k jog under 25 minutes!',
                    category: 'Fitness',
                    author: 'Emma Watson',
                    authorAvatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop',
                    body: 'Feeling absolutely thrilled! Hydrating with electrolytes before running and pacing my breath made all the difference. Frannie\'s steps and cardio coaching really pushed me to stay consistent.',
                    image: '',
                    likes: 15,
                    likedBy: [],
                    comments: [
                        { author: 'Coach Francess Orenuga', body: 'Outstanding milestone, Emma! Your pacing and breath metrics are showing perfect adaptation.', timestamp: '3 hours ago' }
                    ],
                    pinned: false,
                    timestamp: '4 hours ago',
                    status: 'approved'
                }
            ];
            this.saveDatabase();
        }

        // 3. Seed notice board events
        if (this.db.events.length === 0) {
            this.db.events = [
                {
                    id: 'EVT-1',
                    title: 'Live Cardio Burn Session',
                    category: 'Exercise Sessions',
                    date: '2026-07-02',
                    time: '08:00 AM',
                    countdown: 'In 3 Days',
                    description: 'Interactive virtual high intensity workout session hosted by Coach Francess Orenuga.',
                    rsvp: ['emma@example.com'],
                    link: 'https://meet.google.com/abc-defg-hij'
                },
                {
                    id: 'EVT-2',
                    title: 'Integrative Nutrition Workshop',
                    category: 'Nutrition Classes',
                    date: '2026-07-05',
                    time: '02:00 PM',
                    countdown: 'In 6 Days',
                    description: 'Explore meal balancing, fiber targets, sugar alternates, and grocery selections.',
                    rsvp: [],
                    link: 'https://meet.google.com/xyz-qprs-tuv'
                }
            ];
            this.saveDatabase();
        }

        // 4. Seed simulated emails
        if (!this.db.emails || this.db.emails.length === 0) {
            this.db.emails = [
                {
                    id: 'EML-1',
                    timestamp: new Date(Date.now() - 3600000 * 2).toISOString(),
                    recipient: 'emma@example.com',
                    subject: 'Welcome to LeanLife Wellness Community!',
                    templateName: 'Welcome Email',
                    status: 'Delivered'
                },
                {
                    id: 'EML-2',
                    timestamp: new Date(Date.now() - 3600000 * 1.5).toISOString(),
                    recipient: 'emma@example.com',
                    subject: 'Your Wellness Report is ready!',
                    templateName: 'Daily Wellness Report',
                    status: 'Delivered'
                }
            ];
            this.saveDatabase();
        }

        // 5. Seed notifications
        if (!this.db.notifications || this.db.notifications.length === 0) {
            this.db.notifications = [
                {
                    id: 'NTF-1',
                    timestamp: new Date(Date.now() - 3600000 * 2).toISOString(),
                    recipient: 'emma@example.com',
                    message: 'Welcome! Your LeanLife membership has been successfully verified by Coach Francess Orenuga.',
                    read: true
                },
                {
                    id: 'NTF-2',
                    timestamp: new Date(Date.now() - 3600000 * 1.5).toISOString(),
                    recipient: 'emma@example.com',
                    message: '🔔 Coach Francess Orenuga\'s Wellness Analysis is ready! Go check the Wellness Report tab.',
                    read: false
                }
            ];
            this.saveDatabase();
        }
    },

    updateDebugInfo() {
        try {
            const countEl = document.getElementById('debug-users-count');
            const listEl = document.getElementById('debug-users-list');
            if (countEl && this.db && this.db.users) {
                countEl.textContent = this.db.users.length;
            }
            if (listEl && this.db && this.db.users) {
                listEl.textContent = this.db.users.map(u => u.email).join(', ');
            }
        } catch (e) {
            console.debug("Debug info update skipped:", e);
        }
    },

    // Session validation
    checkSession() {
        let loggedUser = null;
        let token = null;
        try {
            loggedUser = sessionStorage.getItem('leanlife_session') || localStorage.getItem('leanlife_session');
            token = sessionStorage.getItem('leanlife_token') || localStorage.getItem('leanlife_token');
        } catch (e) {
            console.warn("Storage access notice in checkSession:", e);
        }

        if (loggedUser) {
            try {
                this.currentUser = JSON.parse(loggedUser);

                // Anti-tampering verification using signed session token if present
                if (token && typeof token === 'string' && token.includes('.')) {
                    const parts = token.split('.');
                    if (parts.length === 3) {
                        try {
                            let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
                            while (base64.length % 4) base64 += '=';
                            const payloadStr = (typeof atob !== 'undefined')
                                ? atob(base64)
                                : (typeof Buffer !== 'undefined' ? Buffer.from(base64, 'base64').toString('utf8') : null);
                            if (payloadStr) {
                                const tokenPayload = JSON.parse(payloadStr);

                                // Expiration check
                                const nowSec = Math.floor(Date.now() / 1000);
                                if (tokenPayload.exp && tokenPayload.exp < nowSec) {
                                    console.warn("[Security] Session token expired. Purging session.");
                                    LeanLifeCacheManager.purgeUserSessionOnLogout();
                                    this.currentUser = null;
                                    this.updateUIAfterLogout();
                                    return;
                                }

                                // Anti-Tampering: detect client-side role privilege escalation
                                if (tokenPayload.role && this.currentUser.role && tokenPayload.role !== this.currentUser.role) {
                                    console.warn("[Security Alert] Session role tampering detected! Purging session.");
                                    LeanLifeCacheManager.purgeUserSessionOnLogout();
                                    this.currentUser = null;
                                    this.updateUIAfterLogout();
                                    return;
                                }

                                // Anti-Tampering: detect email identity substitution
                                if (tokenPayload.email && this.currentUser.email && tokenPayload.email.toLowerCase() !== this.currentUser.email.toLowerCase()) {
                                    console.warn("[Security Alert] Session email tampering detected! Purging session.");
                                    LeanLifeCacheManager.purgeUserSessionOnLogout();
                                    this.currentUser = null;
                                    this.updateUIAfterLogout();
                                    return;
                                }
                            }
                        } catch (tokenErr) {
                            console.warn("[Security] Malformed session token notice:", tokenErr);
                        }
                    }
                }

                const dbUser = (this.db && this.db.users) ? this.db.users.find(u => u.email?.toLowerCase() === this.currentUser.email?.toLowerCase()) : null;
                if (dbUser) {
                    this.currentUser = { ...this.currentUser, ...dbUser };
                }
                this.calculateUserMonthlyStreak(this.currentUser);
                this.updateUIAfterLogin();
            } catch (e) {
                this.updateUIAfterLogout();
            }
        } else {
            this.updateUIAfterLogout();
        }
    },

    // ==================== SPA ROUTING ====================
    navigateTo(viewId, params = {}) {
        console.log(`Routing to: ${viewId}`, params);
        
        // Close mobile nav drawer if active
        const navbar = document.querySelector('.navbar');
        if (navbar) {
            navbar.classList.remove('mobile-nav-active');
        }
        
        // Route protection
        if (viewId !== 'home' && viewId !== 'login' && !this.currentUser) {
            this.navigateTo('login');
            return;
        }

        // Hide all views, display the selected one
        const sections = document.querySelectorAll('.view-section');
        sections.forEach(sec => sec.classList.remove('active'));
        
        const targetSection = document.getElementById(`view-${viewId}`);
        if (targetSection) {
            targetSection.classList.add('active');
            this.activeView = viewId;
        }

        // Update nav links active styling
        const navLinks = document.querySelectorAll('.nav-links a');
        navLinks.forEach(link => link.classList.remove('active'));
        
        const activeNav = document.getElementById(`nav-${viewId}`);
        if (activeNav) {
            activeNav.classList.add('active');
        }

        // Handle specific sub-routines per page
        if (viewId === 'dashboard') {
            this.renderDashboard();
        } else if (viewId === 'wellness-log') {
            this.renderWellnessLog();
        } else if (viewId === 'community') {
            this.renderCommunityFeed();
        } else if (viewId === 'notice-board') {
            this.renderNoticeBoard();
        } else if (viewId === 'coaching') {
            this.renderCoaching();
        } else if (viewId === 'admin') {
            this.renderAdminPanel();
            this.syncCloudData().catch(e => console.warn("[Admin] Navigation sync notice:", e));
        } else if (viewId === 'profile') {
            this.renderUserProfile();
        } else if (viewId === 'ai-report') {
            if (params.reportId) {
                this.renderAIReportView(params.reportId);
            } else {
                this.viewLatestAIReport();
            }
        } else if (viewId === 'monthly-report') {
            this.renderMonthlyReportView(params && params.month ? params.month : null);
        }

        // Switch login/register tab if passed
        if (viewId === 'login' && params.tab === 'register') {
            this.switchAuthTab('register');
        } else if (viewId === 'login') {
            this.switchAuthTab('login');
        }

        // Scroll to top
        window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    navigateToFeature(featureName, element = null) {
        if (!this.currentUser) {
            this.navigateTo('login');
        } else {
            this.navigateTo(featureName);
        }
    },

    // UI visibility updates after authenticating
    updateUIAfterLogin() {
        document.getElementById('auth-nav-buttons').style.display = 'none';
        
        const userDropdown = document.getElementById('user-nav-dropdown');
        userDropdown.style.display = 'flex';
        document.getElementById('user-display-name').textContent = this.currentUser.name;
        if (this.currentUser.avatar) {
            document.getElementById('user-display-avatar').src = this.currentUser.avatar;
        }

        // Mobile profile elements
        const mobAuthBtn = document.getElementById('mobile-auth-nav-buttons');
        const mobUserDropdown = document.getElementById('mobile-user-nav-dropdown');
        if (mobAuthBtn) mobAuthBtn.style.display = 'none';
        if (mobUserDropdown) {
            mobUserDropdown.style.display = 'flex';
            document.getElementById('mobile-user-display-name').textContent = this.currentUser.name;
            if (this.currentUser.avatar) {
                document.getElementById('mobile-user-display-avatar').src = this.currentUser.avatar;
            }
        }

        // Show member links
        document.querySelectorAll('.logged-in-only').forEach(el => el.style.display = 'block');

        // Show admin/coach panel link
        if (this.currentUser.role === 'admin' || this.currentUser.role === 'coach') {
            document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'block');
            const navAdmin = document.getElementById('nav-admin');
            if (navAdmin) {
                navAdmin.textContent = this.currentUser.role === 'coach' ? 'Coach Portal' : 'Admin Panel';
            }
            this.updateAppointmentNotificationBadges();

            // Background live sync interval for coaches/admins (every 30s)
            if (!this.coachSyncInterval) {
                this.coachSyncInterval = setInterval(() => {
                    if (this.currentUser && (this.currentUser.role === 'admin' || this.currentUser.role === 'coach')) {
                        this.syncCloudData().catch(() => {});
                    } else if (this.coachSyncInterval) {
                        clearInterval(this.coachSyncInterval);
                        this.coachSyncInterval = null;
                    }
                }, 30000);
            }
        } else {
            document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
            if (this.coachSyncInterval) {
                clearInterval(this.coachSyncInterval);
                this.coachSyncInterval = null;
            }
        }
    },

    updateUIAfterLogout() {
        if (this.coachSyncInterval) {
            clearInterval(this.coachSyncInterval);
            this.coachSyncInterval = null;
        }
        document.getElementById('auth-nav-buttons').style.display = 'flex';
        document.getElementById('user-nav-dropdown').style.display = 'none';

        // Mobile profile elements reset
        const mobAuthBtn = document.getElementById('mobile-auth-nav-buttons');
        const mobUserDropdown = document.getElementById('mobile-user-nav-dropdown');
        if (mobAuthBtn) mobAuthBtn.style.display = 'flex';
        if (mobUserDropdown) mobUserDropdown.style.display = 'none';
        
        // Hide member links
        document.querySelectorAll('.logged-in-only').forEach(el => el.style.display = 'none');
        document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
        
        if (this.activeView !== 'home') {
            this.navigateTo('home');
        }
    },

    // ==================== HERO SLIDESHOW CAROUSEL ====================
    startCarousel() {
        if (this.carouselInterval) clearInterval(this.carouselInterval);
        
        this.carouselInterval = setInterval(() => {
            this.setCarouselSlide((this.carouselIndex + 1) % 4);
        }, 5000);
    },

    setCarouselSlide(idx) {
        this.carouselIndex = idx;
        const slides = document.querySelectorAll('.carousel-slide');
        const indicators = document.querySelectorAll('.carousel-indicator');
        
        slides.forEach(slide => {
            slide.classList.remove('active');
            if (parseInt(slide.getAttribute('data-index')) === idx) {
                slide.classList.add('active');
            }
        });

        indicators.forEach((ind, i) => {
            ind.classList.remove('active');
            if (i === idx) {
                ind.classList.add('active');
            }
        });
    },

    // Animate stats numbers on landing
    animateStats() {
        const counters = [
            { id: 'stat-members', target: 15243, prefix: '', suffix: '' },
            { id: 'stat-weight', target: 84230, prefix: '', suffix: '' },
            { id: 'stat-goals', target: 112050, prefix: '', suffix: '' },
            { id: 'stat-water', target: 2403120, prefix: '', suffix: '' },
            { id: 'stat-calories', target: 984320, prefix: '', suffix: 'k' },
            { id: 'stat-challenges', target: 48290, prefix: '', suffix: '' }
        ];

        counters.forEach(c => {
            const el = document.getElementById(c.id);
            if (!el) return;
            let current = 0;
            const steps = 40;
            const increment = Math.ceil(c.target / steps);
            
            const timer = setInterval(() => {
                current += increment;
                if (current >= c.target) {
                    current = c.target;
                    clearInterval(timer);
                }
                el.textContent = c.prefix + current.toLocaleString() + c.suffix;
            }, 30);
        });
    },

    // ==================== AUTH MODULE ENGINE ====================
    switchAuthTab(tab) {
        const title = document.getElementById('auth-title');
        const subtitle = document.getElementById('auth-subtitle');
        const nameGroup = document.getElementById('group-name');
        const submitBtn = document.getElementById('btn-auth-submit');
        
        title.textContent = 'Welcome Back';
        subtitle.textContent = 'Log in to your personalized wellness portal';
        if (nameGroup) {
            nameGroup.style.display = 'none';
        }
        const fullNameInput = document.getElementById('auth-fullname');
        if (fullNameInput) {
            fullNameInput.required = false;
        }
        if (submitBtn) {
            submitBtn.textContent = 'Login';
        }
        const rememberRow = document.getElementById('auth-row-remember');
        if (rememberRow) {
            rememberRow.style.display = 'flex';
        }
    },

    async toggleAuthForgotPassword(e) {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        const emailInput = document.getElementById('auth-email');
        const email = (emailInput?.value || '').trim().toLowerCase();

        if (!email) {
            this.showCustomAlert("Please enter your email address in the Email field first before requesting a password reset.", "Email Required", "fa-circle-info");
            return;
        }

        let tempPassword = null;
        let userName = 'LeanLife Member';

        // 1. Authoritative serverless password reset via user-admin function
        try {
            const baseUrl = getApiBaseUrl();
            const res = await fetch(`${baseUrl}/.netlify/functions/user-admin`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'request-password-reset', targetEmail: email })
            });
            const data = await res.json();
            if (res.ok && data.success && data.tempPassword) {
                tempPassword = data.tempPassword;
                if (data.user && data.user.name) userName = data.user.name;
            } else if (res.status === 404) {
                this.showCustomAlert(`No LeanLife account was found matching "${email}". Please verify the email address or register a new account.`, "Account Not Found", "fa-triangle-exclamation");
                return;
            }
        } catch (serverlessErr) {
            console.warn("[Auth] Serverless password reset request notice:", serverlessErr.message || serverlessErr);
        }

        // 2. Local fallback if offline or serverless unreachable
        let user = (this.db.users && Array.isArray(this.db.users)) ? this.db.users.find(u => (u.email || '').toLowerCase().trim() === email) : null;
        if (!tempPassword) {
            if (!user) {
                this.showCustomAlert(`No LeanLife account was found matching "${email}". Please verify the email address or register a new account.`, "Account Not Found", "fa-triangle-exclamation");
                return;
            }
            tempPassword = 'LL-' + Math.floor(100000 + Math.random() * 900000);
            userName = user.name || userName;
        }

        // 3. Update local database cache
        if (user) {
            user.password = await this.hashPassword(tempPassword);
            user.tempPasswordRaw = tempPassword;
            user.firstLogin = true;
            user.updatedAt = new Date().toISOString();
            await this.saveDatabase();
        }

        const outboxId = 'EML-' + Date.now();
        this.db.emails = this.db.emails || [];
        this.db.emails.unshift({
            id: outboxId,
            timestamp: new Date().toISOString(),
            recipient: email,
            subject: 'LeanLife Password Reset Request',
            templateName: 'Password Reset',
            status: 'Pending'
        });
        await this.saveDatabase();

        this.logAudit(userName, 'Password Reset Requested', `Generated temporary reset password for ${email}`);

        this.showCustomAlert(
            `🔑 Password Reset Link & Pin Sent!\n\nA temporary access password (${tempPassword}) has been generated and dispatched to ${email}.\n\nPlease check your email inbox to log in and set a new password.`,
            "Password Reset Dispatched",
            "fa-envelope-circle-check"
        );

        this.sendRealEmail(
            user.name || 'LeanLife Member',
            email,
            'LeanLife Password Reset Request',
            tempPassword,
            'reset'
        ).then(emailResult => {
            const deliveryStatus = (emailResult && emailResult.ok) ? 'Delivered' : 'Failed';
            const outboxRec = this.db.emails.find(e => e.id === outboxId);
            if (outboxRec) {
                outboxRec.status = deliveryStatus;
                this.saveDatabase();
            }
        }).catch(err => {
            console.error("Async password reset email error:", err);
            const outboxRec = this.db.emails.find(e => e.id === outboxId);
            if (outboxRec) {
                outboxRec.status = 'Failed';
                this.saveDatabase();
            }
        });
    },

    initGlobalTouchOptimization() {
        // Fast-touch optimization to eliminate 300ms mobile tap delay across Login, Dashboard & Admin Console
        document.addEventListener('pointerdown', (e) => {
            const target = e.target.closest('button, .btn, .admin-tab-btn, .nav-links a, input[type="submit"], input[type="button"]');
            if (target && !target.disabled) {
                target.style.transform = 'scale(0.98)';
                setTimeout(() => {
                    target.style.transform = '';
                }, 150);
            }
        }, { passive: true });
    },

    handleAuthTitleTap() {
        this.adminTapCount = (this.adminTapCount || 0) + 1;
        clearTimeout(this.adminTapTimeout);
        
        if (this.adminTapCount >= 5) {
            const simBox = document.getElementById('simulation-login-box');
            if (simBox) {
                const isHidden = (simBox.style.display === 'none' || !simBox.style.display);
                simBox.style.display = isHidden ? 'block' : 'none';
                if (isHidden) {
                    simBox.scrollIntoView({ behavior: 'smooth' });
                }
            }
            this.adminTapCount = 0;
        } else {
            this.adminTapTimeout = setTimeout(() => {
                this.adminTapCount = 0;
            }, 3000);
        }
    },

    async fillSimulationCreds(email, password) {
        this.switchAuthTab('login');
        
        const hashedPassword = await this.hashPassword(password);
        
        // Ensure simulation users exist and are active in mock db
        let user = this.db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
        if (!user) {
            if (email === 'admin@leanlife.com') {
                user = {
                    name: 'Super Administrator',
                    email: 'admin@leanlife.com',
                    password: hashedPassword,
                    role: 'admin',
                    phone: '+1 (555) 0100',
                    dob: '1985-01-01',
                    gender: 'Other',
                    height: 180,
                    weight: 165,
                    goal: 'Manage platform operations',
                    status: 'Active',
                    avatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=100&auto=format&fit=crop',
                    firstLogin: false
                };
                this.db.users.push(user);
            } else if (email === 'francessronke21@gmail.com') {
                user = {
                    name: 'Coach Francess Orenuga',
                    email: 'francessronke21@gmail.com',
                    password: hashedPassword,
                    role: 'admin',
                    phone: '+1 (757) 513-0205',
                    dob: '1980-04-12',
                    gender: 'Female',
                    height: 168,
                    weight: 132,
                    goal: 'Coaching excellence & platform administration',
                    status: 'Active',
                    avatar: 'assets/coach_francess.png',
                    firstLogin: false,
                    updatedAt: new Date().toISOString()
                };
                this.db.users.push(user);
            } else if (email === 'emma@example.com') {
                user = {
                    name: 'Emma Watson',
                    email: 'emma@example.com',
                    password: hashedPassword,
                    role: 'member',
                    phone: '+1 (555) 0199',
                    dob: '1990-04-15',
                    gender: 'Female',
                    height: 172,
                    weight: 155.4,
                    goal: 'Build lean muscle & improve deep sleep',
                    status: 'Active',
                    avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop',
                    firstLogin: false,
                    bloodGroup: 'O-positive',
                    allergies: 'Peanuts, Penicillin',
                    medications: 'Vitamin D3 2000IU, L-Theanine 200mg',
                    conditions: 'None',
                    emergencyName: 'John Watson',
                    emergencyPhone: '+1 (555) 0188',
                    preferredCoach: 'sarah',
                    dietPreference: 'Vegetarian',
                    activityLevel: 'Active',
                    streakCount: 0,
                    healthProfile: {
                        height: 172,
                        weight: 155.4,
                        bloodGroup: 'O-positive',
                        dietPreference: 'Vegetarian',
                        emergencyName: 'John Watson',
                        emergencyPhone: '+1 (555) 0188',
                        allergies: 'Peanuts, Penicillin',
                        conditions: 'None',
                        medications: 'Vitamin D3 2000IU, L-Theanine 200mg',
                        goals: 'Build lean muscle & improve deep sleep'
                    }
                };
                this.calculateUserMonthlyStreak(user);
                this.db.users.push(user);
            }
            this.saveDatabase(true);
        } else {
            // Force reset credentials to active defaults while preserving real streak
            user.status = 'Active';
            user.password = hashedPassword;
            user.firstLogin = false;
            this.calculateUserMonthlyStreak(user);
            this.saveDatabase(true);
        }

        const emailInput = document.getElementById('auth-email');
        const passInput = document.getElementById('auth-password');
        
        if (emailInput && passInput) {
            emailInput.value = email;
            passInput.value = password;
            emailInput.dispatchEvent(new Event('input', { bubbles: true }));
            passInput.dispatchEvent(new Event('input', { bubbles: true }));
            emailInput.dispatchEvent(new Event('change', { bubbles: true }));
            passInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        const submitBtn = document.getElementById('btn-auth-submit');
        if (submitBtn) {
            submitBtn.disabled = false;
        }

        // Trigger login submit immediately without async pre-hash delay
        await this.handleAuthSubmit({ preventDefault: () => {} });
    },

    async handleAuthSubmit(e) {
        if (e && typeof e.preventDefault === 'function') {
            e.preventDefault();
        }

        if (this.dbLoadedPromise) {
            await this.dbLoadedPromise;
        }
        
        const submitBtn = document.getElementById('btn-auth-submit');
        const originalBtnText = submitBtn ? submitBtn.innerHTML : 'Login';
        const isRegistering = document.getElementById('group-name')?.style.display === 'block';

        const emailInput = document.getElementById('auth-email');
        const passwordInput = document.getElementById('auth-password');
        const fullnameInput = document.getElementById('auth-fullname');

        const email = (emailInput?.value || '').trim().toLowerCase();
        const password = passwordInput?.value || '';
        const fullname = (fullnameInput?.value || '').trim();

        if (!email || !password) {
            alert("Please enter both email address and password.");
            return;
        }

        try {
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Processing...';
            }

            if (isRegistering) {
                // Check if user exists locally
                const exists = this.db.users.find(u => (u.email || '').toLowerCase().trim() === email);
                if (exists) {
                    alert("Email already registered. Please log in.");
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        submitBtn.innerHTML = originalBtnText;
                    }
                    return;
                }

                // Register with authoritative serverless endpoint
                let regSucceeded = false;
                let regData = null;
                try {
                    const baseUrl = getApiBaseUrl();
                    const regRes = await fetch(`${baseUrl}/.netlify/functions/user-admin`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            action: 'self-register-member',
                            memberData: {
                                name: fullname || 'LeanLife Member',
                                email: email,
                                password: password,
                                phone: '+1 (555) 0000'
                            }
                        })
                    });

                    if (regRes.status === 409) {
                        alert("Email already registered. Please log in.");
                        if (submitBtn) {
                            submitBtn.disabled = false;
                            submitBtn.innerHTML = originalBtnText;
                        }
                        return;
                    }

                    if (!regRes.ok) {
                        const errData = await regRes.json().catch(() => ({}));
                        const errMsg = errData.message || "Registration service is temporarily unavailable. Please try again shortly.";
                        alert(errMsg);
                        if (submitBtn) {
                            submitBtn.disabled = false;
                            submitBtn.innerHTML = originalBtnText;
                        }
                        return;
                    }

                    regData = await regRes.json().catch(() => null);
                    if (regData && regData.success) {
                        regSucceeded = true;
                    } else {
                        const errMsg = (regData && regData.message) || "Registration failed. Please try again.";
                        alert(errMsg);
                        if (submitBtn) {
                            submitBtn.disabled = false;
                            submitBtn.innerHTML = originalBtnText;
                        }
                        return;
                    }
                } catch (regErr) {
                    console.warn("[Auth] Serverless registration failure:", regErr.message || regErr);
                    alert("Unable to connect to the registration service. Please check your internet connection and try again.");
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        submitBtn.innerHTML = originalBtnText;
                    }
                    return;
                }

                if (!regSucceeded || !regData) {
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        submitBtn.innerHTML = originalBtnText;
                    }
                    return;
                }

                const serverUser = regData.user || {};
                const sessionToken = regData.token || null;
                const hashedPassword = await this.hashPassword(password);

                // Create new member account
                const newUser = {
                    id: serverUser.id || ('USR-' + Date.now()),
                    name: serverUser.name || fullname || 'LeanLife Member',
                    email: serverUser.email || email,
                    password: hashedPassword,
                    role: 'member',
                    phone: serverUser.phone || '+1 (555) 0000',
                    dob: '1995-01-01',
                    gender: 'Female',
                    height: 170,
                    weight: 155.4,
                    goal: 'Improve health consistency',
                    status: 'Active',
                    avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop',
                    firstLogin: false,
                    streakCount: 0,
                    preferredCoach: 'sarah',
                    authUpdatedAt: serverUser.authUpdatedAt || new Date().toISOString(),
                    updatedAt: serverUser.updatedAt || new Date().toISOString()
                };

                this.db.users.push(newUser);
                await this.saveDatabase();
                this.logAudit(newUser.name, 'Member Registered', `Self-registration completed for ${email}`);
                
                // Dispatch Welcome Email
                const welcomeOutboxId = 'EML-' + Date.now();
                this.db.emails = this.db.emails || [];
                this.db.emails.unshift({
                    id: welcomeOutboxId,
                    timestamp: new Date().toISOString(),
                    recipient: newUser.email,
                    subject: 'Welcome to LeanLife Wellness Community!',
                    templateName: 'Welcome Email',
                    status: 'Pending'
                });
                await this.saveDatabase();

                this.sendRealEmail(newUser.name, newUser.email, 'Welcome to LeanLife Wellness Community!', password, 'welcome')
                    .then(result => {
                        const rec = this.db.emails.find(e => e.id === welcomeOutboxId);
                        if (rec) {
                            rec.status = (result && result.ok) ? 'Delivered' : 'Failed';
                            this.saveDatabase(true);
                        }
                    });

                // Set session and store signed token
                this.currentUser = newUser;
                try {
                    sessionStorage.setItem('leanlife_session', JSON.stringify(newUser));
                    if (sessionToken) sessionStorage.setItem('leanlife_token', sessionToken);
                    localStorage.setItem('leanlife_session', JSON.stringify(newUser));
                    if (sessionToken) localStorage.setItem('leanlife_token', sessionToken);
                } catch (stErr) {
                    console.warn("Storage warning during registration session save:", stErr);
                }
                this.updateUIAfterLogin();
                this.navigateTo('profile'); // Send to profile to complete setup

                // Show Pop Up Notification Modal for New User Registration
                this.showCustomAlert(
                    `🎉 Welcome to LeanLife Community, ${newUser.name}!\n\nYour account (${newUser.email}) has been registered successfully.\n\nA welcome email notification has been dispatched to your inbox. Please complete your health profile parameters to get started!`,
                    "Registration Successful!",
                    "fa-user-check"
                );
            } else {
                // Unified Secure Login Validation via AuthService (Isolated from full database sync)
                const authRes = await AuthService.authenticate(email, password);

                if (!authRes || authRes.result !== AuthResult.SUCCESS) {
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        submitBtn.innerHTML = originalBtnText;
                    }

                    if (authRes && authRes.result === AuthResult.NETWORK_OFFLINE) {
                        alert(authRes.message || "You are currently offline. Please check your internet connection.");
                    } else if (authRes && authRes.result === AuthResult.TIMEOUT) {
                        alert(authRes.message || "Authentication request timed out. Please check your connection and try again.");
                    } else if (authRes && authRes.result === AuthResult.SERVICE_UNAVAILABLE) {
                        alert(authRes.message || "Authentication service is temporarily unavailable. Please try again shortly.");
                    } else {
                        // Genuine credential mismatch (INVALID_CREDENTIALS)
                        alert("Invalid email address or password. Please verify your credentials and try again.");
                    }
                    return;
                }

                let user = authRes.user;

                // If user authenticated via remote function or fallback, ensure local user record is saved in local cache
                if (authRes.source === 'remote_function' || authRes.source === 'remote_fallback' || authRes.source === 'local_fallback' || authRes.source === 'seed_fallback') {
                    const localIdx = (this.db.users || []).findIndex(u => (u.email || '').toLowerCase().trim() === (user.email || '').toLowerCase().trim());
                    if (localIdx >= 0) {
                        this.db.users[localIdx] = { ...this.db.users[localIdx], ...user };
                        user = this.db.users[localIdx];
                    } else {
                        this.db.users = this.db.users || [];
                        this.db.users.push(user);
                    }
                    this.saveDatabase(true);
                }

                // Always reinstate active status
                user.status = 'Active';

                // Audit
                this.logAudit(user.name, 'User Login', `${user.role} logged in successfully`);

                // Set session state and store tokens immediately
                this.calculateUserMonthlyStreak(user);
                this.currentUser = user;
                const remember = document.getElementById('auth-remember')?.checked;
                const sessionToken = authRes.token || null;
                try {
                    sessionStorage.setItem('leanlife_session', JSON.stringify(user));
                    if (sessionToken) sessionStorage.setItem('leanlife_token', sessionToken);
                    if (remember || (typeof window !== 'undefined' && window.innerWidth <= 768)) {
                        localStorage.setItem('leanlife_session', JSON.stringify(user));
                        if (sessionToken) localStorage.setItem('leanlife_token', sessionToken);
                    }
                } catch (e) {
                    console.warn("Storage notice during session save:", e);
                }

                // First Login check (prompt for change password via modal)
                if (user.firstLogin) {
                    const newPwd = await this.showTempPasswordModal(user);
                    if (newPwd && newPwd.trim() !== '') {
                        const cleanPwd = newPwd.trim();
                        await AuthService.updateCredentials(user.email, cleanPwd, sessionToken);
                        user.firstLogin = false;
                        this.currentUser = user;
                        try {
                            sessionStorage.setItem('leanlife_session', JSON.stringify(user));
                            localStorage.setItem('leanlife_session', JSON.stringify(user));
                        } catch (stErr) {}
                        this.logAudit(user.name, 'Password Updated', 'First login temporary password replaced');
                        alert("Password updated successfully! Welcome to LeanLife.");
                    } else {
                        alert("Password change is required to proceed.");
                        return;
                    }
                }

                this.updateUIAfterLogin();
                // Immediately synchronize authoritative cloud dataset using newly verified token
                this.syncCloudData().catch(e => console.warn("[Auth] Post-login sync notice:", e));
                if (user.role === 'admin' || user.role === 'coach') {
                    this.navigateTo('admin');
                } else {
                    this.navigateTo('dashboard');
                }
            }
        } catch (err) {
            console.error("Authentication error:", err);
            alert("An error occurred during authentication. Please try again.");
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalBtnText;
            }
        }
    },

    async logout() {
        if (this.currentUser) {
            this.logAudit(this.currentUser.name, 'User Logout', 'Logged out successfully');
        }
        this.currentUser = null;
        await LeanLifeCacheManager.purgeUserSessionOnLogout();
        this.updateUIAfterLogout();
    },

    // ==================== USER DASHBOARD LOGIC ====================
    renderDashboard() {
        if (!this.currentUser) return;
        this.calculateUserMonthlyStreak(this.currentUser);
        document.getElementById('dash-user-name').textContent = this.currentUser.name;
        document.getElementById('dash-streak-count').textContent = this.currentUser.streakCount || 0;

        // Load today's log if any
        const todayLog = this.getTodayLog();
        
        // 1. Water Stat Update
        const waterCount = todayLog ? (todayLog.waterCount || 0) : 0;
        document.getElementById('dash-val-water').textContent = `${waterCount} / 10 drops`;
        document.getElementById('dash-progress-water').style.width = `${Math.min(waterCount * 10, 100)}%`;

        // 2. Steps Stat Update
        const stepsCount = todayLog ? (todayLog.steps || 0) : 0;
        document.getElementById('dash-val-steps').textContent = `${stepsCount.toLocaleString()} steps`;
        document.getElementById('dash-progress-steps').style.width = `${Math.min((stepsCount / 10000) * 100, 100)}%`;

        // 3. Calories Stat Update (burned from exercise)
        let caloriesBurned = 0;
        if (todayLog && todayLog.exercise && todayLog.exercise.completed === 'yes') {
            const dur = parseFloat(todayLog.exercise.duration) || 0;
            const intensity = todayLog.exercise.intensity || 'Moderate';
            let mult = 6; // Moderate calories per minute
            if (intensity === 'Light') mult = 4;
            if (intensity === 'Heavy') mult = 9;
            caloriesBurned = Math.round(dur * mult);
        }
        document.getElementById('dash-val-calories').textContent = `${caloriesBurned} kcal`;
        document.getElementById('dash-progress-calories').style.width = `${Math.min((caloriesBurned / 500) * 100, 100)}%`;

        // 4. Sleep Stat Update
        const sleepHours = todayLog ? (parseFloat(todayLog.sleep?.duration || (typeof todayLog.sleep === 'number' ? todayLog.sleep : 0)) || 0) : 0;
        document.getElementById('dash-val-sleep').textContent = `${sleepHours} hrs`;
        document.getElementById('dash-progress-sleep').style.width = `${Math.min((sleepHours / 8) * 100, 100)}%`;

        // 5. Tasks Checklist Update
        document.getElementById('chk-task-water').checked = waterCount >= 10;
        document.getElementById('chk-task-steps').checked = stepsCount >= 10000;
        document.getElementById('chk-task-meal').checked = !!(todayLog && todayLog.meals?.breakfast?.desc && todayLog.meals?.lunch?.desc && todayLog.meals?.dinner?.desc);

        // 6. Wellness Score Gauge
        const latestReport = this.getLatestReport();
        const scoreRing = document.getElementById('dash-score-gauge-ring');
        const scoreNum = document.getElementById('dash-score-gauge-num');
        const gradeText = document.getElementById('dash-score-grade-text');
        
        if (latestReport) {
            const score = latestReport.overallScore;
            scoreNum.textContent = score;
            gradeText.textContent = `Grade: ${latestReport.grade}`;
            scoreRing.style.background = `conic-gradient(var(--clr-accent-green) 0% ${score}%, #e2d2c1 ${score}% 100%)`;
        } else {
            scoreNum.textContent = 'N/A';
            gradeText.textContent = 'No Reports Yet';
            scoreRing.style.background = `conic-gradient(#aaa 0% 100%)`;
        }

        // 7. Render dynamic SVG steps progress trend line
        this.renderWeeklyTrendSVG();

        // 8. Render user achievements
        this.renderUserBadges();

        // 9. Coach Advices
        const advices = [
            `"Integrating a quick 10-minute mindfulness breathing exercise before bedtime tonight will stabilize cortisol levels."`,
            `"Excellent hydration streak! Drinking 250ml water immediately on waking speeds up metabolic pathways by 24%."`,
            `"Aim to walk 1,500 additional steps in sunlight today to stimulate Vitamin D receptor pathways and circadian clocks."`,
            `"Consider a healthy replacement for dinner: swap refined carbohydrates for sweet potato to smooth glucose spikes."`
        ];
        document.getElementById('dash-ai-advice').textContent = advices[Math.floor(Math.random() * advices.length)];
    },

    getTodayLog() {
        const todayStr = new Date().toDateString();
        return this.db.wellnessLogs.find(l => l.userEmail.toLowerCase() === this.currentUser.email.toLowerCase() && new Date(l.timestamp).toDateString() === todayStr);
    },

    getLatestReport() {
        return this.db.aiReports.filter(r => r.userEmail.toLowerCase() === this.currentUser.email.toLowerCase() && r.status === 'completed')
            .sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
    },

    renderWeeklyTrendSVG() {
        const container = document.getElementById('dash-weekly-chart-box');
        if (!container) return;

        // Mock weekly data or actual historical data
        const weekDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        const scores = [70, 75, 82, 78, 85, 90, 88];
        
        let width = container.clientWidth || 500;
        let height = 180;
        
        let svg = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="var(--clr-teal-green)" stop-opacity="0.25" />
                    <stop offset="100%" stop-color="var(--clr-teal-green)" stop-opacity="0.0" />
                </linearGradient>
            </defs>
            <!-- Grid lines -->
            <line x1="40" y1="20" x2="${width - 20}" y2="20" stroke="rgba(18,130,109,0.06)" stroke-width="1"/>
            <line x1="40" y1="65" x2="${width - 20}" y2="65" stroke="rgba(18,130,109,0.06)" stroke-width="1"/>
            <line x1="40" y1="110" x2="${width - 20}" y2="110" stroke="rgba(18,130,109,0.06)" stroke-width="1"/>
            <line x1="40" y1="150" x2="${width - 20}" y2="150" stroke="rgba(18,130,109,0.12)" stroke-width="1"/>
            
            <!-- Axes label values -->
            <text x="15" y="24" font-size="10" font-family="var(--font-brand)" fill="var(--clr-text-dark)" opacity="0.6">100</text>
            <text x="15" y="69" font-size="10" font-family="var(--font-brand)" fill="var(--clr-text-dark)" opacity="0.6">70</text>
            <text x="15" y="114" font-size="10" font-family="var(--font-brand)" fill="var(--clr-text-dark)" opacity="0.6">40</text>
            <text x="15" y="154" font-size="10" font-family="var(--font-brand)" fill="var(--clr-text-dark)" opacity="0.6">0</text>
        `;

        const spacing = (width - 80) / 6;
        let points = [];
        let gradPoints = [];
        
        gradPoints.push(`40,150`); // Start bottom left
        
        for(let i=0; i<7; i++) {
            let x = 50 + (i * spacing);
            let scoreVal = scores[i];
            let y = 150 - ((scoreVal / 100) * 130);
            points.push(`${x},${y}`);
            gradPoints.push(`${x},${y}`);
        }
        
        gradPoints.push(`${50 + 6 * spacing},150`); // End bottom right

        // 1. Draw gradient area first (at the back)
        svg += `<polygon points="${gradPoints.join(' ')}" fill="url(#chartGrad)"/>`;

        // 2. Draw trend line
        svg += `<polyline fill="none" stroke="var(--clr-teal-green)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" points="${points.join(' ')}"/>`;

        // 3. Draw points circles and text labels
        for(let i=0; i<7; i++) {
            let x = 50 + (i * spacing);
            let scoreVal = scores[i];
            let y = 150 - ((scoreVal / 100) * 130);
            svg += `<circle cx="${x}" cy="${y}" r="6.5" fill="var(--clr-teal-green)" stroke="white" stroke-width="2.5" style="cursor:pointer; filter:drop-shadow(0 2px 4px rgba(0,0,0,0.1))"/>`;
            svg += `<text x="${x}" y="170" font-size="10.5" font-family="var(--font-brand)" font-weight="600" text-anchor="middle" fill="var(--clr-text-dark)">${weekDays[i]}</text>`;
            svg += `<text x="${x}" y="${y - 12}" font-size="10" font-family="var(--font-brand)" font-weight="700" text-anchor="middle" fill="var(--clr-teal-green)">${scoreVal}</text>`;
        }

        svg += `</svg>`;
        container.innerHTML = svg;
    },

    renderUserBadges() {
        const container = document.getElementById('dash-badges-container');
        if (!container) return;

        const allBadges = [
            { icon: '🏆', title: 'Consistent Tracker', desc: 'Completed 3 wellness logs' },
            { icon: '💧', title: 'Hydration Hero', desc: 'Log 10 water drops in a day' },
            { icon: '🚶‍♀️', title: 'Active Stride', desc: 'Covered 10k steps' }
        ];

        let html = '';
        allBadges.forEach(b => {
            html += `
                <div style="background-color: var(--clr-primary-translucent); padding: 8px; border-radius: var(--radius-sm); border: 1px solid var(--clr-border-glass); cursor: pointer;" title="${b.desc}">
                    <div style="font-size: 1.5rem; margin-bottom: 2px;">${b.icon}</div>
                    <div style="font-size: 0.75rem; font-weight: 700; color: var(--clr-text-dark); line-height: 1.1;">${b.title}</div>
                </div>
            `;
        });
        container.innerHTML = html;
    },

    toggleTaskCheck(taskKey) {
        alert(`Good job on making progress towards your ${taskKey} targets today! Keep tracking.`);
    },

    quickLogWater() {
        let todayLog = this.getTodayLog();
        if (!todayLog) {
            alert("Please start your Daily Wellness Log first before quick-logging.");
            this.navigateTo('wellness-log');
            return;
        }
        
        todayLog.waterCount = Math.min((todayLog.waterCount || 0) + 1, 10);
        this.saveDatabase();
        this.renderDashboard();
        this.logAudit(this.currentUser.name, 'Quick Water Logged', `Water droplets incremented to ${todayLog.waterCount}`);
        alert(`1 Glass of Water (250ml) logged successfully! Current hydration status: ${todayLog.waterCount}/10 drops.`);
    },

    // ==================== DAILY WELLNESS LOG CONTROLS ====================
    renderWellnessLog() {
        this.currentWaterCount = 0;
        this.updateWaterDropletsUI();
        this.selectMood('happy');
        this.toggleExerciseInputs(true);
        this.toggleFastingInputs(false);
        this.calculateBMI();
        this.updateStepsCharts();
    },

    logWaterClick(num) {
        this.currentWaterCount = num;
        this.updateWaterDropletsUI();
    },

    updateWaterDropletsUI() {
        const droplets = document.querySelectorAll('.droplet');
        droplets.forEach(d => {
            const val = parseInt(d.getAttribute('data-num'));
            if (val <= this.currentWaterCount) {
                d.classList.add('active');
            } else {
                d.classList.remove('active');
            }
        });

        const pct = this.currentWaterCount * 10;
        document.getElementById('water-log-gauge').style.width = `${pct}%`;
        document.getElementById('water-log-gauge-text').textContent = `${pct}% (${this.currentWaterCount} / 10 glasses)`;
    },

    selectMood(mood) {
        this.currentMood = mood;
        const moodBtns = document.querySelectorAll('.mood-btn');
        moodBtns.forEach(btn => {
            btn.classList.remove('active');
            if (btn.getAttribute('data-mood') === mood) {
                btn.classList.add('active');
            }
        });

        // Update advisor text based on mood selected
        const adviceMap = {
            excellent: `"Excellent state! Your cortisol pathways are highly stabilized. Great time to engage in high productivity goals."`,
            happy: `"Feeling happy! Boosts overall lymphatic health and nutrient assimilation. Consider a short walk to extend this."`,
            good: `"Good emotional rating. Balance this with deep breath cycles to lock in your steady productivity state."`,
            neutral: `"Neutral state. Engage in 15 minutes of outdoor sunlight exposure to elevate serotonin receptors."`,
            sad: `"Feeling low? Coach Frannie advises a warm herbal tea, 5 minutes of gratitude journaling, and avoiding screen lights."`,
            stressed: `"Stress indicators detected! Coach Frannie recommends a 4-7-8 breathing exercise: inhale 4s, hold 7s, exhale 8s."`,
            tired: `"Tiredness check: Your recovery score demands rest. Prioritize sleep quality and minimize screen lights."`,
            angry: `"Anger triggers metabolic heat. Engaged in box breathing: inhale, hold, exhale, hold for 4 seconds each."`
        };
        document.getElementById('mood-advice-text').textContent = adviceMap[mood];
    },

    toggleExerciseInputs(show) {
        document.getElementById('exercise-details-fields').style.display = show ? 'grid' : 'none';
    },

    toggleFastingInputs(show) {
        document.getElementById('fasting-details-fields').style.display = show ? 'grid' : 'none';
    },

    calculateBMI() {
        const weightLbs = parseFloat(document.getElementById('metrics-weight')?.value) || 0;
        const heightCm = parseFloat(this.currentUser?.height) || 170; // uses profile height in cm
        
        if (weightLbs > 0 && heightCm > 0) {
            const weightKg = weightLbs * 0.45359237;
            const heightM = heightCm / 100;
            const bmi = (weightKg / (heightM * heightM)).toFixed(1);
            const bmiEl = document.getElementById('metrics-bmi');
            if (bmiEl) bmiEl.value = bmi;
        }
    },

    updateStepsCharts() {
        const stepsVal = parseInt(document.getElementById('log-steps-input')?.value) || 0;
        const container = document.getElementById('steps-chart-box');
        if (!container) return;

        let width = container.clientWidth || 500;
        let height = 180;
        let spacing = (width - 80) / 6;

        let svg = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
            <line x1="40" y1="150" x2="${width - 20}" y2="150" stroke="rgba(18,130,109,0.12)" stroke-width="1"/>
        `;

        if (this.stepsChartMode === 'week') {
            // Render Weekly bar graph with rounded columns and soft fills
            const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
            const stepData = [6200, 7800, 9400, 5000, 8100, 11200, stepsVal];
            
            for(let i=0; i<7; i++) {
                let x = 50 + (i * spacing);
                let val = stepData[i];
                let barHeight = (val / 15000) * 110;
                let y = 150 - barHeight;
                
                // Column bar with rx/ry rounded tops and soft shadow/drop-shadow
                svg += `<rect x="${x - 12}" y="${y}" width="24" height="${barHeight}" rx="6" ry="6" fill="var(--clr-teal-green)" fill-opacity="0.85" stroke="var(--clr-teal-green)" stroke-width="1" style="transition:all 0.5s; cursor:pointer; filter:drop-shadow(0 2px 4px rgba(18,130,109,0.15))"/>`;
                // Label
                svg += `<text x="${x}" y="165" font-size="10.5" font-family="var(--font-brand)" text-anchor="middle" fill="var(--clr-text-dark)">${days[i]}</text>`;
                svg += `<text x="${x}" y="${y - 8}" font-size="9.5" font-family="var(--font-brand)" font-weight="700" text-anchor="middle" fill="var(--clr-teal-green)">${(val/1000).toFixed(1)}k</text>`;
            }
        } else {
            // Render Monthly trend curve with gradient area
            const weeks = ['W1', 'W2', 'W3', 'W4'];
            const stepData = [7200, 8500, 6800, stepsVal];
            let spacingMonth = (width - 80) / 3;
            let points = [];
            let gradPoints = [];

            gradPoints.push(`40,150`);
            for(let i=0; i<4; i++) {
                let x = 50 + (i * spacingMonth);
                let val = stepData[i];
                let y = 150 - ((val / 15000) * 110);
                points.push(`${x},${y}`);
                gradPoints.push(`${x},${y}`);
            }
            gradPoints.push(`${50 + 3 * spacingMonth},150`);

            svg += `<defs>
                <linearGradient id="stepsGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="var(--clr-teal-green)" stop-opacity="0.25" />
                    <stop offset="100%" stop-color="var(--clr-teal-green)" stop-opacity="0.0" />
                </linearGradient>
            </defs>`;
            
            svg += `<polygon points="${gradPoints.join(' ')}" fill="url(#stepsGrad)"/>`;
            svg += `<polyline fill="none" stroke="var(--clr-teal-green)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" points="${points.join(' ')}"/>`;

            for(let i=0; i<4; i++) {
                let x = 50 + (i * spacingMonth);
                let val = stepData[i];
                let y = 150 - ((val / 15000) * 110);
                svg += `<circle cx="${x}" cy="${y}" r="6.5" fill="var(--clr-teal-green)" stroke="white" stroke-width="2.5" style="filter:drop-shadow(0 2px 4px rgba(0,0,0,0.1))"/>`;
                svg += `<text x="${x}" y="165" font-size="10.5" font-family="var(--font-brand)" text-anchor="middle" fill="var(--clr-text-dark)">${weeks[i]}</text>`;
                svg += `<text x="${x}" y="${y - 12}" font-size="9.5" font-family="var(--font-brand)" font-weight="700" text-anchor="middle" fill="var(--clr-teal-green)">${val.toLocaleString()}</text>`;
            }
        }

        svg += `</svg>`;
        container.innerHTML = svg;
    },

    switchStepsTab(mode) {
        this.stepsChartMode = mode;
        this.updateStepsCharts();
    },

    // Handle wellness log submit with async verified persistence & photo support
    async handleWellnessLogSubmit(e) {
        e.preventDefault();
        
        const submitBtn = e.target?.querySelector('button[type="submit"]') || document.getElementById('wellness-submit-btn');
        const originalBtnHtml = submitBtn ? submitBtn.innerHTML : '';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting Wellness Log...';
        }

        try {
            // 1. Detect platform & environment for data telemetry
            const isAndroid = /Android/i.test(navigator.userAgent);
            const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
            const deviceType = isAndroid ? 'Android App/WebView' : (isIOS ? 'iOS Mobile Safari' : 'Web Desktop/Mobile');

            // 2. Gather form inputs safely with default fallbacks
            const affirmations = [
                document.getElementById('affirmation-1')?.value || '',
                document.getElementById('affirmation-2')?.value || '',
                document.getElementById('affirmation-3')?.value || ''
            ].filter(Boolean);

            const gratitudes = [
                document.getElementById('gratitude-1')?.value || '',
                document.getElementById('gratitude-2')?.value || '',
                document.getElementById('gratitude-3')?.value || ''
            ].filter(Boolean);

            const goals = [
                document.getElementById('goals-1')?.value || '',
                document.getElementById('goals-2')?.value || '',
                document.getElementById('goals-3')?.value || ''
            ].filter(Boolean);

            const reflections = [
                document.getElementById('journal-1')?.value || '',
                document.getElementById('journal-2')?.value || '',
                document.getElementById('journal-3')?.value || ''
            ].filter(Boolean);

            const greatThings = [
                document.getElementById('great-things-1')?.value || '',
                document.getElementById('great-things-2')?.value || '',
                document.getElementById('great-things-3')?.value || ''
            ].filter(Boolean);

            const exerciseCompleted = document.querySelector('input[name="exercise-completed"]:checked')?.value || 'yes';
            const fastingCompleted = document.querySelector('input[name="fasting-completed"]:checked')?.value || 'no';

            const weightLbs = parseFloat(document.getElementById('metrics-weight')?.value) || 155.4;
            const bmiVal = parseFloat(document.getElementById('metrics-bmi')?.value) || 22.5;
            const bodyFatVal = parseFloat(document.getElementById('metrics-bodyfat')?.value) || 18.5;
            const visceralFatVal = parseFloat(document.getElementById('metrics-viscerafat')?.value) || 10.0;
            const skeletalMuscleVal = parseFloat(document.getElementById('metrics-skeletalmuscle')?.value) || 66.1;
            const leanMassVal = parseFloat(document.getElementById('metrics-leanmass')?.value) || 110.2;
            const bloodPressureVal = document.getElementById('metrics-bloodpressure')?.value || '120/80';
            const bloodSugarVal = parseFloat(document.getElementById('metrics-bloodsugar')?.value) || 95;
            const heartRateVal = parseInt(document.getElementById('metrics-heartrate')?.value) || 65;
            const stressVal = parseInt(document.getElementById('metrics-stress')?.value) || 4;
            const energyVal = parseInt(document.getElementById('metrics-energy')?.value) || 7;
            const screenTimeVal = parseFloat(document.getElementById('metrics-screentime')?.value) || 4.5;
            const outdoorTimeVal = parseInt(document.getElementById('metrics-outdoortime')?.value) || 45;
            const sunlightVal = parseInt(document.getElementById('metrics-sunlight')?.value) || 20;
            const meditationVal = parseInt(document.getElementById('metrics-meditation')?.value) || 15;
            const medicationTaken = document.getElementById('metrics-medication')?.checked ?? true;
            const supplementTaken = document.getElementById('metrics-supplement')?.checked ?? true;

            const photoDataUrl = this.selectedPhotoData?.base64 || '';

            const log = {
                id: 'LOG-' + Date.now(),
                userEmail: this.currentUser.email,
                timestamp: new Date().toISOString(),
                device: deviceType,
                sleep: {
                    wakeup: document.getElementById('sleep-wakeup')?.value || '07:00 AM',
                    bedtime: document.getElementById('sleep-bedtime')?.value || '11:00 PM',
                    duration: document.getElementById('sleep-duration')?.value || '8.0',
                    quality: 'Restful'
                },
                affirmations: affirmations,
                gratitudes: gratitudes,
                goals: goals,
                reflections: reflections,
                greatThings: greatThings,
                journal: {
                    affirmation: affirmations.join('; '),
                    gratitude: gratitudes.join('; '),
                    reflections: reflections.join('; ')
                },
                waterCount: this.currentWaterCount || 8,
                exercise: {
                    completed: exerciseCompleted,
                    type: document.getElementById('exercise-type')?.value || 'Running',
                    duration: document.getElementById('exercise-duration')?.value || '30',
                    intensity: document.getElementById('exercise-intensity')?.value || 'Moderate'
                },
                exerciseCompleted: exerciseCompleted,
                steps: parseInt(document.getElementById('log-steps-input')?.value) || 0,
                mood: this.currentMood || 'happy',
                meals: {
                    breakfast: { desc: document.getElementById('meal-breakfast-desc')?.value || '', portion: document.getElementById('meal-breakfast-portion')?.value || '' },
                    lunch: { desc: document.getElementById('meal-lunch-desc')?.value || '', portion: document.getElementById('meal-lunch-portion')?.value || '' },
                    dinner: { desc: document.getElementById('meal-dinner-desc')?.value || '', portion: document.getElementById('meal-dinner-portion')?.value || '' },
                    snacks: { desc: document.getElementById('meal-snacks-desc')?.value || '', portion: document.getElementById('meal-snacks-portion')?.value || '' },
                    photo: photoDataUrl
                },
                fasting: {
                    completed: fastingCompleted,
                    type: document.getElementById('fasting-type')?.value || '16:8 Intermittent',
                    start: document.getElementById('fasting-start')?.value || '20:00',
                    end: document.getElementById('fasting-end')?.value || '12:00',
                    hours: 16
                },
                photos: photoDataUrl ? [photoDataUrl] : [],
                photoUrl: photoDataUrl,
                metrics: {
                    weight: weightLbs,
                    bmi: bmiVal,
                    bodyFat: bodyFatVal,
                    visceralFat: visceralFatVal,
                    skeletalMuscle: skeletalMuscleVal,
                    leanMass: leanMassVal,
                    bloodPressure: bloodPressureVal,
                    bloodSugar: bloodSugarVal,
                    heartRate: heartRateVal,
                    stress: stressVal,
                    energy: energyVal,
                    screenTime: screenTimeVal,
                    outdoorTime: outdoorTimeVal,
                    sunlight: sunlightVal,
                    meditation: meditationVal,
                    medicationTaken: medicationTaken,
                    supplementTaken: supplementTaken
                },
                outdoorTime: outdoorTimeVal,
                sunlight: sunlightVal,
                meditation: meditationVal,
                screenTime: screenTimeVal,
                streakCount: (this.currentUser.streakCount || 0) + 1
            };

            // 3. Save log to local in-memory DB
            this.db.wellnessLogs.unshift(log);

            // Deterministically calculate and update user monthly streak
            const userObj = this.db.users.find(u => u.email.toLowerCase() === this.currentUser.email.toLowerCase());
            const targetUser = userObj || this.currentUser;
            const updatedStreak = this.calculateUserMonthlyStreak(targetUser, new Date(log.timestamp));
            
            targetUser.streakCount = updatedStreak;
            targetUser.lastStreakDate = log.timestamp.split('T')[0];
            targetUser.updatedAt = new Date().toISOString();

            if (userObj) {
                userObj.streakCount = updatedStreak;
                userObj.lastStreakDate = targetUser.lastStreakDate;
                userObj.streakMonthCycle = targetUser.streakMonthCycle;
                userObj.updatedAt = targetUser.updatedAt;
            }
            this.currentUser.streakCount = updatedStreak;
            this.currentUser.lastStreakDate = targetUser.lastStreakDate;
            this.currentUser.streakMonthCycle = targetUser.streakMonthCycle;
            this.currentUser.updatedAt = targetUser.updatedAt;

            log.streakCount = updatedStreak;

            try {
                sessionStorage.setItem('leanlife_session', JSON.stringify(this.currentUser));
                localStorage.setItem('leanlife_session', JSON.stringify(this.currentUser));
            } catch(e) {}

            // Save to local storage & safe Cloud sync
            await this.saveDatabase();

            // 4. Direct Atomic Table Write to Supabase 'wellness_logs' and 'users' table if available
            if (this.supabase) {
                try {
                    const { error: logErr } = await this.supabase
                        .from('wellness_logs')
                        .upsert({
                            id: log.id,
                            user_email: log.userEmail,
                            date: log.timestamp.split('T')[0],
                            weight: log.metrics.weight,
                            calories_intake: 1850,
                            calories_burned: log.exercise.completed === 'yes' ? (parseInt(log.exercise.duration) * 7 || 150) : 0,
                            water_ml: log.waterCount * 250,
                            steps: log.steps,
                            sleep_hours: parseFloat(log.sleep.duration) || 8.0,
                            mood: log.mood,
                            heart_rate: log.metrics.heartRate,
                            blood_pressure: log.metrics.bloodPressure,
                            notes: reflections.join('; ') || `Daily submission from ${deviceType}`,
                            meals: log.meals,
                            activities: [log.exercise],
                            created_at: log.timestamp
                        });

                    if (logErr) {
                        console.warn("Supabase wellness_logs atomic insert notice:", logErr.message);
                    } else {
                        console.log("Atomic wellness_logs record persisted to Supabase table.");
                    }

                    // Update user streak count in Supabase users table
                    await this.supabase.from('users').upsert({
                        email: this.currentUser.email,
                        streak_count: updatedStreak,
                        name: this.currentUser.name,
                        password: this.currentUser.password || 'TEMP_HASH',
                        role: this.currentUser.role || 'member'
                    }, { onConflict: 'email' });
                } catch (dbErr) {
                    console.error("Direct table persistence error:", dbErr);
                }
            }

            this.logAudit(this.currentUser.name, 'Wellness Log Submitted', `Daily log created for ${this.currentUser.email} (${deviceType})`);

            // 5. Initiate Frannie's AI report with countdown
            this.triggerAIAnalysisCountdown(log.id);

            // 6. Clear photo selection
            this.clearSelectedPhoto();

            // 7. Display verified checkmark success animation overlay
            const overlay = document.getElementById('success-overlay');
            if (overlay) overlay.style.display = 'flex';

        } catch (submitErr) {
            console.error("Critical submission error in handleWellnessLogSubmit:", submitErr);
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalBtnHtml || '<i class="fa-solid fa-cloud-arrow-up"></i> Submit Daily Wellness Log';
            }
            alert("A problem occurred while saving your wellness log. Please try again: " + submitErr.message);
        }
    },

    closeSuccessOverlay() {
        const overlay = document.getElementById('success-overlay');
        if (overlay) overlay.style.display = 'none';
        const submitBtn = document.getElementById('wellness-submit-btn');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i> Submit Daily Wellness Log';
        }
        this.navigateTo('dashboard');
    },

    // ==================== FRANNIE'S DELAYED AI REPORT SYSTEM ====================
    triggerAIAnalysisCountdown(logId) {
        // Clear active intervals
        if (this.countdownInterval) clearInterval(this.countdownInterval);

        const duration = 3600; // 1 hour in seconds
        const submissionTime = Date.now();
        const reportTargetTime = submissionTime + (duration * 1000);

        // Create a pending AI Report record in mock DB
        const pendingReport = {
            id: 'REP-' + Date.now(),
            logId: logId,
            userEmail: this.currentUser.email,
            timestamp: new Date().toISOString(),
            status: 'pending',
            reportTargetTime: reportTargetTime,
            overallScore: 0,
            grade: 'N/A'
        };

        this.db.aiReports.push(pendingReport);

        // Queue an asynchronous background job in Automation Center
        const jobId = 'JOB-' + Date.now().toString().slice(-4);
        this.db.automationJobs.unshift({
            id: jobId,
            name: `Daily Log Processor & AI Report`,
            user: this.currentUser.email,
            timestamp: new Date().toISOString(),
            retries: 0,
            status: 'Pending'
        });
        this.logAutomation(`Daily Log submitted by ${this.currentUser.email}. Asynchronous Job ${jobId} queued.`);
        
        this.saveDatabase();

        this.activeCountdown = pendingReport;
        this.startTimerInterval(reportTargetTime);
    },

    restorePendingCountdowns() {
        if (!this.currentUser) return;
        const pending = this.db.aiReports.find(r => r.userEmail.toLowerCase() === this.currentUser.email.toLowerCase() && r.status === 'pending');
        if (pending) {
            this.activeCountdown = pending;
            const now = Date.now();
            if (now >= pending.reportTargetTime) {
                // Timer expired while offline, complete it now
                this.generateAIReport(pending.id);
            } else {
                this.startTimerInterval(pending.reportTargetTime);
            }
        }
    },

    startBackgroundAutomationLoop() {
        console.log("Starting LeanLife Background Automation Scheduler (Web Worker Thread)...");
        this.autoUptimeStart = Date.now();
        this.autoTerminalLogs = [];
        this.simulatedNetworkFailure = false;
        
        this.logAutomation("System Daemon initialized via Web Worker thread. Uptime active.");
        this.logAutomation("Starting multi-threaded asynchronous queue processor loop.");

        const workerCode = `
            self.onmessage = function(e) {
                if (e.data.type === 'START') {
                    setInterval(() => {
                        self.postMessage({ type: 'TICK' });
                    }, 5000);
                }
            };
        `;

        try {
            const blob = new Blob([workerCode], { type: 'application/javascript' });
            const workerUrl = URL.createObjectURL(blob);
            this.autoWorker = new Worker(workerUrl);
            
            this.autoWorker.onmessage = (e) => {
                if (e.data.type === 'TICK') {
                    this.runSimulatedBackgroundTasks();
                }
            };

            this.autoWorker.postMessage({ type: 'START' });
        } catch (err) {
            console.warn("Web Worker creation failed. Falling back to main thread interval.", err);
            setInterval(() => {
                this.runSimulatedBackgroundTasks();
            }, 5000);
        }
    },

    runSimulatedBackgroundTasks() {
        const now = Date.now();

        // 1. Update Uptime Ticker
        const uptimeDiff = now - this.autoUptimeStart;
        const upSecs = Math.floor(uptimeDiff / 1000) % 60;
        const upMins = Math.floor(uptimeDiff / 60000) % 60;
        const upHours = Math.floor(uptimeDiff / 3600000);
        const uptimeStr = `${upHours.toString().padStart(2, '0')}:${upMins.toString().padStart(2, '0')}:${upSecs.toString().padStart(2, '0')}`;
        const uptimeEl = document.getElementById('auto-uptime');
        if (uptimeEl) uptimeEl.textContent = uptimeStr;

        // 2. Process Asynchronous Task Queues
        const nextJob = this.db.automationJobs.find(j => j.status === 'Pending' || j.status === 'In Progress');
        if (nextJob) {
            if (nextJob.status === 'Pending') {
                nextJob.status = 'In Progress';
                this.logAutomation(`Processing job ${nextJob.id}: "${nextJob.name}" for user: ${nextJob.user}`);
                this.saveDatabase();
                if (this.activeView === 'admin' && this.activeAdminTab === 'automation') {
                    this.renderAdminAutomationCMS();
                }
            } else if (nextJob.status === 'In Progress') {
                // Execute job logic
                if (this.simulatedNetworkFailure) {
                    // Retry execution block
                    nextJob.retries++;
                    this.db.automationRetries++;
                    this.logAutomation(`CRITICAL: Job ${nextJob.id} run execution failed (Network Timeout). Attempting retry #${nextJob.retries}...`);
                    
                    if (nextJob.retries >= 3) {
                        nextJob.status = 'Failed';
                        this.db.automationFailures++;
                        this.logAutomation(`SHUTDOWN: Job ${nextJob.id} reached retry threshold limit. Marked as FAILED.`);
                    }
                    this.saveDatabase();
                    if (this.activeView === 'admin' && this.activeAdminTab === 'automation') {
                        this.renderAdminAutomationCMS();
                    }
                } else {
                    // Job finished successfully
                    nextJob.status = 'Completed';
                    this.logAutomation(`SUCCESS: Job ${nextJob.id} finished successfully in 4.8s.`);
                    
                    // Side-effect processing
                    if (nextJob.name.includes('Newsletter')) {
                        const members = this.db.users.filter(u => u.role === 'member');
                        members.forEach(m => {
                            this.db.emails.unshift({
                                id: 'EML-' + Date.now() + Math.random().toString(36).substr(2, 2),
                                timestamp: new Date().toISOString(),
                                recipient: m.email,
                                subject: 'Weekly Longevity & Wellness Newsletter',
                                templateName: 'Newsletter Summary',
                                status: 'Delivered'
                            });
                        });
                        this.logAutomation(`Sent email dispatch notifications to ${members.length} members.`);
                        if (this.activeView === 'admin' && this.activeAdminTab === 'emails-cms') {
                            this.renderAdminEmailsCMS();
                        }
                    } else if (nextJob.name.includes('Backup')) {
                        this.logAudit('Cron Automation Scheduler', 'Backup Snapshot Created', `JSON snapshot verified & archived.`);
                    } else if (nextJob.name.includes('AI')) {
                        this.logAudit('Frannie AI Engine', 'NLP Optimization Loop', `Finished deep learning training on historical log data.`);
                    } else if (nextJob.name.includes('Daily Log')) {
                        // Complete pending report
                        const pendingReport = this.db.aiReports.find(r => r.status === 'pending');
                        if (pendingReport) {
                            this.generateAIReport(pendingReport.id);
                        }
                        this.logAutomation("Wellness Log database synced & Frannie AI analysis report compiled.");
                    }

                    this.saveDatabase();
                    if (this.activeView === 'admin' && this.activeAdminTab === 'automation') {
                        this.renderAdminAutomationCMS();
                    }
                }
            }
        }

        // 3. Automated Periodic Newsletter runs (every 5 mins)
        try {
            const lastDispatch = localStorage.getItem('leanlife_last_newsletter');
            if (!lastDispatch || (now - parseInt(lastDispatch)) > 300000) { // every 5 minutes
                localStorage.setItem('leanlife_last_newsletter', now.toString());
                this.runNewsletterJob();
            }
        } catch (e) {
            console.warn("Storage notice during newsletter check:", e);
        }

        // 4. Maintenance log outputs (every 30s)
        if (!this.lastMaintenanceLog || (now - this.lastMaintenanceLog) > 30000) {
            this.lastMaintenanceLog = now;
            this.logAutomation(`Daemon: Local database check. Size: ${(JSON.stringify(this.db).length / 1024).toFixed(2)} KB.`);
            
            // Refresh general analytics if viewing
            if (this.activeView === 'admin' && this.activeAdminTab === 'analytics-cms') {
                this.renderAdminAnalyticsCMS();
            }
        }

        // 5. Update Automation view metrics dynamically
        if (this.activeView === 'admin' && this.activeAdminTab === 'automation') {
            this.renderAdminAutomationCMS();
        }

        // 6. Check Clinic Appointment Reminders & Update Notification Badges
        this.checkAppointmentReminders();
        this.updateAppointmentNotificationBadges();
    },

    startTimerInterval(targetTime) {
        document.getElementById('dashboard-pending-analysis-card').style.display = 'flex';

        const updateTimer = () => {
            const diff = targetTime - Date.now();
            if (diff <= 0) {
                clearInterval(this.countdownInterval);
                document.getElementById('dashboard-pending-analysis-card').style.display = 'none';
                this.generateAIReport(this.activeCountdown.id);
                return;
            }

            const hrs = Math.floor(diff / 3600000);
            const mins = Math.floor((diff % 3600000) / 60000);
            const secs = Math.floor((diff % 60000) / 1000);

            document.getElementById('timer-hour').textContent = hrs.toString().padStart(2, '0');
            document.getElementById('timer-min').textContent = mins.toString().padStart(2, '0');
            document.getElementById('timer-sec').textContent = secs.toString().padStart(2, '0');
        };

        updateTimer();
        this.countdownInterval = setInterval(updateTimer, 1000);
    },

    triggerAISpeedUp() {
        if (!this.activeCountdown) return;
        console.log("Speeding up AI analysis for testing...");
        clearInterval(this.countdownInterval);
        document.getElementById('dashboard-pending-analysis-card').style.display = 'none';
        this.generateAIReport(this.activeCountdown.id);
    },

    // Generates a comprehensive AI analysis report based on user log parameters
    generateAIReport(reportId) {
        console.log("Generating report reportId:", reportId);
        const report = this.db.aiReports.find(r => r.id === reportId);
        if (!report) return;

        const log = this.db.wellnessLogs.find(l => l.id === report.logId);
        if (!log) return;

        // Perform algorithmic scoring based on log parameters
        let sleepVal = parseFloat(log.sleep?.duration || (typeof log.sleep === 'number' ? log.sleep : 0)) || 0;
        let sleepScore = sleepVal >= 8 ? 95 : (sleepVal >= 7 ? 85 : (sleepVal >= 6 ? 70 : 50));
        
        let waterVal = log.waterCount || 0;
        let waterScore = waterVal >= 10 ? 100 : (waterVal >= 8 ? 85 : (waterVal >= 5 ? 65 : 40));

        let exerciseVal = (log.exerciseCompleted === 'yes' || log.exercise?.completed === 'yes');
        let physicalScore = exerciseVal ? 90 : 50;

        let stepsVal = log.steps || 0;
        if (stepsVal >= 10000) physicalScore += 10;
        else if (stepsVal >= 7500) physicalScore += 5;
        physicalScore = Math.min(physicalScore, 100);

        let stressVal = log.metrics?.stress || 5;
        let mentalScore = 100 - (stressVal * 7);
        if (log.metrics?.screenTime && log.metrics.screenTime < 3) mentalScore += 10;
        mentalScore = Math.min(mentalScore, 100);

        let nutritionScore = 80; // baseline
        if (log.meals?.breakfast?.desc && log.meals?.lunch?.desc && log.meals?.dinner?.desc) nutritionScore += 10;
        if (log.meals?.snacks?.desc && (log.meals.snacks.desc.toLowerCase().includes('fruit') || log.meals.snacks.desc.toLowerCase().includes('nuts'))) nutritionScore += 5;
        nutritionScore = Math.min(nutritionScore, 100);

        const overallScore = Math.round((sleepScore + waterScore + physicalScore + mentalScore + nutritionScore) / 5);
        
        let grade = 'C';
        if (overallScore >= 95) grade = 'A+';
        else if (overallScore >= 90) grade = 'A';
        else if (overallScore >= 80) grade = 'B+';
        else if (overallScore >= 70) grade = 'B';

        // Update report details
        report.status = 'completed';
        report.overallScore = overallScore;
        report.grade = grade;
        report.scores = {
            sleep: sleepScore,
            water: waterScore,
            physical: physicalScore,
            mental: mentalScore,
            nutrition: nutritionScore
        };

        // Textual analyses generated by AI assistant Frannie
        report.analyses = {
            sleep: {
                desc: `You completed ${sleepVal} hours of sleep, waking up at ${log.sleep.wakeup}. Sleep consistency is scored high at ${sleepScore}%. Circadian clocks remain steady.`,
                rec: `Recovery score is ${sleepScore}. Coach Frannie recommends a target bedtime of ${log.sleep.bedtime} tonight with no blue screen lights in the preceding 30 minutes.`
            },
            water: {
                desc: `Hydration level is at ${waterVal * 250}ml (${waterVal}/10 drops). Your overall water completion score is ${waterScore}%.`,
                tips: waterVal >= 10 ? `Excellent! Your cells are fully hydrated. Keep logging to track consistency.` : `Coach Frannie notes that increasing water by ${10 - waterVal} glasses today will reduce muscle fatigue and optimize kidney clearance levels.`
            },
            nutrition: {
                profile: `Estimated intake: 1,920 kcal. Protein: 95g, Carbohydrates: 210g, Healthy Fats: 58g, Fiber: 30g, Sodium: 1,320mg. Meal balance rating is high.`,
                subs: `Meal quality rating: Grade A. Consider swapping processed snack items with raw pumpkin seeds for zinc support.`
            },
            fitness: {
                desc: `Exercise: ${log.exercise.completed === 'yes' ? log.exercise.type : 'Rest day'}. Duration: ${log.exercise.duration} mins. Intensity: ${log.exercise.intensity}. Calories Burned: estimated ${log.exercise.completed === 'yes' ? (log.exercise.duration * 7) : 0} kcal.`,
                steps: `Daily steps registered: ${stepsVal.toLocaleString()}. Activity classification: ${stepsVal >= 10000 ? 'Highly Active' : 'Moderate'}.`
            },
            mental: {
                desc: `Emotional wellness rating: ${log.mood.toUpperCase()}. Stress level registered: ${stressVal}/10. Thought index is highly positive. Journal analysis indicates consistent gratitude focus.`
            },
            motivate: `Outstanding execution today, ${this.currentUser.name}! Logging your details consistently builds accountability. Coach Frannie is highly impressed with your gratitude practices. Let's hit 10,000 steps tomorrow!`
        };

        report.log = log;
        report.userName = this.currentUser ? this.currentUser.name : 'LeanLife Member';
        report.metrics = log.metrics || {};
        report.sleepData = log.sleep;
        report.mealsData = log.meals;
        report.exerciseData = log.exercise;
        report.photos = log.photos || (log.photoUrl ? [log.photoUrl] : []);
        report.affirmations = log.affirmations;
        report.gratitudes = log.gratitudes;
        report.reflections = log.reflections;
        report.goals = log.goals;
        report.waterCount = log.waterCount;
        report.steps = log.steps;
        report.mood = log.mood;
        report.outdoorTime = log.outdoorTime;
        report.sunlight = log.sunlight;
        report.meditation = log.meditation;
        report.screenTime = log.screenTime;

        this.saveDatabase();
        this.activeCountdown = null;
        
        this.logAudit(this.currentUser.name, 'AI Report Generated', `Wellness analysis finished for log ${log.id}`);
        
        // Show notification
        if (this.showCustomAlert) {
            this.showCustomAlert(
                `🔔 Coach Frannie's Wellness Analysis is ready!\n\nOverall Wellness Score: ${overallScore} (Grade: ${grade}).\n\nClick 'View Full Wellness Report' to explore your complete biometric recovery insights.`,
                "Wellness Report Ready",
                "fa-square-poll-horizontal"
            );
        }

        // If user is currently looking at dashboard, refresh it
        if (this.activeView === 'dashboard') {
            this.renderDashboard();
        } else if (this.activeView === 'ai-report') {
            this.renderAIReportView(report.id);
        }
    },

    getLatestReport() {
        if (!this.currentUser) return null;
        const userEmail = (this.currentUser.email || '').toLowerCase().trim();
        const userReports = (this.db.aiReports || []).filter(r => {
            const rEmail = (r.userEmail || r.user_email || '').toLowerCase().trim();
            return rEmail === userEmail;
        });

        if (userReports.length === 0) {
            // Check if there are user wellness logs to construct a report from
            const userLogs = (this.db.wellnessLogs || []).filter(l => {
                const lEmail = (l.userEmail || l.user_email || '').toLowerCase().trim();
                return lEmail === userEmail;
            });
            if (userLogs.length > 0) {
                const latestLog = userLogs[userLogs.length - 1];
                let newRep = (this.db.aiReports || []).find(r => r.logId === latestLog.id);
                if (!newRep) {
                    newRep = {
                        id: 'REP-' + Date.now(),
                        logId: latestLog.id,
                        userEmail: this.currentUser.email,
                        timestamp: latestLog.timestamp || new Date().toISOString(),
                        status: 'completed'
                    };
                    this.db.aiReports.push(newRep);
                    this.generateAIReport(newRep.id);
                }
                return newRep;
            }
            return null;
        }

        // Prioritize newest completed report
        const completedReports = userReports.filter(r => r.status === 'completed');
        if (completedReports.length > 0) {
            return completedReports[completedReports.length - 1];
        }
        return userReports[userReports.length - 1];
    },

    viewLatestAIReport() {
        if (!this.currentUser) {
            this.navigateTo('login');
            return;
        }

        let latest = this.getLatestReport();
        if (latest) {
            this.navigateTo('ai-report', { reportId: latest.id });
        } else {
            alert("No completed Wellness Reports found. Please submit a Daily Wellness Log first.");
            this.navigateTo('wellness-log');
        }
    },

    refreshAIReportState() {
        if (this.activeCountdown && Date.now() >= this.activeCountdown.reportTargetTime) {
            this.generateAIReport(this.activeCountdown.id);
        }
        const latest = this.getLatestReport();
        if (latest) {
            this.renderAIReportView(latest.id);
        }
    },

    renderAIReportView(reportId) {
        let report = this.db.aiReports.find(r => r.id === reportId);
        if (!report) {
            report = this.getLatestReport();
        }
        if (!report) return;

        const log = this.db.wellnessLogs.find(l => l.id === report.logId) || report.log || {};
        const memberName = report.userName || (this.currentUser ? this.currentUser.name : 'LeanLife Member');
        const reportTimestamp = report.timestamp ? new Date(report.timestamp).toLocaleString() : new Date().toLocaleString();

        // 1. Header Information
        const nameEl = document.getElementById('report-member-name');
        if (nameEl) nameEl.textContent = memberName;
        const timeEl = document.getElementById('report-timestamp-val');
        if (timeEl) timeEl.textContent = reportTimestamp;

        // 2. 1-Hour Processing Status Banner Handling
        const banner = document.getElementById('report-status-banner');
        const bannerText = document.getElementById('report-status-banner-text');
        const userEmail = (this.currentUser ? this.currentUser.email : '').toLowerCase().trim();
        const pending = (this.db.aiReports || []).find(r => (r.userEmail || '').toLowerCase().trim() === userEmail && r.status === 'pending');

        if (pending && banner && bannerText) {
            const diffMs = pending.reportTargetTime - Date.now();
            if (diffMs > 0) {
                const mins = Math.floor(diffMs / 60000);
                const secs = Math.floor((diffMs % 60000) / 1000);
                banner.style.display = 'flex';
                bannerText.textContent = `Coach Frannie is currently analyzing your latest wellness submission (${mins}m ${secs}s remaining). Showing your latest completed report below.`;
            } else {
                banner.style.display = 'none';
            }
        } else if (banner) {
            banner.style.display = 'none';
        }

        // 3. Overall Score Ring Gauges
        const overallScore = report.overallScore || 88;
        const nutritionScore = report.scores?.nutrition || 75;
        const physicalScore = report.scores?.physical || 90;
        const mentalScore = report.scores?.mental || 92;

        const valOverall = document.getElementById('report-val-overall');
        if (valOverall) valOverall.textContent = overallScore;
        const gradeVal = document.getElementById('report-grade-val');
        if (gradeVal) gradeVal.textContent = `Grade: ${report.grade || 'A'}`;
        const gaugeOverall = document.getElementById('report-gauge-overall');
        if (gaugeOverall) gaugeOverall.style.background = `conic-gradient(var(--clr-accent-green) 0% ${overallScore}%, #eee ${overallScore}% 100%)`;

        const valNutrition = document.getElementById('report-val-nutrition');
        if (valNutrition) valNutrition.textContent = nutritionScore;
        const gaugeNutrition = document.getElementById('report-gauge-nutrition');
        if (gaugeNutrition) gaugeNutrition.style.background = `conic-gradient(var(--clr-accent-green) 0% ${nutritionScore}%, #eee ${nutritionScore}% 100%)`;

        const valPhysical = document.getElementById('report-val-physical');
        if (valPhysical) valPhysical.textContent = physicalScore;
        const gaugePhysical = document.getElementById('report-gauge-physical');
        if (gaugePhysical) gaugePhysical.style.background = `conic-gradient(var(--clr-accent-green) 0% ${physicalScore}%, #eee ${physicalScore}% 100%)`;

        const valMental = document.getElementById('report-val-mental');
        if (valMental) valMental.textContent = mentalScore;
        const gaugeMental = document.getElementById('report-gauge-mental');
        if (gaugeMental) gaugeMental.style.background = `conic-gradient(var(--clr-accent-green) 0% ${mentalScore}%, #eee ${mentalScore}% 100%)`;

        // 4. Complete Biometric Vitals
        const met = log.metrics || report.metrics || {};
        const setEl = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = (val !== undefined && val !== null && val !== '') ? val : '--';
        };

        setEl('report-metric-weight', met.weight || log.weight || (this.currentUser ? this.currentUser.weight : '--'));
        setEl('report-metric-bmi', met.bmi || '--');
        setEl('report-metric-bodyfat', met.bodyFat ? `${met.bodyFat}%` : '--');
        setEl('report-metric-bp', met.bloodPressure || '--');
        setEl('report-metric-bloodsugar', met.bloodSugar || '--');
        setEl('report-metric-heartrate', met.heartRate || '--');

        // Lifestyle Metrics
        setEl('report-metric-stress', met.stress || '--');
        setEl('report-metric-energy', met.energy || '--');
        setEl('report-metric-outdoor', (met.outdoorTime !== undefined ? `${met.outdoorTime}m` : (log.outdoorTime ? `${log.outdoorTime}m` : '--')));
        setEl('report-metric-sunlight', (met.sunlight !== undefined ? `${met.sunlight}m` : (log.sunlight ? `${log.sunlight}m` : '--')));
        setEl('report-metric-meditation', (met.meditation !== undefined ? `${met.meditation}m` : (log.meditation ? `${log.meditation}m` : '--')));
        setEl('report-metric-screentime', (met.screenTime !== undefined ? `${met.screenTime}h` : (log.screenTime ? `${log.screenTime}h` : '--')));

        // 5. Analyses Text Elements
        const analyses = report.analyses || {};
        const setText = (id, txt) => {
            const el = document.getElementById(id);
            if (el && txt) el.textContent = txt;
        };

        setText('report-sleep-desc', analyses.sleep?.desc || `You logged consistent sleep. Circadian recovery is rated high.`);
        setText('report-sleep-recovery', analyses.sleep?.rec || `Target bedtime is 10:15 PM to optimize growth hormone release.`);
        setText('report-water-desc', analyses.water?.desc || `Water hydration completion is at optimal levels.`);
        setText('report-water-tips', analyses.water?.tips || `Ensure consistent water intake before and after physical workouts.`);
        setText('report-nutrition-profile', analyses.nutrition?.profile || `Balanced macronutrient distribution observed.`);
        setText('report-nutrition-subs', analyses.nutrition?.subs || `Incorporate whole foods, fiber, and antioxidant-rich greens.`);
        setText('report-fitness-desc', analyses.fitness?.desc || `Daily activity performed with high consistency.`);
        setText('report-steps-fasting-desc', analyses.fitness?.steps || `Daily step goals tracking towards optimal cardiovascular health.`);
        setText('report-mood-journal-desc', analyses.mental?.desc || `Emotional wellness and mental focus are balanced.`);
        setText('report-ai-motivate', analyses.motivate || `"You are doing exceptionally well, ${memberName}! Keep logging consistently to build lifelong health habits."`);

        // 6. Render Full Meals Breakdown
        const mealsContainer = document.getElementById('report-meals-container');
        if (mealsContainer) {
            const meals = log.meals || report.mealsData || {};
            const mealSlots = [
                { key: 'breakfast', label: 'Breakfast' },
                { key: 'lunch', label: 'Lunch' },
                { key: 'dinner', label: 'Dinner' },
                { key: 'snacks', label: 'Snacks' }
            ];

            let mealsHtml = '';
            mealSlots.forEach(slot => {
                const mealData = meals[slot.key];
                const desc = typeof mealData === 'object' ? (mealData.desc || '') : (typeof mealData === 'string' ? mealData : '');
                const photo = typeof mealData === 'object' ? (mealData.photo || '') : '';

                mealsHtml += `
                    <div class="report-meal-item">
                        <h5><i class="fa-solid fa-utensils" style="color: var(--clr-primary-green); margin-right: 4px;"></i> ${slot.label}</h5>
                        <p>${desc || 'Balanced whole-food meal tracked.'}</p>
                        ${photo ? `
                            <img src="${photo}" class="report-thumb-img" alt="${slot.label} Photo" onclick="app.openLightbox('${photo}', '${slot.label} Meal')" title="Click to view photo">
                        ` : ''}
                    </div>
                `;
            });
            mealsContainer.innerHTML = mealsHtml;
        }

        // 7. Render Journaling (Affirmations, Gratitudes, Reflections, Goals)
        const formatJournal = (data) => {
            if (!data) return 'None logged';
            if (Array.isArray(data)) return data.filter(Boolean).join('\n• ');
            if (typeof data === 'string') return data.trim() || 'None logged';
            return 'None logged';
        };

        setText('report-journal-affirmations', formatJournal(log.affirmations || report.affirmations || log.journal?.affirmation));
        setText('report-journal-gratitudes', formatJournal(log.gratitudes || report.gratitudes || log.journal?.gratitude));
        setText('report-journal-reflections', formatJournal(log.reflections || report.reflections || log.journal?.reflections));
        setText('report-journal-goals', formatJournal(log.goals || report.goals || (this.currentUser ? this.currentUser.goals : 'None logged')));

        // 8. Render Progress Photos Gallery
        const photoGallery = document.getElementById('report-photos-gallery');
        if (photoGallery) {
            const photos = [];
            if (Array.isArray(log.photos)) photos.push(...log.photos);
            else if (Array.isArray(report.photos)) photos.push(...report.photos);
            if (log.photoUrl && !photos.includes(log.photoUrl)) photos.push(log.photoUrl);

            if (photos.length > 0) {
                photoGallery.innerHTML = photos.map((p, idx) => `
                    <div style="text-align: center;">
                        <img src="${p}" class="report-thumb-img" style="width: 100px; height: 100px;" alt="Progress Photo ${idx + 1}" onclick="app.openLightbox('${p}', 'Progress Photo ${idx + 1}')" title="Click to enlarge">
                        <div style="font-size: 0.75rem; color: #666; margin-top: 4px;">Photo ${idx + 1}</div>
                    </div>
                `).join('');
            } else {
                photoGallery.innerHTML = '<p style="color: #888; font-size: 0.9rem; margin: 0;">No progress photos attached for this log.</p>';
            }
        }

        // 9. Render Macro Pie Chart
        this.renderMacroPieChartSVG();
    },

    renderMacroPieChartSVG() {
        const container = document.getElementById('report-nutrition-svg-chart');
        if (!container) return;

        // Dynamic SVG Pie Chart representing: Protein (25%), Carbs (55%), Fats (20%)
        container.innerHTML = `
            <svg viewBox="0 0 160 160" width="140" height="140" xmlns="http://www.w3.org/2000/svg">
                <!-- Carbs (55%): Green -->
                <circle cx="80" cy="80" r="60" fill="none" stroke="#2ed573" stroke-width="22" stroke-dasharray="207.3 377" stroke-dashoffset="0"/>
                <!-- Protein (25%): Accent green -->
                <circle cx="80" cy="80" r="60" fill="none" stroke="var(--clr-accent-green)" stroke-width="22" stroke-dasharray="94.25 377" stroke-dashoffset="-207.3"/>
                <!-- Fats (20%): Gray -->
                <circle cx="80" cy="80" r="60" fill="none" stroke="#747d8c" stroke-width="22" stroke-dasharray="75.4 377" stroke-dashoffset="-301.55"/>
                
                <text x="80" y="85" font-size="11" font-family="var(--font-brand)" font-weight="bold" text-anchor="middle" fill="#000">Macros %</text>
            </svg>
            <div style="font-size: 0.8rem; margin-top: 8px; display: flex; gap: 10px; flex-wrap: wrap; justify-content: center;">
                <div><span style="display:inline-block; width:9px; height:9px; background:#2ed573; margin-right:4px;"></span>Carbs 55%</div>
                <div><span style="display:inline-block; width:9px; height:9px; background:var(--clr-accent-green); margin-right:4px;"></span>Protein 25%</div>
                <div><span style="display:inline-block; width:9px; height:9px; background:#747d8c; margin-right:4px;"></span>Fats 20%</div>
            </div>
        `;
    },

    downloadReportPDF(reportId = null) {
        let report = null;
        if (reportId) {
            report = (this.db.aiReports || []).find(r => r.id === reportId);
        }
        if (!report) {
            report = this.getLatestReport();
        }
        if (!report) {
            alert("No wellness report available to download.");
            return;
        }
        
        this.generateAndDownloadPDF(report);
    },

    generateAndDownloadPDF(report) {
        const log = this.db.wellnessLogs.find(l => l.id === report.logId) || report.log || {};
        const memberName = report.userName || (this.currentUser ? this.currentUser.name : 'LeanLife Member');
        const memberEmail = report.userEmail || (this.currentUser ? this.currentUser.email : 'member@leanlife.com');
        const reportDate = new Date(report.timestamp || Date.now()).toLocaleDateString('en-US', {
            year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });

        const met = log.metrics || report.metrics || {};
        const analyses = report.analyses || {};
        const meals = log.meals || report.mealsData || {};

        let mealsSummaryHtml = '';
        ['breakfast', 'lunch', 'dinner', 'snacks'].forEach(slot => {
            const m = meals[slot];
            const desc = typeof m === 'object' ? (m.desc || '') : (typeof m === 'string' ? m : '');
            if (desc) {
                mealsSummaryHtml += `<tr><td style="font-weight:700; width:100px; text-transform:capitalize; padding:6px 10px; border:1px solid #e2e8f0;">${slot}</td><td style="padding:6px 10px; border:1px solid #e2e8f0;">${desc}</td></tr>`;
            }
        });
        if (!mealsSummaryHtml) {
            mealsSummaryHtml = `<tr><td colspan="2" style="padding:6px 10px; border:1px solid #e2e8f0;">Standard balanced healthy nutrition logged.</td></tr>`;
        }

        const pdfHtml = `
<div id="pdf-report-content" style="width: 750px; max-width: 750px; margin: 0; padding: 14px; background: #ffffff; color: #1a202c; font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; box-sizing: border-box; font-size: 11.5px; line-height: 1.4;">
    <style>
        #pdf-report-content * { box-sizing: border-box; }
        #pdf-report-content .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2.5px solid #12826d; padding-bottom: 10px; margin-bottom: 12px; page-break-inside: avoid; break-inside: avoid; }
        #pdf-report-content .brand-title { font-size: 19px; font-weight: 800; color: #12826d; margin: 0; }
        #pdf-report-content .badge { background: #e6fffa; color: #12826d; padding: 4px 10px; border-radius: 14px; font-size: 10px; font-weight: 700; border: 1px solid rgba(18, 130, 109, 0.3); }
        #pdf-report-content .meta-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; background: #f8fafc; padding: 10px 12px; border-radius: 6px; margin-bottom: 12px; border: 1px solid #e2e8f0; page-break-inside: avoid; break-inside: avoid; }
        #pdf-report-content .meta-label { color: #718096; font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; }
        #pdf-report-content .meta-value { font-weight: 700; color: #2d3748; margin-top: 2px; font-size: 10.5px; word-break: break-word; }
        #pdf-report-content .score-banner { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 12px; text-align: center; page-break-inside: avoid; break-inside: avoid; }
        #pdf-report-content .score-box { background: #f4fbf7; border: 1.5px solid #12826d; padding: 8px; border-radius: 6px; }
        #pdf-report-content .score-num { font-size: 20px; font-weight: 900; color: #12826d; line-height: 1; }
        #pdf-report-content .score-name { font-size: 9px; text-transform: uppercase; color: #4a5568; font-weight: 700; margin-top: 3px; }
        #pdf-report-content .section-title { font-size: 12px; font-weight: 700; color: #12826d; margin-top: 12px; margin-bottom: 6px; border-bottom: 1.5px solid #e2e8f0; padding-bottom: 3px; text-transform: uppercase; letter-spacing: 0.5px; page-break-inside: avoid; break-inside: avoid; }
        #pdf-report-content .table { width: 100%; border-collapse: collapse; margin-bottom: 10px; font-size: 10.5px; table-layout: fixed; page-break-inside: avoid; break-inside: avoid; }
        #pdf-report-content .table th, #pdf-report-content .table td { padding: 5px 7px; border: 1px solid #e2e8f0; text-align: left; word-break: break-word; }
        #pdf-report-content .table th { background: #f8fafc; color: #4a5568; font-weight: 700; }
        #pdf-report-content .content-box { background: #f8fafc; border: 1px solid #e2e8f0; border-left: 3.5px solid #12826d; padding: 8px 10px; border-radius: 4px; margin-bottom: 8px; line-height: 1.4; page-break-inside: avoid; break-inside: avoid; }
        #pdf-report-content .content-box h4 { margin: 0 0 3px 0; font-size: 11px; color: #2d3748; }
        #pdf-report-content .content-box p { margin: 0; color: #4a5568; font-size: 10.5px; }
        #pdf-report-content .footer { margin-top: 16px; padding-top: 8px; border-top: 1px solid #e2e8f0; display: flex; justify-content: space-between; font-size: 9px; color: #a0aec0; page-break-inside: avoid; break-inside: avoid; }
    </style>
    
    <div class="header">
        <div>
            <div class="brand-title">🌿 LeanLife Health & Wellness</div>
            <div style="font-size: 10.5px; color: #718096;">AI-Powered Comprehensive Wellness Recovery Report</div>
        </div>
        <div class="badge">CONFIDENTIAL & OFFICIAL</div>
    </div>

    <div class="meta-grid">
        <div class="meta-item">
            <div class="meta-label">Member Name</div>
            <div class="meta-value">${memberName}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Email Address</div>
            <div class="meta-value">${memberEmail}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Report ID</div>
            <div class="meta-value">${report.id || 'RPT-AI-OFFICIAL'}</div>
        </div>
        <div class="meta-item">
            <div class="meta-label">Generated Date</div>
            <div class="meta-value">${reportDate}</div>
        </div>
    </div>

    <div class="score-banner">
        <div class="score-box">
            <div class="score-num">${report.overallScore || 88}</div>
            <div class="score-name">Overall Score (${report.grade || 'A'})</div>
        </div>
        <div class="score-box">
            <div class="score-num">${report.scores?.nutrition || 75}</div>
            <div class="score-name">Nutrition Score</div>
        </div>
        <div class="score-box">
            <div class="score-num">${report.scores?.physical || 90}</div>
            <div class="score-name">Physical Health</div>
        </div>
        <div class="score-box">
            <div class="score-num">${report.scores?.mental || 92}</div>
            <div class="score-name">Mental Wellness</div>
        </div>
    </div>

    <div class="section-title">1. Biometric Vitals & Health Metrics</div>
    <table class="table">
        <tr>
            <th style="width:20%;">Weight</th><td style="width:30%;">${met.weight || log.weight || '--'} lbs</td>
            <th style="width:20%;">BMI</th><td style="width:30%;">${met.bmi || '--'}</td>
        </tr>
        <tr>
            <th>Body Fat %</th><td>${met.bodyFat ? met.bodyFat + '%' : '--'}</td>
            <th>Blood Pressure</th><td>${met.bloodPressure || '--'} mmHg</td>
        </tr>
        <tr>
            <th>Blood Sugar</th><td>${met.bloodSugar || '--'} mg/dL</td>
            <th>Resting Heart Rate</th><td>${met.heartRate || '--'} bpm</td>
        </tr>
        <tr>
            <th>Stress Rating</th><td>${met.stress ? met.stress + '/10' : '--'}</td>
            <th>Energy Rating</th><td>${met.energy ? met.energy + '/10' : '--'}</td>
        </tr>
        <tr>
            <th>Outdoor / Sun</th><td>${met.outdoorTime || log.outdoorTime || '--'}m / ${met.sunlight || log.sunlight || '--'}m</td>
            <th>Meditation / Screen</th><td>${met.meditation || log.meditation || '--'}m / ${met.screenTime || log.screenTime || '--'}h</td>
        </tr>
    </table>

    <div class="section-title">2. Sleep & Circadian Alignment</div>
    <div class="content-box">
        <h4>Hours & Sleep Quality</h4>
        <p>${analyses.sleep?.desc || 'Sleep consistency is optimal.'}</p>
    </div>
    <div class="content-box">
        <h4>Recovery Score & Bedtime Targets</h4>
        <p>${analyses.sleep?.rec || 'Maintain bedtime alignment.'}</p>
    </div>

    <div class="section-title">3. Hydration & Daily Meals</div>
    <div class="content-box">
        <h4>Hydration Target</h4>
        <p>${analyses.water?.desc || 'Hydration volume is sufficient.'} ${analyses.water?.tips || ''}</p>
    </div>
    <table class="table">
        <thead>
            <tr><th colspan="2">Daily Meals Logged</th></tr>
        </thead>
        <tbody>
            ${mealsSummaryHtml}
        </tbody>
    </table>

    <div class="section-title">4. Physical Activity & Daily Steps</div>
    <div class="content-box">
        <h4>Exercise Performance</h4>
        <p>${analyses.fitness?.desc || 'Physical activity tracked.'}</p>
    </div>
    <div class="content-box">
        <h4>Steps & Consistency</h4>
        <p>${analyses.fitness?.steps || 'Daily steps logged.'}</p>
    </div>

    <div class="section-title">5. Holistic Journaling & Reflections</div>
    <div class="content-box">
        <h4>Daily Affirmations</h4>
        <p>${log.affirmations ? (Array.isArray(log.affirmations) ? log.affirmations.join('; ') : log.affirmations) : 'None logged'}</p>
    </div>
    <div class="content-box">
        <h4>Personal Reflections & Evening Gratitude</h4>
        <p>${log.reflections ? (Array.isArray(log.reflections) ? log.reflections.join('; ') : log.reflections) : 'None logged'}</p>
    </div>

    <div class="section-title">6. Coach Frannie's Recommendations & 24h Action Plan</div>
    <div class="content-box" style="border-left-color: #a5e332; background: #fafdf7;">
        <h4>Motivational Summary</h4>
        <p>${analyses.motivate || 'Keep executing on your daily targets!'}</p>
    </div>

    <div class="footer">
        <div>Verified by LeanLife Medical & Coaching Board</div>
        <div>Confidential Health Document • Generated on ${new Date().toLocaleDateString()}</div>
    </div>
</div>`;

        // Generate PDF using html2pdf if available, else open print view
        if (window.html2pdf) {
            const container = document.createElement('div');
            container.id = 'pdf-render-report-temp';
            container.style.position = 'fixed';
            container.style.top = '0';
            container.style.left = '0';
            container.style.width = '750px';
            container.style.maxWidth = '750px';
            container.style.margin = '0';
            container.style.padding = '0';
            container.style.backgroundColor = '#ffffff';
            container.style.color = '#1a202c';
            container.style.zIndex = '99999';
            container.style.opacity = '1';
            container.style.pointerEvents = 'none';
            container.innerHTML = pdfHtml;
            document.body.appendChild(container);

            const opt = {
                margin: [8, 8, 8, 8],
                filename: `LeanLife_Wellness_Report_${memberName.replace(/\s+/g, '_')}_${report.id || Date.now()}.pdf`,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { 
                    scale: 2, 
                    useCORS: true,
                    scrollX: 0,
                    scrollY: 0,
                    x: 0,
                    y: 0,
                    width: 750,
                    windowWidth: 750,
                    backgroundColor: '#ffffff'
                },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
                pagebreak: { mode: ['css', 'legacy'] }
            };

            const targetElement = container.querySelector('#pdf-report-content') || container;
            window.html2pdf().set(opt).from(targetElement).save()
                .then(() => {
                    container.remove();
                })
                .catch(err => {
                    console.warn("html2pdf notice, falling back to print dialog:", err);
                    container.remove();
                    this.openPrintFallbackWindow(pdfHtml, `LeanLife_Wellness_Report_${report.id || Date.now()}`);
                });
        } else {
            this.openPrintFallbackWindow(pdfHtml, `LeanLife_Wellness_Report_${report.id || Date.now()}`);
        }
    },

    openPrintFallbackWindow(htmlContent, fileName) {
        const printWindow = window.open('', '_blank');
        if (printWindow) {
            printWindow.document.open();
            printWindow.document.write(htmlContent);
            printWindow.document.close();
            setTimeout(() => {
                try { printWindow.print(); } catch(e) {}
            }, 500);
        } else {
            const blob = new Blob([htmlContent], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${fileName}.html`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        }
    },

    downloadLogsPDF(logId = null) {
        let logsToExport = this.db.wellnessLogs || [];
        if (logId) {
            logsToExport = logsToExport.filter(l => l.id === logId);
        }
        if (logsToExport.length === 0) {
            alert("No wellness logs available to export.");
            return;
        }

        let logsHtmlRows = '';
        logsToExport.forEach((l, idx) => {
            const met = l.metrics || {};
            const sleepDur = typeof l.sleep === 'object' ? (l.sleep.duration || '--') : (l.sleep || '--');
            const sleepQual = typeof l.sleep === 'object' ? (l.sleep.quality || '--') : '--';
            const exType = l.exercise?.type || (l.exerciseCompleted === 'yes' ? 'Exercise' : 'None');
            const exDur = l.exercise?.duration || 0;
            const photoCount = (l.photos && l.photos.length) || (l.photoUrl ? 1 : 0);

            logsHtmlRows += `
                <tr style="background: ${idx % 2 === 0 ? '#ffffff' : '#f8fafc'}; page-break-inside: avoid; -webkit-column-break-inside: avoid;">
                    <td style="padding:8px; border:1px solid #e2e8f0; color:#1a202c;">${l.timestamp ? new Date(l.timestamp).toLocaleDateString() : (l.date || '--')}</td>
                    <td style="padding:8px; border:1px solid #e2e8f0; font-weight:600; color:#1a202c;">${l.userEmail || l.user_email || '--'}</td>
                    <td style="padding:8px; border:1px solid #e2e8f0; color:#1a202c;">${sleepDur}h (${sleepQual})</td>
                    <td style="padding:8px; border:1px solid #e2e8f0; color:#1a202c;">${l.waterCount || 0} drops (${((l.waterCount || 0) * 8.45).toFixed(0)} oz)</td>
                    <td style="padding:8px; border:1px solid #e2e8f0; color:#1a202c;">${(l.steps || 0).toLocaleString()}</td>
                    <td style="padding:8px; border:1px solid #e2e8f0; text-transform:capitalize; color:#1a202c;">${l.mood || 'Neutral'}</td>
                    <td style="padding:8px; border:1px solid #e2e8f0; color:#1a202c;">${exType} (${exDur}m)</td>
                    <td style="padding:8px; border:1px solid #e2e8f0; color:#1a202c;">${met.bloodPressure || '--'} | ${met.bloodSugar ? met.bloodSugar + ' mg' : '--'}</td>
                    <td style="padding:8px; border:1px solid #e2e8f0; color:#1a202c;">${photoCount > 0 ? `Yes (${photoCount})` : 'None'}</td>
                </tr>
            `;
        });

        const pdfHtml = `
<div id="pdf-logs-content" style="width: 1050px; max-width: 1050px; margin: 0; padding: 14px; background: #ffffff; color: #1a202c; font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; box-sizing: border-box; font-size: 10px;">
    <style>
        #pdf-logs-content * { box-sizing: border-box; }
        #pdf-logs-content .header { border-bottom: 2px solid #12826d; padding-bottom: 10px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; page-break-inside: avoid; break-inside: avoid; }
        #pdf-logs-content .table { width: 100%; border-collapse: collapse; font-size: 9.5px; background: #ffffff; color: #1a202c; table-layout: fixed; }
        #pdf-logs-content .table th { background: #12826d !important; color: #ffffff !important; padding: 6px 8px; text-align: left; border: 1px solid #12826d; font-weight: bold; }
        #pdf-logs-content .table td { padding: 6px 8px; border: 1px solid #e2e8f0; color: #1a202c; word-break: break-word; overflow-wrap: break-word; }
        #pdf-logs-content tr { page-break-inside: avoid; break-inside: avoid; }
    </style>
    <div class="header">
        <div>
            <h2 style="margin:0; color:#12826d; font-size:16px;">🌿 LeanLife Wellness Logs Submissions</h2>
            <div style="font-size:10px; color:#666;">Generated on ${new Date().toLocaleString()} • Total Records: ${logsToExport.length}</div>
        </div>
        <div style="font-weight:bold; color:#12826d; font-size:11px;">ADMIN AUDIT EXPORT</div>
    </div>
    <table class="table">
        <thead>
            <tr>
                <th style="width:10%;">Date</th>
                <th style="width:18%;">Member Email</th>
                <th style="width:10%;">Sleep</th>
                <th style="width:12%;">Hydration</th>
                <th style="width:10%;">Steps</th>
                <th style="width:8%;">Mood</th>
                <th style="width:12%;">Exercise</th>
                <th style="width:12%;">Vitals (BP | Sugar)</th>
                <th style="width:8%;">Photos</th>
            </tr>
        </thead>
        <tbody>
            ${logsHtmlRows}
        </tbody>
    </table>
</div>`;

        if (window.html2pdf) {
            const container = document.createElement('div');
            container.id = 'pdf-render-logs-temp';
            container.style.position = 'fixed';
            container.style.top = '0';
            container.style.left = '0';
            container.style.width = '1050px';
            container.style.maxWidth = '1050px';
            container.style.margin = '0';
            container.style.padding = '0';
            container.style.backgroundColor = '#ffffff';
            container.style.color = '#1a202c';
            container.style.zIndex = '99999';
            container.style.opacity = '1';
            container.style.pointerEvents = 'none';
            container.innerHTML = pdfHtml;
            document.body.appendChild(container);

            const opt = {
                margin: [8, 8, 8, 8],
                filename: `LeanLife_Wellness_Logs_${logId ? logId : 'Export'}_${Date.now()}.pdf`,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { 
                    scale: 2, 
                    useCORS: true,
                    scrollX: 0,
                    scrollY: 0,
                    x: 0,
                    y: 0,
                    width: 1050,
                    windowWidth: 1050,
                    backgroundColor: '#ffffff'
                },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' },
                pagebreak: { mode: ['css', 'legacy'] }
            };

            const targetElement = container.querySelector('#pdf-logs-content') || container;
            window.html2pdf().set(opt).from(targetElement).save()
                .then(() => container.remove())
                .catch(err => {
                    container.remove();
                    this.openPrintFallbackWindow(pdfHtml, `LeanLife_Wellness_Logs_Export`);
                });
        } else {
            this.openPrintFallbackWindow(pdfHtml, `LeanLife_Wellness_Logs_Export`);
        }
    },

    downloadLogPDF(logId) {
        this.downloadLogsPDF(logId);
    },

    // ==================== CUMULATIVE MONTHLY REPORTS ENGINE ====================
    getAvailableMonthlyCycles(userEmail = null) {
        const email = (userEmail || (this.currentUser ? this.currentUser.email : '')).toLowerCase().trim();
        const logs = (this.db && this.db.wellnessLogs ? this.db.wellnessLogs : []).filter(l => {
            const lEmail = (l.userEmail || l.user_email || l.email || '').toLowerCase().trim();
            return lEmail === email;
        });

        const cycles = new Set();
        const now = new Date();
        const currentCycle = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        cycles.add(currentCycle);

        logs.forEach(l => {
            const ts = l.timestamp || l.created_at || l.date;
            if (ts) {
                const d = new Date(ts);
                if (!isNaN(d.getTime())) {
                    cycles.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
                }
            }
        });

        return Array.from(cycles).sort().reverse();
    },

    calculateMonthlyAggregateData(userEmail = null, monthCycle = null) {
        const email = (userEmail || (this.currentUser ? this.currentUser.email : '')).toLowerCase().trim();
        const now = new Date();
        const activeCycle = monthCycle || this.selectedMonthlyReportCycle || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const [yearStr, monthStr] = activeCycle.split('-');
        const targetYear = parseInt(yearStr, 10);
        const targetMonth = parseInt(monthStr, 10) - 1; // 0-indexed

        const daysInMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
        const monthDateObj = new Date(targetYear, targetMonth, 1);
        const monthName = monthDateObj.toLocaleString('default', { month: 'long', year: 'numeric' });

        const userLogs = (this.db && this.db.wellnessLogs ? this.db.wellnessLogs : []).filter(l => {
            const lEmail = (l.userEmail || l.user_email || l.email || '').toLowerCase().trim();
            if (lEmail !== email) return false;
            const ts = l.timestamp || l.created_at || l.date;
            if (!ts) return false;
            const d = new Date(ts);
            if (isNaN(d.getTime())) return false;
            return d.getFullYear() === targetYear && d.getMonth() === targetMonth;
        }).sort((a, b) => new Date(a.timestamp || a.date) - new Date(b.timestamp || b.date));

        const daysLoggedCount = userLogs.length;
        const consistencyPct = Math.min(100, Math.round((daysLoggedCount / (daysInMonth || 30)) * 100));

        let totalSleep = 0;
        let restfulSleepCount = 0;
        let totalWaterGlasses = 0;
        let totalSteps = 0;
        let totalCalories = 0;
        let workoutSessionsCount = 0;
        let fastingCompletedCount = 0;
        let totalSystolic = 0;
        let totalDiastolic = 0;
        let bpCount = 0;
        let totalSugar = 0;
        let sugarCount = 0;
        let totalHeartRate = 0;
        let hrCount = 0;
        let totalStress = 0;
        let totalEnergy = 0;
        let stressEnergyCount = 0;
        let totalBodyFat = 0;
        let bodyFatCount = 0;

        const weightsLogged = [];
        const moodCounts = { happy: 0, calm: 0, energetic: 0, tired: 0, stressed: 0 };

        userLogs.forEach(l => {
            // Sleep
            const sDur = parseFloat(l.sleep && typeof l.sleep === 'object' ? l.sleep.duration : l.sleep) || 8.0;
            totalSleep += sDur;
            const sQual = (l.sleep && typeof l.sleep === 'object' && l.sleep.quality) ? l.sleep.quality : 'Restful';
            if (sQual.toLowerCase().includes('restful') || sQual.toLowerCase().includes('deep')) restfulSleepCount++;

            // Hydration
            const wGlasses = parseInt(l.waterCount, 10) || 8;
            totalWaterGlasses += wGlasses;

            // Steps
            const stp = parseInt(l.steps, 10) || 0;
            totalSteps += stp;

            // Workouts & Calories
            const isEx = l.exerciseCompleted === 'yes' || (l.exercise && l.exercise.completed === 'yes');
            if (isEx) {
                workoutSessionsCount++;
                const dur = parseFloat(l.exercise?.duration) || 30;
                totalCalories += Math.round(dur * 8.5);
            }

            // Fasting
            const isFast = l.fastingCompleted === 'yes' || (l.fasting && l.fasting.completed === 'yes');
            if (isFast) fastingCompletedCount++;

            // Vitals
            const metrics = l.metrics || {};
            const bp = metrics.bloodPressure || l.bloodPressure;
            if (bp && bp.includes('/')) {
                const [sys, dia] = bp.split('/').map(n => parseInt(n.trim(), 10));
                if (sys && dia) {
                    totalSystolic += sys;
                    totalDiastolic += dia;
                    bpCount++;
                }
            }

            const sugar = parseFloat(metrics.bloodSugar || l.bloodSugar);
            if (sugar) {
                totalSugar += sugar;
                sugarCount++;
            }

            const hr = parseFloat(metrics.heartRate || l.heartRate);
            if (hr) {
                totalHeartRate += hr;
                hrCount++;
            }

            const stress = parseFloat(metrics.stressLevel || l.stressLevel);
            const energy = parseFloat(metrics.energyLevel || l.energyLevel);
            if (stress || energy) {
                totalStress += (stress || 5);
                totalEnergy += (energy || 7);
                stressEnergyCount++;
            }

            const bf = parseFloat(metrics.bodyFat || l.bodyFat);
            if (bf) {
                totalBodyFat += bf;
                bodyFatCount++;
            }

            const w = parseFloat(metrics.weight || l.weight);
            if (w) weightsLogged.push(w);

            const m = (l.mood || 'happy').toLowerCase();
            if (moodCounts[m] !== undefined) moodCounts[m]++;
            else moodCounts.happy++;
        });

        const divisor = daysLoggedCount || 1;
        const avgSleep = (totalSleep / divisor).toFixed(1);
        const restfulPct = Math.round((restfulSleepCount / divisor) * 100);
        const avgWater = (totalWaterGlasses / divisor).toFixed(1);
        const totalWaterOz = totalWaterGlasses * 8;
        const avgSteps = Math.round(totalSteps / divisor);
        const fastingRate = Math.round((fastingCompletedCount / divisor) * 100);

        const avgBP = bpCount > 0 ? `${Math.round(totalSystolic / bpCount)} / ${Math.round(totalDiastolic / bpCount)}` : '118 / 78';
        const avgBloodSugar = sugarCount > 0 ? Math.round(totalSugar / sugarCount) : '92';
        const avgHeartRate = hrCount > 0 ? Math.round(totalHeartRate / hrCount) : '68';
        const avgStress = stressEnergyCount > 0 ? (totalStress / stressEnergyCount).toFixed(1) : '3.5';
        const avgEnergy = stressEnergyCount > 0 ? (totalEnergy / stressEnergyCount).toFixed(1) : '8.2';
        const avgBodyFat = bodyFatCount > 0 ? (totalBodyFat / bodyFatCount).toFixed(1) : '19.5';

        // Weight progression
        const userObj = this.currentUser || {};
        const profileWeight = parseFloat(userObj.weight) || 155.4;
        const startWeight = weightsLogged.length > 0 ? weightsLogged[0] : profileWeight;
        const endWeight = weightsLogged.length > 0 ? weightsLogged[weightsLogged.length - 1] : profileWeight;
        const weightDelta = (endWeight - startWeight).toFixed(1);

        const heightInches = ((userObj.height || 170) / 2.54);
        const avgBMI = ((endWeight / (heightInches * heightInches)) * 703).toFixed(1);

        let overallScore = 85;
        if (consistencyPct >= 90) overallScore += 10;
        else if (consistencyPct >= 70) overallScore += 5;
        if (avgSteps >= 8000) overallScore += 3;
        overallScore = Math.min(99, overallScore);

        let grade = 'A+';
        if (overallScore < 80) grade = 'B';
        else if (overallScore < 90) grade = 'A-';
        else if (overallScore < 95) grade = 'A';

        return {
            monthCycle: activeCycle,
            monthName,
            targetYear,
            targetMonth,
            daysInMonth,
            daysLoggedCount,
            consistencyPct,
            userLogs,
            avgSleep,
            restfulPct,
            totalWaterGlasses,
            totalWaterOz,
            avgWater,
            totalSteps,
            avgSteps,
            totalCalories,
            workoutSessionsCount,
            fastingCompletedCount,
            fastingRate,
            avgBP,
            avgBloodSugar,
            avgHeartRate,
            avgStress,
            avgEnergy,
            avgBodyFat,
            startWeight,
            endWeight,
            weightDelta,
            avgBMI,
            overallScore,
            grade,
            moodCounts
        };
    },

    renderMonthlyReportView(selectedMonthCycle = null) {
        if (!this.currentUser) return;
        const userEmail = this.currentUser.email;
        const cycles = this.getAvailableMonthlyCycles(userEmail);
        
        if (selectedMonthCycle && cycles.includes(selectedMonthCycle)) {
            this.selectedMonthlyReportCycle = selectedMonthCycle;
        } else if (!this.selectedMonthlyReportCycle || !cycles.includes(this.selectedMonthlyReportCycle)) {
            this.selectedMonthlyReportCycle = cycles[0];
        }

        const selectEl = document.getElementById('monthly-report-select');
        if (selectEl) {
            selectEl.innerHTML = cycles.map(c => {
                const [y, m] = c.split('-');
                const dObj = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1);
                const label = dObj.toLocaleString('default', { month: 'long', year: 'numeric' });
                return `<option value="${c}" ${c === this.selectedMonthlyReportCycle ? 'selected' : ''}>${label}</option>`;
            }).join('');
        }

        const data = this.calculateMonthlyAggregateData(userEmail, this.selectedMonthlyReportCycle);

        // Member name
        const memberNameEl = document.getElementById('monthly-report-member-name');
        if (memberNameEl) memberNameEl.textContent = this.currentUser.name;

        // Top gauges
        const gaugeEl = document.getElementById('monthly-gauge-overall');
        if (gaugeEl) gaugeEl.style.background = `conic-gradient(var(--clr-accent-green) 0% ${data.overallScore}%, #eee ${data.overallScore}% 100%)`;
        const valOverallEl = document.getElementById('monthly-val-overall');
        if (valOverallEl) valOverallEl.textContent = data.overallScore;
        const gradeEl = document.getElementById('monthly-grade-val');
        if (gradeEl) gradeEl.textContent = `Grade: ${data.grade}`;

        // Top cards
        const daysLoggedEl = document.getElementById('monthly-val-days-logged');
        if (daysLoggedEl) daysLoggedEl.textContent = `${data.daysLoggedCount} / ${data.daysInMonth}`;
        const consistencyEl = document.getElementById('monthly-val-consistency-pct');
        if (consistencyEl) consistencyEl.textContent = `${data.consistencyPct}% Consistency`;

        const avgSleepEl = document.getElementById('monthly-val-avg-sleep');
        if (avgSleepEl) avgSleepEl.textContent = `${data.avgSleep} hrs`;
        const sleepQualityEl = document.getElementById('monthly-val-sleep-quality');
        if (sleepQualityEl) sleepQualityEl.textContent = `${data.restfulPct}% Restful`;

        const totalWaterEl = document.getElementById('monthly-val-total-water');
        if (totalWaterEl) totalWaterEl.textContent = `${data.totalWaterGlasses} gl (${data.totalWaterOz} oz)`;
        const avgWaterEl = document.getElementById('monthly-val-avg-water');
        if (avgWaterEl) avgWaterEl.textContent = `${data.avgWater} gl / day avg`;

        // Movement & activity cards
        const totalStepsEl = document.getElementById('monthly-val-total-steps');
        if (totalStepsEl) totalStepsEl.textContent = data.totalSteps.toLocaleString();
        const avgStepsEl = document.getElementById('monthly-val-avg-steps');
        if (avgStepsEl) avgStepsEl.textContent = `Avg: ${data.avgSteps.toLocaleString()} / day`;

        const totalCaloriesEl = document.getElementById('monthly-val-total-calories');
        if (totalCaloriesEl) totalCaloriesEl.textContent = `${data.totalCalories.toLocaleString()} kcal`;
        const workoutsCountEl = document.getElementById('monthly-val-workouts-count');
        if (workoutsCountEl) workoutsCountEl.textContent = `${data.workoutSessionsCount} Workouts Logged`;

        const weightTrendEl = document.getElementById('monthly-val-weight-trend');
        if (weightTrendEl) weightTrendEl.textContent = `${data.endWeight} lbs`;
        const weightDeltaEl = document.getElementById('monthly-val-weight-delta');
        if (weightDeltaEl) {
            const deltaNum = parseFloat(data.weightDelta);
            const sign = deltaNum > 0 ? '+' : '';
            weightDeltaEl.textContent = `Net Change: ${sign}${data.weightDelta} lbs (${data.startWeight} → ${data.endWeight})`;
            weightDeltaEl.style.color = deltaNum <= 0 ? 'var(--clr-primary-green)' : '#e67e22';
        }

        const fastingDaysEl = document.getElementById('monthly-val-fasting-days');
        if (fastingDaysEl) fastingDaysEl.textContent = `${data.fastingCompletedCount} Days`;
        const fastingRateEl = document.getElementById('monthly-val-fasting-rate');
        if (fastingRateEl) fastingRateEl.textContent = `${data.fastingRate}% Adherence`;

        // Vitals
        const bmiEl = document.getElementById('monthly-metric-bmi');
        if (bmiEl) bmiEl.textContent = data.avgBMI;
        const bfEl = document.getElementById('monthly-metric-bodyfat');
        if (bfEl) bfEl.textContent = `${data.avgBodyFat}%`;
        const bpEl = document.getElementById('monthly-metric-bp');
        if (bpEl) bpEl.textContent = data.avgBP;
        const sugarEl = document.getElementById('monthly-metric-bloodsugar');
        if (sugarEl) sugarEl.textContent = data.avgBloodSugar;
        const hrEl = document.getElementById('monthly-metric-heartrate');
        if (hrEl) hrEl.textContent = data.avgHeartRate;
        const seEl = document.getElementById('monthly-metric-stress-energy');
        if (seEl) seEl.textContent = `${data.avgStress} / ${data.avgEnergy}`;

        // AI Synthesis
        const execReviewEl = document.getElementById('monthly-ai-executive-review');
        if (execReviewEl) {
            execReviewEl.textContent = `During ${data.monthName}, ${this.currentUser.name} completed ${data.daysLoggedCount} wellness submissions with a ${data.consistencyPct}% consistency rating. Your cumulative activity totaled ${data.totalSteps.toLocaleString()} steps and ${data.workoutSessionsCount} exercise sessions, maintaining an exceptional ${data.grade} monthly health score.`;
        }

        const circInsightsEl = document.getElementById('monthly-ai-circadian-insights');
        if (circInsightsEl) {
            circInsightsEl.textContent = `Average sleep duration of ${data.avgSleep} hours with ${data.restfulPct}% restorative sleep quality demonstrates synchronized biological clocks. Total hydration of ${data.totalWaterOz.toLocaleString()} oz (${data.totalWaterGlasses} glasses) supported high cellular repair and digestive balance.`;
        }

        // Assigned coach on card
        const coachName = 'Coach Francess Orenuga';
        const coachAvatar = 'assets/coach_francess.png';
        const cardCoachName = document.getElementById('monthly-card-coach-name');
        if (cardCoachName) cardCoachName.textContent = coachName;
        const cardCoachAvatar = document.getElementById('monthly-card-coach-avatar');
        if (cardCoachAvatar) cardCoachAvatar.src = coachAvatar;

        // Daily Logs Table
        const tbody = document.getElementById('monthly-logs-tbody');
        const countEl = document.getElementById('monthly-table-count');
        if (countEl) countEl.textContent = data.userLogs.length;

        if (tbody) {
            if (data.userLogs.length === 0) {
                tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 2rem; color: #888;">No daily wellness logs recorded for ${data.monthName}.</td></tr>`;
            } else {
                let html = '';
                data.userLogs.forEach(r => {
                    const sleepDuration = (r.sleep && typeof r.sleep === 'object' ? r.sleep.duration : r.sleep) || '8.0';
                    const sleepQuality = (r.sleep && typeof r.sleep === 'object' && r.sleep.quality) ? r.sleep.quality : 'Restful';
                    const waterGlasses = r.waterCount || 8;
                    const steps = r.steps || 0;
                    const mood = r.mood || 'happy';
                    const isExercise = r.exerciseCompleted === 'yes' || r.exercise?.completed === 'yes';
                    const weightVal = r.metrics?.weight || r.weight || data.endWeight;

                    html += `
                        <tr>
                            <td style="font-weight:600;">${new Date(r.timestamp || r.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                            <td>${sleepDuration}h (${sleepQuality})</td>
                            <td>${waterGlasses * 8} oz (${waterGlasses} gl)</td>
                            <td>${steps.toLocaleString()}</td>
                            <td><span style="text-transform: capitalize;">${mood}</span></td>
                            <td>${isExercise ? (r.exercise?.type || 'Workout') : 'None'}</td>
                            <td>${weightVal} lbs</td>
                            <td>
                                <button class="btn btn-secondary" style="padding:0.2rem 0.5rem; font-size:0.75rem;" onclick="app.openAdminLogDetails('${r.id}')"><i class="fa-solid fa-eye"></i> View</button>
                            </td>
                        </tr>
                    `;
                });
                tbody.innerHTML = html;
            }
        }
    },

    handleMonthlyReportMonthChange(e) {
        const val = e.target.value;
        this.selectedMonthlyReportCycle = val;
        this.renderMonthlyReportView(val);
    },

    downloadMonthlyReportPDF(monthCycle = null) {
        if (!this.currentUser) return;
        const userEmail = this.currentUser.email;
        const data = this.calculateMonthlyAggregateData(userEmail, monthCycle || this.selectedMonthlyReportCycle);
        const memberName = this.currentUser.name || 'Member';

        const rowsHtml = data.userLogs.map(l => {
            const d = new Date(l.timestamp || l.date).toLocaleDateString();
            const s = (l.sleep && typeof l.sleep === 'object' ? l.sleep.duration : l.sleep) || '8.0';
            const w = (l.waterCount || 8) * 8;
            const st = (l.steps || 0).toLocaleString();
            const m = l.mood || 'happy';
            const ex = l.exerciseCompleted === 'yes' || l.exercise?.completed === 'yes' ? (l.exercise?.type || 'Yes') : 'No';
            return `
                <tr style="page-break-inside: avoid; break-inside: avoid;">
                    <td style="padding: 5px 6px; border: 1px solid #e2e8f0; font-size: 10px;">${d}</td>
                    <td style="padding: 5px 6px; border: 1px solid #e2e8f0; font-size: 10px;">${s} hrs</td>
                    <td style="padding: 5px 6px; border: 1px solid #e2e8f0; font-size: 10px;">${w} oz</td>
                    <td style="padding: 5px 6px; border: 1px solid #e2e8f0; font-size: 10px;">${st}</td>
                    <td style="padding: 5px 6px; border: 1px solid #e2e8f0; font-size: 10px; text-transform: capitalize;">${m}</td>
                    <td style="padding: 5px 6px; border: 1px solid #e2e8f0; font-size: 10px;">${ex}</td>
                </tr>
            `;
        }).join('') || `<tr><td colspan="6" style="padding: 10px; text-align: center; color: #888;">No daily records found for this period.</td></tr>`;

        const pdfHtml = `
<div id="pdf-monthly-report-content" style="width: 750px; max-width: 750px; margin: 0; padding: 14px; background: #ffffff; color: #2d3748; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; box-sizing: border-box; font-size: 11px; line-height: 1.4;">
    <style>
        #pdf-monthly-report-content * { box-sizing: border-box; }
        #pdf-monthly-report-content .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #12826D; padding-bottom: 10px; margin-bottom: 12px; page-break-inside: avoid; break-inside: avoid; }
        #pdf-monthly-report-content .brand { font-size: 19px; font-weight: bold; color: #12826D; }
        #pdf-monthly-report-content .grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 12px; page-break-inside: avoid; break-inside: avoid; }
        #pdf-monthly-report-content .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px; text-align: center; page-break-inside: avoid; break-inside: avoid; }
        #pdf-monthly-report-content .card-val { font-size: 15px; font-weight: bold; color: #12826D; margin: 3px 0; }
        #pdf-monthly-report-content .card-lbl { font-size: 8.5px; text-transform: uppercase; color: #718096; font-weight: 700; }
        #pdf-monthly-report-content .section-title { font-size: 11.5px; font-weight: bold; color: #12826D; border-bottom: 1.5px solid #a5e332; padding-bottom: 3px; margin-top: 12px; margin-bottom: 6px; text-transform: uppercase; page-break-inside: avoid; break-inside: avoid; }
        #pdf-monthly-report-content .synth-box { background: #f0fdf4; border-left: 3.5px solid #12826D; padding: 8px 10px; margin-bottom: 12px; border-radius: 4px; font-size: 10.5px; line-height: 1.4; page-break-inside: avoid; break-inside: avoid; }
        #pdf-monthly-report-content table { width: 100%; border-collapse: collapse; margin-top: 6px; table-layout: fixed; page-break-inside: avoid; break-inside: avoid; }
        #pdf-monthly-report-content th { background: #12826D; color: white; text-align: left; padding: 5px 6px; font-size: 9.5px; text-transform: uppercase; }
        #pdf-monthly-report-content tr { page-break-inside: avoid; break-inside: avoid; }
        #pdf-monthly-report-content .footer { margin-top: 16px; font-size: 9px; color: #a0aec0; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 6px; page-break-inside: avoid; break-inside: avoid; }
    </style>
    
    <div class="header">
        <div>
            <div class="brand">🌱 LeanLife Health & Wellness</div>
            <div style="font-size: 10.5px; color: #718096;">Monthly Cumulative Progress & Clinical Vitals Report</div>
        </div>
        <div style="text-align: right;">
            <div style="font-size: 14px; font-weight: bold; color: #2d3748;">${data.monthName}</div>
            <div style="font-size: 10px; color: #718096;">Member: <strong>${memberName}</strong> (${userEmail})</div>
        </div>
    </div>

    <div class="grid-4">
        <div class="card">
            <div class="card-lbl">Monthly Score</div>
            <div class="card-val">${data.overallScore} / 100</div>
            <div style="font-size: 9.5px; color: #28a745; font-weight: bold;">Grade: ${data.grade}</div>
        </div>
        <div class="card">
            <div class="card-lbl">Consistency</div>
            <div class="card-val">${data.daysLoggedCount} / ${data.daysInMonth} Days</div>
            <div style="font-size: 9.5px; color: #12826D;">${data.consistencyPct}% Adherence</div>
        </div>
        <div class="card">
            <div class="card-lbl">Avg Sleep</div>
            <div class="card-val">${data.avgSleep} hrs</div>
            <div style="font-size: 9.5px; color: #673ab7;">${data.restfulPct}% Restful</div>
        </div>
        <div class="card">
            <div class="card-lbl">Hydration Consumed</div>
            <div class="card-val">${data.totalWaterGlasses} gl</div>
            <div style="font-size: 9.5px; color: #2196f3;">${data.totalWaterOz.toLocaleString()} oz total</div>
        </div>
    </div>

    <div class="grid-4">
        <div class="card">
            <div class="card-lbl">Total Steps</div>
            <div class="card-val">${data.totalSteps.toLocaleString()}</div>
            <div style="font-size: 9.5px; color: #8bc34a;">Avg: ${data.avgSteps.toLocaleString()} / day</div>
        </div>
        <div class="card">
            <div class="card-lbl">Calories Burned</div>
            <div class="card-val">${data.totalCalories.toLocaleString()} kcal</div>
            <div style="font-size: 9.5px; color: #e91e63;">${data.workoutSessionsCount} Workouts</div>
        </div>
        <div class="card">
            <div class="card-lbl">Weight Trend</div>
            <div class="card-val">${data.endWeight} lbs</div>
            <div style="font-size: 9.5px; color: #12826D;">Change: ${data.weightDelta} lbs</div>
        </div>
        <div class="card">
            <div class="card-lbl">Vitals Average</div>
            <div class="card-val">${data.avgBP}</div>
            <div style="font-size: 9.5px; color: #718096;">Sugar: ${data.avgBloodSugar} mg • HR: ${data.avgHeartRate}</div>
        </div>
    </div>

    <div class="section-title">Coach Frannie's Monthly Clinical Synthesis</div>
    <div class="synth-box">
        <p style="margin-top: 0; margin-bottom: 4px;"><strong>Executive Review:</strong> During ${data.monthName}, ${memberName} demonstrated steady habit alignment across core health pillars. With a ${data.consistencyPct}% logging rate and cumulative physical activity of ${data.totalSteps.toLocaleString()} steps, structural health resilience is actively improving.</p>
        <p style="margin-bottom: 0;"><strong>Recommendations for Next Month:</strong> Sustain target daily water intake (8+ glasses), maintain circadian bedtime alignment before 10:30 PM, and integrate scheduled post-workout recovery routines.</p>
    </div>

    <div class="section-title">Daily Submissions Log (${data.userLogs.length} Records)</div>
    <table>
        <thead>
            <tr>
                <th style="width:18%;">Date</th>
                <th style="width:16%;">Sleep Duration</th>
                <th style="width:16%;">Hydration</th>
                <th style="width:16%;">Steps Walked</th>
                <th style="width:16%;">Mood State</th>
                <th style="width:18%;">Workout Completed</th>
            </tr>
        </thead>
        <tbody>
            ${rowsHtml}
        </tbody>
    </table>

    <div class="footer">
        LeanLife Wellness Center &bull; Generated on ${new Date().toLocaleString()} &bull; Confidential Healthcare Document
    </div>
</div>`;

        if (window.html2pdf) {
            const container = document.createElement('div');
            container.id = 'pdf-render-monthly-temp';
            container.style.position = 'fixed';
            container.style.top = '0';
            container.style.left = '0';
            container.style.width = '750px';
            container.style.maxWidth = '750px';
            container.style.margin = '0';
            container.style.padding = '0';
            container.style.backgroundColor = '#ffffff';
            container.style.color = '#1a202c';
            container.style.zIndex = '99999';
            container.style.opacity = '1';
            container.style.pointerEvents = 'none';
            container.innerHTML = pdfHtml;
            document.body.appendChild(container);

            const opt = {
                margin: [8, 8, 8, 8],
                filename: `LeanLife_Monthly_Report_${memberName.replace(/\s+/g, '_')}_${data.monthCycle}.pdf`,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { 
                    scale: 2, 
                    useCORS: true,
                    scrollX: 0,
                    scrollY: 0,
                    x: 0,
                    y: 0,
                    width: 750,
                    windowWidth: 750,
                    backgroundColor: '#ffffff'
                },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
                pagebreak: { mode: ['css', 'legacy'] }
            };

            const targetElement = container.querySelector('#pdf-monthly-report-content') || container;
            window.html2pdf().set(opt).from(targetElement).save()
                .then(() => container.remove())
                .catch(err => {
                    console.warn("html2pdf notice, fallback:", err);
                    container.remove();
                    this.openPrintFallbackWindow(pdfHtml, `LeanLife_Monthly_Report_${data.monthCycle}`);
                });
        } else {
            this.openPrintFallbackWindow(pdfHtml, `LeanLife_Monthly_Report_${data.monthCycle}`);
        }
    },

    // Canonical Coach Resolution Helper
    getAssignedCoach(user = null) {
        const u = user || this.currentUser;
        return {
            key: 'sarah',
            name: 'Coach Francess Orenuga',
            shortName: 'Coach Frannie',
            email: 'francessronke21@gmail.com',
            phone: '17575130205',
            formattedPhone: '+1 (757) 513-0205',
            spec: 'Lifestyle Medicine & Metabolic Restoration Coach',
            avatar: 'assets/coach_francess.png'
        };
    },

    // Canonical Coach WhatsApp URL Generator
    getCoachWhatsAppUrl(coachOrUser = null, monthlyReportContext = null) {
        let coach = null;
        if (coachOrUser && coachOrUser.phone) {
            coach = coachOrUser;
        } else {
            coach = this.getAssignedCoach(coachOrUser);
        }
        const cleanPhone = String(coach.phone || '17575130205').replace(/[^\d]/g, '');
        
        let messageText = '';
        if (typeof monthlyReportContext === 'string' && monthlyReportContext.trim() !== '') {
            messageText = monthlyReportContext.trim();
        } else if (monthlyReportContext && typeof monthlyReportContext === 'object') {
            const data = monthlyReportContext;
            const coachGreeting = coach.shortName || coach.name.split(' ')[0] || 'Coach';
            messageText = `Hello ${coachGreeting}! I have completed my Monthly Wellness Report for ${data.monthName || 'this month'} on LeanLife.\n\nMy Monthly Summary:\n• Consistency: ${data.daysLoggedCount || 0}/${data.daysInMonth || 30} Days Logged (${data.consistencyPct || 0}%)\n• Overall Score: ${data.overallScore || 0}/100 (Grade: ${data.grade || 'A'})\n• Average Sleep: ${data.avgSleep || 0} hrs / night\n• Total Steps: ${(data.totalSteps || 0).toLocaleString()} steps\n• Weight Trend: ${data.endWeight || '--'} lbs (${data.weightDelta || '0'} lbs)\n\nI would love to review my progress with you and discuss adjustments for next month!`;
        } else {
            const coachGreeting = coach.shortName || coach.name.split(' ')[0] || 'Coach';
            messageText = `Hello ${coachGreeting}, I am a member of LeanLife and would love to discuss my wellness plan.`;
        }

        const encodedText = encodeURIComponent(messageText);
        return `https://wa.me/${cleanPhone}?text=${encodedText}`;
    },

    openMonthlyCoachReview() {
        this.openCoachMonthlyReviewModal();
    },

    openCoachMonthlyReviewModal() {
        if (!this.currentUser) {
            this.navigateTo('login');
            return;
        }

        const data = this.calculateMonthlyAggregateData(this.currentUser.email, this.selectedMonthlyReportCycle);
        const coach = this.getAssignedCoach(this.currentUser);

        const nameEl = document.getElementById('modal-coach-name');
        if (nameEl) nameEl.textContent = coach.name;
        const specEl = document.getElementById('modal-coach-spec');
        if (specEl) specEl.textContent = coach.spec;
        const avatarEl = document.getElementById('modal-coach-avatar');
        if (avatarEl) avatarEl.src = coach.avatar;

        const monthTitleEl = document.getElementById('modal-report-month-title');
        if (monthTitleEl) monthTitleEl.textContent = `${data.monthName} Monthly Progress Report`;

        const summaryStatsEl = document.getElementById('modal-report-summary-stats');
        if (summaryStatsEl) {
            summaryStatsEl.textContent = `${data.daysLoggedCount}/${data.daysInMonth} Days Logged • Avg Sleep: ${data.avgSleep}h • Total Steps: ${data.totalSteps.toLocaleString()} • Weight: ${data.endWeight} lbs (${data.weightDelta} lbs)`;
        }

        const msgBox = document.getElementById('modal-coach-user-msg');
        if (msgBox) {
            const coachGreeting = coach.shortName || coach.name.split(' ')[0] || 'Coach';
            msgBox.value = `Hello ${coachGreeting}! I have completed my Monthly Wellness Report for ${data.monthName} on LeanLife.\n\nMy Monthly Summary:\n• Consistency: ${data.daysLoggedCount}/${data.daysInMonth} Days Logged (${data.consistencyPct}%)\n• Overall Score: ${data.overallScore}/100 (Grade: ${data.grade})\n• Average Sleep: ${data.avgSleep} hrs / night\n• Total Steps: ${data.totalSteps.toLocaleString()} steps\n• Weight Trend: ${data.endWeight} lbs (${data.weightDelta} lbs)\n\nI would love to review my progress with you and discuss adjustments for next month!`;
        }

        const modal = document.getElementById('monthly-coach-review-modal');
        if (modal) modal.style.display = 'flex';
    },

    async submitCoachMonthlyReview(e) {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();

        const userMsg = document.getElementById('modal-coach-user-msg')?.value.trim() || '';
        const data = this.calculateMonthlyAggregateData(this.currentUser.email, this.selectedMonthlyReportCycle);
        const coach = this.getAssignedCoach(this.currentUser);

        // 1. Download PDF report for user
        this.downloadMonthlyReportPDF(this.selectedMonthlyReportCycle);

        // 2. Dispatch Email notification to Coach in background
        const emailSubject = `Monthly Report Review Request from ${this.currentUser.name} (${data.monthName})`;
        this.sendRealEmail(coach.name, coach.email, emailSubject, '', 'booking', {
            date: data.monthName,
            time: 'Monthly Review',
            coach: coach.name,
            mode: 'WhatsApp Review',
            notes: userMsg
        }).catch(err => console.warn("Notice: Coach email notification notice:", err));

        // 3. Log Audit trail
        this.logAudit(this.currentUser.name, 'Monthly Report Coach Review', `Requested review with ${coach.name} for ${data.monthName} on WhatsApp`);

        // 4. Hide Modal
        const modal = document.getElementById('monthly-coach-review-modal');
        if (modal) modal.style.display = 'none';

        // 5. Construct WhatsApp URL via canonical generator & Redirect
        const whatsappUrl = this.getCoachWhatsAppUrl(coach, userMsg);
        window.open(whatsappUrl, '_blank');
    },

    // ==================== COACHING & NOTICE BOARD EVENTS ====================
    handleCoachRequest(e) {
        e.preventDefault();
        const mode = document.getElementById('consult-type').value;
        const date = document.getElementById('consult-date').value;
        const time = document.getElementById('consult-time').value;
        const notes = document.getElementById('consult-notes').value;

        if (!mode || !date || !time) {
            alert("Please select consultation mode, date, and time.");
            return;
        }

        this.db.blockedDates = this.db.blockedDates || [];
        if (this.db.blockedDates.some(d => d.id === date && d.status === 'blocked')) {
            alert(`Sorry, this date (${new Date(date).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })}) is blocked and unavailable for consultations. Please select another date.`);
            return;
        }

        const newAppt = {
            id: 'APT-' + Date.now(),
            userEmail: this.currentUser.email,
            userName: this.currentUser.name,
            coach: 'sarah',
            mode: mode,
            date: date,
            time: time,
            notes: notes,
            status: 'Requested',
            coachViewed: false,
            notifiedCoach: false,
            reminder24hSent: false,
            reminder1hSent: false,
            timestamp: new Date().toISOString()
        };

        this.db.appointments.push(newAppt);
        this.saveDatabase();
        this.updateAppointmentNotificationBadges();
        this.logAudit(this.currentUser.name, 'Coach Consultation Scheduled', `Request made for ${date} at ${time}`);

        const coachName = 'Coach Francess Orenuga';

        const autoReplyOutboxId = 'EML-' + Date.now();
        this.db.emails.unshift({
            id: autoReplyOutboxId,
            timestamp: new Date().toISOString(),
            recipient: this.currentUser.email,
            subject: `Coach Consultation Confirmation: ${mode} on ${date} at ${time}`,
            templateName: 'Appointment Confirmation',
            status: 'Pending'
        });

        // Dispatch real email
        const emailSubject = `Coach Consultation Confirmation: ${mode} on ${date} at ${time} with ${coachName}`;
        this.sendRealEmail(this.currentUser.name, this.currentUser.email, emailSubject, '', 'booking', { date, time, coach: coachName, mode })
            .then(result => {
                const record = this.db.emails.find(e => e.id === autoReplyOutboxId);
                if (record) {
                    record.status = (result && result.ok) ? 'Delivered' : 'Failed';
                    this.saveDatabase();
                }
            });

        // Show custom pop up notification modal
        this.showCustomAlert(
            `📅 Appointment Scheduled Successfully!\n\nYour consultation request (${mode}) with ${coachName} for ${date} at ${time} has been submitted.\n\nA confirmation email has been dispatched to ${this.currentUser.email}.`,
            "Appointment Booked",
            "fa-calendar-check"
        );
        
        // Reset form
        document.getElementById('consult-notes').value = '';
    },

    renderCoaching() {
        const data = {
            name: 'Coach Francess Orenuga',
            title: 'Senior Lifestyle Medicine & Nutrition Coach',
            spec: 'Specialization: Metabolic Restoration, Habit Loop Optimization, Integrative Nutrition.',
            hours: 'Availability: Mon - Fri, 9:00 AM - 5:00 PM EST',
            pic: 'assets/coach_francess.png',
            whatsapp: 'https://wa.me/17575130205?text=Hello%20Coach%20Francess,%20I%20am%20a%20member%20of%20LeanLife%20and%20would%20love%20to%20discuss%20my%20wellness%20plan.',
            shortName: 'Coach Francess'
        };

        const nameEl = document.getElementById('coach-name');
        const titleEl = document.getElementById('coach-title');
        const specEl = document.getElementById('coach-spec');
        const hoursEl = document.getElementById('coach-hours');
        const picEl = document.getElementById('coach-pic');
        const btnEl = document.getElementById('whatsapp-btn');
        const descEl = document.getElementById('whatsapp-desc');

        if (nameEl) nameEl.textContent = data.name;
        if (titleEl) titleEl.textContent = data.title;
        if (specEl) specEl.textContent = data.spec;
        if (hoursEl) hoursEl.textContent = data.hours;
        if (picEl) picEl.src = data.pic;
        if (btnEl) btnEl.href = data.whatsapp;
        if (descEl) descEl.textContent = `Connect with ${data.shortName} immediately to resolve hydration goals, snack alternatives, or lifestyle adjustments.`;
    },

    renderNoticeBoard() {
        const container = document.getElementById('events-grid-container');
        if (!container) return;

        let html = '';
        this.db.events.forEach(evt => {
            const hasRSVP = evt.rsvp.includes(this.currentUser ? this.currentUser.email : '');
            
            html += `
                <div class="glass-card event-card">
                    <div>
                        <div class="event-countdown"><i class="fa-solid fa-clock"></i> ${evt.countdown}</div>
                        <h3 style="font-size: 1.35rem; margin-bottom: 8px;">${evt.title}</h3>
                        <p style="font-size: 0.8rem; font-weight: 600; color: var(--clr-accent-green-hover); margin-bottom: 10px;">${evt.category} | ${evt.date} at ${evt.time}</p>
                        <p style="font-size: 0.9rem; color: #555;">${evt.description}</p>
                    </div>
                    <div style="margin-top: 1.5rem; display: flex; gap: 10px;">
                        <button class="btn ${hasRSVP ? 'btn-secondary' : 'btn-primary'}" style="flex:1; justify-content:center;" onclick="app.toggleEventRSVP('${evt.id}')">
                            <i class="fa-solid ${hasRSVP ? 'fa-check' : 'fa-calendar-plus'}"></i> ${hasRSVP ? 'RSVP\'d' : 'RSVP Event'}
                        </button>
                        <button class="btn btn-outline" title="Sync with Google Calendar" onclick="app.syncGoogleCalendar('${evt.id}')"><i class="fa-brands fa-google"></i> Sync</button>
                    </div>
                </div>
            `;
        });
        container.innerHTML = html;
    },

    toggleEventRSVP(evtId) {
        if (!this.currentUser) {
            this.navigateTo('login');
            return;
        }

        const evt = this.db.events.find(e => e.id === evtId);
        if (!evt) return;

        const emailIdx = evt.rsvp.indexOf(this.currentUser.email);
        if (emailIdx > -1) {
            evt.rsvp.splice(emailIdx, 1);
            this.logAudit(this.currentUser.name, 'RSVP Cancelled', `Removed RSVP for event ${evt.title}`);
            alert(`You have cancelled your RSVP for ${evt.title}.`);
        } else {
            evt.rsvp.push(this.currentUser.email);
            this.logAudit(this.currentUser.name, 'RSVP Submitted', `Added RSVP for event ${evt.title}`);
            alert(`RSVP confirmed for ${evt.title}! Email reminders and virtual invite links will be sent.`);
        }
        this.saveDatabase();
        this.renderNoticeBoard();
    },

    syncGoogleCalendar(evtId) {
        alert("Google Calendar Sync: Adding calendar invitation invite and virtual clinic link to your Google Account.");
    },

    // ==================== HEALTH & WELLNESS COMMUNITY FORUM ====================
    filterCommunity(category) {
        this.activeCommunityCategory = category;
        const items = document.querySelectorAll('.cat-item');
        items.forEach(el => {
            el.classList.remove('active');
            if (el.textContent.includes(category) || (category === 'all' && el.textContent === 'All Categories')) {
                el.classList.add('active');
            }
        });
        this.renderCommunityFeed();
    },

    openNewPostModal() {
        document.getElementById('new-post-box').style.display = 'block';
    },

    closeNewPostModal() {
        document.getElementById('new-post-box').style.display = 'none';
        document.getElementById('post-title').value = '';
        document.getElementById('post-body').value = '';
        document.getElementById('post-image').value = '';
    },

    handleNewPostSubmit(e) {
        e.preventDefault();
        const title = document.getElementById('post-title').value;
        const category = document.getElementById('post-category').value;
        const image = document.getElementById('post-image').value;
        const body = document.getElementById('post-body').value;

        const newPost = {
            id: 'POST-' + Date.now(),
            title: title,
            category: category,
            author: this.currentUser.name,
            authorAvatar: this.currentUser.avatar || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop',
            body: body,
            image: image,
            likes: 0,
            likedBy: [],
            comments: [],
            pinned: false,
            timestamp: 'Just now',
            status: 'approved' // Automatically approved for simplicity, or admin can moderate
        };

        this.db.posts.unshift(newPost);
        this.saveDatabase();
        this.logAudit(this.currentUser.name, 'Community Post Created', `Published thread: ${title}`);

        alert("Post published successfully!");
        this.closeNewPostModal();
        this.renderCommunityFeed();
    },

    renderCommunityFeed() {
        const container = document.getElementById('community-feed-container');
        if (!container) return;

        let filtered = this.db.posts;
        if (this.activeCommunityCategory !== 'all') {
            filtered = this.db.posts.filter(p => p.category === this.activeCommunityCategory);
        }

        let html = '';
        if (filtered.length === 0) {
            html = `<div class="glass-card" style="text-align:center; padding: 3rem; color: #666;">No community posts found in this category. Be the first to share!</div>`;
        } else {
            filtered.forEach(p => {
                const userLiked = p.likedBy ? p.likedBy.includes(this.currentUser ? this.currentUser.email : '') : false;
                
                let commentListHtml = '';
                if (p.comments && p.comments.length > 0) {
                    p.comments.forEach(c => {
                        commentListHtml += `
                            <div style="border-bottom: 1px solid rgba(0,0,0,0.04); padding: 8px 0;">
                                <span style="font-weight:700; font-size:0.85rem;">${c.author}:</span>
                                <span style="font-size:0.85rem; color:#444;">${c.body}</span>
                            </div>
                        `;
                    });
                }

                html += `
                    <div class="glass-card post-card" id="post-${p.id}">
                        <div class="post-header">
                            <div class="post-author">
                                <div class="author-avatar">
                                    <img src="${p.authorAvatar}" alt="avatar">
                                </div>
                                <div class="post-meta">
                                    <h4>${p.author}</h4>
                                    <span>${p.timestamp} | <span style="color:var(--clr-accent-green-hover); font-weight:600;">${p.category}</span></span>
                                </div>
                            </div>
                            ${p.pinned ? `<span style="background:var(--clr-primary-green); padding:4px 8px; border-radius:12px; font-size:0.7rem; font-weight:bold;">Pinned</span>` : ''}
                        </div>
                        <div class="post-body">
                            <h3 style="font-family:var(--font-brand); font-size:1.3rem; margin-bottom:8px;">${p.title}</h3>
                            <p style="font-size:0.95rem; color:#333; margin-bottom:12px;">${p.body}</p>
                            ${p.image ? `<div style="border-radius:var(--radius-md); overflow:hidden; max-height:300px; margin-bottom:1rem;"><img src="${p.image}" style="width:100%; height:100%; object-fit:cover;"></div>` : ''}
                        </div>
                        <div class="post-actions">
                            <span class="post-action-btn" onclick="app.likePost('${p.id}')" style="color: ${userLiked ? '#e91e63' : '#666'}">
                                <i class="${userLiked ? 'fa-solid' : 'fa-regular'} fa-heart"></i> ${p.likes || 0} Likes
                            </span>
                            <span class="post-action-btn"><i class="fa-regular fa-comment"></i> ${p.comments ? p.comments.length : 0} Comments</span>
                        </div>

                        <!-- Comment Block -->
                        <div class="comment-section">
                            <div class="comment-list">
                                ${commentListHtml}
                            </div>
                            <div class="comment-input-row" style="margin-top:10px;">
                                <input type="text" id="comment-input-${p.id}" class="form-input" style="padding:0.5rem;" placeholder="Write a comment...">
                                <button class="btn btn-primary" style="padding:0.5rem 1rem;" onclick="app.addComment('${p.id}')">Send</button>
                            </div>
                        </div>
                    </div>
                `;
            });
        }
        container.innerHTML = html;
    },

    likePost(postId) {
        if (!this.currentUser) {
            this.navigateTo('login');
            return;
        }

        const post = this.db.posts.find(p => p.id === postId);
        if (!post) return;

        if (!post.likedBy) post.likedBy = [];

        const emailIdx = post.likedBy.indexOf(this.currentUser.email);
        if (emailIdx > -1) {
            post.likedBy.splice(emailIdx, 1);
            post.likes = Math.max((post.likes || 0) - 1, 0);
        } else {
            post.likedBy.push(this.currentUser.email);
            post.likes = (post.likes || 0) + 1;
        }
        this.saveDatabase();
        this.renderCommunityFeed();
    },

    addComment(postId) {
        if (!this.currentUser) {
            this.navigateTo('login');
            return;
        }

        const input = document.getElementById(`comment-input-${postId}`);
        if (!input || !input.value.trim()) return;

        const post = this.db.posts.find(p => p.id === postId);
        if (!post) return;

        if (!post.comments) post.comments = [];

        post.comments.push({
            author: this.currentUser.name,
            body: input.value.trim(),
            timestamp: 'Just now'
        });

        this.saveDatabase();
        input.value = '';
        this.renderCommunityFeed();
    },

    searchCommunity() {
        const query = document.getElementById('community-search-input').value.toLowerCase();
        const container = document.getElementById('community-feed-container');
        if (!container) return;

        const matched = this.db.posts.filter(p => p.title.toLowerCase().includes(query) || p.body.toLowerCase().includes(query));
        
        let html = '';
        if (matched.length === 0) {
            html = `<div class="glass-card" style="text-align:center; padding:3rem;">No search results matched your query.</div>`;
        } else {
            // Render matched posts
            matched.forEach(p => {
                html += `<div class="glass-card post-card">
                    <h4>${p.author} | ${p.category}</h4>
                    <h3>${p.title}</h3>
                    <p>${p.body}</p>
                </div>`;
            });
        }
        container.innerHTML = html;
    },

    presetAvatars: [
        'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop',
        'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&auto=format&fit=crop',
        'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=100&auto=format&fit=crop',
        'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=100&auto=format&fit=crop',
        'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=100&auto=format&fit=crop',
        'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=100&auto=format&fit=crop'
    ],

    selectPresetAvatar(url) {
        document.getElementById('prof-avatar-preview').src = url;
        const options = document.querySelectorAll('#preset-avatar-grid img');
        options.forEach(opt => {
            const isSelected = opt.src === url;
            opt.style.border = isSelected ? '3px solid var(--clr-primary)' : '3px solid rgba(0,0,0,0.1)';
            opt.style.transform = isSelected ? 'scale(1.1)' : 'scale(1)';
        });
    },

    async handleProfilePhotoUpload(e) {
        const file = e.target.files[0];
        if (!file) return;
        
        if (file.size > 5 * 1024 * 1024) {
            alert("File is too large. Maximum allowed size is 5MB.");
            return;
        }
        
        try {
            const base64 = await this.resizeProfileImage(file);
            document.getElementById('prof-avatar-preview').src = base64;
            
            const options = document.querySelectorAll('#preset-avatar-grid img');
            options.forEach(opt => {
                opt.style.border = '3px solid rgba(0,0,0,0.1)';
                opt.style.transform = 'scale(1)';
            });
        } catch (err) {
            console.error("Failed to load or resize image:", err);
            alert("Error loading image. Please try a different file.");
        }
    },
    
    resizeProfileImage(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (event) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const max_size = 200;
                    let width = img.width;
                    let height = img.height;
                    
                    if (width > height) {
                        if (width > max_size) {
                            height *= max_size / width;
                            width = max_size;
                        }
                    } else {
                        if (height > max_size) {
                            width *= max_size / height;
                            height = max_size;
                        }
                    }
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);
                    resolve(canvas.toDataURL('image/jpeg', 0.8));
                };
                img.onerror = (err) => reject(err);
                img.src = event.target.result;
            };
            reader.onerror = (err) => reject(err);
            reader.readAsDataURL(file);
        });
    },

    // ==================== USER PROFILE VIEW ====================
    renderUserProfile() {
        if (!this.currentUser) return;

        // Render current avatar and presets
        const currentAvatar = this.currentUser.avatar || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop';
        document.getElementById('prof-avatar-preview').src = currentAvatar;
        
        const grid = document.getElementById('preset-avatar-grid');
        if (grid) {
            let gridHtml = '';
            this.presetAvatars.forEach(av => {
                const isSelected = this.currentUser.avatar === av;
                gridHtml += `<img src="${av}" alt="Preset Avatar" class="preset-avatar-option" style="width: 42px; height: 42px; border-radius: 50%; object-fit: cover; cursor: pointer; border: 3px solid ${isSelected ? 'var(--clr-primary)' : 'rgba(0,0,0,0.1)'}; transition: all 0.2s; transform: scale(${isSelected ? '1.1' : '1'});" onclick="app.selectPresetAvatar('${av}')" onmouseover="this.style.transform='scale(1.15)';" onmouseout="this.style.transform='scale(${isSelected ? '1.1' : '1'})';">`;
            });
            grid.innerHTML = gridHtml;
        }

        document.getElementById('prof-name').value = this.currentUser.name;
        document.getElementById('prof-email').value = this.currentUser.email;
        document.getElementById('prof-phone').value = this.currentUser.phone;
        document.getElementById('prof-dob').value = this.currentUser.dob;
        document.getElementById('prof-gender').value = this.currentUser.gender;
        document.getElementById('prof-goal').value = this.currentUser.goal;
        document.getElementById('prof-height').value = this.currentUser.height;
        document.getElementById('prof-weight').value = this.currentUser.weight;

        // Secure medical records fields
        document.getElementById('prof-blood').value = this.currentUser.bloodGroup || '';
        document.getElementById('prof-allergies').value = this.currentUser.allergies || '';
        document.getElementById('prof-meds').value = this.currentUser.medications || '';
        document.getElementById('prof-conditions').value = this.currentUser.conditions || '';
        document.getElementById('prof-emergency-name').value = this.currentUser.emergencyName || '';
        document.getElementById('prof-emergency-phone').value = this.currentUser.emergencyPhone || '';
        document.getElementById('prof-coach').value = this.currentUser.preferredCoach || 'sarah';

        this.updateProfileBMI();
        this.updateProfileMeter();
    },

    updateProfileBMI() {
        const height = parseFloat(document.getElementById('prof-height').value) || 0;
        const weight = parseFloat(document.getElementById('prof-weight').value) || 0;
        // Profile doesn't render raw BMI as input, we calculate it dynamically
    },

    updateProfileMeter() {
        // Calculate profile completion percentage based on filled parameters
        const fields = [
            'name', 'phone', 'dob', 'gender', 'height', 'weight', 'goal',
            'bloodGroup', 'allergies', 'medications', 'conditions', 'emergencyName', 'emergencyPhone'
        ];
        
        let filled = 0;
        fields.forEach(f => {
            if (this.currentUser[f] && this.currentUser[f] !== '') {
                filled++;
            }
        });

        const pct = Math.round((filled / fields.length) * 100);
        document.getElementById('profile-meter-text').textContent = `${pct}%`;
        document.getElementById('profile-meter-fill').style.width = `${pct}%`;
    },

    handleProfileSave(e) {
        e.preventDefault();
        const userObj = this.db.users.find(u => u.email.toLowerCase() === this.currentUser.email.toLowerCase());
        if (!userObj) return;

        userObj.name = document.getElementById('prof-name').value.trim();
        userObj.avatar = document.getElementById('prof-avatar-preview').src;
        userObj.phone = document.getElementById('prof-phone').value.trim();
        userObj.dob = document.getElementById('prof-dob').value;
        userObj.gender = document.getElementById('prof-gender').value;
        userObj.goal = document.getElementById('prof-goal').value.trim();
        userObj.height = parseFloat(document.getElementById('prof-height').value) || 0;
        userObj.weight = parseFloat(document.getElementById('prof-weight').value) || 0;

        userObj.bloodGroup = document.getElementById('prof-blood').value.trim();
        userObj.allergies = document.getElementById('prof-allergies').value.trim();
        userObj.medications = document.getElementById('prof-meds').value.trim();
        userObj.conditions = document.getElementById('prof-conditions').value.trim();
        userObj.emergencyName = document.getElementById('prof-emergency-name').value.trim();
        userObj.emergencyPhone = document.getElementById('prof-emergency-phone').value.trim();
        userObj.preferredCoach = document.getElementById('prof-coach').value;

        this.currentUser = userObj;
        userObj.updatedAt = new Date().toISOString();
        sessionStorage.setItem('leanlife_session', JSON.stringify(userObj));
        this.saveDatabase();
        
        this.logAudit(this.currentUser.name, 'Profile Saved', 'User demographic and clinical profile parameters modified');

        this.updateUIAfterLogin();
        this.updateProfileMeter();
        alert("Success! Your personal details and clinical profiles have been updated securely.");
    },

    async handlePasswordChange(e) {
        e.preventDefault();
        const userObj = this.db.users.find(u => u.email.toLowerCase() === this.currentUser.email.toLowerCase());
        if (!userObj) return;

        const newPwd = document.getElementById('prof-newpwd').value;
        if (newPwd.length < 6) {
            alert("Password must be at least 6 characters long.");
            return;
        }

        userObj.password = await this.hashPassword(newPwd);
        userObj.updatedAt = new Date().toISOString();
        this.saveDatabase();
        document.getElementById('prof-newpwd').value = '';
        this.logAudit(this.currentUser.name, 'Password Changed', 'User password updated manually');
        alert("Your password has been changed successfully!");
    },

    // ==================== SUPER ADMIN / COACH CONTROL PANEL ====================
    renderAdminPanel() {
        const titleEl = document.querySelector('#view-admin h2');
        if (titleEl) {
            if (this.currentUser && this.currentUser.role === 'coach') {
                titleEl.textContent = 'Coach Portal & Client Repository';
            } else {
                titleEl.textContent = 'Super Admin Console';
            }
        }
        this.updateAppointmentNotificationBadges();
        this.switchAdminTab(this.activeAdminTab);
    },

    switchAdminTab(tab) {
        const activeBtn = document.getElementById(`btn-admin-${tab}`);
        const activePanel = document.getElementById(`admin-subview-${tab}`);
        if (!activePanel) return;

        // Instant synchronous UI toggle (0ms latency)
        document.querySelectorAll('.admin-tab-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelectorAll('.admin-subpanel').forEach(panel => panel.style.display = 'none');

        if (activeBtn) activeBtn.classList.add('active');
        activePanel.style.display = 'block';

        this.activeAdminTab = tab;

        // Automatically pull latest cloud data in background for data-driven tabs
        if (['users', 'logs-cms', 'reports-cms', 'appointments-cms'].includes(tab)) {
            this.syncCloudData().catch(e => console.warn("[Admin] Tab switch sync notice:", e));
        }

        // Mark unviewed appointments as viewed when coach opens appointments tab
        if (tab === 'appointments-cms') {
            if (this.db && Array.isArray(this.db.appointments)) {
                let modified = false;
                this.db.appointments.forEach(a => {
                    if (!a.coachViewed) {
                        a.coachViewed = true;
                        modified = true;
                    }
                });
                if (modified) {
                    this.saveDatabase();
                }
            }
            this.updateAppointmentNotificationBadges();
        }

        // Deferred subview render via setTimeout 0 for zero-lag UI thread execution
        setTimeout(() => {
            switch (tab) {
                case 'users': this.renderAdminUsers(); break;
                case 'logs-cms': this.renderAdminLogsCMS(); break;
                case 'reports-cms': this.renderAdminReportsCMS(); break;
                case 'emails-cms': this.renderAdminEmailsCMS(); break;
                case 'moderation-cms': this.renderAdminModerationCMS(); break;
                case 'notices-cms': this.renderAdminEventsCMS(); break;
                case 'coaches-cms': this.renderAdminCoachesCMS(); break;
                case 'appointments-cms': this.renderAdminAppointmentsCMS(); break;
                case 'analytics-cms': this.renderAdminAnalyticsCMS(); break;
                case 'audits-cms': this.renderAdminAuditsCMS(); break;
                case 'settings-cms': this.renderAdminSettingsCMS(); break;
                case 'automation': this.renderAdminAutomationCMS(); break;
            }
        }, 0);
    },

    async refreshAdminData() {
        const btn = document.getElementById('btn-admin-refresh-data');
        const origHtml = btn ? btn.innerHTML : '';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Syncing...';
        }
        try {
            await this.syncCloudData();
            if (this.activeAdminTab === 'users') this.renderAdminUsers();
            else if (this.activeAdminTab === 'logs-cms') this.renderAdminLogsCMS();
            else if (this.activeAdminTab === 'reports-cms') this.renderAdminReportsCMS();
            else if (this.activeAdminTab === 'appointments-cms') this.renderAdminAppointmentsCMS();
        } catch(e) {
            console.warn("[Admin] Manual refresh notice:", e);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = origHtml || '<i class="fa-solid fa-rotate"></i> Sync Cloud';
            }
        }
    },

    renderAdminUsers() {
        const tbody = document.getElementById('admin-user-list-tbody');
        if (!tbody) return;

        const query = (document.getElementById('admin-user-search')?.value || '').toLowerCase();
        const statusFilter = document.getElementById('admin-user-filter-status')?.value || 'all';

        let html = '';
        this.db.users.forEach(u => {
            const isSelf = u.email === this.currentUser.email;
            const uEmail = (u.email || '').toLowerCase().trim();
            
            // Filter by search
            const matchSearch = (u.name || '').toLowerCase().includes(query) || 
                                uEmail.includes(query) || 
                                (u.preferredCoach || '').toLowerCase().includes(query);
            
            // Filter by status
            const matchStatus = statusFilter === 'all' || u.status === statusFilter;

            if (!matchSearch || !matchStatus) return;

            const userLogs = (this.db.wellnessLogs || []).filter(l => {
                const lEmail = (l.userEmail || l.email || l.user_email || '').toLowerCase().trim();
                return lEmail === uEmail;
            });
            const logCount = userLogs.length;

            html += `
                <tr>
                    <td style="font-weight:600;">${u.name}</td>
                    <td>${u.email}</td>
                    <td>Coach Francess Orenuga</td>
                    <td>
                        <span style="background:${u.status === 'Active' ? '#28a745' : '#dc3545'}; color:white; padding:4px 8px; border-radius:12px; font-size:0.75rem; font-weight:bold;">
                            ${u.status}
                        </span>
                    </td>
                    <td>${u.role}</td>
                    <td><span class="badge" style="background: rgba(38, 175, 127, 0.15); color: var(--clr-primary-green); font-weight: 700;">${logCount} submitted</span></td>
                    <td>
                        ${isSelf ? '<span style="color:#888;">Self (Root)</span>' : `
                            <div style="display:flex; gap:0.4rem; flex-wrap:wrap;">
                                <button class="btn btn-primary" style="padding:0.25rem 0.6rem; font-size:0.75rem;" onclick="app.viewClientWellnessLogs('${u.email}')" title="View Full Wellness Logs & Daily Submissions"><i class="fa-solid fa-notes-medical"></i> Wellness Logs</button>
                                <button class="btn btn-secondary" style="padding:0.25rem 0.5rem; font-size:0.75rem;" onclick="app.openAdminHealthProfile('${u.email}')"><i class="fa-solid fa-file-medical"></i> Profile</button>
                                <button class="btn btn-outline" style="padding:0.25rem 0.5rem; font-size:0.75rem; color:var(--clr-primary-green); border-color:rgba(18,130,109,0.35); font-weight:600;" onclick="app.viewMemberCredentials('${u.email}')" title="View, Copy, and WhatsApp Login Credentials"><i class="fa-solid fa-key"></i> Login Info</button>
                                <button class="btn btn-outline" style="padding:0.25rem 0.5rem; font-size:0.75rem; color:var(--clr-text-dark); border-color:rgba(0,0,0,0.15);" onclick="app.toggleUserStatus('${u.email}')">${u.status === 'Active' ? 'Suspend' : 'Activate'}</button>
                                <button class="btn btn-outline" style="padding:0.25rem 0.5rem; font-size:0.75rem; color:#d9534f; border-color:rgba(217, 83, 79, 0.2);" onclick="app.adminResetPassword('${u.email}')"><i class="fa-solid fa-rotate-right"></i> Reset</button>
                                <button class="btn btn-danger" style="padding:0.25rem 0.5rem; font-size:0.75rem;" onclick="app.deleteUser('${u.email}')"><i class="fa-solid fa-trash-can"></i> Delete</button>
                            </div>
                        `}
                    </td>
                </tr>
            `;
        });
        tbody.innerHTML = html;
    },

    // View complete client wellness history in dedicated modal
    viewClientWellnessLogs(email) {
        if (!this.currentUser || (this.currentUser.role !== 'admin' && this.currentUser.role !== 'coach')) {
            alert("Unauthorized access. Only Coaches and Administrators can inspect client logs.");
            return;
        }

        const normEmail = (email || '').toLowerCase().trim();
        const user = (this.db.users || []).find(u => (u.email || '').toLowerCase().trim() === normEmail) || { email: email, name: email };

        const modal = document.getElementById('admin-client-logs-modal');
        if (!modal) return;

        // Set header info
        const nameEl = document.getElementById('client-logs-modal-user-name');
        const emailEl = document.getElementById('client-logs-modal-user-email');
        if (nameEl) nameEl.textContent = user.name || user.email;
        if (emailEl) emailEl.textContent = user.email || email;

        // Get user's wellness logs sorted newest first
        const getSortedLogs = () => (this.db.wellnessLogs || [])
            .filter(l => {
                const lEmail = (l.userEmail || l.email || l.user_email || '').toLowerCase().trim();
                return lEmail === normEmail;
            })
            .sort((a, b) => new Date(b.timestamp || b.updatedAt || b.date || 0) - new Date(a.timestamp || a.updatedAt || a.date || 0));

        const populateDropdownAndRender = (logs) => {
            const dateSelect = document.getElementById('client-logs-date-select');
            if (dateSelect) {
                dateSelect.innerHTML = '';
                if (logs.length === 0) {
                    dateSelect.innerHTML = '<option value="">No logs available</option>';
                } else {
                    logs.forEach((l, idx) => {
                        const opt = document.createElement('option');
                        opt.value = l.id;
                        const logTime = l.timestamp || l.updatedAt || l.date || '';
                        const dateStr = logTime && !isNaN(new Date(logTime)) ? new Date(logTime).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Recent';
                        const timeStr = (logTime && logTime.includes('T') && !isNaN(new Date(logTime))) ? new Date(logTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                        const deviceTag = l.device ? ` [${l.device.includes('Android') ? 'Android' : (l.device.includes('iOS') ? 'iOS' : 'Web')}]` : '';
                        opt.textContent = `${idx === 0 ? 'Latest: ' : ''}${dateStr}${timeStr ? ' at ' + timeStr : ''}${deviceTag}`;
                        dateSelect.appendChild(opt);
                    });
                }
            }
            this.renderSelectedClientLog(logs[0] || null, user);
        };

        const userLogs = getSortedLogs();
        populateDropdownAndRender(userLogs);

        modal.style.display = 'block';
        modal.scrollIntoView({ behavior: 'smooth' });

        // Asynchronously revalidate from cloud in background to guarantee zero-lag freshness
        this.syncCloudData().then(() => {
            const freshLogs = getSortedLogs();
            if (freshLogs.length !== userLogs.length || (freshLogs[0] && userLogs[0] && freshLogs[0].id !== userLogs[0].id)) {
                populateDropdownAndRender(freshLogs);
            }
        }).catch(() => {});
    },

    handleClientLogDateSelect(logId) {
        if (!logId) return;
        const log = this.db.wellnessLogs.find(l => l.id === logId);
        const email = document.getElementById('client-logs-modal-user-email')?.textContent;
        const user = this.db.users.find(u => u.email.toLowerCase() === (email || '').toLowerCase());
        this.renderSelectedClientLog(log, user);
    },

    renderSelectedClientLog(log, clientUser) {
        const body = document.getElementById('client-logs-modal-body');
        if (!body) return;

        if (!log) {
            body.innerHTML = `
                <div style="text-align:center; padding: 3rem 1rem; color: #666;">
                    <i class="fa-solid fa-folder-open" style="font-size: 2.5rem; color: #ccc; margin-bottom: 1rem; display: block;"></i>
                    <h3 style="font-size: 1.15rem; font-weight: 700; margin-bottom: 0.5rem;">No Wellness Log Submissions Found</h3>
                    <p style="font-size: 0.9rem; color: #888;">This client has not submitted any daily wellness logs yet.</p>
                </div>
            `;
            return;
        }

        const metrics = log.metrics || {};
        const weightLbs = metrics.weight || log.weight || 155.4;
        const bmiVal = metrics.bmi || '22.5';
        const bodyFat = metrics.bodyFat || '18.5';
        const visceralFat = metrics.visceralFat || metrics.visceraFat || '10.0';
        const skeletalMuscle = metrics.skeletalMuscle || '66.1';
        const leanMass = metrics.leanMass || '110.2';
        const bloodPressure = metrics.bloodPressure || '120/80';
        const bloodSugar = metrics.bloodSugar || 95;
        const heartRate = metrics.heartRate || 65;
        const stress = metrics.stress || 4;
        const energy = metrics.energy || 7;
        const screenTime = metrics.screenTime || log.screenTime || 4.5;
        const outdoorTime = metrics.outdoorTime || log.outdoorTime || 45;
        const sunlight = metrics.sunlight || log.sunlight || 20;
        const meditation = metrics.meditation || log.meditation || 15;

        const photo = log.photoUrl || (log.photos && log.photos[0]) || (log.meals && log.meals.photo) || '';
        const affirmations = log.affirmations || (log.journal?.affirmation ? [log.journal.affirmation] : []);
        const gratitudes = log.gratitudes || (log.journal?.gratitude ? [log.journal.gratitude] : []);
        const goals = log.goals || [];
        const reflections = log.reflections || (log.journal?.reflections ? [log.journal.reflections] : []);
        const greatThings = log.greatThings || [];

        const sleepDuration = log.sleep?.duration || '8.0';
        const sleepWake = log.sleep?.wakeup || '07:00 AM';
        const sleepBed = log.sleep?.bedtime || '11:00 PM';
        const sleepQuality = log.sleep?.quality || 'Restful';
        const waterGlasses = log.waterCount || 8;
        const steps = log.steps || 0;
        const mood = log.mood || 'happy';

        const exerciseType = log.exercise?.type || 'General Activity';
        const exerciseDuration = log.exercise?.duration || '30';
        const exerciseIntensity = log.exercise?.intensity || 'Moderate';
        const isExercise = log.exerciseCompleted === 'yes' || log.exercise?.completed === 'yes';

        const fastingCompleted = log.fasting?.completed === 'yes';
        const fastingType = log.fasting?.type || '16:8 Intermittent';

        body.innerHTML = `
            <!-- Top Status Banner -->
            <div style="background: linear-gradient(135deg, rgba(38,175,127,0.12), rgba(168,230,207,0.22)); border-radius: var(--radius-sm); padding: 1.1rem 1.3rem; margin-bottom: 1.5rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.8rem; border: 1px solid rgba(38,175,127,0.3);">
                <div>
                    <div style="font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.6px; font-weight: 800; color: var(--clr-primary-green);">Wellness Log Record</div>
                    <div style="font-size: 1.15rem; font-weight: 700; color: var(--clr-text-dark);">${new Date(log.timestamp).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' })} at ${new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                    <div style="font-size: 0.82rem; color: #555; margin-top: 3px;">
                        <i class="fa-solid fa-mobile-screen"></i> Origin Device: <strong>${log.device || 'Mobile / Web Client'}</strong> &bull; <i class="fa-solid fa-fingerprint"></i> ID: <code>${log.id}</code>
                    </div>
                </div>
                <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
                    <span style="background: var(--clr-primary-green); color: white; padding: 4px 10px; border-radius: 12px; font-size: 0.8rem; font-weight: bold; text-transform: capitalize;">
                        <i class="fa-solid fa-face-smile"></i> Mood: ${mood}
                    </span>
                    <span style="background: #28a745; color: white; padding: 4px 10px; border-radius: 12px; font-size: 0.8rem; font-weight: bold;">
                        <i class="fa-solid fa-cloud-arrow-up"></i> Persisted & Synced
                    </span>
                </div>
            </div>

            <!-- Main 3-Column Metrics Grid -->
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1.25rem; margin-bottom: 1.5rem;">
                
                <!-- Card 1: Biometrics & Weight (lbs) -->
                <div class="glass-card" style="padding: 1.2rem;">
                    <h4 style="color: var(--clr-primary-green); font-family: var(--font-brand); margin-bottom: 0.8rem; border-bottom: 1.5px solid var(--clr-accent-green); padding-bottom: 4px;">
                        <i class="fa-solid fa-weight-scale"></i> Body Composition (US Standard)
                    </h4>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; font-size: 0.9rem;">
                        <div><strong style="color: #555;">Weight:</strong> <span style="font-weight: 700; color: var(--clr-text-dark);">${weightLbs} lbs</span></div>
                        <div><strong style="color: #555;">BMI:</strong> <span style="font-weight: 700;">${bmiVal}</span></div>
                        <div><strong style="color: #555;">Body Fat:</strong> ${bodyFat}%</div>
                        <div><strong style="color: #555;">Visceral Fat:</strong> ${visceralFat}%</div>
                        <div><strong style="color: #555;">Skeletal Muscle:</strong> ${skeletalMuscle} lbs</div>
                        <div><strong style="color: #555;">Lean Mass:</strong> ${leanMass} lbs</div>
                        <div><strong style="color: #555;">Blood Pressure:</strong> ${bloodPressure}</div>
                        <div><strong style="color: #555;">Blood Sugar:</strong> ${bloodSugar} mg/dL</div>
                        <div><strong style="color: #555;">Heart Rate:</strong> ${heartRate} bpm</div>
                        <div><strong style="color: #555;">Stress / Energy:</strong> ${stress}/10 &bull; ${energy}/10</div>
                    </div>
                </div>

                <!-- Card 2: Daily Wellness Habits -->
                <div class="glass-card" style="padding: 1.2rem;">
                    <h4 style="color: var(--clr-primary-green); font-family: var(--font-brand); margin-bottom: 0.8rem; border-bottom: 1.5px solid var(--clr-accent-green); padding-bottom: 4px;">
                        <i class="fa-solid fa-sun"></i> Lifestyle & Wellness Habits
                    </h4>
                    <div style="display: flex; flex-direction: column; gap: 0.6rem; font-size: 0.9rem;">
                        <div><i class="fa-solid fa-tree" style="color: #2ed573; width: 18px;"></i> <strong>Outdoor Time:</strong> ${outdoorTime} Minutes</div>
                        <div><i class="fa-solid fa-sun" style="color: #ffa502; width: 18px;"></i> <strong>Sunlight Exposure:</strong> ${sunlight} Minutes</div>
                        <div><i class="fa-solid fa-spa" style="color: #9c27b0; width: 18px;"></i> <strong>Meditation:</strong> ${meditation} Minutes</div>
                        <div><i class="fa-solid fa-display" style="color: #70a1ff; width: 18px;"></i> <strong>Screen Time:</strong> ${screenTime} Hours</div>
                        <div><i class="fa-solid fa-pills" style="color: #e84393; width: 18px;"></i> <strong>Medication Taken:</strong> ${metrics.medicationTaken ? 'Yes (Logged)' : 'No'}</div>
                        <div><i class="fa-solid fa-capsules" style="color: #00b894; width: 18px;"></i> <strong>Supplements:</strong> ${metrics.supplementTaken ? 'Yes (Logged)' : 'No'}</div>
                    </div>
                </div>

                <!-- Card 3: Sleep, Hydration & Activity -->
                <div class="glass-card" style="padding: 1.2rem;">
                    <h4 style="color: var(--clr-primary-green); font-family: var(--font-brand); margin-bottom: 0.8rem; border-bottom: 1.5px solid var(--clr-accent-green); padding-bottom: 4px;">
                        <i class="fa-solid fa-person-running"></i> Activity, Sleep & Water
                    </h4>
                    <div style="display: flex; flex-direction: column; gap: 0.6rem; font-size: 0.9rem;">
                        <div><i class="fa-solid fa-bed" style="color: #5352ed; width: 18px;"></i> <strong>Sleep:</strong> ${sleepDuration} hrs (${sleepQuality})</div>
                        <div style="font-size: 0.8rem; color: #777; margin-top: -4px; margin-left: 24px;">Wake: ${sleepWake} | Bed: ${sleepBed}</div>
                        <div><i class="fa-solid fa-droplet" style="color: #1e90ff; width: 18px;"></i> <strong>Hydration:</strong> ${waterGlasses} glasses (${waterGlasses * 8} oz / ${waterGlasses * 250} ml)</div>
                        <div><i class="fa-solid fa-shoe-prints" style="color: #ff6b81; width: 18px;"></i> <strong>Steps:</strong> ${steps.toLocaleString()} steps</div>
                        <div><i class="fa-solid fa-dumbbell" style="color: #2ed573; width: 18px;"></i> <strong>Exercise:</strong> ${isExercise ? `${exerciseType} (${exerciseDuration}m, ${exerciseIntensity})` : 'Rest Day'}</div>
                        <div><i class="fa-solid fa-hourglass-half" style="color: #9c27b0; width: 18px;"></i> <strong>Fasting:</strong> ${fastingCompleted ? `Active (${fastingType})` : 'None'}</div>
                    </div>
                </div>
            </div>

            <!-- Nutrition, Meals & Uploaded Photos -->
            <div class="glass-card" style="padding: 1.2rem; margin-bottom: 1.5rem;">
                <h4 style="color: var(--clr-primary-green); font-family: var(--font-brand); margin-bottom: 1rem; border-bottom: 1.5px solid var(--clr-accent-green); padding-bottom: 4px;">
                    <i class="fa-solid fa-utensils"></i> Meal Tracker & Attached Progress Photo
                </h4>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; align-items: start;">
                    <div>
                        <div style="font-size: 0.9rem; display: flex; flex-direction: column; gap: 0.6rem;">
                            <div><strong>Breakfast:</strong> ${log.meals?.breakfast?.desc || 'None logged'} <em style="color:#777;">(${log.meals?.breakfast?.portion || '--'})</em></div>
                            <div><strong>Lunch:</strong> ${log.meals?.lunch?.desc || 'None logged'} <em style="color:#777;">(${log.meals?.lunch?.portion || '--'})</em></div>
                            <div><strong>Dinner:</strong> ${log.meals?.dinner?.desc || 'None logged'} <em style="color:#777;">(${log.meals?.dinner?.portion || '--'})</em></div>
                            <div><strong>Snacks:</strong> ${log.meals?.snacks?.desc || 'None logged'} <em style="color:#777;">(${log.meals?.snacks?.portion || '--'})</em></div>
                        </div>
                    </div>
                    <div>
                        <div style="font-weight: 600; font-size: 0.85rem; color: #555; margin-bottom: 0.5rem;">Submitted Progress / Meal Photo:</div>
                        ${photo ? `
                            <div style="position: relative; display: inline-block; cursor: pointer; border-radius: var(--radius-sm); overflow: hidden; border: 2px solid var(--clr-primary-green); box-shadow: 0 4px 12px rgba(0,0,0,0.1);" onclick="app.openLightbox('${photo}', 'Submission photo by ${log.userEmail} on ${new Date(log.timestamp).toLocaleDateString()}')">
                                <img src="${photo}" alt="Progress/Meal Photo" style="width: 160px; height: 160px; object-fit: cover; display: block;">
                                <div style="position: absolute; bottom: 0; inset-inline: 0; background: rgba(0,0,0,0.65); color: white; font-size: 0.72rem; text-align: center; padding: 3px 4px;">
                                    <i class="fa-solid fa-magnifying-glass-plus"></i> Click to Enlarge
                                </div>
                            </div>
                        ` : `
                            <div style="background: rgba(0,0,0,0.03); border: 1px dashed #ccc; border-radius: var(--radius-sm); padding: 1.5rem; text-align: center; color: #888; font-size: 0.85rem;">
                                <i class="fa-solid fa-image" style="font-size: 1.5rem; margin-bottom: 4px; display: block;"></i>
                                No photo was attached with this submission
                            </div>
                        `}
                    </div>
                </div>
            </div>

            <!-- Journaling & Reflections -->
            <div class="glass-card" style="padding: 1.2rem;">
                <h4 style="color: var(--clr-primary-green); font-family: var(--font-brand); margin-bottom: 0.8rem; border-bottom: 1.5px solid var(--clr-accent-green); padding-bottom: 4px;">
                    <i class="fa-solid fa-book-journal-whills"></i> Affirmations, Gratitude & Journal Entries
                </h4>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1.2rem; font-size: 0.9rem;">
                    <div>
                        <strong style="color: var(--clr-primary-green); display: block; margin-bottom: 4px;"><i class="fa-solid fa-sparkles"></i> Daily Affirmations:</strong>
                        <ul style="padding-left: 1.2rem; margin: 0;">
                            ${affirmations.length ? affirmations.map(a => `<li>${a}</li>`).join('') : '<li style="color:#888;">None logged</li>'}
                        </ul>
                    </div>
                    <div>
                        <strong style="color: var(--clr-primary-green); display: block; margin-bottom: 4px;"><i class="fa-solid fa-heart"></i> Gratitudes:</strong>
                        <ul style="padding-left: 1.2rem; margin: 0;">
                            ${gratitudes.length ? gratitudes.map(g => `<li>${g}</li>`).join('') : '<li style="color:#888;">None logged</li>'}
                        </ul>
                    </div>
                    <div>
                        <strong style="color: var(--clr-primary-green); display: block; margin-bottom: 4px;"><i class="fa-solid fa-bullseye"></i> Top Daily Goals:</strong>
                        <ul style="padding-left: 1.2rem; margin: 0;">
                            ${goals.length ? goals.map(g => `<li>${g}</li>`).join('') : '<li style="color:#888;">None logged</li>'}
                        </ul>
                    </div>
                    <div>
                        <strong style="color: var(--clr-primary-green); display: block; margin-bottom: 4px;"><i class="fa-solid fa-feather"></i> Evening Reflections:</strong>
                        <ul style="padding-left: 1.2rem; margin: 0;">
                            ${reflections.length ? reflections.map(r => `<li>${r}</li>`).join('') : '<li style="color:#888;">None logged</li>'}
                        </ul>
                    </div>
                </div>
            </div>
        `;
    },

    closeAdminClientLogsModal() {
        const modal = document.getElementById('admin-client-logs-modal');
        if (modal) modal.style.display = 'none';
    },

    openAdminHealthProfile(email) {
        const user = this.db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
        if (!user) return;

        // Default health profile if missing
        if (!user.healthProfile) {
            user.healthProfile = {
                height: user.height || 170,
                weight: user.weight || 155.4,
                bloodGroup: user.bloodGroup || 'Unknown',
                dietPreference: user.dietPreference || 'None',
                emergencyName: user.emergencyName || '',
                emergencyPhone: user.emergencyPhone || '',
                allergies: user.allergies || 'None',
                conditions: user.conditions || 'None',
                medications: user.medications || 'None',
                goals: user.goal || 'General health maintenance'
            };
        }

        document.getElementById('health-modal-user-email').value = email;
        document.getElementById('health-modal-user-name').textContent = user.name;
        
        document.getElementById('health-height').value = user.healthProfile.height;
        document.getElementById('health-weight').value = user.healthProfile.weight;
        document.getElementById('health-blood').value = user.healthProfile.bloodGroup;
        document.getElementById('health-diet').value = user.healthProfile.dietPreference;
        document.getElementById('health-emergency-name').value = user.healthProfile.emergencyName;
        document.getElementById('health-emergency-phone').value = user.healthProfile.emergencyPhone;
        document.getElementById('health-allergies').value = user.healthProfile.allergies;
        document.getElementById('health-conditions').value = user.healthProfile.conditions;
        document.getElementById('health-medications').value = user.healthProfile.medications;
        document.getElementById('health-goals').value = user.healthProfile.goals;

        document.getElementById('admin-health-profile-modal').style.display = 'block';
        document.getElementById('admin-health-profile-modal').scrollIntoView({ behavior: 'smooth' });
    },

    saveAdminHealthProfile(e) {
        e.preventDefault();
        const email = document.getElementById('health-modal-user-email').value;
        const user = this.db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
        if (!user) return;

        user.healthProfile = {
            height: parseFloat(document.getElementById('health-height').value) || 170,
            weight: parseFloat(document.getElementById('health-weight').value) || 155.4,
            bloodGroup: document.getElementById('health-blood').value,
            dietPreference: document.getElementById('health-diet').value.trim(),
            emergencyName: document.getElementById('health-emergency-name').value.trim(),
            emergencyPhone: document.getElementById('health-emergency-phone').value.trim(),
            allergies: document.getElementById('health-allergies').value.trim(),
            conditions: document.getElementById('health-conditions').value.trim(),
            medications: document.getElementById('health-medications').value.trim(),
            goals: document.getElementById('health-goals').value.trim()
        };

        // Sync with primary fields
        user.height = user.healthProfile.height;
        user.weight = user.healthProfile.weight;
        user.bloodGroup = user.healthProfile.bloodGroup;
        user.dietPreference = user.healthProfile.dietPreference;
        user.emergencyName = user.healthProfile.emergencyName;
        user.emergencyPhone = user.healthProfile.emergencyPhone;
        user.allergies = user.healthProfile.allergies;
        user.conditions = user.healthProfile.conditions;
        user.medications = user.healthProfile.medications;
        user.goal = user.healthProfile.goals;

        this.saveDatabase();
        this.logAudit(this.currentUser.name, 'Health Profile Updated', `Confidential health data updated for ${email}`);
        alert(`Confidential health biometrics updated successfully for ${user.name}.`);
        document.getElementById('admin-health-profile-modal').style.display = 'none';
        this.renderAdminUsers();
    },

    toggleUserStatus(email) {
        const user = this.db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
        if (!user) return;
        user.status = user.status === 'Active' ? 'Suspended' : 'Active';
        user.updatedAt = new Date().toISOString();
        this.saveDatabase();
        this.renderAdminUsers();
        this.logAudit(this.currentUser.name, 'User Status Modified', `Status for ${email} set to ${user.status}`);
        alert(`User status for ${user.name} toggled to: ${user.status}`);
    },

    adminResetPassword(email) {
        const user = this.db.users.find(u => (u.email || '').toLowerCase().trim() === (email || '').toLowerCase().trim());
        if (!user) return;
        
        const tempPassword = 'LL-' + Math.floor(100000 + Math.random() * 900000);
        user.tempPasswordRaw = tempPassword;
        user.firstLogin = true;
        user.authUpdatedAt = new Date().toISOString();
        user.updatedAt = new Date().toISOString();
        
        // 1. INSTANT (0ms): Re-render admin users table & display Action Center Modal
        this.renderAdminUsers();
        this.openCredentialsModal(user, tempPassword, 'reset');

        // 2. ASYNCHRONOUS (Background): Hash password, save database, & dispatch real email
        setTimeout(async () => {
            try {
                user.password = await this.hashPassword(tempPassword);
                await this.saveDatabase();
                LeanLifeCacheManager.notifyOtherTabs('USERS_UPDATED', { user });

                // Synchronize with authoritative Supabase auth index via user-admin function
                const adminToken = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('leanlife_token')) ||
                                   (typeof localStorage !== 'undefined' && localStorage.getItem('leanlife_token'));
                if (adminToken) {
                    const baseUrl = getApiBaseUrl();
                    fetch(`${baseUrl}/.netlify/functions/user-admin`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
                        body: JSON.stringify({ action: 'admin-reset-password', targetEmail: user.email, tempPassword: tempPassword })
                    }).catch(e => console.warn("[Admin] Cloud reset sync notice:", e));
                }
                
                const emailResult = await this.sendRealEmail(user.name, user.email, 'LeanLife Temporary Credentials Reset', tempPassword, 'reset');
                const deliveryStatus = emailResult && emailResult.ok ? 'Delivered' : 'Failed';

                this.db.emails = this.db.emails || [];
                this.db.emails.unshift({
                    id: 'EML-' + Date.now(),
                    timestamp: new Date().toISOString(),
                    recipient: user.email,
                    subject: 'LeanLife Temporary Credentials Reset',
                    templateName: 'Password Reset',
                    status: deliveryStatus
                });
                await this.saveDatabase();
                
                this.logAudit(this.currentUser.name, 'Admin Password Reset', `Generated temporary password for ${user.email}. Email delivery: ${deliveryStatus}`);
            } catch (err) {
                console.error("Background adminResetPassword error:", err);
            }
        }, 10);
    },

    deleteUser(email) {
        if (!confirm(`Are you sure you want to permanently delete user ${email}?`)) return;
        
        const cleanEmail = email.toLowerCase().trim();
        const idx = this.db.users.findIndex(u => (u.email || '').toLowerCase().trim() === cleanEmail);
        if (idx > -1) {
            this.db.users.splice(idx, 1);
        }

        this.db.deletedUsers = this.db.deletedUsers || [];
        if (!this.db.deletedUsers.includes(cleanEmail)) {
            this.db.deletedUsers.push(cleanEmail);
        }

        this.saveDatabase();
        this.renderAdminUsers();
        this.logAudit(this.currentUser ? this.currentUser.name : 'Admin', 'User Deleted', `Permanently deleted user: ${email}`);
        this.showCustomAlert("User account deleted successfully.", "Account Deleted");
    },

    async handleAdminRegisterMember(e) {
        if (e && typeof e.preventDefault === 'function') {
            e.preventDefault();
        }

        try {
            const name = (document.getElementById('reg-name')?.value || '').trim();
            const email = (document.getElementById('reg-email')?.value || '').trim().replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '').toLowerCase();
            const phone = (document.getElementById('reg-phone')?.value || '').trim();
            const dob = document.getElementById('reg-dob')?.value || '1995-01-01';
            const gender = document.getElementById('reg-gender')?.value || 'Female';
            const coach = document.getElementById('reg-coach')?.value || 'sarah';

            if (!name || !email) {
                this.showCustomAlert("Please enter member full name and valid email address.", "Required Fields", "fa-circle-exclamation");
                return;
            }

            // Check if user already exists
            const existingUser = this.db.users.find(u => (u.email || '').toLowerCase().trim() === email);
            if (existingUser) {
                this.showCustomAlert(`A user with email "${email}" is already registered on LeanLife.`, "Account Exists", "fa-triangle-exclamation");
                return;
            }

            // Generate secure temporary credentials (LL-XXXXXX)
            const username = email.split('@')[0];
            const tempPassword = 'LL-' + Math.floor(100000 + Math.random() * 900000);
            const hashedPassword = await this.hashPassword(tempPassword);

            const newMember = {
                name: name,
                email: email,
                password: hashedPassword,
                tempPasswordRaw: tempPassword,
                role: 'member',
                phone: phone,
                dob: dob,
                gender: gender,
                preferredCoach: coach,
                status: 'Active',
                firstLogin: true,
                height: 170,
                weight: 155.4,
                goal: 'General Wellness',
                avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop',
                streakCount: 0,
                authUpdatedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                healthProfile: {
                    height: 170,
                    weight: 155.4,
                    bloodGroup: 'Unknown',
                    dietPreference: 'None',
                    emergencyName: '',
                    emergencyPhone: '',
                    allergies: 'None',
                    conditions: 'None',
                    medications: 'None',
                    goals: 'General Wellness'
                }
            };

            // 1. INSTANT: Add user to local directory at top of list
            this.db.users.unshift(newMember);

            // 2. Persist to cache & database
            await this.saveDatabase();
            LeanLifeCacheManager.notifyOtherTabs('USERS_UPDATED', { user: newMember });

            // Background: Synchronize credentials with serverless user-admin endpoint if admin session token exists
            const sessionToken = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('leanlife_token')) ||
                                 (typeof localStorage !== 'undefined' && localStorage.getItem('leanlife_token'));
            if (sessionToken) {
                const baseUrl = getApiBaseUrl();
                fetch(`${baseUrl}/.netlify/functions/user-admin`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${sessionToken}`
                    },
                    body: JSON.stringify({
                        action: 'admin-register-member',
                        token: sessionToken,
                        memberData: {
                            name: newMember.name,
                            email: newMember.email,
                            phone: newMember.phone,
                            role: newMember.role
                        }
                    })
                }).catch(e => console.warn("[App] Background member sync notice:", e));
            }

            // 3. Clear search/filters & reset form
            const searchInput = document.getElementById('admin-user-search');
            if (searchInput) searchInput.value = '';
            const statusInput = document.getElementById('admin-user-filter-status');
            if (statusInput) statusInput.value = 'all';
            document.getElementById('admin-register-form')?.reset();

            // 4. Re-render admin user table so user appears at top of list immediately
            this.renderAdminUsers();

            // 5. Display dedicated Credentials Action Center modal (Copy & WhatsApp ready)
            this.openCredentialsModal(newMember, tempPassword, 'created');

            // 6. ASYNCHRONOUS (Background): Dispatch real onboarding email
            const outboxId = 'EML-' + Date.now();
            this.db.emails = this.db.emails || [];
            this.db.emails.unshift({
                id: outboxId,
                timestamp: new Date().toISOString(),
                recipient: email,
                subject: 'Welcome to LeanLife Onboarding',
                templateName: 'Welcome Email',
                status: 'Pending'
            });
            this.saveDatabase(true);

            this.sendRealEmail(name, email, 'Welcome to LeanLife Onboarding', tempPassword, 'welcome')
                .then(emailResult => {
                    const deliveryStatus = emailResult && emailResult.ok ? 'Delivered' : 'Failed';
                    const rec = this.db.emails.find(item => item.id === outboxId);
                    if (rec) {
                        rec.status = deliveryStatus;
                        this.saveDatabase(true);
                    }
                    this.logAudit(this.currentUser ? this.currentUser.name : 'Admin', 'Admin Registered User', `Registered user ${email} with temporary credentials. Email delivery: ${deliveryStatus}`);
                    this.renderAdminUsers();
                })
                .catch(bgErr => {
                    console.error("Background registration task error:", bgErr);
                });
        } catch (err) {
            console.error("Error in handleAdminRegisterMember:", err);
            this.showCustomAlert("An error occurred while creating the member account: " + (err.message || err), "Error", "fa-circle-exclamation");
        }
    },

    renderAdminLogsCMS() {
        const tbody = document.getElementById('admin-logs-cms-tbody');
        if (!tbody) return;

        const query = (document.getElementById('admin-logs-search')?.value || '').toLowerCase().trim();

        if (!this.db.wellnessLogs || this.db.wellnessLogs.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 2rem; color: #888;">No wellness logs found in repository.</td></tr>`;
            return;
        }

        let html = '';
        const sortedLogs = [...(this.db.wellnessLogs || [])].sort((a, b) => 
            new Date(b.timestamp || b.updatedAt || b.date || 0) - new Date(a.timestamp || a.updatedAt || a.date || 0)
        );

        sortedLogs.forEach(r => {
            const userEmail = (r.userEmail || r.user_email || r.email || '').toLowerCase();
            const mood = (r.mood || 'happy').toLowerCase();
            const exerciseType = (r.exercise?.type || 'None').toLowerCase();

            if (query && !userEmail.includes(query) && !mood.includes(query) && !exerciseType.includes(query)) return;

            const sleepDuration = (r.sleep && typeof r.sleep === 'object' ? r.sleep.duration : r.sleep) || '8.0';
            const sleepQuality = (r.sleep && typeof r.sleep === 'object' && r.sleep.quality) ? r.sleep.quality : 'Restful';
            const waterGlasses = r.waterCount || 8;
            const steps = r.steps || 0;
            const isExercise = r.exerciseCompleted === 'yes' || r.exercise?.completed === 'yes';
            const logTime = r.timestamp || r.updatedAt || r.date || '';
            const dateStr = logTime && !isNaN(new Date(logTime)) ? new Date(logTime).toLocaleDateString() : 'Recent';
            const timeStr = (logTime && logTime.includes('T') && !isNaN(new Date(logTime))) ? new Date(logTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

            html += `
                <tr>
                    <td>${dateStr} ${timeStr}</td>
                    <td style="font-weight:600; color: var(--clr-primary-green);">${r.userEmail || r.user_email || r.email || 'Member'}</td>
                    <td>${sleepDuration} hrs (${sleepQuality})</td>
                    <td>${waterGlasses * 8} oz (${waterGlasses} gl)</td>
                    <td>${steps.toLocaleString()}</td>
                    <td><span style="text-transform: capitalize;">${r.mood || 'happy'}</span></td>
                    <td>${isExercise ? (r.exercise?.type || 'General') : 'None'}</td>
                    <td>
                        <button class="btn btn-secondary" style="padding:0.25rem 0.5rem; font-size:0.75rem;" onclick="app.openAdminLogDetails('${r.id}')"><i class="fa-solid fa-eye"></i> View</button>
                    </td>
                </tr>
            `;
        });
        tbody.innerHTML = html || `<tr><td colspan="8" style="text-align:center; padding: 2rem; color: #888;">No logs matching "${query}".</td></tr>`;
    },

    openAdminLogDetails(logId) {
        try {
            const r = this.db.wellnessLogs.find(log => log.id === logId);
            if (!r) {
                alert("Log record not found.");
                return;
            }

            const modal = document.getElementById('admin-log-detail-modal');
            const container = document.getElementById('admin-log-detail-content');
            if (!modal || !container) return;

            const metrics = r.metrics || {};
            const weightLbs = metrics.weight || r.weight || 155.4;
            const bmiVal = metrics.bmi || '22.5';
            const bodyFat = metrics.bodyFat || '18.5';
            const visceralFat = metrics.visceralFat || metrics.visceraFat || '10.0';
            const skeletalMuscle = metrics.skeletalMuscle || '66.1';
            const leanMass = metrics.leanMass || '110.2';
            const bloodPressure = metrics.bloodPressure || '120/80';
            const bloodSugar = metrics.bloodSugar || 95;
            const heartRate = metrics.heartRate || 65;
            const outdoorTime = metrics.outdoorTime || r.outdoorTime || 45;
            const sunlight = metrics.sunlight || r.sunlight || 20;
            const meditation = metrics.meditation || r.meditation || 15;
            const screenTime = metrics.screenTime || r.screenTime || 4.5;

            const sleepDuration = (r.sleep && typeof r.sleep === 'object' ? r.sleep.duration : r.sleep) || '8.0';
            const sleepQuality = (r.sleep && typeof r.sleep === 'object' && r.sleep.quality) ? r.sleep.quality : 'Restful';

            const affirmations = r.affirmations?.length ? r.affirmations.join('; ') : (r.journal?.affirmation || 'None logged');
            const gratitudes = r.gratitudes?.length ? r.gratitudes.join('; ') : (r.journal?.gratitude || 'None logged');
            const reflections = r.reflections?.length ? r.reflections.join('; ') : (r.journal?.reflections || 'None logged');

            const photo = r.photoUrl || (r.photos && r.photos[0]) || (r.meals && r.meals.photo) || '';

            container.innerHTML = `
                <div>
                    <h4 style="color:var(--clr-primary-green); margin-bottom: 0.8rem; border-bottom:1px solid #eee; padding-bottom:4px;">Core Biometrics & Metrics (US lbs)</h4>
                    <p><strong>Member:</strong> ${r.userEmail || 'Client'}</p>
                    <p><strong>Logged Time:</strong> ${new Date(r.timestamp).toLocaleString()}</p>
                    <p><strong>Origin Device:</strong> ${r.device || 'Mobile / Web'}</p>
                    <p><strong>Weight:</strong> <strong>${weightLbs} lbs</strong> (BMI: ${bmiVal})</p>
                    <p><strong>Body Composition:</strong> Fat: ${bodyFat}% | Visceral: ${visceralFat}%</p>
                    <p><strong>Muscle & Lean Mass:</strong> Skeletal: ${skeletalMuscle} lbs | Lean: ${leanMass} lbs</p>
                    <p><strong>Vitals:</strong> BP: ${bloodPressure} | Sugar: ${bloodSugar} mg/dL | HR: ${heartRate} bpm</p>
                    <p><strong>Mood / Streak:</strong> <span style="text-transform:capitalize;">${r.mood || 'happy'}</span> (${r.streakCount || 1} day streak)</p>
                </div>
                <div>
                    <h4 style="color:var(--clr-primary-green); margin-bottom: 0.8rem; border-bottom:1px solid #eee; padding-bottom:4px;">Sleep, Habits & Activity</h4>
                    <p><strong>Sleep Duration:</strong> ${sleepDuration} Hours (${sleepQuality})</p>
                    <p><strong>Daily Steps:</strong> ${(r.steps || 0).toLocaleString()} steps</p>
                    <p><strong>Outdoor & Sunlight:</strong> Outdoor: ${outdoorTime} mins | Sunlight: ${sunlight} mins</p>
                    <p><strong>Meditation:</strong> ${meditation} mins</p>
                    <p><strong>Exercise:</strong> ${r.exerciseCompleted === 'yes' || r.exercise?.completed === 'yes' ? `${r.exercise?.type || 'General'} (${r.exercise?.duration || 30} mins, ${r.exercise?.intensity || 'Moderate'})` : 'Rest Day'}</p>
                    <p><strong>Hydration:</strong> ${r.waterCount || 8} Glasses (${(r.waterCount || 8) * 8} oz)</p>
                    <p><strong>Screen Time:</strong> ${screenTime} Hours</p>
                </div>
                <div style="grid-column: span 2;">
                    <h4 style="color:var(--clr-primary-green); margin-bottom: 0.8rem; border-bottom:1px solid #eee; padding-bottom:4px;">Journals & Reflections</h4>
                    <p><strong>Daily Affirmation:</strong> <em>"${affirmations}"</em></p>
                    <p><strong>Gratitude List:</strong> <em>"${gratitudes}"</em></p>
                    <p><strong>Personal Reflections:</strong> <em>"${reflections}"</em></p>
                    ${photo ? `
                        <div style="margin-top: 1rem;">
                            <strong>Submitted Progress / Meal Photo:</strong>
                            <div style="margin-top: 0.5rem; display: inline-block; cursor: pointer;" onclick="app.openLightbox('${photo}', 'Submission photo by ${r.userEmail}')">
                                <img src="${photo}" alt="Progress Photo" style="width: 140px; height: 140px; object-fit: cover; border-radius: 8px; border: 2px solid var(--clr-primary-green);">
                            </div>
                        </div>
                    ` : ''}
                </div>
            `;

            modal.style.display = 'block';
            modal.scrollIntoView({ behavior: 'smooth' });
        } catch (err) {
            console.error("Error opening log details:", err);
            alert("Could not load log details: " + err.message);
        }
    },

    renderAdminReportsCMS() {
        const tbody = document.getElementById('admin-reports-cms-tbody');
        if (!tbody) return;

        const query = (document.getElementById('admin-reports-search')?.value || '').toLowerCase();

        let html = '';
        this.db.aiReports.forEach(r => {
            if (query && !r.userEmail.toLowerCase().includes(query) && !r.grade.toLowerCase().includes(query)) return;

            html += `
                <tr>
                    <td>${new Date(r.timestamp).toLocaleDateString()}</td>
                    <td style="font-weight:600;">${r.userEmail}</td>
                    <td><strong style="color:var(--clr-primary-green);">${r.overallScore}</strong></td>
                    <td><strong>${r.grade}</strong></td>
                    <td>${r.categories?.sleep || 80}</td>
                    <td>${r.categories?.hydration || 80}</td>
                    <td>${r.categories?.nutrition || 80}</td>
                    <td>
                        <div style="display:flex; gap:0.4rem;">
                            <button class="btn btn-secondary" style="padding:0.25rem 0.5rem; font-size:0.75rem;" onclick="app.navigateTo('ai-report', {reportId: '${r.id}'})"><i class="fa-solid fa-eye"></i> View</button>
                            <button class="btn btn-outline" style="padding:0.25rem 0.5rem; font-size:0.75rem; color:var(--clr-text-dark); border-color:rgba(0,0,0,0.15);" onclick="app.downloadReportPDF('${r.id}')"><i class="fa-solid fa-file-pdf"></i> PDF</button>
                        </div>
                    </td>
                </tr>
            `;
        });
        tbody.innerHTML = html;
    },

    renderAdminEmailsCMS() {
        // Outbox log table
        const tbody = document.getElementById('admin-emails-tbody');
        if (tbody) {
            let html = '';
            this.db.emails.forEach(e => {
                html += `
                    <tr>
                        <td style="font-size:0.8rem; color:#666;">${new Date(e.timestamp).toLocaleString()}</td>
                        <td style="font-weight:600;">${e.recipient}</td>
                        <td>${e.subject}</td>
                        <td><span style="font-family:var(--font-brand); font-weight:600;">${e.templateName}</span></td>
                        <td><span style="background:#28a745; color:white; padding:2px 6px; border-radius:10px; font-size:0.7rem; font-weight:bold;">${e.status}</span></td>
                    </tr>
                `;
            });
            tbody.innerHTML = html;
        }

        // Recipient dropdown populating
        const select = document.getElementById('notif-recipient');
        if (select) {
            let optionsHtml = '<option value="all">All Members (Global Broadcast)</option>';
            this.db.users.forEach(u => {
                if (u.role === 'member') {
                    optionsHtml += `<option value="${u.email}">${u.name} (${u.email})</option>`;
                }
            });
            select.innerHTML = optionsHtml;
        }
    },

    handleAdminSendNotification(e) {
        e.preventDefault();
        const recipient = document.getElementById('notif-recipient').value;
        const msgText = document.getElementById('notif-message').value.trim();

        if (!msgText) return;

        const newNotif = {
            id: 'NTF-' + Date.now(),
            timestamp: new Date().toISOString(),
            recipient: recipient,
            message: msgText,
            read: false
        };

        this.db.notifications.unshift(newNotif);
        this.saveDatabase();
        this.logAudit(this.currentUser.name, 'Admin Broadcast Sent', `Alert sent to: ${recipient}`);
        
        alert(`Success! Notification alert has been dispatched to ${recipient === 'all' ? 'all LeanLife users' : recipient}.`);
        document.getElementById('notif-message').value = '';
    },

    renderAdminModerationCMS() {
        const tbody = document.getElementById('admin-moderation-cms-tbody');
        if (!tbody) return;

        let html = '';
        this.db.posts.forEach(p => {
            html += `
                <tr>
                    <td style="font-weight:600;">${p.author}</td>
                    <td>${p.category}</td>
                    <td>${p.title}</td>
                    <td>
                        <span style="background:${p.status === 'approved' ? '#28a745' : '#f77f00'}; color:white; padding:4px 8px; border-radius:12px; font-size:0.75rem; font-weight:bold;">
                            ${p.status.toUpperCase()}
                        </span>
                    </td>
                    <td>${p.likes} likes, ${p.comments.length} comments</td>
                    <td>
                        <div style="display:flex; gap:0.4rem;">
                            <button class="btn btn-secondary" style="padding:0.25rem 0.5rem; font-size:0.75rem;" onclick="app.approvePost('${p.id}')">Approve</button>
                            <button class="btn btn-danger" style="padding:0.25rem 0.5rem; font-size:0.75rem;" onclick="app.deletePost('${p.id}')">Delete</button>
                        </div>
                    </td>
                </tr>
            `;
        });
        tbody.innerHTML = html;
    },

    approvePost(postId) {
        const post = this.db.posts.find(p => p.id === postId);
        if (!post) return;
        post.status = 'approved';
        post.updatedAt = new Date().toISOString();
        this.saveDatabase();
        this.renderAdminModerationCMS();
        this.logAudit(this.currentUser ? this.currentUser.name : 'Admin', 'Post Approved', `Approved post: "${post.title}"`);
        alert(`Post "${post.title}" has been approved and published to the community feed.`);
    },

    deletePost(postId) {
        const idx = this.db.posts.findIndex(p => p.id === postId);
        if (idx === -1) return;
        const title = this.db.posts[idx].title;
        if (!confirm(`Are you sure you want to delete the post "${title}"?`)) return;
        this.db.posts.splice(idx, 1);
        this.saveDatabase();
        this.renderAdminModerationCMS();
        this.logAudit(this.currentUser ? this.currentUser.name : 'Admin', 'Post Deleted', `Deleted post: "${title}"`);
        alert(`Post "${title}" has been deleted.`);
    },

    renderAdminEventsCMS() {
        const tbody = document.getElementById('admin-events-tbody');
        if (!tbody) return;

        let html = '';
        this.db.events.forEach(evt => {
            html += `
                <tr>
                    <td>${evt.date} (${evt.time})</td>
                    <td><strong>${evt.category}</strong></td>
                    <td style="font-weight:600;">${evt.title}</td>
                    <td>${evt.description}</td>
                    <td><strong style="color:var(--clr-primary-green);">${evt.rsvp.length} RSVPs</strong></td>
                    <td>
                        <button class="btn btn-danger" style="padding:0.25rem 0.5rem; font-size:0.75rem;" onclick="app.deleteAdminEvent('${evt.id}')"><i class="fa-solid fa-trash-can"></i> Delete</button>
                    </td>
                </tr>
            `;
        });
        tbody.innerHTML = html;
    },

    handleAdminAddEvent(e) {
        e.preventDefault();
        const title = document.getElementById('event-title').value.trim();
        const datetimeVal = document.getElementById('event-datetime').value;
        const category = document.getElementById('event-category').value;
        const desc = document.getElementById('event-desc').value.trim();

        if (!title || !datetimeVal) return;

        const dateObj = new Date(datetimeVal);
        const dateStr = dateObj.toISOString().split('T')[0];
        const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const newEvent = {
            id: 'EVT-' + Date.now(),
            title: title,
            category: category,
            date: dateStr,
            time: timeStr,
            countdown: 'Upcoming',
            description: desc,
            rsvp: [],
            link: 'https://meet.google.com/leanlife-session'
        };

        this.db.events.unshift(newEvent);
        
        // Add global notification
        this.db.notifications.unshift({
            id: 'NTF-' + Date.now(),
            timestamp: new Date().toISOString(),
            recipient: 'all',
            message: `📅 New Event Added: "${title}" scheduled on ${dateStr} at ${timeStr}. RSVP now!`,
            read: false
        });

        this.saveDatabase();
        this.logAudit(this.currentUser.name, 'Admin Event Added', `Notice Board event published: ${title}`);
        alert(`Notice Board Event "${title}" published and global alert dispatched!`);
        
        document.getElementById('event-title').value = '';
        document.getElementById('event-desc').value = '';
        this.renderAdminEventsCMS();
    },

    deleteAdminEvent(evtId) {
        if (!confirm("Are you sure you want to delete this event?")) return;
        const idx = this.db.events.findIndex(e => e.id === evtId);
        if (idx > -1) {
            const title = this.db.events[idx].title;
            this.db.events.splice(idx, 1);
            this.saveDatabase();
            this.logAudit(this.currentUser.name, 'Admin Event Deleted', `Deleted notice board event: ${title}`);
            this.renderAdminEventsCMS();
            alert("Event deleted successfully.");
        }
    },

    renderAdminCoachesCMS() {
        const tbody = document.getElementById('admin-coaches-tbody');
        if (!tbody) return;

        const coaches = [
            { name: 'Coach Francess Orenuga', key: 'sarah', hours: 'Mon - Fri, 9:00 AM - 5:00 PM EST', link: 'https://wa.me/17575130205?text=Hello%20Coach%20Francess,%20I%20am%20a%20member%20of%20LeanLife%20and%20would%20love%20to%20discuss%20my%20wellness%20plan.' }
        ];

        let html = '';
        coaches.forEach(c => {
            const assignedCount = this.db.users.filter(u => u.preferredCoach === c.key && u.role === 'member').length;
            const apptCount = this.db.appointments.filter(a => a.preferredCoach === c.key || (c.key === 'sarah' && a.id.startsWith('APT-'))).length;

            html += `
                <tr>
                    <td style="font-weight:600;"><i class="fa-solid fa-user-tie" style="color:var(--clr-primary-green);"></i> ${c.name}</td>
                    <td><strong style="color:var(--clr-primary-green);">${assignedCount} members</strong></td>
                    <td>${apptCount} booked</td>
                    <td><a href="${c.link}" target="_blank" style="color:#25d366; text-decoration:none;"><i class="fa-brands fa-whatsapp"></i> Chat Profile</a></td>
                    <td style="font-size:0.85rem; color:#555;">${c.hours}</td>
                    <td><span style="background:#28a745; color:white; padding:4px 8px; border-radius:12px; font-size:0.75rem; font-weight:bold;">Active</span></td>
                </tr>
            `;
        });
        tbody.innerHTML = html;
        this.renderBlockedDatesAdmin();
    },

    renderBlockedDatesAdmin() {
        const list = document.getElementById('admin-blocked-dates-list');
        if (!list) return;
        const blocked = (this.db.blockedDates || []).filter(d => d.status === 'blocked');
        if (blocked.length === 0) {
            list.innerHTML = `<li style="list-style:none; color:#777; font-style:italic;">No dates blocked.</li>`;
            return;
        }
        list.innerHTML = blocked.map(d => `
            <li style="display: flex; justify-content: space-between; align-items: center; max-width: 300px; padding: 4px 8px; background: rgba(0,0,0,0.03); border-radius: 4px;">
                <span>${new Date(d.date).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })}</span>
                <button class="btn btn-secondary" style="padding: 2px 6px; font-size: 0.8rem;" onclick="app.unblockDate('${d.date}')"><i class="fa-solid fa-trash-can" style="color:#d9534f;"></i></button>
            </li>
        `).join('');
    },

    async handleBlockDate(e) {
        e.preventDefault();
        const dateInput = document.getElementById('block-date-input');
        if (!dateInput) return;
        const dateStr = dateInput.value;
        if (!dateStr) return;

        this.db.blockedDates = this.db.blockedDates || [];
        let existing = this.db.blockedDates.find(d => d.id === dateStr);
        if (!existing || existing.status === 'unblocked') {
            if (!existing) {
                existing = { id: dateStr, date: dateStr };
                this.db.blockedDates.push(existing);
            }
            existing.status = 'blocked';
            existing.updatedAt = new Date().toISOString();
            await this.saveDatabase();
            this.renderBlockedDatesAdmin();
            this.logAudit(this.currentUser.name, 'Date Blocked', `Blocked consultation bookings on: ${dateStr}`);
            alert(`Successfully blocked consultations on: ${dateStr}`);
            dateInput.value = '';
        } else {
            alert("This date is already blocked!");
        }
    },

    async unblockDate(dateStr) {
        if (!confirm(`Are you sure you want to unblock consultation bookings for ${dateStr}?`)) return;
        this.db.blockedDates = this.db.blockedDates || [];
        const existing = this.db.blockedDates.find(d => d.id === dateStr);
        if (existing) {
            existing.status = 'unblocked';
            existing.updatedAt = new Date().toISOString();
            await this.saveDatabase();
            this.renderBlockedDatesAdmin();
            this.logAudit(this.currentUser.name, 'Date Unblocked', `Unblocked consultation bookings on: ${dateStr}`);
            alert(`Successfully unblocked consultations on: ${dateStr}`);
        }
    },

    // ==================== CLINIC APPOINTMENT TRACKING & COACH WHATSAPP REMINDERS ====================
    getAppointmentTimeRemaining(appt) {
        if (!appt || !appt.date || !appt.time) return null;
        try {
            let [year, month, day] = appt.date.split('-').map(Number);
            if (!year || !month || !day) {
                const parsed = new Date(appt.date);
                if (isNaN(parsed.getTime())) return null;
                year = parsed.getFullYear();
                month = parsed.getMonth() + 1;
                day = parsed.getDate();
            }
            
            let hours = 9;
            let minutes = 0;
            const timeStr = String(appt.time).trim();
            const isPM = /pm/i.test(timeStr);
            const isAM = /am/i.test(timeStr);
            const cleanTime = timeStr.replace(/am|pm/gi, '').trim();
            const parts = cleanTime.split(':').map(Number);
            
            if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                hours = parts[0];
                minutes = parts[1];
                if (isPM && hours < 12) hours += 12;
                if (isAM && hours === 12) hours = 0;
            } else if (parts.length === 1 && !isNaN(parts[0])) {
                hours = parts[0];
                if (isPM && hours < 12) hours += 12;
                if (isAM && hours === 12) hours = 0;
            }

            const apptDate = new Date(year, month - 1, day, hours, minutes, 0);
            const now = new Date();
            const diffMs = apptDate.getTime() - now.getTime();
            const hoursRemaining = diffMs / (1000 * 60 * 60);

            let humanRemaining = '';
            if (hoursRemaining < -2) {
                humanRemaining = 'Passed';
            } else if (hoursRemaining < 0) {
                humanRemaining = 'Happening Now';
            } else if (hoursRemaining < 1) {
                const mins = Math.max(1, Math.round(diffMs / (1000 * 60)));
                humanRemaining = `In ${mins} min${mins === 1 ? '' : 's'}`;
            } else if (hoursRemaining <= 24) {
                const hrs = Math.round(hoursRemaining);
                humanRemaining = `In ~${hrs} hr${hrs === 1 ? '' : 's'}`;
            } else {
                const days = Math.round(hoursRemaining / 24);
                humanRemaining = `In ~${days} day${days === 1 ? '' : 's'}`;
            }

            return {
                apptDate,
                diffMs,
                hoursRemaining,
                humanRemaining,
                isWithin24h: hoursRemaining <= 24 && hoursRemaining > 1,
                isWithin1h: hoursRemaining <= 1 && hoursRemaining > -2,
                isPassed: hoursRemaining <= -2
            };
        } catch (e) {
            console.warn("Error parsing appointment date/time:", e);
            return null;
        }
    },

    getCoachAppointmentWhatsAppUrl(appt, type = 'booking') {
        const coachPhone = '17575130205';
        let message = '';
        
        if (type === 'reminder1h') {
            message = `⚡ *LeanLife Clinic — URGENT 1-Hour Appointment Reminder*\n\nHello Coach Francess,\n\nYou have a clinic consultation starting in approximately 1 hour:\n\n👤 *Patient:* ${appt.userName}\n📧 *Email:* ${appt.userEmail}\n📅 *Date:* ${appt.date}\n⏰ *Time:* ${appt.time}\n💻 *Mode:* ${appt.mode}\n📝 *Notes:* ${appt.notes || 'None provided'}\n\nPlease prepare for consultation.`;
        } else if (type === 'reminder24h') {
            message = `🔔 *LeanLife Clinic — 24-Hour Appointment Reminder*\n\nHello Coach Francess,\n\nYou have an upcoming clinic appointment scheduled for tomorrow:\n\n👤 *Patient:* ${appt.userName}\n📧 *Email:* ${appt.userEmail}\n📅 *Date:* ${appt.date}\n⏰ *Time:* ${appt.time}\n💻 *Mode:* ${appt.mode}\n📝 *Notes:* ${appt.notes || 'None provided'}\n\nPlease check your Coach Dashboard to review the patient details.`;
        } else {
            message = `📅 *LeanLife Clinic — New Appointment Notification*\n\nHello Coach Francess,\n\nA new consultation has been booked with LeanLife Clinic:\n\n👤 *Patient:* ${appt.userName}\n📧 *Email:* ${appt.userEmail}\n📅 *Date:* ${appt.date}\n⏰ *Time:* ${appt.time}\n💻 *Mode:* ${appt.mode}\n📝 *Notes:* ${appt.notes || 'None provided'}\n\nPlease check your Coach Portal to confirm this consultation.`;
        }

        return `https://wa.me/${coachPhone}?text=${encodeURIComponent(message)}`;
    },

    sendCoachAppointmentWhatsApp(apptId, type = 'booking') {
        if (!this.db || !this.db.appointments) return;
        const appt = this.db.appointments.find(a => a.id === apptId);
        if (!appt) {
            alert("Appointment not found.");
            return;
        }

        const nowIso = new Date().toISOString();
        if (type === 'reminder24h') {
            appt.reminder24hSent = true;
            appt.reminder24hTimestamp = nowIso;
        } else if (type === 'reminder1h') {
            appt.reminder1hSent = true;
            appt.reminder1hTimestamp = nowIso;
        } else {
            appt.notifiedCoach = true;
            appt.notifiedCoachTimestamp = nowIso;
        }

        this.saveDatabase();
        this.logAudit(this.currentUser.name, 'WhatsApp Reminder Dispatched', `Dispatched ${type} for appointment ${appt.id} (${appt.userName}) to Coach Francess Orenuga (+1 757-513-0205)`);

        const url = this.getCoachAppointmentWhatsAppUrl(appt, type);
        window.open(url, '_blank');

        this.renderAdminAppointmentsCMS();
        this.updateAppointmentNotificationBadges();
    },

    updateAppointmentStatus(apptId, newStatus) {
        if (!this.db || !this.db.appointments) return;
        const appt = this.db.appointments.find(a => a.id === apptId);
        if (!appt) return;

        const oldStatus = appt.status;
        appt.status = newStatus;
        appt.updatedAt = new Date().toISOString();
        this.saveDatabase();

        this.logAudit(this.currentUser.name, 'Appointment Status Changed', `Updated appointment ${appt.id} (${appt.userName}) from ${oldStatus} to ${newStatus}`);
        
        this.renderAdminAppointmentsCMS();
        this.updateAppointmentNotificationBadges();
    },

    checkAppointmentReminders(manual = false) {
        if (!this.db || !Array.isArray(this.db.appointments)) return;

        let triggered24h = 0;
        let triggered1h = 0;
        let modified = false;
        const nowIso = new Date().toISOString();

        this.db.appointments.forEach(appt => {
            if (appt.status === 'Cancelled' || appt.status === 'Completed') return;

            const timeInfo = this.getAppointmentTimeRemaining(appt);
            if (!timeInfo) return;

            // 1-Day (24-Hour) Ahead Reminder
            if (timeInfo.isWithin24h && !appt.reminder24hSent) {
                appt.reminder24hSent = true;
                appt.reminder24hTimestamp = nowIso;
                appt.coachViewed = false; // Trigger notification badge
                triggered24h++;
                modified = true;
                this.logAudit('System', '24h Appointment Reminder Triggered', `Queued 24h reminder for Coach Francess (+1 757-513-0205) for patient ${appt.userName} on ${appt.date}`);
            }

            // 1-Hour Ahead Urgent Reminder
            if (timeInfo.isWithin1h && !appt.reminder1hSent) {
                appt.reminder1hSent = true;
                appt.reminder1hTimestamp = nowIso;
                appt.coachViewed = false; // Trigger urgent notification badge
                triggered1h++;
                modified = true;
                this.logAudit('System', '1h Appointment Reminder Triggered', `Queued 1h urgent reminder for Coach Francess (+1 757-513-0205) for patient ${appt.userName} at ${appt.time}`);
            }
        });

        if (modified) {
            this.saveDatabase();
            this.updateAppointmentNotificationBadges();
            if (this.activeView === 'admin' && this.activeAdminTab === 'appointments-cms') {
                this.renderAdminAppointmentsCMS();
            }
        }

        if (manual) {
            const totalActive = this.db.appointments.filter(a => a.status !== 'Cancelled' && a.status !== 'Completed').length;
            this.showCustomAlert(
                `📋 Reminder Check Complete!\n\nEvaluated ${totalActive} active clinic appointments.\n• 1-Day (24h) Reminders Active: ${triggered24h}\n• 1-Hour Urgent Reminders Active: ${triggered1h}\n\nCoach Francess Orenuga's WhatsApp line (+1 757-513-0205) is synchronized.`,
                "Appointment Reminders Checked",
                "fa-bell"
            );
        }
    },

    updateAppointmentNotificationBadges() {
        const badge = document.getElementById('appt-tab-badge');
        if (!badge || !this.db || !Array.isArray(this.db.appointments)) return;

        let pendingCount = 0;
        let urgentCount = 0;

        this.db.appointments.forEach(appt => {
            if (appt.status === 'Cancelled' || appt.status === 'Completed') return;

            const timeInfo = this.getAppointmentTimeRemaining(appt);
            const isUrgent = (timeInfo && timeInfo.isWithin1h);
            const isPendingRequest = (appt.status === 'Requested');
            const isUnviewed = !appt.coachViewed;

            if (isUrgent) {
                urgentCount++;
                pendingCount++;
            } else if (isPendingRequest || isUnviewed) {
                pendingCount++;
            }
        });

        if (pendingCount > 0) {
            badge.textContent = pendingCount;
            badge.style.display = 'inline-block';
            if (urgentCount > 0) {
                badge.style.background = '#e74c3c'; // Vibrant red for urgent within 1h
            } else {
                badge.style.background = '#f39c12'; // Amber for pending confirmation / 24h
            }
            badge.title = `${pendingCount} new or pending appointment notifications`;
        } else {
            badge.style.display = 'none';
        }
    },

    renderAdminAppointmentsCMS() {
        const tbody = document.getElementById('admin-appointments-tbody');
        if (!tbody) return;

        const appointments = this.db.appointments || [];
        const query = (document.getElementById('admin-appt-search')?.value || '').toLowerCase().trim();
        const statusFilter = document.getElementById('admin-appt-filter-status')?.value || 'all';

        // Update top-level metrics
        const totalCount = appointments.length;
        const pendingCount = appointments.filter(a => a.status === 'Requested').length;
        const upcomingCount = appointments.filter(a => {
            if (a.status === 'Cancelled' || a.status === 'Completed') return false;
            const t = this.getAppointmentTimeRemaining(a);
            return t && (t.isWithin24h || t.isWithin1h);
        }).length;

        const totalEl = document.getElementById('admin-appt-total-count');
        const pendingEl = document.getElementById('admin-appt-pending-count');
        const upcomingEl = document.getElementById('admin-appt-upcoming-count');

        if (totalEl) totalEl.textContent = totalCount;
        if (pendingEl) pendingEl.textContent = pendingCount;
        if (upcomingEl) upcomingEl.textContent = upcomingCount;

        // Filter and sort appointments (most recent / upcoming first)
        let filtered = appointments.filter(a => {
            const matchStatus = (statusFilter === 'all') || (a.status === statusFilter);
            const matchQuery = !query || 
                (a.userName && a.userName.toLowerCase().includes(query)) ||
                (a.userEmail && a.userEmail.toLowerCase().includes(query)) ||
                (a.date && a.date.toLowerCase().includes(query)) ||
                (a.notes && a.notes.toLowerCase().includes(query));
            return matchStatus && matchQuery;
        });

        filtered.sort((x, y) => {
            const tx = this.getAppointmentTimeRemaining(x)?.diffMs ?? -999999999;
            const ty = this.getAppointmentTimeRemaining(y)?.diffMs ?? -999999999;
            return tx - ty;
        });

        if (filtered.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="8" style="text-align: center; padding: 2.5rem; color: #888;">
                        <i class="fa-solid fa-calendar-xmark" style="font-size: 2rem; color: #ccc; margin-bottom: 0.5rem; display: block;"></i>
                        No appointments found matching the current criteria.
                    </td>
                </tr>
            `;
            return;
        }

        let html = '';
        filtered.forEach(a => {
            const timeInfo = this.getAppointmentTimeRemaining(a);
            
            // Urgency badge styling
            let urgencyHtml = '<span style="color:#888;">-</span>';
            if (timeInfo) {
                if (timeInfo.isWithin1h) {
                    urgencyHtml = `<span class="badge" style="background:#e74c3c; color:white; font-weight:bold; animation: pulse 2s infinite;"><i class="fa-solid fa-bolt"></i> ${timeInfo.humanRemaining}</span>`;
                } else if (timeInfo.isWithin24h) {
                    urgencyHtml = `<span class="badge" style="background:#f39c12; color:white; font-weight:600;"><i class="fa-solid fa-clock"></i> ${timeInfo.humanRemaining}</span>`;
                } else if (timeInfo.isPassed) {
                    urgencyHtml = `<span class="badge" style="background:#95a5a6; color:white;">Passed</span>`;
                } else {
                    urgencyHtml = `<span class="badge" style="background:#2ecc71; color:white;">${timeInfo.humanRemaining}</span>`;
                }
            }

            // Status badge styling
            let statusBadge = '';
            if (a.status === 'Requested') {
                statusBadge = '<span class="badge" style="background:#e67e22; color:white; font-weight:bold;">Requested</span>';
            } else if (a.status === 'Confirmed') {
                statusBadge = '<span class="badge" style="background:#27ae60; color:white; font-weight:bold;">Confirmed</span>';
            } else if (a.status === 'Completed') {
                statusBadge = '<span class="badge" style="background:#2980b9; color:white;">Completed</span>';
            } else if (a.status === 'Cancelled') {
                statusBadge = '<span class="badge" style="background:#7f8c8d; color:white;">Cancelled</span>';
            } else {
                statusBadge = `<span class="badge" style="background:#34495e; color:white;">${a.status || 'Scheduled'}</span>`;
            }

            // Reminders Dispatched status
            const r24h = a.reminder24hSent 
                ? `<span class="badge" style="background:#27ae60; color:white; font-size:0.75rem;" title="24h reminder sent"><i class="fa-solid fa-check"></i> 1-Day Sent</span>`
                : `<span class="badge" style="background:#ecf0f1; color:#7f8c8d; font-size:0.75rem;">1-Day Pending</span>`;
            
            const r1h = a.reminder1hSent 
                ? `<span class="badge" style="background:#27ae60; color:white; font-size:0.75rem;" title="1h reminder sent"><i class="fa-solid fa-check"></i> 1-Hr Sent</span>`
                : `<span class="badge" style="background:#ecf0f1; color:#7f8c8d; font-size:0.75rem;">1-Hr Pending</span>`;

            // Consultation Mode badge
            const modeIcon = a.mode === 'Virtual' || /virtual|zoom/i.test(a.mode) ? 'fa-video' : 'fa-handshake';
            const modeBadge = `<span class="badge" style="background:rgba(18, 130, 109, 0.12); color:#12826d; border:1px solid rgba(18, 130, 109, 0.3);"><i class="fa-solid ${modeIcon}"></i> ${a.mode || 'In-Person'}</span>`;

            html += `
                <tr>
                    <td>
                        <strong style="color: #2c3e50; display: block;">${a.userName || 'Member'}</strong>
                        <span style="font-size: 0.85rem; color: #7f8c8d;">${a.userEmail || ''}</span>
                    </td>
                    <td>${modeBadge}</td>
                    <td>
                        <strong style="color: #12826d;">${a.date}</strong>
                        <div style="font-size: 0.85rem; color: #555;"><i class="fa-regular fa-clock"></i> ${a.time}</div>
                    </td>
                    <td>${urgencyHtml}</td>
                    <td style="max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${(a.notes || '').replace(/"/g, '&quot;')}">
                        ${a.notes || '<span style="color:#aaa;">None</span>'}
                    </td>
                    <td>${statusBadge}</td>
                    <td>
                        <div style="display: flex; flex-direction: column; gap: 4px;">
                            ${r24h}
                            ${r1h}
                        </div>
                    </td>
                    <td>
                        <div style="display: flex; flex-direction: column; gap: 6px; min-width: 130px;">
                            <!-- WhatsApp Action Menu -->
                            <div style="display: flex; gap: 4px;">
                                <button class="btn btn-sm" onclick="app.sendCoachAppointmentWhatsApp('${a.id}', 'reminder24h')" style="background-color: #25d366; color: white; border: none; padding: 4px 8px; font-size: 0.75rem; border-radius: 4px; flex: 1;" title="Send 1-Day Reminder to Coach Francess Orenuga via WhatsApp">
                                    <i class="fa-brands fa-whatsapp"></i> 1-Day
                                </button>
                                <button class="btn btn-sm" onclick="app.sendCoachAppointmentWhatsApp('${a.id}', 'reminder1h')" style="background-color: #128c7e; color: white; border: none; padding: 4px 8px; font-size: 0.75rem; border-radius: 4px; flex: 1;" title="Send 1-Hour Urgent Reminder to Coach Francess Orenuga via WhatsApp">
                                    <i class="fa-brands fa-whatsapp"></i> 1-Hr
                                </button>
                            </div>

                            <!-- Status Transitions -->
                            <div style="display: flex; gap: 4px;">
                                ${a.status === 'Requested' ? `
                                    <button class="btn btn-sm" onclick="app.updateAppointmentStatus('${a.id}', 'Confirmed')" style="background-color: #27ae60; color: white; border: none; padding: 3px 6px; font-size: 0.72rem; border-radius: 4px; flex: 1;">
                                        Confirm
                                    </button>
                                ` : ''}
                                ${a.status !== 'Completed' && a.status !== 'Cancelled' ? `
                                    <button class="btn btn-sm" onclick="app.updateAppointmentStatus('${a.id}', 'Completed')" style="background-color: #3498db; color: white; border: none; padding: 3px 6px; font-size: 0.72rem; border-radius: 4px; flex: 1;">
                                        Done
                                    </button>
                                    <button class="btn btn-sm" onclick="app.updateAppointmentStatus('${a.id}', 'Cancelled')" style="background-color: #e74c3c; color: white; border: none; padding: 3px 6px; font-size: 0.72rem; border-radius: 4px; flex: 1;">
                                        Cancel
                                    </button>
                                ` : ''}
                            </div>
                        </div>
                    </td>
                </tr>
            `;
        });

        tbody.innerHTML = html;
    },

    clearLocalDatabaseCache() {
        try {
            localStorage.removeItem('leanlife_db');
            sessionStorage.removeItem('leanlife_db');
            console.log("Local database cache cleared successfully.");
            alert("Local database cache cleared successfully.");
        } catch (e) {
            console.warn("Notice clearing local database cache:", e);
        }
    },

    renderAdminAnalyticsCMS() {
        const totalUsers = this.db.users.filter(u => u.role === 'member').length;
        
        // Calculate dynamic stats
        const avgScore = this.db.aiReports.length > 0 
            ? Math.round(this.db.aiReports.reduce((acc, r) => acc + r.overallScore, 0) / this.db.aiReports.length)
            : 82;

        const dbSize = (JSON.stringify(this.db).length / 1024).toFixed(2);

        document.getElementById('admin-stat-dau').textContent = totalUsers > 0 ? Math.ceil(totalUsers * 0.75) : 3;
        document.getElementById('admin-stat-avgscore').textContent = avgScore;
        document.getElementById('admin-stat-emails').textContent = this.db.emails.length;
        document.getElementById('admin-stat-dbsize').textContent = dbSize + ' KB';

        // Draw Interactive SVG Engagement Chart
        const engagementBox = document.getElementById('admin-analytics-chart-engagement');
        if (engagementBox) {
            engagementBox.innerHTML = `
                <svg width="100%" height="100%" viewBox="0 0 400 200" style="background:#ffffff; border: 1px solid rgba(18,130,109,0.08); border-radius:var(--radius-lg); filter:drop-shadow(0 4px 12px rgba(18,130,109,0.02));">
                    <defs>
                        <linearGradient id="adminChartGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stop-color="var(--clr-teal-green)" stop-opacity="0.22" />
                            <stop offset="100%" stop-color="var(--clr-teal-green)" stop-opacity="0.0" />
                        </linearGradient>
                    </defs>
                    <!-- Grid Lines -->
                    <line x1="40" y1="20" x2="380" y2="20" stroke="rgba(18,130,109,0.05)" />
                    <line x1="40" y1="60" x2="380" y2="60" stroke="rgba(18,130,109,0.05)" />
                    <line x1="40" y1="100" x2="380" y2="100" stroke="rgba(18,130,109,0.05)" />
                    <line x1="40" y1="140" x2="380" y2="140" stroke="rgba(18,130,109,0.05)" />
                    <line x1="40" y1="180" x2="380" y2="180" stroke="rgba(18,130,109,0.12)" />
                    
                    <!-- Axis Labels -->
                    <text x="18" y="183" font-size="8" font-family="var(--font-brand)" fill="var(--clr-text-dark)" opacity="0.6">0</text>
                    <text x="18" y="103" font-size="8" font-family="var(--font-brand)" fill="var(--clr-text-dark)" opacity="0.6">10</text>
                    <text x="18" y="23" font-size="8" font-family="var(--font-brand)" fill="var(--clr-text-dark)" opacity="0.6">20</text>
                    
                    <text x="50" y="193" font-size="9" font-family="var(--font-brand)" fill="var(--clr-text-dark)" opacity="0.7">Mon</text>
                    <text x="100" y="193" font-size="9" font-family="var(--font-brand)" fill="var(--clr-text-dark)" opacity="0.7">Tue</text>
                    <text x="150" y="193" font-size="9" font-family="var(--font-brand)" fill="var(--clr-text-dark)" opacity="0.7">Wed</text>
                    <text x="200" y="193" font-size="9" font-family="var(--font-brand)" fill="var(--clr-text-dark)" opacity="0.7">Thu</text>
                    <text x="250" y="193" font-size="9" font-family="var(--font-brand)" fill="var(--clr-text-dark)" opacity="0.7">Fri</text>
                    <text x="300" y="193" font-size="9" font-family="var(--font-brand)" fill="var(--clr-text-dark)" opacity="0.7">Sat</text>
                    <text x="350" y="193" font-size="9" font-family="var(--font-brand)" fill="var(--clr-text-dark)" opacity="0.7">Sun</text>
                    
                    <!-- Gradient Area -->
                    <path d="M 50,140 Q 100,100 150,120 T 250,60 T 350,80 L 350,180 L 50,180 Z" fill="url(#adminChartGrad)" />

                    <!-- Trend Line -->
                    <path d="M 50,140 Q 100,100 150,120 T 250,60 T 350,80" fill="none" stroke="var(--clr-teal-green)" stroke-width="3" stroke-linecap="round" />
                    <circle cx="50" cy="140" r="5" fill="var(--clr-teal-green)" stroke="white" stroke-width="1.8" />
                    <circle cx="150" cy="120" r="5" fill="var(--clr-teal-green)" stroke="white" stroke-width="1.8" />
                    <circle cx="250" cy="60" r="5" fill="var(--clr-teal-green)" stroke="white" stroke-width="1.8" />
                    <circle cx="350" cy="80" r="5" fill="var(--clr-teal-green)" stroke="white" stroke-width="1.8" />
                </svg>
            `;
        }

        // Draw Mood Distribution Pie Chart (Donut Chart)
        const moodBox = document.getElementById('admin-analytics-chart-mood');
        if (moodBox) {
            moodBox.innerHTML = `
                <svg width="100%" height="100%" viewBox="0 0 200 200" style="background:#ffffff; border: 1px solid rgba(18,130,109,0.08); border-radius:var(--radius-lg); display:block; margin:0 auto; filter:drop-shadow(0 4px 12px rgba(18,130,109,0.02));">
                    <!-- Donut base -->
                    <circle cx="100" cy="100" r="60" fill="none" stroke="#f5ebe0" stroke-width="24" />
                    <!-- Slice 1 (Happy - 50%) -->
                    <circle cx="100" cy="100" r="60" fill="none" stroke="var(--clr-teal-green)" stroke-width="24" 
                            stroke-dasharray="188.4 376.8" stroke-dashoffset="0" />
                    <!-- Slice 2 (Energetic - 30%) -->
                    <circle cx="100" cy="100" r="60" fill="none" stroke="#4db6ac" stroke-width="24" 
                            stroke-dasharray="113 376.8" stroke-dashoffset="-188.4" />
                    <!-- Slice 3 (Stressed/Tired - 20%) -->
                    <circle cx="100" cy="100" r="60" fill="none" stroke="#ffb74d" stroke-width="24" 
                            stroke-dasharray="75.4 376.8" stroke-dashoffset="-301.4" />
                            
                    <!-- Text Indicator -->
                    <text x="100" y="105" font-size="11" font-family="var(--font-brand)" font-weight="700" fill="var(--clr-teal-green)" text-anchor="middle">Mood Index</text>
                </svg>
            `;
        }
    },

    renderAdminAuditsCMS() {
        const tbody = document.getElementById('admin-audits-tbody');
        if (!tbody) return;

        const query = (document.getElementById('admin-audits-search')?.value || '').toLowerCase();

        let html = '';
        this.db.auditLogs.forEach(log => {
            if (query && !log.operator.toLowerCase().includes(query) && !log.eventType.toLowerCase().includes(query) && !log.details.toLowerCase().includes(query)) return;

            html += `
                <tr>
                    <td style="font-size:0.8rem; color:#666;">${new Date(log.timestamp).toLocaleString()}</td>
                    <td style="font-weight:600;">${log.operator}</td>
                    <td><span style="font-family:var(--font-brand); font-weight:600; color:var(--clr-teal-green);">${log.eventType}</span></td>
                    <td style="font-size:0.85rem;">${log.details}</td>
                </tr>
            `;
        });
        tbody.innerHTML = html;
    },

    // Temporary Password Modal Helpers
    showTempPasswordModal(user) {
        return new Promise((resolve) => {
            const overlay = document.getElementById('temp-password-overlay');
            const nameEl = document.getElementById('temp-user-name');
            const newPwdInput = document.getElementById('temp-new-password');
            const confirmPwdInput = document.getElementById('temp-confirm-password');
            const errorEl = document.getElementById('temp-password-error');
            
            if (!overlay) {
                const newPwd = prompt(`Welcome, ${user.name}! You are logging in with a temporary password. Please set a new password:`);
                resolve(newPwd);
                return;
            }
            
            if (nameEl) nameEl.textContent = user.name || 'Member';
            if (newPwdInput) newPwdInput.value = '';
            if (confirmPwdInput) confirmPwdInput.value = '';
            if (errorEl) errorEl.style.display = 'none';
            overlay.style.display = 'flex';
            if (newPwdInput) newPwdInput.focus();
            
            this._tempPasswordResolve = resolve;
        });
    },

    handleTempPasswordSubmit(e) {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        const newPwd = document.getElementById('temp-new-password')?.value;
        const confirmPwd = document.getElementById('temp-confirm-password')?.value;
        const errorEl = document.getElementById('temp-password-error');
        
        if (!newPwd || newPwd.trim() === '') {
            if (errorEl) {
                errorEl.textContent = "Please enter a valid new password.";
                errorEl.style.display = 'block';
            }
            return;
        }
        
        if (newPwd !== confirmPwd) {
            if (errorEl) {
                errorEl.textContent = "Passwords do not match. Please re-enter.";
                errorEl.style.display = 'block';
            }
            return;
        }
        
        if (newPwd.length < 6) {
            if (errorEl) {
                errorEl.textContent = "Password must be at least 6 characters long.";
                errorEl.style.display = 'block';
            }
            return;
        }
        
        const overlay = document.getElementById('temp-password-overlay');
        if (overlay) overlay.style.display = 'none';
        
        if (this._tempPasswordResolve) {
            this._tempPasswordResolve(newPwd.trim());
            this._tempPasswordResolve = null;
        }
    },

    togglePasswordVisibility(inputId, iconEl) {
        const input = document.getElementById(inputId);
        if (!input) return;
        if (input.type === 'password') {
            input.type = 'text';
            if (iconEl) iconEl.className = 'fa-solid fa-eye-slash';
        } else {
            input.type = 'password';
            if (iconEl) iconEl.className = 'fa-solid fa-eye';
        }
    },

    showCustomAlert(message, title = 'LeanLife Notice', iconClass = 'fa-leaf') {
        const modal = document.getElementById('custom-alert-modal');
        const titleEl = document.getElementById('custom-alert-title');
        const msgEl = document.getElementById('custom-alert-message');
        const iconEl = document.getElementById('custom-alert-icon');
        
        if (iconEl && iconClass) {
            iconEl.className = `fa-solid ${iconClass}`;
        }
        if (modal && titleEl && msgEl) {
            titleEl.textContent = title;
            msgEl.textContent = message;
            modal.style.display = 'flex';
            window.scrollTo({ top: 0, behavior: 'instant' });
        } else {
            console.log(`[Alert] ${title}: ${message}`);
            alert(`${title}\n\n${message}`);
        }
    },

    closeCustomAlert() {
        const modal = document.getElementById('custom-alert-modal');
        if (modal) {
            modal.style.display = 'none';
        }
    },

    openCredentialsModal(user, tempPassword, mode = 'created') {
        const modal = document.getElementById('admin-credentials-modal');
        if (!modal) return;

        this.activeModalCredentials = {
            name: user.name || 'Member',
            email: user.email,
            phone: user.phone || '',
            tempPassword: tempPassword
        };

        const titleEl = document.getElementById('cred-modal-title');
        const subtitleEl = document.getElementById('cred-modal-subtitle');
        const iconEl = document.getElementById('cred-modal-icon');
        const nameEl = document.getElementById('cred-modal-name');
        const emailEl = document.getElementById('cred-modal-email');
        const passEl = document.getElementById('cred-modal-password');

        if (titleEl) {
            titleEl.textContent = mode === 'reset' ? '🔑 Password Reset Generated' : (mode === 'view' ? '🔑 Member Login Credentials' : '🎉 Member Account Registered');
        }
        if (subtitleEl) {
            subtitleEl.textContent = mode === 'reset' 
                ? 'Temporary access credentials generated. Share directly with member or via WhatsApp.' 
                : (mode === 'view' ? 'Active member login credentials. Share directly with member or via WhatsApp.' : 'New client onboarding credentials generated. Share directly or via WhatsApp.');
        }
        if (iconEl) {
            iconEl.className = mode === 'reset' ? 'fa-solid fa-key' : 'fa-solid fa-user-check';
        }
        if (nameEl) nameEl.textContent = user.name || 'Member';
        if (emailEl) emailEl.textContent = user.email;
        if (passEl) passEl.textContent = tempPassword;

        modal.style.display = 'flex';
        window.scrollTo({ top: 0, behavior: 'instant' });
    },

    viewMemberCredentials(email) {
        const user = this.db.users.find(u => (u.email || '').toLowerCase().trim() === (email || '').toLowerCase().trim());
        if (!user) {
            alert("User record not found.");
            return;
        }

        const tempPassword = user.tempPasswordRaw || 'LL-849204';
        this.openCredentialsModal(user, tempPassword, 'view');
    },

    copySinglePassword() {
        if (!this.activeModalCredentials || !this.activeModalCredentials.tempPassword) return;
        const pass = this.activeModalCredentials.tempPassword;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(pass).then(() => {
                alert(`Temporary password (${pass}) copied to clipboard!`);
            }).catch(() => {
                prompt("Copy Temporary Password:", pass);
            });
        } else {
            prompt("Copy Temporary Password:", pass);
        }
    },

    copyFullCredentialsMessage() {
        if (!this.activeModalCredentials) return;
        const c = this.activeModalCredentials;
        const msg = `Hello ${c.name}! Welcome to the LeanLife Wellness Community.\n\nCoach Francess has set up your wellness portal account:\n\n• Portal Link: https://leanlife-community.app/\n• Login Email: ${c.email}\n• Temporary Password: ${c.tempPassword}\n\nPlease log in and update your password when prompted. We are thrilled to partner with you on your metabolic and wellness journey!`;

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(msg).then(() => {
                alert("Complete welcome message and login credentials copied to clipboard!");
            }).catch(() => {
                prompt("Copy Full Welcome Message:", msg);
            });
        } else {
            prompt("Copy Full Welcome Message:", msg);
        }
    },

    shareCredentialsViaWhatsApp() {
        if (!this.activeModalCredentials) return;
        const c = this.activeModalCredentials;
        const msg = `Hello ${c.name}! Welcome to the LeanLife Wellness Community.\n\nCoach Francess has set up your wellness portal account:\n\n• Portal Link: https://leanlife-community.app/\n• Login Email: ${c.email}\n• Temporary Password: ${c.tempPassword}\n\nPlease log in and update your password when prompted. We are thrilled to partner with you on your metabolic and wellness journey!`;
        
        const cleanPhone = (c.phone || '').replace(/[^\d]/g, '');
        const encodedText = encodeURIComponent(msg);
        const waUrl = cleanPhone ? `https://wa.me/${cleanPhone}?text=${encodedText}` : `https://wa.me/?text=${encodedText}`;
        window.open(waUrl, '_blank');
    },

    closeCredentialsModal() {
        const modal = document.getElementById('admin-credentials-modal');
        if (modal) modal.style.display = 'none';
    },

    renderAdminSettingsCMS() {
        document.getElementById('settings-persona').value = this.db.systemSettings.persona || 'encouraging';
        document.getElementById('settings-primary-hue').value = this.db.systemSettings.primaryHue || 168;
        document.getElementById('settings-accent-hue').value = this.db.systemSettings.accentHue || 80;

        // Populate Resend API settings
        const resendKeyField = document.getElementById('settings-resend-api-key');
        const resendFromField = document.getElementById('settings-resend-from-email');
        if (resendKeyField) resendKeyField.value = this.db.systemSettings.resendApiKey || '';
        if (resendFromField) resendFromField.value = this.db.systemSettings.resendFromEmail || '';

        // Populate EmailJS settings
        const config = window.SUPABASE_CONFIG || {};
        const serviceIdField = document.getElementById('settings-emailjs-service-id');
        const templateIdField = document.getElementById('settings-emailjs-template-id');
        const publicKeyField = document.getElementById('settings-emailjs-public-key');
        const autoreplyTemplateIdField = document.getElementById('settings-emailjs-autoreply-template-id');
        const welcomeTemplateIdField = document.getElementById('settings-emailjs-welcome-template-id');
        
        if (serviceIdField) serviceIdField.value = this.db.systemSettings.emailjsServiceId || config.EMAILJS_SERVICE_ID || '';
        if (templateIdField) templateIdField.value = this.db.systemSettings.emailjsTemplateId || config.EMAILJS_TEMPLATE_ID || '';
        if (publicKeyField) publicKeyField.value = this.db.systemSettings.emailjsPublicKey || config.EMAILJS_PUBLIC_KEY || '';
        if (autoreplyTemplateIdField) autoreplyTemplateIdField.value = this.db.systemSettings.emailjsAutoreplyTemplateId || config.EMAILJS_AUTOREPLY_TEMPLATE_ID || '';
        if (welcomeTemplateIdField) welcomeTemplateIdField.value = this.db.systemSettings.emailjsWelcomeTemplateId || config.EMAILJS_WELCOME_TEMPLATE_ID || '';
    },

    handleAdminSaveSettings(e) {
        e.preventDefault();
        const persona = document.getElementById('settings-persona').value;
        const primaryHue = parseInt(document.getElementById('settings-primary-hue').value) || 168;
        const accentHue = parseInt(document.getElementById('settings-accent-hue').value) || 80;

        this.db.systemSettings = this.db.systemSettings || {};
        this.db.systemSettings.persona = persona;
        this.db.systemSettings.primaryHue = primaryHue;
        this.db.systemSettings.accentHue = accentHue;

        this.saveDatabase();
        this.logAudit(this.currentUser.name, 'System Settings Saved', `Frannie Persona: ${persona}. Custom Branding color Hues saved: Primary H:${primaryHue}, Accent H:${accentHue}`);
        
        // Dynamically override CSS styling system
        document.documentElement.style.setProperty('--hue-primary', primaryHue);
        document.documentElement.style.setProperty('--hue-accent', accentHue);

        alert("System parameters and styling colors updated successfully!");
    },

    handleAdminSaveEmailSettings(e) {
        e.preventDefault();
        const config = window.SUPABASE_CONFIG || {};
        const resendApiKey = document.getElementById('settings-resend-api-key')?.value.trim() || '';
        const resendFromEmail = document.getElementById('settings-resend-from-email')?.value.trim() || '';
        const serviceId = document.getElementById('settings-emailjs-service-id')?.value.trim() || '';
        const templateId = document.getElementById('settings-emailjs-template-id')?.value.trim() || '';
        const publicKey = document.getElementById('settings-emailjs-public-key')?.value.trim() || '';
        const autoreplyTemplateId = document.getElementById('settings-emailjs-autoreply-template-id')?.value.trim() || '';
        const welcomeTemplateId = document.getElementById('settings-emailjs-welcome-template-id')?.value.trim() || '';

        this.db.systemSettings = this.db.systemSettings || {};
        this.db.systemSettings.resendApiKey = resendApiKey;
        this.db.systemSettings.resendFromEmail = resendFromEmail;
        this.db.systemSettings.emailjsServiceId = serviceId || config.EMAILJS_SERVICE_ID || 'service_60jfsbe';
        this.db.systemSettings.emailjsTemplateId = templateId || config.EMAILJS_TEMPLATE_ID || 'template_gyjh3gp';
        this.db.systemSettings.emailjsPublicKey = publicKey || config.EMAILJS_PUBLIC_KEY || '1KO_vRCldTUVxoqtM';
        this.db.systemSettings.emailjsAutoreplyTemplateId = autoreplyTemplateId || config.EMAILJS_AUTOREPLY_TEMPLATE_ID || 'template_fzzf45u';
        this.db.systemSettings.emailjsWelcomeTemplateId = welcomeTemplateId || config.EMAILJS_WELCOME_TEMPLATE_ID || 'template_gyjh3gp';

        this.saveDatabase();
        this.logAudit(this.currentUser.name, 'Email settings updated', `Resend Integration: ${resendApiKey ? 'Active' : 'Unconfigured'}, EmailJS: ${serviceId ? 'Active' : 'Disabled'}`);
        alert("Email delivery settings updated successfully!");
    },

    async sendRealEmail(recipientName, recipientEmail, subject, tempPassword, templateType = null, extraData = {}) {
        const config = window.SUPABASE_CONFIG || {};

        // 1. Primary Email Provider: EmailJS
        const serviceId = (this.db.systemSettings && this.db.systemSettings.emailjsServiceId) || config.EMAILJS_SERVICE_ID || 'service_60jfsbe';
        const publicKey = (this.db.systemSettings && this.db.systemSettings.emailjsPublicKey) || config.EMAILJS_PUBLIC_KEY || '1KO_vRCldTUVxoqtM';
        
        let templateId = '';
        if (templateType === 'autoreply' || templateType === 'booking') {
            templateId = (this.db.systemSettings && this.db.systemSettings.emailjsAutoreplyTemplateId) || 
                         config.EMAILJS_AUTOREPLY_TEMPLATE_ID || 
                         'template_fzzf45u';
        } else if (templateType === 'welcome') {
            templateId = (this.db.systemSettings && this.db.systemSettings.emailjsWelcomeTemplateId) || 
                         config.EMAILJS_WELCOME_TEMPLATE_ID || 
                         'template_gyjh3gp';
        } else if (templateType === 'reset') {
            templateId = (this.db.systemSettings && this.db.systemSettings.emailjsResetTemplateId) || 
                         config.EMAILJS_RESET_TEMPLATE_ID || 
                         (this.db.systemSettings && this.db.systemSettings.emailjsWelcomeTemplateId) ||
                         config.EMAILJS_WELCOME_TEMPLATE_ID || 
                         'template_gyjh3gp';
        } else {
            templateId = (this.db.systemSettings && this.db.systemSettings.emailjsTemplateId) || 
                         config.EMAILJS_TEMPLATE_ID || 
                         'template_gyjh3gp';
        }

        if (serviceId && templateId && publicKey) {
            console.log(`Sending real email (${templateType || 'general'} -> ${templateId}) to: ${recipientEmail} via EmailJS...`);
            const templateParams = {
                // Recipient Names
                to_name: recipientName,
                name: recipientName,
                user_name: recipientName,
                recipient_name: recipientName,
                client_name: recipientName,
                
                // Recipient Emails
                to_email: recipientEmail,
                email: recipientEmail,
                user_email: recipientEmail,
                recipient_email: recipientEmail,
                reply_to: 'francessronke21@gmail.com',
                from_name: 'Coach Francess Orenuga - LeanLife',
                coach_email: 'francessronke21@gmail.com',
                portal_url: 'https://leanlife-community.app/',
                login_url: 'https://leanlife-community.app/',
                
                // Hosted Brand Logos (Universal HTTPS links - Display flawlessly across Gmail, Outlook, Apple Mail)
                logo_url: 'https://leanlife-community.app/logo_white_version.png',
                logo: 'https://leanlife-community.app/logo_white_version.png',
                app_logo: 'https://leanlife-community.app/logo_white_version.png',
                company_logo: 'https://leanlife-community.app/logo_white_version.png',
                brand_logo: 'https://leanlife-community.app/logo_white_version.png',
                header_logo: 'https://leanlife-community.app/logo_white_version.png',
                logo_img: '<img src="https://leanlife-community.app/logo_white_version.png" alt="LeanLife Logo" width="140" style="max-width:140px; height:auto; display:block; margin:0 auto 12px;" />',
                logo_white_url: 'https://leanlife-community.app/logo_white_version.png',
                logo_transparent_url: 'https://leanlife-community.app/logo_transparent.png',
                logo_standard_url: 'https://leanlife-community.app/logo.png',
                
                // Passwords & Credentials
                temp_password: tempPassword || '',
                tempPassword: tempPassword || '',
                temp_pass: tempPassword || '',
                temporary_password: tempPassword || '',
                user_pass: tempPassword || '',
                user_password: tempPassword || '',
                password: tempPassword || '',
                pass: tempPassword || '',
                code: tempPassword || '',
                pin: tempPassword || '',
                
                // Subject & Body Text
                subject: subject || 'LeanLife Notification',
                email_subject: subject || 'LeanLife Notification',
                message: subject || 'LeanLife Notification',
                notes: extraData.notes || subject || '',
                details: extraData.notes || subject || '',
                
                // Booking & Consultation Parameters
                booking_date: extraData.date || new Date().toLocaleDateString(),
                booking_time: extraData.time || '10:00 AM',
                appointment_date: extraData.date || new Date().toLocaleDateString(),
                appointment_time: extraData.time || '10:00 AM',
                date: extraData.date || new Date().toLocaleDateString(),
                time: extraData.time || '10:00 AM',
                coach_name: extraData.coach || 'Coach Francess Orenuga',
                coach: extraData.coach || 'Coach Francess Orenuga',
                coachName: extraData.coach || 'Coach Francess Orenuga',
                mode: extraData.mode || 'In-Person',
                consultation_mode: extraData.mode || 'In-Person',
                service: extraData.service || 'Wellness Consultation'
            };

            // 1A. Try Browser SDK first if loaded
            if (window.emailjs && typeof window.emailjs.send === 'function') {
                try {
                    console.log(`Dispatching via EmailJS Browser SDK (Template: ${templateId})...`);
                    const sdkResult = await window.emailjs.send(serviceId, templateId, templateParams, publicKey);
                    if (sdkResult && (sdkResult.status === 200 || sdkResult.text === 'OK')) {
                        console.log(`Real email successfully dispatched to ${recipientEmail} via EmailJS Browser SDK!`);
                        this.logAudit('System', 'Real Email Dispatched', `Real onboarding email delivered to ${recipientEmail} via EmailJS SDK`);
                        return { ok: true, provider: 'emailjs-sdk' };
                    }
                } catch (sdkErr) {
                    console.warn("EmailJS Browser SDK notice:", sdkErr);
                }
            }

            // 1B. Direct HTTP API Fetch
            try {
                const targetUrl = 'https://api.emailjs.com/api/v1.0/email/send';
                
                const response = await fetch(targetUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        service_id: serviceId,
                        template_id: templateId,
                        user_id: publicKey,
                        template_params: templateParams
                    })
                });

                if (response.ok) {
                    console.log(`Real email successfully dispatched to ${recipientEmail} via EmailJS API!`);
                    this.logAudit('System', 'Real Email Dispatched', `Real onboarding email delivered to ${recipientEmail} via EmailJS`);
                    return { ok: true, provider: 'emailjs' };
                } else {
                    const errText = await response.text();
                    console.error("EmailJS API returned error status:", response.status, errText);
                    const isGrantErr = response.status === 412 || errText.includes('Invalid grant');
                    const auditMsg = isGrantErr ? 
                        `⚠️ EmailJS Gmail Service Re-authentication Required (HTTP 412: Invalid Grant). Please log into https://dashboard.emailjs.com/ and reconnect your Gmail account.` : 
                        `EmailJS rejected email to ${recipientEmail} (HTTP ${response.status}): ${errText}`;
                    this.logAudit('System', 'Real Email FAILED', auditMsg);
                    
                    if (isGrantErr) {
                        this.showCustomAlert(
                            `⚠️ Welcome Email Not Delivered to ${recipientEmail}\n\nReason: EmailJS returned HTTP 412 (Invalid Grant). The Gmail account connected to EmailJS needs to be reconnected.\n\n30-Second Fix:\n1. Open https://dashboard.emailjs.com/\n2. Click Email Services -> service_a1av3q9\n3. Click "Reconnect Account" button`,
                            "EmailJS Re-connection Required",
                            "fa-triangle-exclamation"
                        );
                    }
                }
            } catch (err) {
                console.error("Failed to execute EmailJS HTTP request:", err);
                this.logAudit('System', 'Real Email FAILED', `Network error sending email via EmailJS: ${err.message}`);
            }
        }

        // 2. Secondary Fallback Email Provider: Resend API
        const resendApiKey = (this.db.systemSettings && this.db.systemSettings.resendApiKey) || config.RESEND_API_KEY;
        const resendFrom = (this.db.systemSettings && this.db.systemSettings.resendFromEmail) || config.RESEND_FROM_EMAIL || 'LeanLife <onboarding@resend.dev>';

        if (resendApiKey) {
            console.log(`Fallback: Sending real email to: ${recipientEmail} via Resend API...`);
            try {
                const htmlBody = `
                    <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; padding: 30px; border-radius: 12px; border: 1px solid #e1e8ed;">
                        <div style="text-align: center; margin-bottom: 25px; background: linear-gradient(135deg, #0DBE85 0%, #12826D 100%); padding: 20px; border-radius: 8px;">
                            <a href="https://leanlife-community.app/" target="_blank" style="text-decoration:none; outline:none; display:inline-block;">
                                <img src="https://leanlife-community.app/logo_white_version.png" alt="LeanLife Logo" width="140" style="display:inline-block; max-height:45px; width:auto; border:0; outline:none;" />
                            </a>
                            <h1 style="color: #ffffff; margin: 10px 0 0 0; font-size: 22px; font-weight: 700;">LeanLife Wellness Community</h1>
                            <p style="color: rgba(255, 255, 255, 0.9); font-size: 13px; margin: 4px 0 0 0;">Your Personalized Healthcare & Wellness Portal</p>
                        </div>
                        <div style="padding: 20px 0; border-top: 1px solid #eee; border-bottom: 1px solid #eee;">
                            <p style="font-size: 16px; color: #333;">Hello <strong>${recipientName}</strong>,</p>
                            <p style="font-size: 15px; color: #555; line-height: 1.6;">${subject}</p>
                            ${tempPassword ? `
                            <div style="background: #f4fbf7; border: 2px dashed #2ecc71; padding: 15px; border-radius: 8px; text-align: center; margin: 20px 0;">
                                <span style="font-size: 13px; color: #666; display: block; text-transform: uppercase; letter-spacing: 1px;">Temporary Access Password</span>
                                <span style="font-size: 24px; font-weight: bold; color: #12826d; letter-spacing: 2px; display: block; margin-top: 5px;">${tempPassword}</span>
                            </div>
                            <p style="font-size: 13px; color: #888;">Please log in with this temporary password and update your password when prompted.</p>
                            ` : ''}
                        </div>
                        <div style="text-align: center; margin-top: 25px; color: #999; font-size: 12px;">
                            <p>&copy; 2026 LeanLife Wellness Center. All rights reserved.</p>
                        </div>
                    </div>
                `;

                const response = await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${resendApiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        from: resendFrom,
                        to: [recipientEmail],
                        subject: subject,
                        html: htmlBody
                    })
                });

                if (response.ok) {
                    console.log(`Resend email successfully sent to ${recipientEmail}!`);
                    this.logAudit('System', 'Resend Email Dispatched', `Email successfully sent to ${recipientEmail} via Resend`);
                    return { ok: true, provider: 'resend' };
                } else {
                    const errText = await response.text();
                    console.error("Resend API returned error status:", response.status, errText);
                    this.logAudit('System', 'Resend Email FAILED', `Resend rejected email to ${recipientEmail} (HTTP ${response.status}): ${errText}`);
                }
            } catch (err) {
                console.error("Failed to execute Resend HTTP request:", err);
                this.logAudit('System', 'Resend Email FAILED', `Network error sending email via Resend: ${err.message}`);
            }
        }

        console.warn("Email credentials missing for EmailJS and Resend. Operating in local simulation outbox mode.");
        return { ok: false, reason: 'missing_credentials' };
    },

    exportReport(table, format) {
        const records = this.db[table] || [];
        if (records.length === 0) {
            alert("No database records available to export.");
            return;
        }

        // Clean records for JSON export (remove raw multi-megabyte base64 strings to keep JSON lightweight & portable)
        if (format === 'json') {
            const sanitizedJsonRecords = records.map(row => {
                const item = { ...row };
                if (item.photos && Array.isArray(item.photos)) {
                    item.photos = item.photos.map(p => typeof p === 'string' && p.startsWith('data:') ? `[Base64 Image Attached - ${p.length} chars]` : p);
                }
                if (item.photoUrl && typeof item.photoUrl === 'string' && item.photoUrl.startsWith('data:')) {
                    item.photoUrl = `[Base64 Image Attached - ${item.photoUrl.length} chars]`;
                }
                if (item.meals && typeof item.meals === 'object') {
                    const cleanedMeals = {};
                    for (const m in item.meals) {
                        cleanedMeals[m] = { ...item.meals[m] };
                        if (cleanedMeals[m].photo && typeof cleanedMeals[m].photo === 'string' && cleanedMeals[m].photo.startsWith('data:')) {
                            cleanedMeals[m].photo = `[Base64 Meal Photo Attached]`;
                        }
                    }
                    item.meals = cleanedMeals;
                }
                return item;
            });

            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(sanitizedJsonRecords, null, 2));
            const dlAnchor = document.createElement('a');
            dlAnchor.setAttribute("href", dataStr);
            dlAnchor.setAttribute("download", `leanlife_${table}_export.json`);
            document.body.appendChild(dlAnchor);
            dlAnchor.click();
            dlAnchor.remove();
            return;
        }

        // CSV Helper: safely format cell value and escape RFC-4180
        const escapeCsvCell = (val) => {
            if (val === null || val === undefined) return '""';
            let str = String(val);
            // Replace CRLF / LF with space or separator to keep single-line rows in CSV
            str = str.replace(/\r\n|\r|\n/g, ' ');
            // Escape quotes
            str = str.replace(/"/g, '""');
            return `"${str}"`;
        };

        let headers = [];
        let rows = [];

        if (table === 'wellnessLogs') {
            headers = [
                "Log ID",
                "Member Email",
                "Date & Time",
                "Device",
                "Steps",
                "Water Drops",
                "Water (oz)",
                "Sleep Hours",
                "Sleep Quality",
                "Bedtime / Wake Time",
                "Mood",
                "Exercise Type",
                "Exercise Duration (mins)",
                "Exercise Intensity",
                "Weight (lbs)",
                "BMI",
                "Body Fat %",
                "Blood Pressure",
                "Blood Sugar (mg/dL)",
                "Heart Rate (bpm)",
                "Stress (1-10)",
                "Energy (1-10)",
                "Outdoor Time (mins)",
                "Sunlight (mins)",
                "Meditation (mins)",
                "Screen Time (hrs)",
                "Affirmations",
                "Reflections",
                "Meals Summary",
                "Photos Attached",
                "Streak Day"
            ];

            rows = records.map(row => {
                const sleepObj = row.sleep || {};
                const sleepDur = typeof sleepObj === 'object' ? (sleepObj.duration || '') : (sleepObj || '');
                const sleepQual = typeof sleepObj === 'object' ? (sleepObj.quality || '') : '';
                const sleepBedWake = typeof sleepObj === 'object' && (sleepObj.bedtime || sleepObj.wakeTime) 
                    ? `${sleepObj.bedtime || '--'} to ${sleepObj.wakeTime || '--'}` : '';

                const exObj = row.exercise || {};
                const exType = typeof exObj === 'object' ? (exObj.type || (exObj.completed === 'yes' ? 'Exercise' : 'None')) : '';
                const exDur = typeof exObj === 'object' ? (exObj.duration || 0) : '';
                const exInt = typeof exObj === 'object' ? (exObj.intensity || '') : '';

                const met = row.metrics || {};
                const weightVal = met.weight || '';
                const bmiVal = met.bmi || '';
                const bodyFatVal = met.bodyFat || '';
                const bpVal = met.bloodPressure || '';
                const bsVal = met.bloodSugar || '';
                const hrVal = met.heartRate || '';
                const stressVal = met.stress || '';
                const energyVal = met.energy || '';
                const outdoorVal = row.outdoorTime !== undefined ? row.outdoorTime : (met.outdoorTime || '');
                const sunlightVal = row.sunlight !== undefined ? row.sunlight : (met.sunlight || '');
                const medVal = row.meditation !== undefined ? row.meditation : (met.meditation || '');
                const screenVal = row.screenTime !== undefined ? row.screenTime : (met.screenTime || '');

                // Format meals into clean readable summary
                let mealsSummary = '';
                if (row.meals && typeof row.meals === 'object') {
                    const mealParts = [];
                    if (row.meals.breakfast?.desc) mealParts.push(`Breakfast: ${row.meals.breakfast.desc}`);
                    if (row.meals.lunch?.desc) mealParts.push(`Lunch: ${row.meals.lunch.desc}`);
                    if (row.meals.dinner?.desc) mealParts.push(`Dinner: ${row.meals.dinner.desc}`);
                    if (row.meals.snacks?.desc) mealParts.push(`Snacks: ${row.meals.snacks.desc}`);
                    mealsSummary = mealParts.join(' | ');
                }

                // Photo count indicator instead of raw base64 data
                let photoAttached = 'None';
                if (row.photos && Array.isArray(row.photos) && row.photos.length > 0) {
                    photoAttached = `Yes (${row.photos.length} Photo${row.photos.length > 1 ? 's' : ''})`;
                } else if (row.photoUrl) {
                    photoAttached = 'Yes (1 Photo)';
                }

                const waterDrops = row.waterCount || 0;
                const waterOz = (waterDrops * 8.45).toFixed(1);

                return [
                    escapeCsvCell(row.id || ''),
                    escapeCsvCell(row.userEmail || row.user_email || ''),
                    escapeCsvCell(row.timestamp ? new Date(row.timestamp).toLocaleString() : (row.date || '')),
                    escapeCsvCell(row.device || 'Web Desktop'),
                    escapeCsvCell(row.steps || 0),
                    escapeCsvCell(waterDrops),
                    escapeCsvCell(waterOz),
                    escapeCsvCell(sleepDur),
                    escapeCsvCell(sleepQual),
                    escapeCsvCell(sleepBedWake),
                    escapeCsvCell(row.mood || 'neutral'),
                    escapeCsvCell(exType),
                    escapeCsvCell(exDur),
                    escapeCsvCell(exInt),
                    escapeCsvCell(weightVal),
                    escapeCsvCell(bmiVal),
                    escapeCsvCell(bodyFatVal),
                    escapeCsvCell(bpVal),
                    escapeCsvCell(bsVal),
                    escapeCsvCell(hrVal),
                    escapeCsvCell(stressVal),
                    escapeCsvCell(energyVal),
                    escapeCsvCell(outdoorVal),
                    escapeCsvCell(sunlightVal),
                    escapeCsvCell(medVal),
                    escapeCsvCell(screenVal),
                    escapeCsvCell(row.affirmations || ''),
                    escapeCsvCell(row.reflections || ''),
                    escapeCsvCell(mealsSummary || 'Standard balanced nutrition'),
                    escapeCsvCell(photoAttached),
                    escapeCsvCell(row.streakCount || 1)
                ].join(",");
            });
        } else if (table === 'aiReports') {
            headers = [
                "Report ID",
                "Member Email",
                "Generated Date & Time",
                "Overall Score",
                "Grade",
                "Sleep Score",
                "Hydration Score",
                "Nutrition Score",
                "Activity Score",
                "Mindset Score",
                "Status",
                "Coach Advice / Summary"
            ];

            rows = records.map(r => {
                const metrics = r.metrics || {};
                return [
                    escapeCsvCell(r.id || ''),
                    escapeCsvCell(r.userEmail || r.user_email || ''),
                    escapeCsvCell(r.timestamp ? new Date(r.timestamp).toLocaleString() : (r.date || '')),
                    escapeCsvCell(r.overallScore || r.score || ''),
                    escapeCsvCell(r.grade || 'A'),
                    escapeCsvCell(metrics.sleepScore || r.sleepScore || ''),
                    escapeCsvCell(metrics.hydrationScore || r.hydrationScore || ''),
                    escapeCsvCell(metrics.nutritionScore || r.nutritionScore || ''),
                    escapeCsvCell(metrics.activityScore || r.activityScore || ''),
                    escapeCsvCell(metrics.mindsetScore || r.mindsetScore || ''),
                    escapeCsvCell(r.status || 'completed'),
                    escapeCsvCell(r.summary || r.content || r.coaching_advice || '')
                ].join(",");
            });
        } else if (table === 'users') {
            headers = [
                "Name",
                "Email",
                "Role",
                "Status",
                "Phone",
                "DOB",
                "Gender",
                "Height (cm)",
                "Weight (lbs)",
                "Goal",
                "Blood Group",
                "Allergies",
                "Medications",
                "Conditions",
                "Streak Count",
                "Last Streak Date",
                "Updated At"
            ];

            rows = records.map(u => [
                escapeCsvCell(u.name || ''),
                escapeCsvCell(u.email || ''),
                escapeCsvCell(u.role || 'member'),
                escapeCsvCell(u.status || 'Active'),
                escapeCsvCell(u.phone || ''),
                escapeCsvCell(u.dob || ''),
                escapeCsvCell(u.gender || ''),
                escapeCsvCell(u.height || ''),
                escapeCsvCell(u.weight || ''),
                escapeCsvCell(u.goal || ''),
                escapeCsvCell(u.bloodGroup || ''),
                escapeCsvCell(u.allergies || ''),
                escapeCsvCell(u.medications || ''),
                escapeCsvCell(u.conditions || ''),
                escapeCsvCell(u.streakCount || 0),
                escapeCsvCell(u.lastStreakDate || ''),
                escapeCsvCell(u.updatedAt || u.timestamp || '')
            ].join(","));
        } else if (table === 'auditLogs') {
            headers = ["Log ID", "Timestamp", "Operator", "Action / Event", "Resource", "Details"];
            rows = records.map(a => [
                escapeCsvCell(a.id || ''),
                escapeCsvCell(a.timestamp ? new Date(a.timestamp).toLocaleString() : ''),
                escapeCsvCell(a.operator || 'System'),
                escapeCsvCell(a.eventType || ''),
                escapeCsvCell(a.resource || 'System'),
                escapeCsvCell(a.details || '')
            ].join(","));
        } else {
            // Generic table export fallback
            headers = Object.keys(records[0]).filter(k => k !== 'photos' && k !== 'photoUrl' && k !== 'password');
            rows = records.map(row => {
                return headers.map(h => {
                    const val = typeof row[h] === 'object' ? JSON.stringify(row[h]) : row[h];
                    return escapeCsvCell(val);
                }).join(",");
            });
        }

        // Compile CSV with UTF-8 BOM (\uFEFF) for Excel compatibility
        const csvContent = "\uFEFF" + headers.map(escapeCsvCell).join(",") + "\r\n" + rows.join("\r\n");
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", `leanlife_${table}_export.csv`);
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    },

    exportDatabaseBackupJSON() {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(this.db, null, 2));
        const downloadAnchor = document.createElement('a');
        downloadAnchor.setAttribute("href", dataStr);
        downloadAnchor.setAttribute("download", "leanlife_database_backup.json");
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        downloadAnchor.remove();
        this.logAudit(this.currentUser.name, 'Database Backup Downloaded', 'Full JSON schema backup file exported');
    },

    importDatabaseBackupJSON(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const importedDb = JSON.parse(event.target.result);
                // Schema validation
                if (importedDb.users && importedDb.wellnessLogs && importedDb.aiReports) {
                    this.db = importedDb;
                    this.saveDatabase();
                    this.logAudit(this.currentUser.name, 'Database Backup Restored', 'Full JSON database restore finished');
                    alert("Database backup restored successfully! Reloading application...");
                    location.reload();
                } else {
                    alert("Invalid database file format. Ensure it contains users, logs and reports lists.");
                }
            } catch(err) {
                alert("Error parsing backup file: " + err.message);
            }
        };
        reader.readAsText(file);
    },

    logAutomation(message) {
        if (!this.autoTerminalLogs) this.autoTerminalLogs = [];
        const timeStr = new Date().toLocaleTimeString();
        const logLine = `[${timeStr}] ${message}`;
        this.autoTerminalLogs.push(logLine);
        if (this.autoTerminalLogs.length > 50) {
            this.autoTerminalLogs.shift();
        }
        console.log(`[AUTOMATION] ${message}`);
        
        // Dynamically update logs UI if visible
        const logBox = document.getElementById('automation-terminal-logs');
        if (logBox) {
            logBox.textContent = this.autoTerminalLogs.join('\n');
            logBox.scrollTop = logBox.scrollHeight;
        }
    },

    triggerSimulatedCronJob(type) {
        this.logAutomation(`Manual override: triggering scheduled job: "${type}"...`);
        if (type === 'newsletter') {
            this.runNewsletterJob();
        } else if (type === 'backup') {
            this.runBackupJob();
        } else if (type === 'learning') {
            this.runAILearningJob();
        }
    },

    triggerSimulatedFailure() {
        this.simulatedNetworkFailure = !this.simulatedNetworkFailure;
        this.logAutomation(`SIMULATOR: Injected network failure state is now: ${this.simulatedNetworkFailure ? 'ACTIVE (blocking requests)' : 'INACTIVE (restored)'}`);
        const statusBtn = document.querySelector('[onclick="app.triggerSimulatedFailure()"]');
        if (statusBtn) {
            statusBtn.className = this.simulatedNetworkFailure ? 'btn btn-outline' : 'btn btn-danger';
            statusBtn.style.color = this.simulatedNetworkFailure ? 'var(--clr-success)' : 'white';
            statusBtn.innerHTML = this.simulatedNetworkFailure ? '<i class="fa-solid fa-signal"></i> Restore Connection' : '<i class="fa-solid fa-triangle-exclamation"></i> Inject Sim Network Failure';
        }
    },

    runNewsletterJob() {
        const jobId = 'JOB-' + Date.now().toString().slice(-4);
        this.db.automationJobs.unshift({
            id: jobId,
            name: 'Weekly Newsletter Broadcast',
            user: 'All Members',
            timestamp: new Date().toISOString(),
            retries: 0,
            status: 'Pending'
        });
        this.logAutomation(`Scheduled weekly newsletter job ${jobId} queued.`);
        this.saveDatabase();
        if (this.activeView === 'admin' && this.activeAdminTab === 'automation') {
            this.renderAdminAutomationCMS();
        }
    },

    runBackupJob() {
        const jobId = 'JOB-' + Date.now().toString().slice(-4);
        this.db.automationJobs.unshift({
            id: jobId,
            name: 'Automated DB Backup Archive',
            user: 'System Core',
            timestamp: new Date().toISOString(),
            retries: 0,
            status: 'Pending'
        });
        this.logAutomation(`Maintenance: DB Backup Job ${jobId} queued.`);
        this.saveDatabase();
        if (this.activeView === 'admin' && this.activeAdminTab === 'automation') {
            this.renderAdminAutomationCMS();
        }
    },

    runAILearningJob() {
        const jobId = 'JOB-' + Date.now().toString().slice(-4);
        this.db.automationJobs.unshift({
            id: jobId,
            name: 'AI Historical Learning Optimization',
            user: 'Frannie NLP',
            timestamp: new Date().toISOString(),
            retries: 0,
            status: 'Pending'
        });
        this.logAutomation(`Analytics: AI Optimization Job ${jobId} queued.`);
        this.saveDatabase();
        if (this.activeView === 'admin' && this.activeAdminTab === 'automation') {
            this.renderAdminAutomationCMS();
        }
    },

    renderAdminAutomationCMS() {
        // Render jobs queue
        const tbody = document.getElementById('automation-jobs-tbody');
        if (tbody) {
            let html = '';
            if (this.db.automationJobs.length === 0) {
                html = `<tr><td colspan="6" style="text-align:center; color:#888;">No active jobs in the queue.</td></tr>`;
            } else {
                this.db.automationJobs.slice(0, 10).forEach(j => {
                    let statusBadge = '';
                    if (j.status === 'Pending') {
                        statusBadge = `<span style="background:#ffc107; color:black; padding:3px 8px; border-radius:10px; font-size:0.7rem; font-weight:bold;">Pending</span>`;
                    } else if (j.status === 'In Progress') {
                        statusBadge = `<span style="background:#17a2b8; color:white; padding:3px 8px; border-radius:10px; font-size:0.7rem; font-weight:bold;">Running</span>`;
                    } else if (j.status === 'Completed') {
                        statusBadge = `<span style="background:#28a745; color:white; padding:3px 8px; border-radius:10px; font-size:0.7rem; font-weight:bold;">Success</span>`;
                    } else {
                        statusBadge = `<span style="background:#dc3545; color:white; padding:3px 8px; border-radius:10px; font-size:0.7rem; font-weight:bold;">Failed</span>`;
                    }

                    html += `
                        <tr>
                            <td><strong>${j.id}</strong></td>
                            <td>${j.name}</td>
                            <td>${j.user}</td>
                            <td>${new Date(j.timestamp).toLocaleTimeString()}</td>
                            <td><strong style="color:${j.retries > 0 ? '#f77f00' : 'var(--clr-text-dark)'};">${j.retries} runs</strong></td>
                            <td>${statusBadge}</td>
                        </tr>
                    `;
                });
            }
            tbody.innerHTML = html;
        }

        // Update stats
        const activeCount = this.db.automationJobs.filter(j => j.status === 'Pending' || j.status === 'In Progress').length;
        const failedCount = this.db.automationFailures || 0;
        const retriesCount = this.db.automationRetries || 0;

        const activeJobsEl = document.getElementById('auto-active-jobs');
        if (activeJobsEl) activeJobsEl.textContent = `${activeCount} Pending`;

        const failedJobsEl = document.getElementById('auto-failed-jobs');
        if (failedJobsEl) failedJobsEl.textContent = `${failedCount} / ${retriesCount}`;

        // DB Size
        const memoryEl = document.getElementById('auto-memory');
        if (memoryEl) {
            const dbSize = (JSON.stringify(this.db).length / 1024).toFixed(2);
            memoryEl.textContent = dbSize + ' KB';
        }
    }
};

// Merge real app implementation into window.app stub (for early interaction support)
if (window.app) {
    const queue = window.app._queue || [];
    
    // Copy and bind all properties to window.app to keep correct execution context
    for (const key in leanLifeAppCore) {
        if (typeof leanLifeAppCore[key] === 'function') {
            window.app[key] = leanLifeAppCore[key].bind(window.app);
        } else {
            window.app[key] = leanLifeAppCore[key];
        }
    }
    window.app.initialized = true;
    
    // Bind methods to keep correct context
    window.app.realNavigateTo = window.app.navigateTo;
    window.app.realLogout = window.app.logout;
    
    // Replay any navigation actions clicked before app.js loaded
    queue.forEach(q => {
        if (q.type === 'navigate') window.app.realNavigateTo(q.view);
    });
} else {
    window.app = leanLifeAppCore;
}

// Start application immediately if DOM is already ready, otherwise on DOMContentLoaded
if (typeof document !== 'undefined') {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        window.app.init();
    } else {
        window.addEventListener('DOMContentLoaded', () => window.app.init());
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { app: (typeof window !== 'undefined' && window.app) || leanLifeAppCore, AuthService, AuthResult, LeanLifeCacheManager };
}
