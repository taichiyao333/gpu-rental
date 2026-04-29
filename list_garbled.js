const fs = require('fs');
const html = fs.readFileSync('public/portal/index.html', 'utf8');
const lines = html.split('\n');

const badLines = [];
lines.forEach((line, i) => {
    if (/繝|縺|繧/.test(line)) {
        badLines.push({ lineNum: i+1, content: line.trim().slice(0, 120) });
    }
});

console.log(`Total garbled lines: ${badLines.length}`);
console.log('\n--- First 40 garbled lines ---');
badLines.slice(0, 40).forEach(l => console.log(`L${l.lineNum}: ${l.content}`));
