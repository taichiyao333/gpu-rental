/**
 * サーバーのavailability APIのレスポンスを実際にテストする
 */
const http = require('http');

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000${path}`, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    }).on('error', reject);
  });
}

async function main() {
  // 1. availability API のレスポンス確認
  console.log('\n=== GET /api/gpus/6/availability?month=2026-03 ===');
  const avail = await get('/api/gpus/6/availability?month=2026-03');
  console.log('Status:', avail.status);
  console.log('Slots:', JSON.stringify(avail.body, null, 2));

  // 2. フロントエンドが new Date() で解釈する時刻も表示
  if (Array.isArray(avail.body)) {
    console.log('\n=== Frontend interpretation (new Date() = LOCAL = JST) ===');
    for (const s of avail.body) {
      const st = new Date(s.start_time);
      const en = new Date(s.end_time);
      console.log(`  Res: "${s.start_time}" ~ "${s.end_time}"`);
      console.log(`    → new Date() getHours(): ${st.getHours()}:00 ~ ${en.getHours()}:00 (JST)`);
      console.log(`    → Expected: 19:00 ~ 01:00 (JST)`);
      console.log(`    → ${st.getHours() === 19 ? '✅ CORRECT' : '❌ WRONG (should be 19)'}`);
    }
  }
}

main().catch(console.error);
