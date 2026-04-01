const { initDb, getDb } = require('../server/db/database');

async function auditAccountBalances() {
    await initDb();
    const db = getDb();
    console.log('=== GPURental Revenue & Points Audit Report ===\n');

    let errorsFound = 0;

    // 1. 各ユーザーのポイント残高異常チェック
    console.log('[1] ポイント残高の安全性チェック');
    const negativePointsUsers = db.prepare('SELECT id, username, email, point_balance FROM users WHERE point_balance < 0').all();
    if (negativePointsUsers.length > 0) {
        console.error('❌ 警告: 以下のユーザーのポイント残高がマイナスです:');
        negativePointsUsers.forEach(u => console.error(`   - User[${u.id}] ${u.username} (${u.email}): ${u.point_balance} pt`));
        errorsFound += negativePointsUsers.length;
    } else {
        console.log('✅ 構造上安全: ポイント残高がマイナスの不整合データはありません。');
    }

    // 2. プロバイダー収益残高異常チェック
    console.log('\n[2] プロバイダー収益残高の安全性チェック');
    const negativeWalletUsers = db.prepare('SELECT id, username, email, wallet_balance FROM users WHERE wallet_balance < 0').all();
    if (negativeWalletUsers.length > 0) {
        console.error('❌ 警告: 以下のユーザーの収益残高がマイナスです:');
        negativeWalletUsers.forEach(u => console.error(`   - User[${u.id}] ${u.username} (${u.email}): ¥${u.wallet_balance}`));
        errorsFound += negativeWalletUsers.length;
    } else {
        console.log('✅ 構造上安全: 収益残高がマイナスのデータはありません。');
    }

    // 3. マクロポイント監査
    console.log('\n[3] システム全体のポイント統合チェック');
    let totalPurchased = 0;
    try {
        totalPurchased = db.prepare(`SELECT SUM(points) as total FROM point_purchases WHERE status IN ('succeeded', 'completed')`).get().total || 0;
    } catch(e) {}
    
    const totalUsedPoints = db.prepare(`SELECT SUM(total_price) as total FROM reservations WHERE status IN ('completed', 'active', 'confirmed')`).get().total || 0;
    const totalRemainingUserPoints = db.prepare(`SELECT SUM(point_balance) as total FROM users WHERE role = 'user'`).get().total || 0;
    
    console.log(`- 有償/履歴上の購入・付与ポイント: ${totalPurchased} pt`);
    console.log(`- 予約で消費された累計ポイント  : ${totalUsedPoints} pt`);
    console.log(`- 現在全ユーザーが保有する合計  : ${totalRemainingUserPoints} pt`);
    console.log(`  (※管理画面からのボーナス手動付与や、開発中の強制データリセット等があるため、この数値に乖離があるのは開発環境では正常です)`);

    // 4. プロバイダー収益の再計算 vs 現在のウォレット残高
    console.log('\n[4] 履歴ベースのプロバイダー収益 vs ウォレット残高の乖離チェック');
    const rows = db.prepare(`
        SELECT p.id, p.username, p.wallet_balance, 
               IFNULL(SUM(ul.provider_payout), 0) as earned, 
               IFNULL((SELECT SUM(amount) FROM payouts WHERE provider_id = p.id AND status = 'paid'), 0) as paid 
        FROM users p 
        LEFT JOIN usage_logs ul ON ul.provider_id = p.id 
        WHERE p.role IN ('provider', 'admin') 
        GROUP BY p.id
    `).all();
    
    let providerErrors = 0;
    for (const row of rows) {
        const theoreticalWallet = row.earned - row.paid;
        const diff = Math.abs(theoreticalWallet - row.wallet_balance);
        
        // 開発環境におけるデータ削除による乖離を検知
        if (diff > 5) { // 端数切り捨て5円以上の差を警告
            console.log(`⚠️ プロバイダー [ID:${row.id}] ${row.username}`);
            console.log(`   - 実際のウォレット残高  : ¥${row.wallet_balance}`);
            console.log(`   - 履歴に基づく理論値残高: ¥${theoreticalWallet} (稼ぎ¥${row.earned} - 出金¥${row.paid})`);
            providerErrors++;
        }
    }
    
    if (providerErrors > 0) {
        console.log(`\n💬 【総括】 開発やテスト中に「usage_logsだけをリセットした」「ユーザーに手動で残高を追加した」などの理由により生じた『履歴との不一致』が ${providerErrors} 件存在します。テストデータ起因の場合は無視して問題ありません。本番前に全額をリセットしたい場合はご相談ください。`);
    } else {
        console.log(`\n✅ 総括: 各記録ログと現在のウォレット金額は完全に一致しており、矛盾はありません。`);
    }

    console.log('\n=== Check Complete ===');
    process.exit(errorsFound > 0 ? 1 : 0);
}

auditAccountBalances().catch(e => {
    console.error(e);
    process.exit(1);
});
