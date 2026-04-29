const fs = require('fs');

// Read the file as buffer to see actual bytes
const buf = fs.readFileSync('public/portal/app.js');

// Show hex around the icon areas
let content = buf.toString('utf8');
if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

// Find the DOCKER_TEMPLATES section and show raw code points
const dtStart = content.indexOf('const DOCKER_TEMPLATES');
const dtEnd = content.indexOf('];', dtStart) + 2;
const dtSection = content.slice(dtStart, dtEnd);

// Show all icon: '...' with hex codepoints
const iconRegex = /icon:\s*'([^']+)'/g;
let m;
while ((m = iconRegex.exec(dtSection)) !== null) {
    const cps = [...m[1]].map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(', ');
    console.log(`icon: '${m[1]}' → codepoints: ${cps}`);
}

// Now find ALL problematic icons by codepoint 
// Garbled icons contain private use area chars like U+E05E followed by a CJK char
// OR the garbled Shift-JIS conversion: 🔥 → \u{11F3} etc? No...
// Let's see what bytes the garbled 'pytorch' icon has:
const pytorchMatch = content.match(/id:\s*'pytorch'[\s\S]*?icon:\s*'([^']+)'/);
if (pytorchMatch) {
    const raw = pytorchMatch[1];
    const bytes = Buffer.from(raw, 'utf8');
    console.log('\nPyTorch icon raw bytes (hex):', bytes.toString('hex'));
    console.log('PyTorch icon chars:', [...raw].map(c => `'${c}' U+${c.codePointAt(0).toString(16).padStart(4,'0').toUpperCase()}`).join(', '));
}

// Also check username line
const userMatch = content.match(/username\.textContent\s*=\s*`([^`]+)`/);
if (userMatch) {
    const raw = userMatch[1];
    const bytes = Buffer.from(raw, 'utf8');
    console.log('\nUsername line raw:', raw);
    console.log('Username hex:', bytes.toString('hex').slice(0, 40));
}
