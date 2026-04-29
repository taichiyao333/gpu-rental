const fs = require('fs');

// Read as raw buffer
const buf = fs.readFileSync('public/portal/index.html');
console.log('File size (bytes):', buf.length);

// Search for EE 81 9E (U+E05E in UTF-8 is EE 81 9E)
const pua = [0xEE, 0x81, 0x9E];
const positions = [];
for (let i = 0; i < buf.length - 2; i++) {
    if (buf[i] === pua[0] && buf[i+1] === pua[1] && buf[i+2] === pua[2]) {
        positions.push(i);
    }
}
console.log('\nU+E05E (EE 81 9E) byte positions:', positions.length);
positions.slice(0, 5).forEach(pos => {
    const ctx = buf.slice(Math.max(0, pos - 10), pos + 20);
    console.log('  Pos', pos, ':', ctx.toString('utf8').replace(/[\x00-\x1f]/g, '?').slice(0, 40));
});

// Also check for F8F0 (U+F8F0 in UTF-8 is EF A3 B0)
const pua2 = [0xEF, 0xA3, 0xB0];
const positions2 = [];
for (let i = 0; i < buf.length - 2; i++) {
    if (buf[i] === pua2[0] && buf[i+1] === pua2[1] && buf[i+2] === pua2[2]) {
        positions2.push(i);
    }
}
console.log('\nU+F8F0 (EF A3 B0) byte positions:', positions2.length);

// Check all private use area bytes in UTF-8
// PUA range U+E000-U+F8FF: UTF-8 is EE 80 80 - EF A3 BF
let puaCount = 0;
for (let i = 0; i < buf.length - 2; i++) {
    // 3-byte UTF-8 PUA: EE 8x xx to EF 8x xx (where first byte is EE or EF)
    if ((buf[i] === 0xEE || buf[i] === 0xEF) && (buf[i+1] & 0xC0) === 0x80 && (buf[i+2] & 0xC0) === 0x80) {
        // Decode to codepoint
        const cp = ((buf[i] & 0x0F) << 12) | ((buf[i+1] & 0x3F) << 6) | (buf[i+2] & 0x3F);
        if (cp >= 0xE000 && cp <= 0xF8FF) {
            puaCount++;
            if (puaCount <= 3) {
                console.log('\nPUA at', i, 'U+' + cp.toString(16).toUpperCase(), 
                    buf.slice(Math.max(0, i-5), i+15).toString('utf8').replace(/[\x00-\x1f]/g, '?'));
            }
        }
    }
}
console.log('\nTotal PUA chars in raw bytes:', puaCount);
