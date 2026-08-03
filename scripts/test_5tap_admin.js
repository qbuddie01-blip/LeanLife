const fs = require('fs');

console.log("=================================================");
console.log("  5-Tap Admin Login Trigger Verification         ");
console.log("=================================================\n");

const indexHtml = fs.readFileSync('./index.html', 'utf8');
const appJs = fs.readFileSync('./app.js', 'utf8');

// 1. Verify Member Login button removed from index.html
const hasMemberLogin = indexHtml.includes('Member Login');
console.log(`1. Member Login button removed from HTML: ${!hasMemberLogin ? 'PASSED' : 'FAILED'}`);

// 2. Verify Admin Login button present in index.html
const hasAdminLogin = indexHtml.includes('Admin Login') && indexHtml.includes("fillSimulationCreds('admin@leanlife.com', 'admin123')");
console.log(`2. Admin Login button present in secret panel: ${hasAdminLogin ? 'PASSED' : 'FAILED'}`);

// 3. Verify user-select: none and touch styles on auth-title
const hasTouchStyles = indexHtml.includes('id="auth-title"') && indexHtml.includes('user-select: none') && indexHtml.includes('touch-action: manipulation');
console.log(`3. auth-title touch & selection protection styles: ${hasTouchStyles ? 'PASSED' : 'FAILED'}`);

// 4. Verify 5-tap listener in app.js supports touchend + click
const hasTapListener = appJs.includes("authTitle.addEventListener('click'") && appJs.includes("authTitle.addEventListener('touchend'");
console.log(`4. Dual click/touchend 5-tap listener in app.js: ${hasTapListener ? 'PASSED' : 'FAILED'}`);

console.log("\n=================================================");
if (!hasMemberLogin && hasAdminLogin && hasTouchStyles && hasTapListener) {
    console.log("SUCCESS: 5-Tap Admin Login trigger verified 100%!");
} else {
    console.error("FAIL: Verification failed!");
    process.exit(1);
}
console.log("=================================================\n");
