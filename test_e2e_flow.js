/**
 * E2Eフローテストスクリプト
 * 予約作成 → スケジューラによるPod自動起動 → Pod停止 の全フローを確認する
 *
 * 使用方法:
 *   node test_e2e_flow.js
 *
 * ※ サーバーを停止してテストしてください（DB直接操作）
 */

process.chdir(__dirname);
require('dotenv').config();

const { initDb, getDb } = require('./server/db/database');
const { createPod, stopPod } = require('./server/services/podManager');

async function main() {
    console.log('\n🧪 GPURental E2Eフローテスト\n' + '='.repeat(50));

    await initDb();
    const db = getDb();

    // ── 1. 現在のDB状態確認 ─────────────────────────────────────────────
    console.log('\n📊 [1] DB状態確認');

    const gpus = db.prepare("SELECT id, name, status, device_index FROM gpu_nodes LIMIT 5").all();
    console.log('GPUノード一覧:');
    gpus.forEach(g => console.log(`  #${g.id} ${g.name} [${g.status}] device=${g.device_index}`));

    const users = db.prepare("SELECT id, username, wallet_balance, role FROM users WHERE role != 'provider' LIMIT 5").all();
    console.log('\nユーザー一覧:');
    users.forEach(u => console.log(`  #${u.id} ${u.username} (${u.role}) wallet=${u.wallet_balance}pt`));

    const pendingRes = db.prepare("SELECT * FROM reservations WHERE status IN ('confirmed','pending') LIMIT 5").all();
    console.log(`\n確認済み予約: ${pendingRes.length}件`);
    pendingRes.forEach(r => console.log(`  #${r.id} gpu=${r.gpu_id} user=${r.renter_id} ${r.start_time}〜${r.end_time} [${r.status}]`));

    const activePods = db.prepare("SELECT * FROM pods WHERE status = 'running' LIMIT 5").all();
    console.log(`\n稼働中Pod: ${activePods.length}件`);
    activePods.forEach(p => console.log(`  #${p.id} reservation=${p.reservation_id} user=${p.renter_id} [container:${p.container_status}]`));

    // ── 2. テスト用予約を作成（即時開始）──────────────────────────────────
    console.log('\n📝 [2] テスト予約作成');

    // available な GPU を取得
    const availGpu = db.prepare("SELECT * FROM gpu_nodes WHERE status = 'available' LIMIT 1").get();
    if (!availGpu) {
        console.log('⚠️  利用可能なGPUがありません。スキップします。');
        process.exit(0);
    }
    console.log(`  対象GPU: #${availGpu.id} ${availGpu.name}`);

    // 残高があるユーザーを取得
    const testUser = db.prepare("SELECT * FROM users WHERE wallet_balance >= 10 AND role = 'renter' LIMIT 1").get()
        || db.prepare("SELECT * FROM users WHERE wallet_balance >= 10 LIMIT 1").get();
    if (!testUser) {
        console.log('⚠️  ポイント残高のあるユーザーがいません。');
        console.log('   管理画面からボーナスポイントを付与してからテストしてください。');
        process.exit(0);
    }
    console.log(`  テストユーザー: #${testUser.id} ${testUser.username} (${testUser.wallet_balance}pt)`);

    // 過去5分〜今から1時間の予約（即時起動テスト）
    const startTime = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5分前（確実に起動）
    const endTime   = new Date(Date.now() + 55 * 60 * 1000).toISOString(); // 55分後
    const totalPrice = availGpu.price_per_hour * 1;

    try {
        const resResult = db.prepare(`
            INSERT INTO reservations (renter_id, gpu_id, start_time, end_time, status, total_price, notes, docker_template)
            VALUES (?, ?, ?, ?, 'confirmed', ?, '[TEST] E2Eフローテスト', 'pytorch')
        `).run(testUser.id, availGpu.id, startTime, endTime, totalPrice);

        const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(resResult.lastInsertRowid);
        console.log(`  ✅ テスト予約作成: #${reservation.id} (${totalPrice}pt)`);

        // ── 3. createPod でPod起動 ────────────────────────────────────────
        console.log('\n🚀 [3] Pod起動テスト (createPod)');

        try {
            const pod = createPod(reservation.id);
            console.log(`  ✅ Pod作成成功:`);
            console.log(`     Pod ID: #${pod.id}`);
            console.log(`     Status: ${pod.status}`);
            console.log(`     Container: ${pod.container_status}`);
            console.log(`     Port: ${pod.port}`);
            console.log(`     Token: ${pod.access_token?.substring(0, 8)}...`);
            console.log(`     WorkspacePath: ${pod.workspace_path}`);

            // GPU status確認
            const gpuAfter = db.prepare('SELECT status FROM gpu_nodes WHERE id = ?').get(availGpu.id);
            console.log(`\n  GPUステータス変化: ${availGpu.status} → ${gpuAfter.status}`);

            const resAfter = db.prepare('SELECT status FROM reservations WHERE id = ?').get(reservation.id);
            console.log(`  予約ステータス変化: confirmed → ${resAfter.status}`);

            // ── 4. Pod停止テスト ──────────────────────────────────────────
            console.log('\n⏹️  [4] Pod停止テスト (stopPod)');
            const stopResult = await stopPod(pod.id, 'test_completed');
            console.log(`  ✅ Pod停止成功:`);
            console.log(`     Duration: ${stopResult.durationMinutes}分`);
            console.log(`     Actual Cost: ${stopResult.actualCost.toFixed(1)}pt`);
            console.log(`     Refund: ${stopResult.refundAmount}pt`);
            console.log(`     Provider Payout: ${stopResult.providerPayout.toFixed(1)}pt`);

            const gpuFinal = db.prepare('SELECT status FROM gpu_nodes WHERE id = ?').get(availGpu.id);
            console.log(`\n  GPU最終ステータス: ${gpuFinal.status}`);

        } catch (podErr) {
            console.error(`  ❌ Pod起動エラー: ${podErr.message}`);
            // クリーンアップ
            db.prepare("UPDATE reservations SET status = 'cancelled' WHERE id = ?").run(reservation.id);
            db.prepare("UPDATE gpu_nodes SET status = 'available' WHERE id = ?").run(availGpu.id);
        }

    } catch (err) {
        console.error(`  ❌ 予約作成エラー: ${err.message}`);
    }

    // ── 5. メール通知テスト確認 ────────────────────────────────────────────
    console.log('\n📧 [5] メール設定確認');
    const smtpHost = process.env.SMTP_HOST;
    const smtpUser = process.env.SMTP_USER;
    if (smtpHost && smtpUser) {
        console.log(`  ✅ SMTP設定あり: ${smtpUser}@${smtpHost}`);
    } else {
        console.log('  ⚠️  SMTP設定なし (.env に SMTP_HOST, SMTP_USER 未設定)');
    }

    console.log('\n' + '='.repeat(50));
    console.log('✅ E2Eテスト完了\n');
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
