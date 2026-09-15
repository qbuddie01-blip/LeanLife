// netlify/functions/cloud-read.js
// LeanLife Authenticated Server-Side Cloud Read Gateway
// Eliminates public data exposure by replacing direct anonymous SELECTs on leanlife_cloud_db.
// - Unauthenticated Visitors: Receives ONLY public community data (posts, events, theme hues). Zero PII/clinical data.
// - Authenticated Members: Receives public data PLUS strictly caller-owned records (wellness logs, appointments, AI reports, profile).
// - Admins/Coaches: Receives role-authorized dataset for coaching & management. Scrubbed of credential secrets.

const { verifySessionToken } = require('./auth');

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const AUTH_SECRET = process.env.AUTH_SECRET;

// Safe public system settings helper: ONLY theme styling & persona. No API keys or internal settings.
function extractSafePublicSettings(settings = {}) {
    return {
        primaryHue: settings.primaryHue !== undefined ? settings.primaryHue : 168,
        accentHue: settings.accentHue !== undefined ? settings.accentHue : 80,
        persona: settings.persona || 'encouraging'
    };
}

// User profile sanitizer: Removes all credentials and passwords
function sanitizeUserProfile(user) {
    if (!user) return null;
    const { password: _p, tempPasswordRaw: _t, ...safeUser } = user;
    return safeUser;
}

