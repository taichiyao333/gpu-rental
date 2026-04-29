const fs = require('fs');
let html = fs.readFileSync('public/portal/index.html', 'utf8');
const ts = Date.now();

// Add cache buster to CSS
if (html.includes('href="style.css"')) {
    html = html.replace('href="style.css"', `href="style.css?v=${ts}"`);
    console.log('CSS cache busted');
} else if (html.includes('style.css?v=')) {
    html = html.replace(/style\.css\?v=\d+/, `style.css?v=${ts}`);
    console.log('CSS cache busted (updated)');
}

// Add cache buster to JS
if (html.includes('app.v17.js?v=')) {
    html = html.replace(/app\.v17\.js\?v=\d+/, `app.v17.js?v=${ts}`);
    console.log('JS cache busted (updated)');
} else if (html.includes('src="app.v17.js"')) {
    html = html.replace('src="app.v17.js"', `src="app.v17.js?v=${ts}"`);
    console.log('JS cache busted');
}

fs.writeFileSync('public/portal/index.html', html, 'utf8');
console.log('Saved. Timestamp:', ts);
