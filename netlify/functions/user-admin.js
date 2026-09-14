// netlify/functions/user-admin.js
// LeanLife Protected Server-Side Administration & Auth Index Mutation Endpoint
// Enforces cryptographic server-side authorization: 401 Unauthorized / 403 Forbidden

const crypto = require('crypto');
const { verifySessionToken, BASELINE_AUTH_INDEX_USERS } = require('./auth');

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

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
        const authHeader = event.headers.authorization || event.headers.Authorization || '';
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
        const adminActions = ['admin-reset-password', 'admin-register-member', 'toggle-user-status', 'change-user-role', 'admin-delete-user'];
        
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
            const targetEmail = (body.targetEmail || '').trim().toLowerCase();
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

    // 3. Retrieve leanlife_auth_index from Supabase (or baseline seed)
    let authUsers = null;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        const res = await fetch(`${SUPABASE_URL}/rest/v1/system_settings?id=eq.leanlife_auth_index&select=data`, {
            method: 'GET',
            headers: { 'apikey': SUPABASE_KEY, 'Accept': 'application/json' },
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data) && data.length > 0 && data[0].data && Array.isArray(data[0].data.users)) {
                authUsers = data[0].data.users;
            }
        }
    } catch (e) {
        console.warn("[User Admin] Cloud read notice:", e.message || e);
    }

    if (!authUsers || authUsers.length === 0) {
        authUsers = BASELINE_AUTH_INDEX_USERS.map(u => ({ ...u }));
    }

    // 4. Execute Privileged Mutation
    let mutatedUser = null;
    let extraResponseData = {};

    if (action === 'admin-reset-password') {
        const targetEmail = (body.targetEmail || '').trim().toLowerCase();
        const user = authUsers.find(u => (u.email || '').trim().toLowerCase() === targetEmail);
        if (!user) {
            return {
                statusCode: 404,
                headers: CORS_HEADERS,
                body: JSON.stringify({ success: false, error: 'USER_NOT_FOUND' })
            };
        }
        const tempPin = body.tempPassword || ('LL-' + Math.floor(100000 + Math.random() * 900000));
        user.tempPasswordRaw = tempPin;
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
        const exists = authUsers.some(u => (u.email || '').trim().toLowerCase() === cleanEmail);
        if (exists) {
            return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'USER_ALREADY_EXISTS' }) };
        }
        const tempPin = 'LL-' + Math.floor(100000 + Math.random() * 900000);
        const newUser = {
            id: 'USR-' + Date.now(),
            name: name || 'LeanLife Member',
            email: cleanEmail,
            phone: phone || '',
            password: hashPasswordPBKDF2Sync(tempPin),
            tempPasswordRaw: tempPin,
            role: role,
            status: 'Active',
            firstLogin: true,
            authUpdatedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        authUsers.push(newUser);
        mutatedUser = newUser;
        extraResponseData.tempPassword = tempPin;
    } else if (action === 'toggle-user-status') {
        const targetEmail = (body.targetEmail || '').trim().toLowerCase();
        const user = authUsers.find(u => (u.email || '').trim().toLowerCase() === targetEmail);
        if (!user) {
            return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'USER_NOT_FOUND' }) };
        }
        user.status = user.status === 'Active' ? 'Suspended' : 'Active';
        user.authUpdatedAt = new Date().toISOString();
        user.updatedAt = new Date().toISOString();
        mutatedUser = user;
    } else if (action === 'change-user-role') {
        const targetEmail = (body.targetEmail || '').trim().toLowerCase();
        const user = authUsers.find(u => (u.email || '').trim().toLowerCase() === targetEmail);
        if (!user) {
            return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'USER_NOT_FOUND' }) };
        }
        user.role = body.newRole || 'member';
        user.authUpdatedAt = new Date().toISOString();
        user.updatedAt = new Date().toISOString();
        mutatedUser = user;
    } else if (action === 'update-password') {
        const targetEmail = (body.targetEmail || '').trim().toLowerCase();
        const user = authUsers.find(u => (u.email || '').trim().toLowerCase() === targetEmail);
        if (!user) {
            return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'USER_NOT_FOUND' }) };
        }
        user.password = hashPasswordPBKDF2Sync(body.newPassword);
        user.tempPasswordRaw = null;
        user.firstLogin = false;
        user.authUpdatedAt = new Date().toISOString();
        user.updatedAt = new Date().toISOString();
        mutatedUser = user;
    } else if (action === 'request-password-reset') {
        const targetEmail = (body.targetEmail || body.email || '').trim().toLowerCase();
        if (!targetEmail) {
            return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'EMAIL_REQUIRED', message: 'Email address is required.' }) };
        }
        const user = authUsers.find(u => (u.email || '').trim().toLowerCase() === targetEmail);
        if (!user) {
            return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'USER_NOT_FOUND', message: 'Account not found.' }) };
        }
        const tempPin = 'LL-' + Math.floor(100000 + Math.random() * 900000);
        user.tempPasswordRaw = tempPin;
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
        const exists = authUsers.some(u => (u.email || '').trim().toLowerCase() === cleanEmail);
        if (exists) {
            return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: 'USER_ALREADY_EXISTS', message: 'Email is already registered.' }) };
        }
        const newUser = {
            id: 'USR-' + Date.now(),
            name: name || 'LeanLife Member',
            email: cleanEmail,
            phone: phone || '',
            password: hashPasswordPBKDF2Sync(password),
            role: 'member',
            status: 'Active',
            firstLogin: false,
            authUpdatedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        authUsers.push(newUser);
        mutatedUser = newUser;
    }

    // 5. Persist updated leanlife_auth_index to Supabase with Upsert
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        await fetch(`${SUPABASE_URL}/rest/v1/system_settings`, {
            method: 'POST',
            headers: {
                'apikey': SUPABASE_KEY,
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
    } catch (saveErr) {
        console.warn("[User Admin] Cloud write warning:", saveErr.message || saveErr);
    }

    // 6. Return Sanitized Response (Zero password hashes leaked)
    const { password: _p, tempPasswordRaw: _t, ...safeUser } = mutatedUser;

    return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
            success: true,
            user: safeUser,
            ...extraResponseData
        })
    };
};