exports.handler = async function(event, context) {
    // 1. CORS Preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: CORS_HEADERS, body: '' };
    }

    if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: CORS_HEADERS,
            body: JSON.stringify({ success: false, error: 'METHOD_NOT_ALLOWED', message: 'Only GET or POST permitted.' })
        };
    }

    // 2. Token Extraction & Verification
    // CRITICAL: Caller identity comes STRICTLY from the verified cryptographic HMAC session token.
    // Query parameters (?email=...), body fields, or arbitrary headers are STRICTLY IGNORED.
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    let token = authHeader.replace(/^Bearer\s+/i, '').trim();

    // If POST, check body for token fallback
    if (!token && event.httpMethod === 'POST' && event.body) {
        try {
            const parsedBody = JSON.parse(event.body);
            token = parsedBody.token || '';
        } catch (e) {}
    }

    let caller = null;
    let isAuthenticated = false;

    if (token) {
        const tokenVerification = verifySessionToken(token, AUTH_SECRET);
        if (!tokenVerification.valid) {
            // If client provided a token but it's invalid or expired, reject with 401
            return {
                statusCode: 401,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    success: false,
                    error: 'UNAUTHORIZED',
                    message: 'Invalid or expired session token.',
                    detail: tokenVerification.error
                })
            };
        }
        caller = tokenVerification.payload || {};
        isAuthenticated = true;
    }

    // 3. Fetch Authoritative leanlife_cloud_db from Supabase Server-Side
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.error('[CloudRead] SUPABASE_URL and (SUPABASE_SERVICE_ROLE_KEY or SUPABASE_KEY) are required');
        return {
            statusCode: 503,
            headers: CORS_HEADERS,
            body: JSON.stringify({ success: false, error: 'SERVER_CONFIGURATION_ERROR', message: 'Database configuration not configured.' })
        };
    }

    let cloudDb = null;
    try {
        const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timeoutId = controller ? setTimeout(() => controller.abort(), 6000) : null;

        const res = await fetch(`${SUPABASE_URL}/rest/v1/system_settings?id=eq.leanlife_cloud_db&select=*`, {
            method: 'GET',
            headers: {
                'apikey': SUPABASE_KEY,
                'Accept': 'application/json'
            },
            signal: controller ? controller.signal : undefined
        });

        if (timeoutId) clearTimeout(timeoutId);

        if (res.ok) {
            const rows = await res.json();
            if (Array.isArray(rows) && rows.length > 0 && rows[0].data) {
                cloudDb = rows[0].data;
            }
        } else {
            console.warn(`[CloudRead] Supabase error HTTP ${res.status}: ${res.statusText}`);
            const errorBody = { success: false, error: 'SERVICE_UNAVAILABLE', message: 'Database read failed.' };
            if (isAuthenticated && caller && caller.role === 'admin') {
                errorBody.diagnostic = {
                    supabaseStatus: res.status,
                    supabaseStatusText: res.statusText,
                    hasServiceRoleKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
                    hasSupabaseKey: !!process.env.SUPABASE_KEY,
                    keyType: SUPABASE_KEY ? (SUPABASE_KEY.split('.').length === 3 ? 'legacy JWT' : 'opaque secret key') : 'missing',
                    version: 'v2-header-fix'
                };
            }
            return {
                statusCode: 503,
                headers: CORS_HEADERS,
                body: JSON.stringify(errorBody)
            };
        }
    } catch (fetchErr) {
        console.warn("[CloudRead] Supabase connection failure:", fetchErr.message || fetchErr);
        const errBody = { success: false, error: 'SERVICE_UNAVAILABLE', message: 'Database connection error.' };
        if (isAuthenticated && caller && caller.role === 'admin') {
            errBody.diagnostic = {
                fetchError: fetchErr.message || String(fetchErr),
                version: 'v2-header-fix'
            };
        }
        return {
            statusCode: 503,
            headers: CORS_HEADERS,
            body: JSON.stringify(errBody)
        };
    }

    if (!cloudDb) {
        return {
            statusCode: 503,
            headers: CORS_HEADERS,
            body: JSON.stringify({ success: false, error: 'DATABASE_EMPTY', message: 'Cloud database not initialized.' })
        };
    }

    // Baseline collections
    const allPosts = Array.isArray(cloudDb.posts) ? cloudDb.posts : [];
    const allEvents = Array.isArray(cloudDb.events) ? cloudDb.events : [];
    const allUsers = Array.isArray(cloudDb.users) ? cloudDb.users : [];
    const allLogs = Array.isArray(cloudDb.wellnessLogs) ? cloudDb.wellnessLogs : [];
    const allApps = Array.isArray(cloudDb.appointments) ? cloudDb.appointments : [];
    const allAi = Array.isArray(cloudDb.aiReports) ? cloudDb.aiReports : [];
    const allNotifications = Array.isArray(cloudDb.notifications) ? cloudDb.notifications : [];
    const rawSettings = cloudDb.systemSettings || {};

    // 4. Construct Scoped Dataset Based on Verified Identity

    if (!isAuthenticated) {
        // ==================== A. UNAUTHENTICATED VISITOR ====================
        // Returns ONLY public community data.
        // ZERO users, ZERO wellness logs, ZERO appointments, ZERO AI reports,
        // ZERO audit logs, ZERO emails, ZERO automation jobs, ZERO deleted users, ZERO credentials.
        const publicPayload = {
            authenticated: false,
            role: 'visitor',
            posts: allPosts,
            events: allEvents,
            systemSettings: extractSafePublicSettings(rawSettings)
        };

        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                success: true,
                data: publicPayload
            })
        };
    }

    const callerEmail = (caller.email || '').trim().toLowerCase();
    const callerRole = (caller.role || 'member').trim().toLowerCase();

    if (callerRole === 'admin' || callerRole === 'coach') {
        // ==================== B. ADMIN / COACH ====================
        // Returns administrative dataset required by coach & admin dashboards.
        // Sanitizes all user credentials (passwords, tempPasswordRaw).
        // Omits massive backend dumps (emails: 24k records, automationJobs: 2.2k records).
        const sanitizedUsers = allUsers.map(u => sanitizeUserProfile(u)).filter(Boolean);

        const adminPayload = {
            authenticated: true,
            role: callerRole,
            posts: allPosts,
            events: allEvents,
            users: sanitizedUsers,
            appointments: allApps,
            wellnessLogs: allLogs,
            aiReports: allAi,
            notifications: allNotifications,
            auditLogs: Array.isArray(cloudDb.auditLogs) ? cloudDb.auditLogs.slice(0, 100) : [],
            systemSettings: {
                ...extractSafePublicSettings(rawSettings),
                emailjsServiceId: rawSettings.emailjsServiceId || '',
                emailjsTemplateId: rawSettings.emailjsTemplateId || '',
                emailjsWelcomeTemplateId: rawSettings.emailjsWelcomeTemplateId || '',
                emailjsAutoreplyTemplateId: rawSettings.emailjsAutoreplyTemplateId || '',
                emailjsPublicKey: rawSettings.emailjsPublicKey || ''
            },
            _envDiagnostics: {
                supabaseUrl: process.env.SUPABASE_URL ? 'PRESENT' : 'ABSENT',
                supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ? (process.env.SUPABASE_SERVICE_ROLE_KEY.split('.').length === 3 ? 'PRESENT (legacy JWT)' : 'PRESENT (opaque secret key)') : 'ABSENT',
                supabaseKey: process.env.SUPABASE_KEY ? (process.env.SUPABASE_KEY.split('.').length === 3 ? 'PRESENT (legacy JWT)' : 'PRESENT (opaque secret key)') : 'ABSENT',
                authSecret: process.env.AUTH_SECRET ? 'PRESENT' : 'ABSENT'
            }
        };

        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                success: true,
                data: adminPayload
            })
        };
    }

    // ==================== C. AUTHENTICATED MEMBER ====================
    // Returns public data PLUS strictly caller's own records.
    // Caller CANNOT read other members' data or administrative logs.
    const memberLogs = allLogs.filter(l => (l.userEmail || l.email || '').trim().toLowerCase() === callerEmail);
    const memberApps = allApps.filter(a => (a.user_email || a.clientEmail || '').trim().toLowerCase() === callerEmail);
    const memberAi = allAi.filter(r => (r.userEmail || r.email || '').trim().toLowerCase() === callerEmail);
    const memberNotifications = allNotifications.filter(n => (n.recipient || n.email || '').trim().toLowerCase() === callerEmail);

    const callerProfile = allUsers.find(u => (u.email || '').trim().toLowerCase() === callerEmail);
    const sanitizedProfile = sanitizeUserProfile(callerProfile);

    const memberPayload = {
        authenticated: true,
        role: 'member',
        callerEmail: callerEmail,
        posts: allPosts,
        events: allEvents,
        systemSettings: extractSafePublicSettings(rawSettings),
        // Scoped personal records:
        users: sanitizedProfile ? [sanitizedProfile] : [],
        currentUserProfile: sanitizedProfile,
        wellnessLogs: memberLogs,
        appointments: memberApps,
        aiReports: memberAi,
        notifications: memberNotifications
    };

    return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
            success: true,
            data: memberPayload
        })
    };
};
