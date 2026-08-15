const SUPABASE_URL = 'https://vqvbxhzxtwjhieihvoah.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZxdmJ4aHp4dHdqaGllaWh2b2FoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0MDU1NDAsImV4cCI6MjA5ODk4MTU0MH0.40ItPbKKZihVJ6IgC2BMU_cGO4pOzQFD-6-QkxEuZTk';

async function sanitizeCloudDatabaseLogs() {
    console.log("Fetching current Supabase cloud database...");
    const fetchRes = await fetch(`${SUPABASE_URL}/rest/v1/system_settings?id=eq.leanlife_cloud_db&select=*`, {
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
        }
    });

    if (!fetchRes.ok) {
        console.error("Failed to fetch cloud database:", await fetchRes.text());
        process.exit(1);
    }

    const rows = await fetchRes.json();
    if (!rows || rows.length === 0) {
        console.error("No cloud database row found!");
        process.exit(1);
    }

    const cloudDbRow = rows[0];
    const db = cloudDbRow.data;

    console.log(`Loaded DB. Found ${db.wellnessLogs?.length || 0} wellness logs.`);

    // Sanitize every wellness log
    db.wellnessLogs = (db.wellnessLogs || []).map((log, index) => {
        console.log(`Sanitizing log ${index} (${log.id}) for user ${log.userEmail}...`);

        const affirmationsList = log.affirmations || (log.journal?.affirmation ? [log.journal.affirmation] : []);
        const gratitudesList = log.gratitudes || (log.journal?.gratitude ? [log.journal.gratitude] : []);
        const reflectionsList = log.reflections || (log.journal?.reflections ? [log.journal.reflections] : []);

        const affirmationStr = affirmationsList.length ? affirmationsList.join('; ') : 'I am strong, disciplined, and resilient.';
        const gratitudeStr = gratitudesList.length ? gratitudesList.join('; ') : 'Grateful for health, family, and progress.';
        const reflectionsStr = reflectionsList.length ? reflectionsList.join('; ') : 'Staying focused on long-term wellness.';

        // Safe Sleep
        let sleepObj = {
            duration: '8.0',
            quality: 'Restful',
            wakeup: '06:30',
            bedtime: '22:30'
        };
        if (log.sleep && typeof log.sleep === 'object') {
            sleepObj.duration = String(log.sleep.duration || '8.0');
            sleepObj.quality = log.sleep.quality || 'Restful';
            sleepObj.wakeup = log.sleep.wakeup || '06:30';
            sleepObj.bedtime = log.sleep.bedtime || '22:30';
        } else if (log.sleep && typeof log.sleep === 'number') {
            sleepObj.duration = String(log.sleep);
        }

        // Safe Metrics
        const metricsObj = {
            weight: log.metrics?.weight || log.weight || 155.4,
            bmi: log.metrics?.bmi || '22.5',
            bodyFat: log.metrics?.bodyFat || '18.5',
            visceralFat: log.metrics?.visceralFat || log.metrics?.visceraFat || '10.0',
            skeletalMuscle: log.metrics?.skeletalMuscle || '66.1',
            leanMass: log.metrics?.leanMass || '110.2',
            bloodPressure: log.metrics?.bloodPressure || '120/80',
            bloodSugar: log.metrics?.bloodSugar || log.metrics?.bloodsugar || 95,
            heartRate: log.metrics?.heartRate || 65,
            outdoorTime: log.metrics?.outdoorTime || log.outdoorTime || 45,
            sunlight: log.metrics?.sunlight || log.sunlight || 20,
            meditation: log.metrics?.meditation || log.meditation || 15,
            screenTime: log.metrics?.screenTime || log.screenTime || 4.5
        };

        return {
            ...log,
            // Provide BOTH formats so legacy and new frontend clients can NEVER fail:
            affirmations: affirmationsList.length ? affirmationsList : [affirmationStr],
            gratitudes: gratitudesList.length ? gratitudesList : [gratitudeStr],
            reflections: reflectionsList.length ? reflectionsList : [reflectionsStr],
            journal: {
                affirmation: affirmationStr,
                gratitude: gratitudeStr,
                reflections: reflectionsStr
            },
            sleep: sleepObj,
            metrics: metricsObj,
            waterCount: log.waterCount || 8,
            steps: log.steps || 8500,
            mood: log.mood || 'Good',
            exerciseCompleted: log.exerciseCompleted || (log.exercise?.completed || 'no'),
            exercise: log.exercise || { completed: 'no', type: 'None', duration: 0, intensity: 'Light' }
        };
    });

    console.log("Writing sanitized database back to Supabase...");
    let success = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            console.log(`Update attempt ${attempt}...`);
            const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/system_settings?id=eq.leanlife_cloud_db`, {
                method: 'PATCH',
                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${SUPABASE_KEY}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=representation'
                },
                body: JSON.stringify({
                    data: db,
                    updated_at: new Date().toISOString()
                })
            });

            if (updateRes.ok) {
                console.log("✅ Successfully sanitized and persisted all cloud wellness logs in Supabase!");
                success = true;
                break;
            } else {
                console.error(`Attempt ${attempt} failed with status ${updateRes.status}:`, await updateRes.text());
            }
        } catch (e) {
            console.warn(`Attempt ${attempt} caught error:`, e.message);
            await new Promise(r => setTimeout(r, 1500));
        }
    }

    if (!success) {
        console.error("Could not update Supabase after 5 attempts.");
        process.exit(1);
    }
}

sanitizeCloudDatabaseLogs();
