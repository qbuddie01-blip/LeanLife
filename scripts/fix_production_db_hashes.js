const crypto = require('crypto');

const SUPABASE_URL = "https://vqvbxhzxtwjhieihvoah.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZxdmJ4aHp4dHdqaGllaWh2b2FoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MDU1NDAsImV4cCI6MjA5ODk4MTU0MH0.40ItPbKKZihVJ6IgC2BMU_cGO4pOzQFD-6-QkxEuZTk";

function hashPBKDF2(password) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16).toString('hex');
        crypto.pbkdf2(password, salt, 100000, 32, 'sha256', (err, derivedKey) => {
            if (err) return reject(err);
            resolve(`pbkdf2$100000$${salt}$${derivedKey.toString('hex')}`);
        });
    });
}

function verifyPBKDF2(password, storedHash) {
    if (!storedHash || !storedHash.startsWith('pbkdf2$')) return false;
    const parts = storedHash.split('$');
    if (parts.length !== 4) return false;
    const iterations = parseInt(parts[1], 10);
    const salt = parts[2];
    const originalHashHex = parts[3];
    
    return new Promise((resolve) => {
        crypto.pbkdf2(password, salt, iterations, 32, 'sha256', (err, derivedKey) => {
            if (err) return resolve(false);
            resolve(derivedKey.toString('hex') === originalHashHex);
        });
    });
}

async function fixProductionHashes() {
    console.log("Fetching production database from Supabase...");
    const getRes = await fetch(`${SUPABASE_URL}/rest/v1/system_settings?id=eq.leanlife_cloud_db&select=*`, {
        headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
    });
    const getJson = await getRes.json();
    if (!getJson || getJson.length === 0) {
        console.error("Cloud database record not found!");
        return;
    }

    const cloudData = getJson[0].data;
    console.log(`Current Cloud DB has ${cloudData.users.length} users.`);

    const userPasswords = {
        'admin@leanlife.com': 'admin123',
        'francessronke21@gmail.com': 'password123',
        'sarah@leanlife.com': 'password123',
        'qbuddie01@gmail.com': 'password123'
    };

    const nowIso = new Date().toISOString();

    for (const u of cloudData.users) {
        const defaultPwd = userPasswords[u.email.toLowerCase()] || 'password123';
        console.log(`Updating user: ${u.email} with PBKDF2 hash for password: '${defaultPwd}'...`);
        u.password = await hashPBKDF2(defaultPwd);
        u.updatedAt = nowIso;
        u.status = 'Active';
        u.firstLogin = false;
    }

    console.log("\nUpserting updated database back to Supabase...");
    const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/system_settings?id=eq.leanlife_cloud_db`, {
        method: 'PATCH',
        headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
        },
        body: JSON.stringify({
            data: cloudData,
            updated_at: nowIso
        })
    });

    if (updateRes.ok) {
        console.log("Production database successfully updated in Supabase cloud!");
    } else {
        const errText = await updateRes.text();
        console.error("Failed to update Supabase database:", errText);
        return;
    }

    // Verify all users
    console.log("\n--- Verification of Production Hashes ---");
    for (const u of cloudData.users) {
        const defaultPwd = userPasswords[u.email.toLowerCase()] || 'password123';
        const ok = await verifyPBKDF2(defaultPwd, u.password);
        console.log(`User: ${u.email} -> Password '${defaultPwd}' match: ${ok ? 'VERIFIED PASSED' : 'FAILED'}`);
    }
}

fixProductionHashes().catch(console.error);
