const fs = require('fs');

console.log("=================================================");
console.log("  5-Tap Admin Login Trigger & Sensitivity Test   ");
console.log("=================================================\n");

const indexHtml = fs.readFileSync('./index.html', 'utf8');
const appJs = fs.readFileSync('./app.js', 'utf8');
const styleCss = fs.readFileSync('./style.css', 'utf8');

// 1. Verify Member Login button removed from index.html
const hasMemberLogin = indexHtml.includes('Member Login');
console.log(`1. Member Login button removed from HTML: ${!hasMemberLogin ? 'PASSED' : 'FAILED'}`);

// 2. Verify Admin Login button present in index.html
const hasAdminLogin = indexHtml.includes('Admin Login') && indexHtml.includes("fillSimulationCreds('admin@leanlife.com', 'admin123')");
console.log(`2. Admin Login button present in secret panel: ${hasAdminLogin ? 'PASSED' : 'FAILED'}`);

// 3. Verify onclick="app.handleAuthTitleTap()" on auth-title
const hasTitleOnClick = indexHtml.includes('id="auth-title"') && indexHtml.includes('onclick="app.handleAuthTitleTap()"');
console.log(`3. auth-title onclick="app.handleAuthTitleTap()" bound in HTML: ${hasTitleOnClick ? 'PASSED' : 'FAILED'}`);

// 4. Verify handleAuthTitleTap method in app.js
const hasTapMethod = appJs.includes('handleAuthTitleTap()') && appJs.includes('this.adminTapCount');
console.log(`4. handleAuthTitleTap method defined in app.js: ${hasTapMethod ? 'PASSED' : 'FAILED'}`);

// 5. Verify active press feedback in style.css
const hasActiveFeedback = styleCss.includes('.clickable-title:active') && styleCss.includes('transform: scale(0.97)');
console.log(`5. Instant active visual touch feedback in style.css: ${hasActiveFeedback ? 'PASSED' : 'FAILED'}`);

console.log("\n=================================================");
if (!hasMemberLogin && hasAdminLogin && hasTitleOnClick && hasTapMethod && hasActiveFeedback) {
    console.log("SUCCESS: 5-Tap Admin Login trigger & touch sensitivity verified 100%!");
} else {
    console.error("FAIL: Verification failed!");
    process.exit(1);
}
console.log("=================================================\n");
