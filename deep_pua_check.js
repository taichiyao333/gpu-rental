const fs = require('fs');
const html = fs.readFileSync('public/portal/index.html', 'utf8');

// Find all occurrences of U+E05E
const puaPositions = [];
for (let i = 0; i < html.length; i++) {
    if (html.charCodeAt(i) === 0xE05E) {
        puaPositions.push(i);
    }
}
console.log('U+E05E positions:', puaPositions.length);
if (puaPositions.length > 0) {
    puaPositions.slice(0, 5).forEach(pos => {
        console.log('  At pos', pos + ':', JSON.stringify(html.slice(pos - 5, pos + 15)));
    });
}

// Also check for U+E000-U+F8FF range  
const puaAll = [];
for (let i = 0; i < html.length; i++) {
    const cp = html.charCodeAt(i);
    if (cp >= 0xE000 && cp <= 0xF8FF) {
        puaAll.push({ i, cp: cp.toString(16), ctx: html.slice(Math.max(0, i-5), i+10) });
    }
}
console.log('\nAll PUA chars:', puaAll.length);
puaAll.slice(0, 5).forEach(p => {
    console.log('  U+' + p.cp.toUpperCase(), JSON.stringify(p.ctx));
});

// Check the specific lines
console.log('\nLines with cal-section-title:');
html.split('\n').forEach((l, i) => {
    if (l.includes('cal-section-title') || l.includes('cal-sum-label')) {
        // Check for any non-BMP chars in the line
        const hasNonBmp = /[\u{10000}-\u{10FFFF}]/u.test(l);
        console.log('L' + (i+1) + ':', JSON.stringify(l.trim().slice(0, 50)), hasNonBmp ? '(has emoji)' : '');
    }
});
