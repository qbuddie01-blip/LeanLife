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

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://vqvbxhzxtwjhieihvoah.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZxdmJ4aHp4dHdqaGllaWh2b2FoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MDU1NDAsImV4cCI6MjA5ODk4MTU0MH0.40ItPbKKZihVJ6IgC2BMU_cGO4pOzQFD-6-QkxEuZTk';

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

    // 1. Extract Bearer Token
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

    const caller = tokenVerification.payload;
    const action = body.action;

    if (!action) {
        return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ success: false, error: 'MISSING_ACTION' })
        };
    }

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

    // 3. Retrieve leanlife_auth_index from Supabase (or baseline seed)
    let authUsers = null;
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/system_settings?id=eq.leanlife_auth_index&select=data`, {
            method: 'GET',
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        });
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
        const tempPin = 'LL-' + Math.floor(100000 + Math.random() * 900000);
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
    }

    // 5. Persist updated leanlife_auth_index to Supabase with Upsert
    try {
        await fetch(`${SUPABASE_URL}/rest/v1/system_settings`, {
            method: 'POST',
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'resolution=merge-duplicates'
            },
            body: JSON.stringify({
                id: 'leanlife_auth_index',
                data: { users: authUsers },
                updated_at: new Date().toISOString()
            })
        });
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
