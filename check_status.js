/**
 * check_status.js — GPU Rental Platform + GPU SF 統合ヘルスチェック
 *
 * 使い方:
 *   node check_status.js
 *   node check_status.js --json       # JSON出力モード
 *   node check_status.js --sf-only    # SF関連のみ表示
 *
 * ─────────────────────────────────────────────────────────────────
 */
require('dotenv').config();
const { initDb, getDb } = require('./server/db/database');

const JSON_MODE  = process.argv.includes('--json');
const SF_ONLY    = process.argv.includes('--sf-only');
const FULL       = process.argv.includes('--full');

// ─── カラー出力ヘルパー ─────────────────────────────────────────
const c = {
    reset: '\x1b[0m',
    bold:  '\x1b[1m',
    green: '\x1b[32m',
    red:   '\x1b[31m',
    yellow:'\x1b[33m',
    cyan:  '\x1b[36m',
    gray:  '\x1b[90m',
    amber: '\x1b[38;5;214m',
};
const ok  = (s) => `${c.green}✅ ${s}${c.reset}`;
const err = (s) => `${c.red}❌ ${s}${c.reset}`;
const warn= (s) => `${c.yellow}⚠️  ${s}${c.reset}`;
const inf = (s) => `${c.cyan}ℹ️  ${s}${c.reset}`;
const hdr = (s) => `\n${c.bold}${c.amber}⚡ ${s}${c.reset}\n${'─'.repeat(48)}`;

function safeGet(fn, fallback = null) {
    try { return fn(); } catch (_) { return fallback; }
}

