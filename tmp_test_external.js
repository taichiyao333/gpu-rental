const https = require('https');

// Blenderアドオンと全く同じリクエストを再現
function post(hostname, path, body) {
    return new Promise((resolve) => {
        const data = JSON.stringify(body);
        const req = https.request({
            hostname,
            port: 443,
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                'User-Agent': 'Blender/4.0 GPURental-Addon/2.3.0'
            },
            // SSL検証
            rejectUnauthorized: true,
        }, (res) => {
            let out = '';
            res.on('data', d => out += d);
            res.on('end', () => resolve({ status: res.statusCode, body: out, headers: res.headers }));
        });
        req.on('error', e => resolve({ error: e.message, code: e.code }));
        req.write(data);
        req.end();
    });
}

async function main() {
    console.log('=== gpurental.jp 外部アクセステスト ===\n');

    // 1. ログインテスト with zhanggubuaa@gmail.com
    console.log('1. POST https://gpurental.jp/api/auth/login');
    let r = await post('gpurental.jp', '/api/auth/login', {
        email: 'zhanggubuaa@gmail.com',   // otakutaichiのメール
        password: 'test123'               // 不正なパスワードで試す（401が期待値）
    });
    console.log('  Status:', r.status || 'ERROR');
    if (r.error) console.log('  Error:', r.error, '(Code:', r.code, ')');
    else console.log('  Body:', r.body.substring(0, 150));

    // 2. SSL証明書確認のみ
    console.log('\n2. GET https://gpurental.jp/api/blender/status');
    r = await new Promise(resolve => {
        const req = https.request({
            hostname: 'gpurental.jp', port: 443, path: '/api/blender/status',
            method: 'GET', headers: { 'User-Agent': 'Blender/4.0' }
        }, res => {
            let o = ''; res.on('data', d => o += d);
            res.on('end', () => resolve({ status: res.statusCode, body: o }));
        });
        req.on('error', e => resolve({ error: e.message, code: e.code }));
        req.end();
    });
    console.log('  Status:', r.status || 'ERROR');
    if (r.error) console.log('  Error:', r.error, '(Code:', r.code, ')');
    else console.log('  Body:', r.body.substring(0, 150));
}
main().catch(console.error);
