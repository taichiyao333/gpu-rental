const { initDb, getDb, saveToDisk } = require('../server/db/database');

async function resetTransactions() {
    await initDb();
    const db = getDb();
    
    console.log('=== 🚧 [DANGER] データベース履歴リセット開始 🚧 ===');
    
    try {
        db.exec('PRAGMA foreign_keys = OFF;');
        
        db.transaction(() => {
            console.log('1. トランザクション・ログ系テーブルのデータを全削除...');
            const tablesToClear = [
                'usage_logs',
                'pods',
                'reservations',
                'payouts',
                'point_purchases',
                'point_logs',
                'alerts',
                'outage_reports',
                'render_jobs',
                'blender_jobs'
            ];
            
            for (const table of tablesToClear) {
                try {
                    db.prepare(`DELETE FROM ${table}`).run();
                    console.log(`  - 🗑 ${table} をクリアしました`);
                } catch(e) {
                    console.error(`  - ❌ ${table} 削除エラー:`, e.message);
                }
            }

            console.log('2. ユーザーのポイント残高・収益・統計を 0 にリセット...');
            const p = db.prepare(`
                UPDATE users 
                SET point_balance = 0, 
                    wallet_balance = 0
            `);
            p.run();

            console.log('3. GPUノードの状態をすべて [利用可能] にリセット...');
            db.prepare(`
                UPDATE gpu_nodes 
                SET status = 'available'
            `).run();
            
            console.log('4. IDカウンター(AUTOINCREMENT)をリセット...');
            for (const table of tablesToClear) {
                try {
                    db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(table);
                } catch(e) {}
            }
            
        })();
        
        db.exec('PRAGMA foreign_keys = ON;');
        
        console.log('5. データベースをディスクに保存しています...');
        await saveToDisk();
        
        console.log('\n✅ リセットが完了しました！');
    } catch (e) {
        db.exec('PRAGMA foreign_keys = ON;');
        console.error('❌ リセット中にエラーが発生しました:', e);
    }
}

resetTransactions().catch(console.error);

