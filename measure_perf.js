require('dotenv').config();
const { initDb, getDb } = require('./server/db/database');

initDb().then(() => {
    const db = getDb();

    // インデックスの存在確認
    const indexes = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' ORDER BY tbl_name").all();
    console.log('=== 現在のインデックス ===');
    indexes.forEach(i => console.log(`  ${i.tbl_name}.${i.name}`));
    if (indexes.length === 0) console.log('  (なし - フルスキャンになっている！)');

    // レコード数確認
    const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get();
    const resCount = db.prepare('SELECT COUNT(*) as c FROM reservations').get();
    const logCount = db.prepare('SELECT COUNT(*) as c FROM usage_logs').get();
    console.log(`\nusers: ${userCount.c} / reservations: ${resCount.c} / usage_logs: ${logCount.c}`);

    // クエリ時間計測
    const t0 = Date.now();
    const result = db.prepare(`
        SELECT u.id, u.username, u.email, u.role, u.status, u.wallet_balance, u.point_balance,
               u.created_at, u.last_login,
               (SELECT COUNT(*) FROM reservations r WHERE r.renter_id = u.id) as total_reservations,
               (SELECT COALESCE(SUM(ul.cost), 0) FROM usage_logs ul WHERE ul.renter_id = u.id) as total_spent
        FROM users u ORDER BY u.created_at DESC LIMIT 500
    `).all();
    console.log(`\nサブクエリ版 Query time: ${Date.now() - t0}ms (${result.length}件)`);

    // EXPLAIN QUERY PLAN
    const plan = db.prepare(`EXPLAIN QUERY PLAN
        SELECT u.id FROM users u
        WHERE 1=1
    `).all();
    console.log('\nQuery Plan:', JSON.stringify(plan));

    setTimeout(() => process.exit(0), 100);
}).catch(e => { console.error(e); process.exit(1); });
