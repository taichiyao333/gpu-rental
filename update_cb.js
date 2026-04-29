const fs = require('fs');
let html = fs.readFileSync('public/portal/index.html', 'utf8');
const ts = Date.now();
const match = html.match(/app\.v17\.js\?cb=(\d+)/);
console.log('Current cb version:', match ? match[1] : 'not set');
if (match) {
    html = html.replace(/app\.v17\.js\?cb=\d+/, 'app.v17.js?cb=' + ts);
} else {
    html = html.replace('src="app.v17.js"', 'src="app.v17.js?cb=' + ts + '"');
}
fs.writeFileSync('public/portal/index.html', html, 'utf8');
const verify = html.match(/app\.v17\.js\?cb=(\d+)/);
console.log('New cb version:', verify ? verify[1] : 'NOT UPDATED');
