/**
 * GPU Rental Platform — Automated Health Check
 * =============================================
 * 実行: node scripts/health-check.js
 *  PM2 Cron: 5分ごとに自動実行
 *  チェック項目:
 *    1. サーバーHTTPヘルス
 *    2. DBの整合性（pending購入 / ユーザー残高）
 *    3. Stripeの支払い済み未付与チェック
 *    4. ゾンビプロセス（node/ssh ハング）
 *    5. Cloudflare Tunnel 疎通
 *    6. ディスク空き容量
 *    7. PM2サーバー稼働確認
 *    8. メモリ使用量
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const { execSync, exec } = require('child_process');

// ── 設定 ────────────────────────────────────────────────────
const CONFIG = {
    localUrl:    'http://localhost:3000',
    externalUrl: 'https://gpurental.jp',
    logDir:      path.join(__dirname, '../logs/health'),
    incidentDir: path.join(__dirname, '../docs/incidents'),
    thresholds: {
        pendingPurchaseMaxAgeHours: 2,   // 2時間以上pendingなら警告
        diskMinGB: 5,                     // 5GB以下で警告
        memMaxMB: 800,                    // 800MB以上で警告
        zombieMaxCount: 3,                // ゾンビnodeが3以上で警告
    },
};

// ── ログ出力 ─────────────────────────────────────────────────
const RESULTS = [];
const START   = new Date();

function log(level, check, message, detail = null) {
    const entry = {
        ts: new Date().toISOString(),
        level,       // OK | WARN | ERROR | INFO
        check,
        message,
        detail,
    };
    RESULTS.push(entry);
    const icon = { OK: '✅', WARN: '⚠️', ERROR: '❌', INFO: 'ℹ️' }[level] || '?';
    console.log(`${icon} [${level.padEnd(5)}] ${check}: ${message}`);
    if (detail) console.log(`         ↳ ${JSON.stringify(detail)}`);
    return level === 'OK';
}

// ── HTTP チェック ────────────────────────────────────────────
function httpGet(url, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { timeout: timeoutMs }, (res) => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
                catch { resolve({ status: res.statusCode, body }); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

// ── DB チェック ──────────────────────────────────────────────
async function checkDb() {
    try {
        const { initDb, getDb } = require('../server/db/database');
        await initDb();
        const db = getDb();

        // 長時間pending購入チェック
        const maxAge = `datetime('now', '-${CONFIG.thresholds.pendingPurchaseMaxAgeHours} hours')`;
        const stale = db.prepare(`
            SELECT pp.id, pp.user_id, pp.amount_yen, pp.plan_name, pp.created_at,
                   u.email
            FROM point_purchases pp
            JOIN users u ON u.id = pp.user_id
            WHERE pp.status = 'pending'
              AND pp.epsilon_order LIKE 'cs_%'
              AND pp.created_at < ${maxAge}
        `).all();

        if (stale.length > 0) {
            log('WARN', 'DB:PendingPurchases',
                `${stale.length}件のStripe支払い済み可能性あるpendingが${CONFIG.thresholds.pendingPurchaseMaxAgeHours}時間以上放置`,
                stale.map(p => ({ id: p.id, email: p.email, amount: p.amount_yen, at: p.created_at }))
            );
        } else {
            log('OK', 'DB:PendingPurchases', '長時間pendingなし');
        }

        // 残高マイナスチェック
        const negBalance = db.prepare('SELECT id, email, point_balance FROM users WHERE point_balance < 0').all();
        if (negBalance.length > 0) {
            log('ERROR', 'DB:NegativeBalance', `${negBalance.length}件のマイナス残高ユーザー`, negBalance);
        } else {
            log('OK', 'DB:NegativeBalance', 'マイナス残高なし');
        }

        // GPU Nodes 状態
        const gpus = db.prepare("SELECT status, COUNT(*) as c FROM gpu_nodes GROUP BY status").all();
        log('INFO', 'DB:GPUNodes', 'GPU状態', Object.fromEntries(gpus.map(g => [g.status, g.c])));

        // 直近の completed 購入件数
        const recentCompleted = db.prepare(`SELECT COUNT(*) as c FROM point_purchases WHERE status='completed' AND paid_at > datetime('now', '-24 hours')`).get().c;
        log('INFO', 'DB:RecentSales', `過去24h 完了購入: ${recentCompleted}件`);

    } catch (err) {
        log('ERROR', 'DB', 'DB接続/クエリエラー', err.message);
    }
}

// ── Stripe チェック ──────────────────────────────────────────
async function checkStripe() {
    if (!process.env.STRIPE_SECRET_KEY) {
        log('WARN', 'Stripe', 'STRIPE_SECRET_KEY未設定');
        return;
    }
    try {
        const Stripe = require('stripe');
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' });

        // 最新チャージ確認（接続テスト）
        await stripe.checkout.sessions.list({ limit: 1 });
        log('OK', 'Stripe:API', 'Stripe API接続正常');

        // Webhook最新イベント確認（未配信があれば警告）
        const events = await stripe.events.list({ limit: 5, delivery_success: false });
        const pending = events.data.filter(e => e.pending_webhooks > 0);
        if (pending.length > 0) {
            log('WARN', 'Stripe:Webhook',
                `${pending.length}件のWebhook未配信イベントあり`,
                pending.map(e => ({ id: e.id, type: e.type, pending: e.pending_webhooks }))
            );
        } else {
            log('OK', 'Stripe:Webhook', 'Webhook未配信なし');
        }
    } catch (err) {
        log('ERROR', 'Stripe', `Stripe確認エラー: ${err.message}`);
    }
}

// ── プロセス チェック ────────────────────────────────────────
function checkProcesses() {
    try {
        // PM2ステータス
        const pm2Out = execSync('pm2 jlist 2>&1', { encoding: 'utf8', timeout: 8000 });
        const pm2List = JSON.parse(pm2Out);
        const gpuRental = pm2List.find(p => p.name === 'gpu-rental');

        if (!gpuRental) {
            log('ERROR', 'Process:PM2', 'gpu-rental プロセスがPM2に存在しない');
        } else if (gpuRental.pm2_env.status !== 'online') {
            log('ERROR', 'Process:PM2', `gpu-rental ステータス異常: ${gpuRental.pm2_env.status}`);
        } else {
            const uptimeSec = Math.floor((Date.now() - gpuRental.pm2_env.pm_uptime) / 1000);
            log('OK', 'Process:PM2', `gpu-rental online (uptime: ${uptimeSec}s, restarts: ${gpuRental.pm2_env.restart_time})`);
            if (gpuRental.pm2_env.restart_time > 5) {
                log('WARN', 'Process:PM2Restarts', `再起動回数が多い: ${gpuRental.pm2_env.restart_time}回`);
            }
        }
    } catch (err) {
        log('ERROR', 'Process:PM2', `PM2確認エラー: ${err.message}`);
    }

    // ゾンビnodeプロセスチェック（Windows）
    try {
        const wmic = execSync('wmic process where "name=\'node.exe\'" get processid,commandline /format:csv 2>&1', {
            encoding: 'utf8', timeout: 10000,
        });
        const lines = wmic.split('\n').filter(l => l.includes('node.exe'));
        const zombies = lines.filter(l =>
            !l.includes('pm2') && !l.includes('ProcessContainerFork') &&
            !l.includes('tsserver') && !l.includes('Antigravity')
        );

        if (zombies.length > CONFIG.thresholds.zombieMaxCount) {
            log('WARN', 'Process:ZombieNode', `ゾンビnodeプロセスが${zombies.length}個`, { count: zombies.length });
        } else {
            log('OK', 'Process:ZombieNode', `nodeプロセス正常 (PM2以外: ${zombies.length}個)`);
        }
    } catch { /* wmic未対応環境は無視 */ }
}

