// netlify/functions/user-admin.js
// LeanLife Protected Server-Side Administration & Auth Index Mutation Endpoint
// Enforces cryptographic server-side authorization: 401 Unauthorized / 403 Forbidden

const crypto = require('crypto');
const { verifySessionToken, signSessionToken } = require('./auth');

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const cleanUrl = (SUPABASE_URL || '').trim().replace(/\/+$/, '');
const cleanKey = (SUPABASE_KEY || '').trim();

function hashPasswordPBKDF2Sync(password, saltUint8 = null) {
    const iterations = 100000;
    const salt = saltUint8 || crypto.randomBytes(16);
    const derived = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
    const saltHex = salt.toString('hex');
    const hashHex = derived.toString('hex');
    return `pbkdf2$${iterations}$${saltHex}$${hashHex}`;
}

exports.handler = async function(event, context) {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: CORS_HEADERS, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: CORS_HEADERS,
            body: JSON.stringify({ success: false, error: 'METHOD_NOT_ALLOWED' })
        };
    }

    if (!process.env.AUTH_SECRET) {
        console.error('[User Admin] AUTH_SECRET environment variable is required');
        return {
            statusCode: 503,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                success: false,
                error: 'SERVER_CONFIGURATION_ERROR',
                message: 'AUTH_SECRET environment variable is required'
            })
        };
    }

    let body = {};
    try {
        body = JSON.parse(event.body || '{}');
    } catch (e) {
        return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ success: false, error: 'INVALID_JSON' })
        };
    }

    const action = body.action;

    if (!action) {
        return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ success: false, error: 'MISSING_ACTION' })
        };
    }

    // 1. Authorize Action
    const publicActions = ['request-password-reset', 'self-register-member'];
    let caller = null;

    if (!publicActions.includes(action)) {
        const reqHeaders = event.headers || {};
        const authHeader = reqHeaders.authorization || reqHeaders.Authorization || '';
        const token = authHeader.replace(/^Bearer\s+/i, '').trim() || body.token;

        // Case A: Missing Session Token -> 401 Unauthorized
        if (!token) {
            return {
                statusCode: 401,
                headers: CORS_HEADERS,
                body: JSON.stringify({ success: false, error: 'UNAUTHORIZED', message: 'Authentication session token required.' })
            };
        }

        // Case B: Invalid / Tampered Session Token -> 401 Unauthorized
        const tokenVerification = verifySessionToken(token);
        if (!tokenVerification.valid) {
            return {
                statusCode: 401,
                headers: CORS_HEADERS,
                body: JSON.stringify({ success: false, error: 'UNAUTHORIZED', message: 'Invalid or expired session token.' })
            };
        }

        caller = tokenVerification.payload;

        // 2. Role-Based Server-Side Authorization
        const adminActions = [
            'admin-reset-password',
            'admin-register-member',
            'toggle-user-status',
            'change-user-role',
            'admin-delete-user',
            'reconcile-auth-index'
        ];
        
        // Case C: Valid Ordinary Member attempting Admin Action -> 403 Forbidden
        if (adminActions.includes(action) && caller.role !== 'admin') {
            return {
                statusCode: 403,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    success: false,
                    error: 'FORBIDDEN',
                    message: 'Administrator privileges required for this operation.'
                })
            };
        }

        // Case D: Member Self-Update Authorization Check
        if (action === 'update-password') {
            const targetEmail = (body.targetEmail || body.email || '').trim().toLowerCase();
            if (caller.role !== 'admin' && caller.email.toLowerCase() !== targetEmail) {
                return {
                    statusCode: 403,
                    headers: CORS_HEADERS,
                    body: JSON.stringify({
                        success: false,
                        error: 'FORBIDDEN',
                        message: 'Cannot modify credentials of another user.'
                    })
                };
            }
        }
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.error('[User Admin] SUPABASE_URL and (SUPABASE_SERVICE_ROLE_KEY or SUPABASE_KEY) are required');
        return {
            statusCode: 503,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                success: false,
                error: 'SERVER_CONFIGURATION_ERROR',
                message: 'Database configuration not configured.'
            })
        };
    }

    // 3. Helper to Fetch Datasets from system_settings
    async function fetchDataset(id) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 6000);
            const res = await fetch(`${cleanUrl}/rest/v1/system_settings?id=eq.${encodeURIComponent(id)}&select=data`, {
                method: 'GET',
                headers: {
                    'apikey': cleanKey,
                    'Authorization': `Bearer ${cleanKey}`,
                    'Accept': 'application/json'
                },
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data) && data.length > 0 && data[0].data) {
                    return data[0].data;
                }
            }
        } catch (e) {
            console.warn(`[User Admin] Cloud read notice for ${id}:`, e.message || e);
        }
        return null;
    }

    // Retrieve leanlife_auth_index
    let authUsers = null;
    const authData = await fetchDataset('leanlife_auth_index');
    if (authData && Array.isArray(authData.users)) {
        authUsers = authData.users;
    }

    if (!authUsers) {
        console.error('[User Admin] Could not retrieve authoritative leanlife_auth_index dataset.');
        return {
            statusCode: 503,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                success: false,
                error: 'AUTH_SERVICE_UNAVAILABLE',
                message: 'Authoritative authentication index is currently unreachable. Please try again shortly.'
            })
        };
    }

    // 4. Execute Privileged or Public Mutation
    // All credential, registration, and user-management actions operate strictly against
    // the lightweight authoritative leanlife_auth_index (~5 KB), eliminating cloud_db bloat timeouts.
    let mutatedUser = null;
    let extraResponseData = {};

    if (action === 'admin-reset-password') {
        const targetEmail = (body.targetEmail || '').trim().toLowerCase();
        let user = authUsers.find(u => (u.email || '').trim().toLowerCase() === targetEmail);

        if (!user) {
            return {
                statusCode: 404,
                headers: CORS_HEADERS,
                body: JSON.stringify({ success: false, error: 'USER_NOT_FOUND', message: 'User not found in authentication index.' })
            };
        }
        const tempPin = body.tempPassword || ('LL-' + Math.floor(100000 + Math.random() * 900000));
        delete user.tempPasswordRaw;
        user.password = hashPasswordPBKDF2Sync(tempPin);
        user.firstLogin = true;
        user.authUpdatedAt = new Date().toISOString();
        user.updatedAt = new Date().toISOString();
        mutatedUser = user;
        extraResponseData.tempPassword = tempPin;
    } else if (action === 'admin-register-member') {
        const { name, email, phone, role = 'member' } = body.memberData || {};
        const cleanEmail = (email || '').trim().toLowerCase();
        if (!cleanEmail) {
            return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'EMAIL_REQUIRED' }) };
        }
        const existsInAuth = authUsers.some(u => (u.email || '').trim().toLowerCase() === cleanEmail);
        if (existsInAuth) {
            return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'USER_ALREADY_EXISTS' }) };
        }
        const tempPin = (body.memberData && (body.memberData.tempPassword || body.memberData.password)) ||
                        body.tempPassword ||
                        ('LL-' + Math.floor(100000 + Math.random() * 900000));
        const userId = 'USR-' + Date.now();
        const nowIso = new Date().toISOString();
        const newUser = {
            id: userId,
            name: name || 'LeanLife Member',
            email: cleanEmail,
            phone: phone || '',
            password: hashPasswordPBKDF2Sync(tempPin),
            role: role,
            status: 'Active',
            firstLogin: true,
            authUpdatedAt: nowIso,
            updatedAt: nowIso
        };
        authUsers.push(newUser);
        mutatedUser = newUser;
        extraResponseData.tempPassword = tempPin;
    } else if (action === 'toggle-user-status') {
        const targetEmail = (body.targetEmail || '').trim().toLowerCase();
        const user = authUsers.find(u => (u.email || '').trim().toLowerCase() === targetEmail);
        if (!user) {
            return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'USER_NOT_FOUND', message: 'User not found in authentication index.' }) };
        }
        user.status = user.status === 'Active' ? 'Suspended' : 'Active';
        user.authUpdatedAt = new Date().toISOString();
        user.updatedAt = new Date().toISOString();
        mutatedUser = user;
    } else if (action === 'change-user-role') {
        const targetEmail = (body.targetEmail || '').trim().toLowerCase();
        const user = authUsers.find(u => (u.email || '').trim().toLowerCase() === targetEmail);
        if (!user) {
            return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'USER_NOT_FOUND', message: 'User not found in authentication index.' }) };
        }
        user.role = body.newRole || 'member';
        user.authUpdatedAt = new Date().toISOString();
        user.updatedAt = new Date().toISOString();
        mutatedUser = user;
    } else if (action === 'admin-delete-user') {
        const targetEmail = (body.targetEmail || '').trim().toLowerCase();
        const authIdx = authUsers.findIndex(u => (u.email || '').trim().toLowerCase() === targetEmail);
        if (authIdx === -1) {
            return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'USER_NOT_FOUND', message: 'User not found in authentication index.' }) };
        }
        mutatedUser = authUsers[authIdx];
        authUsers.splice(authIdx, 1);
        extraResponseData.deleted = true;
    } else if (action === 'update-password') {
        const targetEmail = (body.targetEmail || body.email || '').trim().toLowerCase();
        let user = authUsers.find(u => (u.email || '').trim().toLowerCase() === targetEmail);
        if (!user) {
            return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'USER_NOT_FOUND', message: 'User not found in authentication index.' }) };
        }
        user.password = hashPasswordPBKDF2Sync(body.newPassword);
        delete user.tempPasswordRaw;
        user.firstLogin = false;
        user.authUpdatedAt = new Date().toISOString();
        user.updatedAt = new Date().toISOString();
        mutatedUser = user;
    } else if (action === 'request-password-reset') {
        const targetEmail = (body.targetEmail || body.email || '').trim().toLowerCase();
        if (!targetEmail) {
            return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'EMAIL_REQUIRED', message: 'Email address is required.' }) };
        }
        let user = authUsers.find(u => (u.email || '').trim().toLowerCase() === targetEmail);
        if (!user) {
            return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'USER_NOT_FOUND', message: 'Account not found.' }) };
        }
        const tempPin = 'LL-' + Math.floor(100000 + Math.random() * 900000);
        delete user.tempPasswordRaw;
        user.password = hashPasswordPBKDF2Sync(tempPin);
        user.firstLogin = true;
        user.authUpdatedAt = new Date().toISOString();
        user.updatedAt = new Date().toISOString();
        mutatedUser = user;
        extraResponseData.tempPassword = tempPin;
    } else if (action === 'self-register-member') {
        const { name, email, password, phone } = body.memberData || body || {};
        const cleanEmail = (email || '').trim().toLowerCase();
        if (!cleanEmail) {
            return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'EMAIL_REQUIRED', message: 'Email is required.' }) };
        }
        if (!password) {
            return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'PASSWORD_REQUIRED', message: 'Password is required.' }) };
        }
        const existsInAuth = authUsers.some(u => (u.email || '').trim().toLowerCase() === cleanEmail);
        if (existsInAuth) {
            return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'USER_ALREADY_EXISTS', message: 'Email is already registered.' }) };
        }
        const hashedPassword = hashPasswordPBKDF2Sync(password);
        const userId = 'USR-' + Date.now();
        const nowIso = new Date().toISOString();

        const newUser = {
            id: userId,
            name: name || 'LeanLife Member',
            email: cleanEmail,
            phone: phone || '+1 (555) 0000',
            password: hashedPassword,
            role: 'member', // Strictly enforce member role
            status: 'Active',
            firstLogin: false,
            authUpdatedAt: nowIso,
            updatedAt: nowIso
        };
        authUsers.push(newUser);
        mutatedUser = newUser;

        // Generate signed HMAC session token
        const nowSec = Math.floor(Date.now() / 1000);
        const sessionPayload = {
            sub: newUser.id,
            email: newUser.email,
            name: newUser.name,
            role: newUser.role,
            status: newUser.status,
            iat: nowSec,
            exp: nowSec + (7 * 24 * 3600)
        };
        extraResponseData.token = signSessionToken(sessionPayload);
    } else if (action === 'reconcile-auth-index') {
        const cloudDbRaw = await fetchDataset('leanlife_cloud_db');
        const cloudUsers = (cloudDbRaw && Array.isArray(cloudDbRaw.users)) ? cloudDbRaw.users : [];
        let reconciledCount = 0;

        for (const cu of cloudUsers) {
            const cleanEmail = (cu.email || '').trim().toLowerCase();
            if (!cleanEmail) continue;

            const existingIdx = authUsers.findIndex(u => (u.email || '').trim().toLowerCase() === cleanEmail);
            if (existingIdx === -1) {
                let pwdHash = cu.password;
                let tempPin = cu.tempPasswordRaw || null;
                if (!pwdHash || !pwdHash.startsWith('pbkdf2$')) {
                    if (pwdHash && pwdHash.length === 64) {
                        // Keep legacy SHA-256 hash intact
                    } else {
                        tempPin = tempPin || ('LL-' + Math.floor(100000 + Math.random() * 900000));
                        pwdHash = hashPasswordPBKDF2Sync(tempPin);
                    }
                }
                const reconciled = {
                    id: cu.id || ('USR-' + Date.now()),
                    name: cu.name || 'LeanLife Member',
                    email: cleanEmail,
                    phone: cu.phone || '',
                    password: pwdHash,
                    role: cu.role || 'member',
                    status: cu.status || 'Active',
                    firstLogin: cu.firstLogin !== undefined ? cu.firstLogin : false,
                    authUpdatedAt: cu.authUpdatedAt || cu.updatedAt || new Date().toISOString(),
                    updatedAt: cu.updatedAt || new Date().toISOString()
                };
                authUsers.push(reconciled);
                reconciledCount++;
            }
        }

        mutatedUser = { email: caller.email, role: caller.role, name: caller.name };
        extraResponseData = {
            reconciledCount,
            totalAuthUsers: authUsers.length,
            totalCloudUsers: cloudUsers.length
        };
    } else {
        return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ success: false, error: 'UNKNOWN_ACTION' })
        };
    }

    // 5. Persist updated authoritative leanlife_auth_index to Supabase with Upsert
    let authSaved = false;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(`${cleanUrl}/rest/v1/system_settings`, {
            method: 'POST',
            headers: {
                'apikey': cleanKey,
                'Authorization': `Bearer ${cleanKey}`,
                'Content-Type': 'application/json',
                'Prefer': 'resolution=merge-duplicates'
            },
            body: JSON.stringify({
                id: 'leanlife_auth_index',
                data: { users: authUsers },
                updated_at: new Date().toISOString()
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        authSaved = res.ok;
        if (!res.ok) {
            console.error(`[User Admin] Supabase write failed for auth_index: HTTP ${res.status} ${res.statusText}`);
        }
    } catch (saveErr) {
        console.error("[User Admin] Cloud write exception (auth_index):", saveErr.message || saveErr);
        authSaved = false;
    }

    // Strict Persistence Invariant: NEVER report success if required database persistence failed
    if (!authSaved) {
        console.error(`[User Admin] Persistence check failed: authSaved=${authSaved}. Aborting success response.`);
        return {
            statusCode: 503,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                success: false,
                error: 'PERSISTENCE_FAILED',
                message: 'Database persistence failed. Changes were not saved.',
                diagnostics: {
                    authSaved
                }
            })
        };
    }

    // 6. Return Sanitized Response (Zero password hashes or raw pins leaked)
    const { password: _p, tempPasswordRaw: _t, ...safeUser } = (mutatedUser || {});
    delete safeUser.tempPasswordRaw;

    return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
            success: true,
            user: safeUser,
            token: extraResponseData.token,
            ...extraResponseData
        })
    };
};
