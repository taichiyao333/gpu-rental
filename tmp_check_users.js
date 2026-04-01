// ロック状態確認 + otakutaichiパスワードリセット
const http = require('http');
const initSqlJs = require('sql.js');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const dbPath = 'F:/gpu-rental/db/platform.db';

async function main() {
    const SQL = await initSqlJs();
    const buf = fs.readFileSync(dbPath);
    const db = new SQL.Database(buf);

    // otakutaichiユーザー情報確認
    const res = db.exec(`SELECT id, username, email, status FROM users WHERE username='otakutaichi' OR email LIKE '%zhanggu%'`);
    if (res.length) {
        console.log('=== otakutaichiユーザー ===');
        res[0].values.forEach(r => console.log(r));
    }
    
    // lockテーブルは存在しない（インメモリ）ので、APIでリセットトークンを確認
    const res2 = db.exec(`SELECT COUNT(*) as c FROM sqlite_master WHERE type='table'`);
    const res3 = db.exec(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`);
    console.log('\n=== テーブル一覧 ===');
    res3[0].values.forEach(r => console.log(r[0]));
    
    db.close();
    
    // APIでパスワードリセットリクエスト
    // ブルートフォースロックはメモリ上 → サーバー再起動でリセットされる
    // まずパスワード変更
    function post(path, body, token) {
        return new Promise(resolve => {
            const data = JSON.stringify(body);
            const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
            if (token) headers['Authorization'] = `Bearer ${token}`;
            const req = http.request({ host:'localhost', port:3000, path, method:'POST', headers }, r2 => {
                let o = ''; r2.on('data', d => o += d); r2.on('end', () => resolve({ status: r2.statusCode, body: o }));
            });
            req.on('error', e => resolve({ error: e.message }));
            req.write(data); req.end();
        });
    }

    // adminトークン取得
    console.log('\n=== adminでログイン ===');
    let r = await post('/api/auth/login', { email: 'taichi.yao@gmail.com', password: 'GPURental2026Secure' });
    const adminToken = JSON.parse(r.body).token;
    console.log('admin token:', adminToken ? 'OK' : 'FAILED');

    if (!adminToken) { console.log('admin login failed:', r.body); return; }

    // otakutaichiのパスワードをリセット（admin APIで変更）
    console.log('\n=== otakutaichi パスワードリセット試行 ===');
    r = await post('/api/admin/users/15/reset-password', { new_password: 'GPURental2026!' }, adminToken);
    console.log('Status:', r.status, r.body);
}
main().catch(console.error);
