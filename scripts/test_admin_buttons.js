const fs = require('fs');

console.log("=================================================");
console.log("  Super Admin Console Responsiveness Verification ");
console.log("=================================================\n");

// Read app.js and index.html
const appJsContent = fs.readFileSync('./app.js', 'utf8');
const indexHtmlContent = fs.readFileSync('./index.html', 'utf8');

// 1. Audit all app.switchAdminTab options in index.html
const tabRegex = /app\.switchAdminTab\(['"]([^'"]+)['"]\)/g;
const tabsFound = new Set();
let match;
while ((match = tabRegex.exec(indexHtmlContent)) !== null) {
    tabsFound.add(match[1]);
}

console.log(`--- Admin Navigation Tabs Found in HTML (${tabsFound.size}) ---`);
tabsFound.forEach(t => console.log(`  - Tab: '${t}'`));

// Check subpanels in app.js
const subpanelMatch = appJsContent.match(/const subpanels = \[\s*([\s\S]*?)\s*\];/);
if (subpanelMatch) {
    const subpanels = subpanelMatch[1].replace(/['"\s]/g, '').split(',');
    console.log(`\nSubpanels configured in app.js: ${subpanels.join(', ')}`);
    
    let allTabsCovered = true;
    tabsFound.forEach(t => {
        if (!subpanels.includes(t)) {
            console.error(`[ERROR] Tab '${t}' in HTML is missing from app.js subpanels!`);
            allTabsCovered = false;
        }
    });
    if (allTabsCovered) {
        console.log("[PASS] 100% of HTML Admin tabs match app.js subpanel definitions!");
    }
}

// 2. Audit all app.* handlers called in HTML onclick/onsubmit/oninput/onchange
const appCallRegex = /app\.([a-zA-Z0-9_]+)\s*\(/g;
const handlersFound = new Set();
while ((match = appCallRegex.exec(indexHtmlContent)) !== null) {
    handlersFound.add(match[1]);
}

console.log(`\n--- Admin Console Action Handlers Verification (${handlersFound.size}) ---`);
let missingHandlers = 0;
handlersFound.forEach(handler => {
    // Check if defined in app.js
    const isDefined = appJsContent.includes(`${handler}(`) || appJsContent.includes(`${handler} =`) || appJsContent.includes(`${handler}:`);
    if (isDefined) {
        console.log(`[PASS] Method app.${handler}() is defined in app.js`);
    } else {
        console.error(`[FAIL] Method app.${handler}() is MISSING in app.js!`);
        missingHandlers++;
    }
});

console.log("\n=================================================");
console.log(`Result: ${missingHandlers === 0 ? 'ALL ADMIN BUTTON HANDLERS VERIFIED SUCCESSFULLY' : 'SOME HANDLERS MISSING'}`);
console.log("=================================================\n");

if (missingHandlers > 0) process.exit(1);