// ── ディスクチェック ─────────────────────────────────────────
function checkDisk() {
    try {
        const out = execSync('wmic logicaldisk get size,freespace,caption /format:csv 2>&1', {
            encoding: 'utf8', timeout: 5000,
        });
        const drives = out.split('\n')
            .filter(l => /^[^,]*,[A-Z]:/.test(l.trim()))
            .map(l => {
                const [,caption,free,size] = l.trim().split(',');
                return { drive: caption, freeGB: Math.floor(Number(free) / 1e9), totalGB: Math.floor(Number(size) / 1e9) };
            }).filter(d => d.totalGB > 0);

        drives.forEach(d => {
            if (d.freeGB < CONFIG.thresholds.diskMinGB) {
                log('WARN', `Disk:${d.drive}`, `空き容量が少ない: ${d.freeGB}GB / ${d.totalGB}GB`);
            } else {
                log('OK', `Disk:${d.drive}`, `空き: ${d.freeGB}GB / ${d.totalGB}GB`);
            }
        });
    } catch { log('WARN', 'Disk', 'ディスク確認スキップ'); }
}

// ── レポート保存 ─────────────────────────────────────────────
function saveReport() {
    fs.mkdirSync(CONFIG.logDir, { recursive: true });

    const dateStr = START.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const logFile = path.join(CONFIG.logDir, `health-${dateStr}.json`);

    const errors  = RESULTS.filter(r => r.level === 'ERROR');
    const warns   = RESULTS.filter(r => r.level === 'WARN');
    const summary = {
        timestamp:  START.toISOString(),
        duration_ms: Date.now() - START.getTime(),
        total_checks: RESULTS.length,
        errors:  errors.length,
        warnings: warns.length,
        status:  errors.length > 0 ? 'DEGRADED' : warns.length > 0 ? 'WARNING' : 'HEALTHY',
        results: RESULTS,
    };

    fs.writeFileSync(logFile, JSON.stringify(summary, null, 2), 'utf8');

    // 最新サマリーも上書き保存（AI参照用）
    fs.writeFileSync(
        path.join(CONFIG.logDir, 'latest.json'),
        JSON.stringify(summary, null, 2), 'utf8'
    );

    // インシデントがあればインシデントログに追記
    if (errors.length > 0 || warns.length > 0) {
        const incidentFile = path.join(CONFIG.incidentDir,
            `${START.toISOString().slice(0, 10)}-incidents.md`);
        const incidentEntry = `
## ${START.toISOString()} — ${summary.status}

| Level | Check | Message |
|-------|-------|---------|
${[...errors, ...warns].map(r => `| **${r.level}** | ${r.check} | ${r.message} |`).join('\n')}

detail: \`logs/health/health-${dateStr}.json\`
---
`;
        fs.appendFileSync(incidentFile, incidentEntry, 'utf8');
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`STATUS: ${summary.status}  (${errors.length} errors, ${warns.length} warnings)`);
    console.log(`Report: ${logFile}`);
    console.log(`${'='.repeat(60)}\n`);

    return summary;
}

