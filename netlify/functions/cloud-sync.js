// netlify/functions/cloud-sync.js
// LeanLife Authenticated Server-Side Cloud Sync Gateway
// Replaces insecure direct anonymous updates to leanlife_cloud_db.
// Requires cryptographic HMAC-SHA256 session token verification (AUTH_SECRET).
// Enforces strict caller identity & field-level authorization server-side:
// - Members can ONLY modify their own wellness logs, appointments, AI reports, and safe profile fields.
// - Members CANNOT modify user roles, other users, audit history, system settings, or authentication records.
// - Admins/coaches are strictly authorized for coaching operations, appointments, and member management.
// - Passwords, hashes, raw PINs, and service_role secrets are NEVER exposed or stored in leanlife_cloud_db.

const crypto = require('crypto');
const { verifySessionToken } = require('./auth');

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const AUTH_SECRET = process.env.AUTH_SECRET;

exports.handler = async function(event, context) {
    // 1. Handle CORS Preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: CORS_HEADERS, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: CORS_HEADERS,
            body: JSON.stringify({ success: false, error: 'METHOD_NOT_ALLOWED', message: 'Only POST requests are permitted.' })
        };
    }

    // 2. Parse JSON Request Body
    let body = {};
    try {
        body = JSON.parse(event.body || '{}');
    } catch (e) {
        return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ success: false, error: 'INVALID_JSON', message: 'Malformed JSON payload.' })
        };
    }

    // 3. Extract and Verify Session Token
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim() || body.token;

    if (!token) {
        return {
            statusCode: 401,
            headers: CORS_HEADERS,
            body: JSON.stringify({ success: false, error: 'UNAUTHORIZED', message: 'Authentication session token required.' })
        };
    }

    const tokenVerification = verifySessionToken(token, AUTH_SECRET);
    if (!tokenVerification.valid) {
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

    const caller = tokenVerification.payload || {};
    const callerEmail = (caller.email || '').trim().toLowerCase();
    const callerRole = (caller.role || 'member').trim().toLowerCase();

    if (!callerEmail) {
        return {
            statusCode: 401,
            headers: CORS_HEADERS,
            body: JSON.stringify({ success: false, error: 'UNAUTHORIZED', message: 'Invalid session claims: email missing.' })
        };
    }

    // 4. Fetch Current Authoritative leanlife_cloud_db from Supabase
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.error('[CloudSync] SUPABASE_URL and (SUPABASE_SERVICE_ROLE_KEY or SUPABASE_KEY) are required');
        return {
            statusCode: 503,
            headers: CORS_HEADERS,
            body: JSON.stringify({ success: false, error: 'SERVER_CONFIGURATION_ERROR', message: 'Database configuration not configured.' })
        };
    }

    let currentCloudDb = null;
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
                currentCloudDb = rows[0].data;
            }
        } else {
            console.warn(`[CloudSync] Supabase fetch error HTTP ${res.status}: ${res.statusText}`);
            return {
                statusCode: 503,
                headers: CORS_HEADERS,
                body: JSON.stringify({ success: false, error: 'SERVICE_UNAVAILABLE', message: 'Database query failed.' })
            };
        }
    } catch (fetchErr) {
        console.warn("[CloudSync] Supabase connection failure:", fetchErr.message || fetchErr);
        return {
            statusCode: 503,
            headers: CORS_HEADERS,
            body: JSON.stringify({ success: false, error: 'SERVICE_UNAVAILABLE', message: 'Database connection error.' })
        };
    }

    if (!currentCloudDb) {
        currentCloudDb = {
            users: [],
            wellnessLogs: [],
            aiReports: [],
            appointments: [],
            posts: [],
            events: [],
            auditLogs: [],
            emails: [],
            notifications: [],
            automationJobs: [],
            systemSettings: {}
        };
    }

    // Ensure array structures
    currentCloudDb.users = Array.isArray(currentCloudDb.users) ? currentCloudDb.users : [];
    currentCloudDb.wellnessLogs = Array.isArray(currentCloudDb.wellnessLogs) ? currentCloudDb.wellnessLogs : [];
    currentCloudDb.aiReports = Array.isArray(currentCloudDb.aiReports) ? currentCloudDb.aiReports : [];
    currentCloudDb.appointments = Array.isArray(currentCloudDb.appointments) ? currentCloudDb.appointments : [];
    currentCloudDb.posts = Array.isArray(currentCloudDb.posts) ? currentCloudDb.posts : [];
    currentCloudDb.events = Array.isArray(currentCloudDb.events) ? currentCloudDb.events : [];
    currentCloudDb.auditLogs = Array.isArray(currentCloudDb.auditLogs) ? currentCloudDb.auditLogs : [];
    currentCloudDb.systemSettings = currentCloudDb.systemSettings || {};

    const {
        wellnessLogs: incomingLogs,
        appointments: incomingAppointments,
        aiReports: incomingAiReports,
        posts: incomingPosts,
        userProfile: incomingProfile,
        users: incomingUsers,
        events: incomingEvents,
        systemSettings: incomingSettings
    } = body;

    // Helper: sanitize photo/image fields to prevent payload bloating
    const sanitizePhoto = (url) => (url && typeof url === 'string' && url.length > 500) ? '' : url;

    // 5. Apply Role-Based Mutation & Field-Level Access Control

    if (callerRole === 'admin' || callerRole === 'coach') {
        // ==================== ADMIN / COACH PRIVILEGES ====================
        
        // A. Appointments: Admins can update/confirm/complete any appointment
        if (Array.isArray(incomingAppointments)) {
            const appMap = new Map();
            currentCloudDb.appointments.forEach(a => { if (a && a.id) appMap.set(String(a.id), a); });
            incomingAppointments.forEach(a => {
                if (a && a.id) {
                    const existing = appMap.get(String(a.id));
                    appMap.set(String(a.id), existing ? { ...existing, ...a } : a);
                }
            });
            currentCloudDb.appointments = Array.from(appMap.values());
        }

        // B. Users: Admins can manage member metadata, but PASSWORDS MUST NEVER BE STORED in leanlife_cloud_db
        if (Array.isArray(incomingUsers)) {
            const userMap = new Map();
            currentCloudDb.users.forEach(u => {
                const k = (u.email || '').trim().toLowerCase();
                if (k) userMap.set(k, u);
            });
            incomingUsers.forEach(u => {
                const k = (u.email || '').trim().toLowerCase();
                if (k) {
                    const existing = userMap.get(k);
                    // Strictly strip any credential fields
                    const { password: _p, tempPasswordRaw: _t, ...safeFields } = u;
                    userMap.set(k, existing ? { ...existing, ...safeFields } : safeFields);
                }
            });
            currentCloudDb.users = Array.from(userMap.values());
        }

        // C. Wellness Logs: Admins can review/add coach notes
        if (Array.isArray(incomingLogs)) {
            const logMap = new Map();
            currentCloudDb.wellnessLogs.forEach(l => { if (l && l.id) logMap.set(String(l.id), l); });
            incomingLogs.forEach(l => {
                if (l && l.id) {
                    const existing = logMap.get(String(l.id));
                    const cleanLog = { ...l, photoUrl: sanitizePhoto(l.photoUrl) };
                    logMap.set(String(l.id), existing ? { ...existing, ...cleanLog } : cleanLog);
                }
            });
            currentCloudDb.wellnessLogs = Array.from(logMap.values());
        }

        // D. Events: Admins can manage community/calendar events
        if (Array.isArray(incomingEvents)) {
            currentCloudDb.events = incomingEvents;
        }

        // E. Community Posts: Admins can moderate/delete posts
        if (Array.isArray(incomingPosts)) {
            const postMap = new Map();
            currentCloudDb.posts.forEach(p => { if (p && p.id) postMap.set(String(p.id), p); });
            incomingPosts.forEach(p => {
                if (p && p.id) {
                    const existing = postMap.get(String(p.id));
                    const cleanPost = { ...p, image: sanitizePhoto(p.image) };
                    postMap.set(String(p.id), existing ? { ...existing, ...cleanPost } : cleanPost);
                }
            });
            currentCloudDb.posts = Array.from(postMap.values());
        }

        // F. System Settings: Admins can update settings
        if (incomingSettings && typeof incomingSettings === 'object') {
            currentCloudDb.systemSettings = { ...currentCloudDb.systemSettings, ...incomingSettings };
        }

        // G. Audit Log Entry for Admin Actions
        currentCloudDb.auditLogs.unshift({
            id: 'AUD-' + Date.now(),
            action: 'ADMIN_CLOUD_SYNC',
            user: callerEmail,
            timestamp: new Date().toISOString()
        });
        if (currentCloudDb.auditLogs.length > 500) {
            currentCloudDb.auditLogs = currentCloudDb.auditLogs.slice(0, 500);
        }

    } else {
        // ==================== MEMBER RESTRICTIONS (ZERO PRIVILEGE ESCALATION) ====================

        // A. Wellness Logs: Member can ONLY upsert records where userEmail === callerEmail
        if (Array.isArray(incomingLogs)) {
            const memberLogs = incomingLogs.filter(l => {
                const logEmail = (l.userEmail || l.email || '').trim().toLowerCase();
                return logEmail === callerEmail;
            });

            const logMap = new Map();
            currentCloudDb.wellnessLogs.forEach(l => { if (l && l.id) logMap.set(String(l.id), l); });

            memberLogs.forEach(l => {
                if (l && l.id) {
                    const existing = logMap.get(String(l.id));
                    // Prevent modifying another user's existing log via ID spoofing
                    if (existing) {
                        const existingEmail = (existing.userEmail || existing.email || '').trim().toLowerCase();
                        if (existingEmail && existingEmail !== callerEmail) {
                            return; // REJECT spoofing
                        }
                    }
                    const cleanLog = {
                        ...l,
                        userEmail: callerEmail,
                        email: callerEmail,
                        photoUrl: sanitizePhoto(l.photoUrl),
                        updatedAt: new Date().toISOString()
                    };
                    logMap.set(String(l.id), cleanLog);
                }
            });
            currentCloudDb.wellnessLogs = Array.from(logMap.values());
        }

        // B. Appointments: Member can ONLY create/reschedule appointments where clientEmail === callerEmail
        if (Array.isArray(incomingAppointments)) {
            const memberAppointments = incomingAppointments.filter(a => {
                const appEmail = (a.user_email || a.clientEmail || '').trim().toLowerCase();
                return appEmail === callerEmail;
            });

            const appMap = new Map();
            currentCloudDb.appointments.forEach(a => { if (a && a.id) appMap.set(String(a.id), a); });

            memberAppointments.forEach(a => {
                if (a && a.id) {
                    const existing = appMap.get(String(a.id));
                    if (existing) {
                        const existingEmail = (existing.user_email || existing.clientEmail || '').trim().toLowerCase();
                        if (existingEmail && existingEmail !== callerEmail) {
                            return; // REJECT spoofing another member's appointment
                        }
                        // Preserve coach-controlled fields
                        const sanitizedApp = {
                            ...existing,
                            date: a.date || existing.date,
                            time: a.time || existing.time,
                            notes: a.notes !== undefined ? a.notes : existing.notes,
                            // If member cancels own appointment:
                            status: (a.status === 'cancelled' || a.status === 'Cancelled') ? 'cancelled' : existing.status,
                            updatedAt: new Date().toISOString()
                        };
                        appMap.set(String(a.id), sanitizedApp);
                    } else {
                        // New appointment booking
                        const newApp = {
                            ...a,
                            user_email: callerEmail,
                            clientEmail: callerEmail,
                            status: 'pending',
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString()
                        };
                        appMap.set(String(a.id), newApp);
                    }
                }
            });
            currentCloudDb.appointments = Array.from(appMap.values());
        }

        // C. AI Reports: Member can only upsert reports matching callerEmail
        if (Array.isArray(incomingAiReports)) {
            const memberReports = incomingAiReports.filter(r => {
                const repEmail = (r.userEmail || r.email || '').trim().toLowerCase();
                return repEmail === callerEmail;
            });

            const repMap = new Map();
            currentCloudDb.aiReports.forEach(r => { if (r && r.id) repMap.set(String(r.id), r); });

            memberReports.forEach(r => {
                if (r && r.id) {
                    const existing = repMap.get(String(r.id));
                    if (existing) {
                        const existingEmail = (existing.userEmail || existing.email || '').trim().toLowerCase();
                        if (existingEmail && existingEmail !== callerEmail) return;
                    }
                    repMap.set(String(r.id), { ...r, userEmail: callerEmail, email: callerEmail });
                }
            });
            currentCloudDb.aiReports = Array.from(repMap.values());
        }

        // D. Community Posts: Member can post content under their own identity
        if (Array.isArray(incomingPosts)) {
            const postMap = new Map();
            currentCloudDb.posts.forEach(p => { if (p && p.id) postMap.set(String(p.id), p); });

            incomingPosts.forEach(p => {
                if (p && p.id) {
                    const existing = postMap.get(String(p.id));
                    if (existing) {
                        // If post exists, only author can edit or like
                        const authorEmail = (existing.authorEmail || '').trim().toLowerCase();
                        if (authorEmail && authorEmail === callerEmail) {
                            postMap.set(String(p.id), {
                                ...existing,
                                content: p.content || existing.content,
                                image: sanitizePhoto(p.image),
                                updatedAt: new Date().toISOString()
                            });
                        } else if (p.likes !== undefined) {
                            // Member liking/unliking a post
                            postMap.set(String(p.id), { ...existing, likes: p.likes });
                        }
                    } else {
                        // New post by caller
                        postMap.set(String(p.id), {
                            ...p,
                            author: caller.name || p.author || 'Member',
                            authorEmail: callerEmail,
                            image: sanitizePhoto(p.image),
                            timestamp: p.timestamp || new Date().toISOString()
                        });
                    }
                }
            });
            currentCloudDb.posts = Array.from(postMap.values());
        }

        // E. User Profile: Member can ONLY update their own safe profile fields
        // CANNOT change: role, status, id, email, password, tempPasswordRaw
        if (incomingProfile && typeof incomingProfile === 'object') {
            const userIndex = currentCloudDb.users.findIndex(u => (u.email || '').trim().toLowerCase() === callerEmail);
            if (userIndex !== -1) {
                const existingUser = currentCloudDb.users[userIndex];
                currentCloudDb.users[userIndex] = {
                    ...existingUser,
                    name: incomingProfile.name || existingUser.name,
                    phone: incomingProfile.phone !== undefined ? incomingProfile.phone : existingUser.phone,
                    avatar: incomingProfile.avatar !== undefined ? incomingProfile.avatar : existingUser.avatar,
                    dob: incomingProfile.dob !== undefined ? incomingProfile.dob : existingUser.dob,
                    gender: incomingProfile.gender !== undefined ? incomingProfile.gender : existingUser.gender,
                    height: incomingProfile.height !== undefined ? incomingProfile.height : existingUser.height,
                    weight: incomingProfile.weight !== undefined ? incomingProfile.weight : existingUser.weight,
                    targetWeight: incomingProfile.targetWeight !== undefined ? incomingProfile.targetWeight : existingUser.targetWeight,
                    healthProfile: incomingProfile.healthProfile || existingUser.healthProfile,
                    streakCount: incomingProfile.streakCount !== undefined ? incomingProfile.streakCount : existingUser.streakCount,
                    preferences: incomingProfile.preferences || existingUser.preferences,
                    updatedAt: new Date().toISOString(),
                    // STRICT IMMUTABILITY GUARDS:
                    role: existingUser.role, // IMMUTABLE
                    status: existingUser.status, // IMMUTABLE
                    id: existingUser.id, // IMMUTABLE
                    email: existingUser.email // IMMUTABLE
                };
                // Delete any leaked credential fields
                delete currentCloudDb.users[userIndex].password;
                delete currentCloudDb.users[userIndex].tempPasswordRaw;
            }
        }

        // F. FORBIDDEN MUTATIONS:
        // Member attempts to mutate auditLogs, events, systemSettings, automationJobs, or emails are SILENTLY DISCARDED.
        // currentCloudDb.auditLogs, currentCloudDb.systemSettings, etc. remain 100% untouched.
    }

    // 6. Persist Updated Authoritative leanlife_cloud_db Back to Supabase
    try {
        const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/system_settings`, {
            method: 'POST',
            headers: {
                'apikey': SUPABASE_KEY,
                'Content-Type': 'application/json',
                'Prefer': 'resolution=merge-duplicates'
            },
            body: JSON.stringify({
                id: 'leanlife_cloud_db',
                data: currentCloudDb,
                updated_at: new Date().toISOString()
            })
        });

        if (!updateRes.ok) {
            const errText = await updateRes.text();
            console.warn(`[CloudSync] Supabase persist error HTTP ${updateRes.status}: ${errText}`);
            return {
                statusCode: 500,
                headers: CORS_HEADERS,
                body: JSON.stringify({ success: false, error: 'PERSISTENCE_FAILED', message: 'Failed to write cloud state.' })
            };
        }
    } catch (saveErr) {
        console.warn("[CloudSync] Supabase save error:", saveErr.message || saveErr);
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ success: false, error: 'PERSISTENCE_FAILED', message: 'Cloud save network failure.' })
        };
    }

    // 7. Return Verified HTTP 200 Response
    return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
            success: true,
            caller: { email: callerEmail, role: callerRole },
            syncedAt: new Date().toISOString()
        })
    };
};
