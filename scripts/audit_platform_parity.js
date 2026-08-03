const fs = require('fs');

console.log("=================================================");
console.log("   Platform Parity Audit (Web & Mobile Android)  ");
console.log("=================================================\n");

const filesToCompare = [
    { name: 'app.js', root: './app.js', android: './leanlife-android/app/src/main/assets/app.js' },
    { name: 'index.html', root: './index.html', android: './leanlife-android/app/src/main/assets/index.html' },
    { name: 'style.css', root: './style.css', android: './leanlife-android/app/src/main/assets/style.css' }
];

let allParityMatch = true;

filesToCompare.forEach(f => {
    const rootBuf = fs.readFileSync(f.root);
    const androidBuf = fs.readFileSync(f.android);
    
    if (rootBuf.equals(androidBuf)) {
        console.log(`[PASS] ${f.name}: 100% Byte-for-Byte identical between Web & Android assets!`);
    } else {
        console.error(`[MISMATCH] ${f.name}: Differences found between Web (${rootBuf.length} bytes) and Android assets (${androidBuf.length} bytes)!`);
        allParityMatch = false;
    }
});

console.log("\n=================================================");
if (allParityMatch) {
    console.log("SUCCESS: 100% Full Platform Parity Verified Across Web, Mobile, and Android App!");
} else {
    console.error("FAIL: Parity mismatch detected!");
    process.exit(1);
}
console.log("=================================================\n");