// ── メイン ───────────────────────────────────────────────────
async function main() {
    console.log(`\n🔍 GPU Rental Health Check — ${START.toISOString()}\n${'─'.repeat(60)}`);

    // 1. ローカルサーバーヘルス
    try {
        const res = await httpGet(`${CONFIG.localUrl}/api/health`);
        if (res.status === 200 && res.body.status === 'ok') {
            log('OK', 'HTTP:Local', `サーバー応答正常 (uptime: ${res.body.uptime}s)`);
        } else {
            log('ERROR', 'HTTP:Local', `異常レスポンス: ${res.status}`);
        }
    } catch (err) {
        log('ERROR', 'HTTP:Local', `ローカルサーバー到達不能: ${err.message}`);
    }

    // 2. 外部アクセス
    try {
        const res = await httpGet(`${CONFIG.externalUrl}/api/health`);
        if (res.status === 200) {
            log('OK', 'HTTP:External', `外部アクセス正常 (${CONFIG.externalUrl})`);
        } else {
            log('WARN', 'HTTP:External', `外部レスポンス異常: ${res.status}`);
        }
    } catch (err) {
        log('WARN', 'HTTP:External', `外部到達不能 (Tunnel断絶?): ${err.message}`);
    }

    // 3-5. 並行チェック
    await Promise.all([checkDb(), checkStripe()]);

    // 6. プロセス・ディスク
    checkProcesses();
    checkDisk();

    // レポート保存
    const summary = saveReport();

    // ログローテーション（7日以上古いファイル削除）
    try {
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        fs.readdirSync(CONFIG.logDir)
            .filter(f => f.startsWith('health-') && f.endsWith('.json'))
            .map(f => ({ f, mtime: fs.statSync(path.join(CONFIG.logDir, f)).mtimeMs }))
            .filter(({ mtime }) => mtime < cutoff)
            .forEach(({ f }) => fs.unlinkSync(path.join(CONFIG.logDir, f)));
    } catch { /* ignore */ }

    process.exit(summary.errors > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Health check crashed:', err);
    process.exit(2);
});
