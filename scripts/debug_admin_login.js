const crypto = require('crypto');

const SUPABASE_URL = "https://vqvbxhzxtwjhieihvoah.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZxdmJ4aHp4dHdqaGllaWh2b2FoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MDU1NDAsImV4cCI6MjA5ODk4MTU0MH0.40ItPbKKZihVJ6IgC2BMU_cGO4pOzQFD-6-QkxEuZTk";

async function verifyPasswordPBKDF2(password, storedHash) {
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

async function run() {
    console.log("Fetching Supabase system_settings data...");
    const res = await fetch(`${SUPABASE_URL}/rest/v1/system_settings?id=eq.leanlife_cloud_db&select=*`, {
        headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
    });
    const json = await res.json();
    if (!json || json.length === 0) {
        console.log("No cloud database found!");
        return;
    }
    const db = json[0].data;
    console.log("Cloud Database fetched. Total users:", db.users ? db.users.length : 0);
    
    for (const u of db.users || []) {
        console.log(`\nUser: ${u.email}`);
        console.log(`  Name: ${u.name}`);
        console.log(`  Role: ${u.role}`);
        console.log(`  Password Hash: ${u.password}`);
        console.log(`  Updated At: ${u.updatedAt}`);
        
        if (u.email.toLowerCase() === 'admin@leanlife.com') {
            const match123 = await verifyPasswordPBKDF2('admin123', u.password);
            console.log(`  Verify against 'admin123': ${match123}`);
        }
    }
}

run().catch(console.error);
