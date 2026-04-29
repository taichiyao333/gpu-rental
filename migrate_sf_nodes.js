const initSqlJs = require('./node_modules/sql.js');
const fs = require('fs');
const dbPath = 'F:/gpu-rental/db/platform.db';

initSqlJs().then(SQL => {
    const db = new SQL.Database(fs.readFileSync(dbPath));

    const existing = db.exec('PRAGMA table_info(sf_nodes)');
    const cols = (existing[0]?.values || []).map(r => r[1]);
    console.log('Current columns:', cols.join(', '));

    const toAdd = [
        ['provider_id', 'INTEGER'],
        ['fp32_tflops', 'REAL DEFAULT 0'],
        ['rtt_ms', 'REAL'],
        ['upload_mbps', 'REAL'],
    ];

    for (const [col, def] of toAdd) {
        if (!cols.includes(col)) {
            db.run('ALTER TABLE sf_nodes ADD COLUMN ' + col + ' ' + def);
            console.log('✅ Added column:', col);
        } else {
            console.log('⏭ Already exists:', col);
        }
    }

    fs.writeFileSync(dbPath, Buffer.from(db.export()));
    console.log('DB saved to disk!');

    const updated = db.exec('PRAGMA table_info(sf_nodes)');
    console.log('Updated columns:', (updated[0]?.values || []).map(r => r[1]).join(', '));
    db.close();
}).catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
});