// ─── メインチェック ────────────────────────────────────────────
async function main() {
    await initDb();
    const db = getDb();
    const result = {};

    // ═══════════════════════════════════════
    // 1. プラットフォーム基本統計
    // ═══════════════════════════════════════
    if (!SF_ONLY) {
        console.log(hdr('PLATFORM OVERVIEW'));

        // ユーザー統計
        const users     = safeGet(() => db.prepare('SELECT COUNT(*) as c FROM users').get());
        const providers = safeGet(() => db.prepare("SELECT COUNT(*) as c FROM users WHERE role='provider'").get());
        const admins    = safeGet(() => db.prepare("SELECT COUNT(*) as c FROM users WHERE role='admin'").get());
        console.log(`  ユーザー総数  : ${c.bold}${users?.c ?? '?'}${c.reset}  (プロバイダー: ${providers?.c ?? '?'}, 管理者: ${admins?.c ?? '?'})`);
        result.users = { total: users?.c, providers: providers?.c };

        // GPU ノード統計
        const gpus = safeGet(() => db.prepare('SELECT status, COUNT(*) as c FROM gpu_nodes GROUP BY status').all(), []);
        const gpuMap = Object.fromEntries(gpus.map(g => [g.status, g.c]));
        const gpuTotal = gpus.reduce((s, g) => s + g.c, 0);
        console.log(`  GPUノード    : 合計 ${c.bold}${gpuTotal}${c.reset} | available: ${gpuMap.available ?? 0}, rented: ${gpuMap.rented ?? 0}, maintenance: ${gpuMap.maintenance ?? 0}`);
        result.gpuNodes = { total: gpuTotal, ...gpuMap };

        // Pod / 予約
        const pods    = safeGet(() => db.prepare("SELECT status, COUNT(*) as c FROM pods GROUP BY status").all(), []);
        const podMap  = Object.fromEntries(pods.map(p => [p.status, p.c]));
        const reserv  = safeGet(() => db.prepare("SELECT status, COUNT(*) as c FROM reservations GROUP BY status").all(), []);
        const resvMap = Object.fromEntries(reserv.map(r => [r.status, r.c]));
        console.log(`  稼働中Pod   : ${c.bold}${podMap.running ?? 0}${c.reset}  (停止済: ${podMap.stopped ?? 0})`);
        console.log(`  予約       : confirmed: ${resvMap.confirmed ?? 0}, active: ${resvMap.active ?? 0}, completed: ${resvMap.completed ?? 0}`);
        result.pods = podMap;
        result.reservations = resvMap;

        // ポイント購入統計
        const purchases = safeGet(() => db.prepare("SELECT status, COUNT(*) as cnt, SUM(points) as total_points FROM point_purchases GROUP BY status").all(), []);
        if (purchases.length) {
            console.log('\n  === ポイント購入 ===');
            purchases.forEach(s => {
                const icon = s.status === 'completed' ? '✅' : s.status === 'pending' ? '⏳' : '❌';
                console.log(`  ${icon} ${s.status}: ${s.cnt}件 / ${s.total_points ?? 0}pt`);
            });
            result.pointPurchases = purchases;
        }

        // pending が多い場合は警告
        const pendingPurchases = safeGet(() =>
            db.prepare("SELECT id, user_id, plan_name, amount_yen, created_at FROM point_purchases WHERE status='pending' ORDER BY id DESC LIMIT 5").all(), []);
        if (pendingPurchases.length > 0) {
            console.log(warn(`  未処理購入: ${pendingPurchases.length}件`));
            if (FULL) pendingPurchases.forEach(p => console.log(`    #${p.id} ${p.plan_name} ¥${p.amount_yen} ${p.created_at}`));
        }
    }

    // ═══════════════════════════════════════
    // 2. GPU Street Fighter 統計
    // ═══════════════════════════════════════
    console.log(hdr('GPU STREET FIGHTER STATUS'));

    // --- SF ノード ---
    const sfNodesTable = safeGet(() => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sf_nodes'").get());
    if (!sfNodesTable) {
        console.log(warn('  sf_nodes テーブルが存在しません → migrations を実行してください'));
        console.log(inf('  node scripts/migrate_sf_columns.js'));
    } else {
        const sfNodes = safeGet(() => db.prepare("SELECT status, COUNT(*) as c FROM sf_nodes GROUP BY status").all(), []);
        const sfNodeMap = Object.fromEntries(sfNodes.map(n => [n.status, n.c]));
        const sfTotal = sfNodes.reduce((s, n) => s + n.c, 0);

        // ハートビートが 2分以内のノードをオンライン判定
        const sfOnline = safeGet(() => db.prepare(
            "SELECT COUNT(*) as c FROM sf_nodes WHERE last_seen > datetime('now','-2 minutes')"
        ).get()?.c ?? 0, 0);

        const statusStr = sfTotal === 0
            ? c.gray + 'ノードなし' + c.reset
            : `online: ${c.green}${sfOnline}${c.reset}, idle: ${sfNodeMap.idle ?? 0}, busy: ${sfNodeMap.busy ?? 0}, offline: ${sfNodeMap.offline ?? 0}`;

        console.log(`  SFノード     : 合計 ${c.bold}${sfTotal}${c.reset} | ${statusStr}`);
        result.sfNodes = { total: sfTotal, online: sfOnline, ...sfNodeMap };
    }

    // --- SF レイドジョブ ---
    const sfRaidTable = safeGet(() => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sf_raid_jobs'").get());
    if (!sfRaidTable) {
        console.log(warn('  sf_raid_jobs テーブルが存在しません'));
    } else {
        const sfRaids = safeGet(() => db.prepare("SELECT status, COUNT(*) as c FROM sf_raid_jobs GROUP BY status").all(), []);
        const raidMap = Object.fromEntries(sfRaids.map(r => [r.status, r.c]));
        const raidTotal = sfRaids.reduce((s, r) => s + r.c, 0);

        const todayDone = safeGet(() => db.prepare(
            "SELECT COUNT(*) as c FROM sf_raid_jobs WHERE status='completed' AND date(completed_at)=date('now')"
        ).get()?.c ?? 0, 0);

        const activeCnt = (raidMap.paid ?? 0) + (raidMap.dispatched ?? 0) + (raidMap.running ?? 0);
        console.log(`  レイドジョブ  : 合計 ${c.bold}${raidTotal}${c.reset} | 🔥 処理中: ${c.red}${activeCnt}${c.reset}, ✅ 本日完了: ${c.green}${todayDone}${c.reset}`);

        if (FULL && raidTotal > 0) {
            const recent = safeGet(() => db.prepare(
                "SELECT id, status, payment_amount_yen, created_at FROM sf_raid_jobs ORDER BY id DESC LIMIT 5"
            ).all(), []);
            console.log(`\n  === 最近のレイドジョブ (最新5件) ===`);
            recent.forEach(r => console.log(`    #${r.id} [${r.status}] ¥${r.payment_amount_yen} ${r.created_at}`));
        }
        result.sfRaidJobs = { total: raidTotal, activeNow: activeCnt, todayDone, ...raidMap };
    }

    // --- SF マッチリクエスト ---
    const sfMatchTable = safeGet(() => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sf_match_requests'").get());
    if (sfMatchTable) {
        const sfMatches = safeGet(() => db.prepare("SELECT status, COUNT(*) as c FROM sf_match_requests GROUP BY status").all(), []);
        const matchMap  = Object.fromEntries(sfMatches.map(m => [m.status, m.c]));
        const matchTotal = sfMatches.reduce((s, m) => s + m.c, 0);
        console.log(`  1on1 マッチ  : 合計 ${c.bold}${matchTotal}${c.reset} | pending: ${matchMap.pending ?? 0}, confirmed: ${matchMap.confirmed ?? 0}, completed: ${matchMap.completed ?? 0}`);
        result.sfMatches = { total: matchTotal, ...matchMap };
    }

    // --- pods SF 連携カラム確認 ---
    const podSfCol = safeGet(() => db.prepare("PRAGMA table_info(pods)").all().some(c => c.name === 'sf_raid_job_id'), false);
    const resvSfCol = safeGet(() => db.prepare("PRAGMA table_info(reservations)").all().some(c => c.name === 'sf_raid_job_id'), false);
    console.log(`\n  DBカラム確認:`);
    console.log(`    pods.sf_raid_job_id        : ${podSfCol  ? ok('存在') : err('なし → migration 要')}`);
    console.log(`    reservations.sf_raid_job_id: ${resvSfCol ? ok('存在') : err('なし → migration 要')}`);

    // ═══════════════════════════════════════
    // 3. SF ポイントログ
    // ═══════════════════════════════════════
    const plTable = safeGet(() => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='point_logs'").get());
    if (plTable) {
        const sfLogs    = safeGet(() => db.prepare("SELECT COUNT(*) as c FROM point_logs WHERE source='raid_job'").get()?.c ?? 0, 0);
        const earnTotal = safeGet(() => db.prepare("SELECT SUM(amount) as s FROM point_logs WHERE type='earn'").get()?.s ?? 0, 0);
        const spendTotal= safeGet(() => db.prepare("SELECT SUM(amount) as s FROM point_logs WHERE type='spend'").get()?.s ?? 0, 0);
        const refundTotal=safeGet(() => db.prepare("SELECT SUM(amount) as s FROM point_logs WHERE type='refund'").get()?.s ?? 0, 0);
        console.log(`\n  ポイントログ : earn: ${c.green}+${earnTotal}pt${c.reset} | spend: ${c.red}-${spendTotal}pt${c.reset} | refund: ${c.yellow}+${refundTotal}pt${c.reset} | SF由来: ${sfLogs}件`);
        result.pointLogs = { sfCount: sfLogs, earnTotal, spendTotal, refundTotal };
    }

    // --- THE DOJO エージェントトークン設定済みプロバイダー ---
    const agentProviders = safeGet(() => db.prepare("SELECT COUNT(*) as c FROM users WHERE agent_token IS NOT NULL AND role='provider'").get()?.c ?? 0, 0);
    const sfConfirmResv  = safeGet(() => {
        const col = db.prepare("PRAGMA table_info(reservations)").all().some(c => c.name === 'sf_raid_job_id');
        return col ? db.prepare("SELECT COUNT(*) as c FROM reservations WHERE sf_raid_job_id IS NOT NULL").get()?.c ?? 0 : '—';
    }, '—');
    console.log(`\n  THE DOJO    : エージェントトークン設定済みプロバイダー: ${c.bold}${agentProviders}${c.reset}`);
    console.log(`  SF予約紐付き : ${c.bold}${sfConfirmResv}${c.reset} 件 (/api/reservations/sf-confirm)`);
    result.theDojoProviders = agentProviders;
    result.sfLinkedReservations = sfConfirmResv;

    // ═══════════════════════════════════════
    // 4. JSON モード出力
    // ═══════════════════════════════════════
    if (JSON_MODE) {
        process.stdout.write('\n');
        console.log(JSON.stringify(result, null, 2));
    }

    console.log(`\n${c.gray}チェック完了: ${new Date().toLocaleString('ja-JP')}${c.reset}\n`);
    // process.exit はsql.js/Windows環境でassertion errorが出るため省略
    // Nodeは非同期完了後に自然終了する
}

main().catch(e => {
    console.error(err('Fatal: ' + e.message));
});
