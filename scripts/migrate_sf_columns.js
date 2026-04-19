#!/usr/bin/env node
/**
 * migrate_sf_columns.js
 * ─────────────────────────────────────────────────────────────────────
 * GPU Street Fighter 統合のために必要な追加カラム・テーブルを
 * 既存の SQLite データベースに安全にマイグレーションする。
 *
 * 使い方:
 *   node scripts/migrate_sf_columns.js
 *   node scripts/migrate_sf_columns.js --dry-run   # 変更せず確認のみ
 *
 * 対象:
 *   - pods        テーブル: sf_raid_job_id, sf_match_id カラム追加
 *   - reservations テーブル: sf_raid_job_id, sf_match_id カラム追加
 *   - sf_raid_jobs テーブル: 新規作成
 *   - sf_nodes     テーブル: 新規作成
 *   - sf_matches   テーブル: 新規作成
 * ─────────────────────────────────────────────────────────────────────
 */

const path    = require('path');
const fs      = require('fs');
const Database = require('better-sqlite3');

const DRY_RUN = process.argv.includes('--dry-run');

// --- DB パス解決 ---
const envPath = path.join(__dirname, '..', '.env');
let dbPath = path.join(__dirname, '..', 'data', 'database.sqlite');

if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const match = envContent.match(/^DATABASE_PATH=(.+)$/m);
    if (match) dbPath = match[1].trim();
}

if (!fs.existsSync(dbPath)) {
    console.error(`[ERROR] DB が見つかりません: ${dbPath}`);
    process.exit(1);
}

console.log(`\n⚡ GPU SF Migration (${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'})`);
console.log(`   DB: ${dbPath}\n`);

const db = new Database(dbPath);

// ─── ヘルパー ────────────────────────────────────────────────────────

function hasColumn(table, col) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    return info.some(r => r.name === col);
}

function tableExists(name) {
    return !!db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(name);
}

function exec(sql, desc) {
    if (DRY_RUN) {
        console.log(`  [DRY] ${desc}`);
        return;
    }
    try {
        db.exec(sql);
        console.log(`  ✅ ${desc}`);
    } catch (e) {
        console.error(`  ❌ ${desc}: ${e.message}`);
    }
}

function addColumn(table, col, type, defaultVal = 'NULL') {
    if (!tableExists(table)) {
        console.log(`  ⏭  テーブル ${table} は存在しません — スキップ`);
        return;
    }
    if (hasColumn(table, col)) {
        console.log(`  ⏭  ${table}.${col} は既に存在します`);
        return;
    }
    const def = defaultVal !== 'NULL' ? `DEFAULT ${defaultVal}` : '';
    exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type} ${def}`.trim(),
         `ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

// ─── 1. pods テーブル ─────────────────────────────────────────────────
console.log('【1/5】 pods テーブル — SF カラム追加');
addColumn('pods', 'sf_raid_job_id', 'INTEGER');
addColumn('pods', 'sf_match_id',    'TEXT');

// ─── 2. reservations テーブル ────────────────────────────────────────
console.log('\n【2/5】 reservations テーブル — SF カラム追加');
addColumn('reservations', 'sf_raid_job_id', 'INTEGER');
addColumn('reservations', 'sf_match_id',    'TEXT');

// ─── 3. sf_raid_jobs テーブル ────────────────────────────────────────
console.log('\n【3/5】 sf_raid_jobs テーブル — 作成');
if (tableExists('sf_raid_jobs')) {
    console.log('  ⏭  テーブルは既に存在します');
} else {
    exec(`
        CREATE TABLE IF NOT EXISTS sf_raid_jobs (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id         INTEGER NOT NULL,
            status          TEXT    NOT NULL DEFAULT 'paid',
            plan_key        TEXT,
            plan_summary    TEXT,             -- JSON
            amount_yen      REAL,
            mrp_job_ids     TEXT,             -- JSON array of MRP job IDs
            output_url      TEXT,
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `, 'sf_raid_jobs テーブル作成');

    exec(`CREATE INDEX IF NOT EXISTS idx_sf_raid_jobs_user_id ON sf_raid_jobs(user_id)`,
         'sf_raid_jobs user_id インデックス');
    exec(`CREATE INDEX IF NOT EXISTS idx_sf_raid_jobs_status ON sf_raid_jobs(status)`,
         'sf_raid_jobs status インデックス');
}

// ─── 4. sf_nodes テーブル ────────────────────────────────────────────
console.log('\n【4/5】 sf_nodes テーブル — 作成');
if (tableExists('sf_nodes')) {
    console.log('  ⏭  テーブルは既に存在します');
    // 不足カラムを追加
    addColumn('sf_nodes', 'provider_id',  'INTEGER');
    addColumn('sf_nodes', 'tflops',       'REAL');
    addColumn('sf_nodes', 'last_heartbeat', 'DATETIME');
} else {
    exec(`
        CREATE TABLE IF NOT EXISTS sf_nodes (
            id              TEXT    PRIMARY KEY,   -- node_id (例: bto-pc-001)
            provider_id     INTEGER,               -- users.id
            status          TEXT    NOT NULL DEFAULT 'idle',  -- idle|busy|offline
            gpu_name        TEXT,
            vram_gb         INTEGER,
            tflops          REAL,
            gpu_load        REAL,
            vram_used_mb    INTEGER,
            rtt_ms          INTEGER,
            last_heartbeat  DATETIME,
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, 'sf_nodes テーブル作成');

    exec(`CREATE INDEX IF NOT EXISTS idx_sf_nodes_status ON sf_nodes(status)`,
         'sf_nodes status インデックス');
}

// ─── 5. sf_matches テーブル ───────────────────────────────────────────
console.log('\n【5/5】 sf_matches テーブル — 作成');
if (tableExists('sf_matches')) {
    console.log('  ⏭  テーブルは既に存在します');
} else {
    exec(`
        CREATE TABLE IF NOT EXISTS sf_matches (
            id              TEXT    PRIMARY KEY,   -- UUID
            user_id         INTEGER NOT NULL,
            node_id         TEXT,                  -- sf_nodes.id
            selected_mode   TEXT,
            status          TEXT    NOT NULL DEFAULT 'pending',
            workspace_url   TEXT,
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `, 'sf_matches テーブル作成');

    exec(`CREATE INDEX IF NOT EXISTS idx_sf_matches_user_id ON sf_matches(user_id)`,
         'sf_matches user_id インデックス');
}

// ─── 完了 ─────────────────────────────────────────────────────────────
console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ SF Migration ${DRY_RUN ? '[DRY-RUN (変更なし)]' : '完了!'}
   pods.sf_raid_job_id / pods.sf_match_id
   reservations.sf_raid_job_id / sf_match_id
   テーブル: sf_raid_jobs / sf_nodes / sf_matches
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

db.close();
