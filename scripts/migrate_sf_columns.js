#!/usr/bin/env node
/**
 * migrate_sf_columns.js
 * ─────────────────────────────────────────────────────────────────────
 * GPU Street Fighter 統合のために必要な追加カラム・テーブルを
 * 既存のデータベースに安全にマイグレーションする。
 *
 * ※ このプロジェクトは sql.js (純粋JS) を使用しています。
 *    better-sqlite3 は不要です。
 *
 * 使い方:
 *   node scripts/migrate_sf_columns.js
 *   node scripts/migrate_sf_columns.js --dry-run   # 変更せず確認のみ
 *
 * ※ サーバー起動時 (runMigrations) にも同等処理が自動実行されます。
 *    このスクリプトは手動確認・強制再実行用です。
 * ─────────────────────────────────────────────────────────────────────
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const DRY_RUN = process.argv.includes('--dry-run');

console.log(`\n⚡ GPU SF Migration (${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'})`);
console.log(`   DB: ${process.env.DB_PATH || 'C:/gpu-rental-main/data/db/platform.db'}\n`);

// ─── DB 初期化 (sql.js ラッパー) ────────────────────────────────────
const { initDb, getDb, saveToDisk } = require('../server/db/database');

async function run() {
    await initDb();
    const db = getDb();

    // ─── ヘルパー ──────────────────────────────────────────────────────
    function tableExists(name) {
        return !!db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
        ).get(name);
    }

    function columnExists(table, col) {
        if (!tableExists(table)) return false;
        const info = db.prepare(`PRAGMA table_info(${table})`).all();
        return info.some(r => r.name === col);
    }

    function addColumn(table, col, type) {
        if (!tableExists(table)) {
            console.log(`  ⏭  テーブル ${table} は存在しません — スキップ`);
            return;
        }
        if (columnExists(table, col)) {
            console.log(`  ⏭  ${table}.${col} は既に存在します`);
            return;
        }
        if (DRY_RUN) {
            console.log(`  [DRY] ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
            return;
        }
        try {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
            console.log(`  ✅ ${table}.${col} ${type} — 追加`);
        } catch (e) {
            console.error(`  ❌ ${table}.${col}: ${e.message}`);
        }
    }

    function createTable(name, ddl, indexes = []) {
        if (tableExists(name)) {
            console.log(`  ⏭  テーブル ${name} は既に存在します`);
            return;
        }
        if (DRY_RUN) {
            console.log(`  [DRY] CREATE TABLE ${name}`);
            indexes.forEach(idx => console.log(`  [DRY] CREATE INDEX ${idx.name}`));
            return;
        }
        try {
            db.exec(ddl);
            console.log(`  ✅ テーブル ${name} 作成`);
            indexes.forEach(idx => {
                try {
                    db.exec(idx.sql);
                    console.log(`  ✅   インデックス ${idx.name}`);
                } catch (_) {}
            });
        } catch (e) {
            console.error(`  ❌ CREATE TABLE ${name}: ${e.message}`);
        }
    }

    // ─── 1. pods テーブル —SF カラム ─────────────────────────────────
    console.log('【1/5】 pods テーブル — SF カラム追加');
    addColumn('pods', 'sf_raid_job_id', 'INTEGER');
    addColumn('pods', 'sf_match_id',    'TEXT');

    // ─── 2. reservations テーブル ——SF カラム ─────────────────────────
    console.log('\n【2/5】 reservations テーブル — SF カラム追加');
    addColumn('reservations', 'sf_raid_job_id', 'INTEGER');
    addColumn('reservations', 'sf_match_id',    'TEXT');

    // ─── 3. sf_raid_jobs テーブル ─────────────────────────────────────
    console.log('\n【3/5】 sf_raid_jobs テーブル');
    createTable('sf_raid_jobs', `
        CREATE TABLE IF NOT EXISTS sf_raid_jobs (
            id                  INTEGER  PRIMARY KEY AUTOINCREMENT,
            user_id             INTEGER  NOT NULL,
            raid_plan_json      TEXT     NOT NULL DEFAULT '{}',
            summary_json        TEXT     NOT NULL DEFAULT '{}',
            status              TEXT     DEFAULT 'payment_pending',
            payment_method      TEXT,
            payment_amount_yen  INTEGER  DEFAULT 0,
            points_used         INTEGER  DEFAULT 0,
            mrp_job_ids         TEXT,
            output_url          TEXT,
            created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
            dispatched_at       DATETIME,
            completed_at        DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `, [
        { name: 'idx_sf_raid_jobs_user',   sql: 'CREATE INDEX IF NOT EXISTS idx_sf_raid_jobs_user ON sf_raid_jobs(user_id)' },
        { name: 'idx_sf_raid_jobs_status', sql: 'CREATE INDEX IF NOT EXISTS idx_sf_raid_jobs_status ON sf_raid_jobs(status)' },
    ]);

    // ─── 4. sf_nodes テーブル ─────────────────────────────────────────
    console.log('\n【4/5】 sf_nodes テーブル');
    if (tableExists('sf_nodes')) {
        console.log('  ⏭  テーブルは既に存在します (カラム追加確認中...)');
        addColumn('sf_nodes', 'last_seen',   'DATETIME');
        addColumn('sf_nodes', 'tflops',      'REAL');
        addColumn('sf_nodes', 'rtt_ms',      'INTEGER');
        addColumn('sf_nodes', 'gpu_load',    'REAL');
        addColumn('sf_nodes', 'vram_used_mb','INTEGER');
    } else {
        createTable('sf_nodes', `
            CREATE TABLE IF NOT EXISTS sf_nodes (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id         INTEGER NOT NULL UNIQUE,
                hostname        TEXT,
                agent_version   TEXT DEFAULT '2.0.0',
                gpu_specs       TEXT,
                gpu_live_stats  TEXT,
                tflops          REAL,
                rtt_ms          INTEGER,
                gpu_load        REAL,
                vram_used_mb    INTEGER,
                location        TEXT DEFAULT 'Unknown',
                network_region  TEXT DEFAULT 'ap-northeast-1',
                status          TEXT DEFAULT 'offline',
                last_seen       DATETIME,
                created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        `, [{ name: 'idx_sf_nodes_status', sql: 'CREATE INDEX IF NOT EXISTS idx_sf_nodes_status ON sf_nodes(status)' }]);
    }

    // ─── 5. sf_match_requests テーブル ───────────────────────────────
    console.log('\n【5/5】 sf_match_requests テーブル');
    createTable('sf_match_requests', `
        CREATE TABLE IF NOT EXISTS sf_match_requests (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id          INTEGER NOT NULL,
            job_params       TEXT,
            cards_json       TEXT,
            status           TEXT DEFAULT 'pending',
            selected_mode    TEXT,
            selected_node_id INTEGER,
            created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
            confirmed_at     DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `, [{ name: 'idx_sf_match_uid', sql: 'CREATE INDEX IF NOT EXISTS idx_sf_match_uid ON sf_match_requests(user_id)' }]);

    // ─── 保存 ─────────────────────────────────────────────────────────
    if (!DRY_RUN) {
        saveToDisk();
        console.log('\n  ✅ DB を保存しました');
    }

    // ─── 現在の状態確認 ───────────────────────────────────────────────
    console.log('\n━━━ 現在のDB状態確認 ━━━');
    ['pods', 'reservations'].forEach(tbl => {
        const hasSf = columnExists(tbl, 'sf_raid_job_id');
        console.log(`  ${hasSf ? '✅' : '❌'} ${tbl}.sf_raid_job_id`);
    });
    ['sf_raid_jobs', 'sf_nodes', 'sf_match_requests'].forEach(tbl => {
        console.log(`  ${tableExists(tbl) ? '✅' : '❌'} テーブル: ${tbl}`);
    });

    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ SF Migration ${DRY_RUN ? '[DRY-RUN (変更なし)]' : '完了!'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

run().catch(e => {
    console.error('Migration failed:', e.message);
    console.error(e.stack);
});
