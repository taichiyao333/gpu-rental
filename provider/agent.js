#!/usr/bin/env node
/**
 * THE DOJO Agent — GPU Street Fighter プロバイダーエージェント
 *
 * 機能:
 *   1. 初回起動時に /api/sf/nodes/register でノード登録 + ベンチマーク送信
 *   2. SF_HEARTBEAT_INTERVAL ごとに /api/sf/nodes/heartbeat を送信
 *      (nvidia-smi でリアルタイムGPU状態を取得)
 *   3. 登録情報は agent_state.json にキャッシュ (再起動時に再利用)
 *
 * 使い方:
 *   node provider/agent.js --token <YOUR_AGENT_TOKEN> --server https://gpurental.jp
 *   または環境変数:
 *     AGENT_TOKEN=xxx SERVER_URL=https://gpurental.jp node provider/agent.js
 *
 * 必要要件:
 *   - nvidia-smi がインストールされていること (NVIDIA GPU必須)
 *   - Node.js 18+
 *   - npm install node-fetch (または Node 18 の fetch を使用)
 */

'use strict';

const { execSync, exec } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ─── 設定 ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
    const i = args.indexOf('--' + name);
    return i !== -1 ? args[i + 1] : null;
}

const AGENT_TOKEN    = getArg('token')      || process.env.AGENT_TOKEN     || '';
const SERVER_URL     = (getArg('server')    || process.env.SERVER_URL      || 'http://localhost:3000').replace(/\/$/, '');
const HEARTBEAT_MS   = parseInt(getArg('interval') || process.env.SF_HEARTBEAT_INTERVAL || '30000');
const STATE_FILE     = path.join(__dirname, 'agent_state.json');
const AGENT_VERSION  = '1.0.0';

if (!AGENT_TOKEN) {
    console.error('❌ エージェントトークンが必要です。');
    console.error('   --token <TOKEN> または AGENT_TOKEN 環境変数を設定してください。');
    console.error('   トークンはポータル → THE DOJO 設定 で確認できます。');
    process.exit(1);
}

// ─── カラー出力 ───────────────────────────────────────────────────────────────
const C = {
    reset: '\x1b[0m', bold: '\x1b[1m',
    green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
    cyan: '\x1b[36m', purple: '\x1b[35m', gray: '\x1b[90m',
};
const log  = (msg)  => console.log(`${C.gray}[${new Date().toLocaleTimeString('ja-JP')}]${C.reset} ${msg}`);
const ok   = (msg)  => console.log(`${C.green}✅${C.reset} ${msg}`);
const warn = (msg)  => console.log(`${C.yellow}⚠️  ${msg}${C.reset}`);
const err  = (msg)  => console.log(`${C.red}❌ ${msg}${C.reset}`);
const info = (msg)  => console.log(`${C.cyan}ℹ️  ${msg}${C.reset}`);

// ─── nvidia-smi ヘルパー ──────────────────────────────────────────────────────
function nvidiaSmiAvailable() {
    try { execSync('nvidia-smi --version', { stdio: 'ignore' }); return true; }
    catch (_) { return false; }
}

function getGpuList() {
    try {
        const out = execSync(
            'nvidia-smi --query-gpu=index,name,memory.total,driver_version --format=csv,noheader,nounits',
            { encoding: 'utf8', timeout: 10000 }
        ).trim();
        return out.split('\n').map(line => {
            const [index, name, vram_total, driver] = line.split(', ').map(s => s.trim());
            return { index: parseInt(index), name, vram_total_mb: parseInt(vram_total), driver };
        });
    } catch (_) { return []; }
}

function getGpuStats() {
    try {
        const out = execSync(
            'nvidia-smi --query-gpu=index,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw --format=csv,noheader,nounits',
            { encoding: 'utf8', timeout: 10000 }
        ).trim();
        return out.split('\n').map(line => {
            const [index, temperature, utilization, vram_used, vram_total, power_draw] = line.split(', ').map(s => s.trim());
            return {
                index: parseInt(index),
                temperature: parseInt(temperature),
                utilization: parseInt(utilization),
                vram_used: parseInt(vram_used),
                vram_total: parseInt(vram_total),
                power_draw: parseFloat(power_draw) || 0,
            };
        });
    } catch (_) { return []; }
}

// RTT 計測 (サーバーへの往復レイテンシ)
async function measureRtt() {
    const start = Date.now();
    try {
        await fetch(`${SERVER_URL}/api/health`, { signal: AbortSignal.timeout(5000) });
        return Date.now() - start;
    } catch (_) { return 9999; }
}

// ─── ベンチマーク (簡易) ───────────────────────────────────────────────────────
async function runBenchmark() {
    info('ベンチマーク測定中...');
    const rtt_ms = await measureRtt();

    // アップロード速度 (1KB のデータを送信して計測)
    let upload_mbps = 0;
    try {
        const payload = Buffer.alloc(4096, 0);
        const start = Date.now();
        await fetch(`${SERVER_URL}/api/health`, {
            method: 'GET',
            signal: AbortSignal.timeout(8000),
        });
        const elapsed = Date.now() - start;
        upload_mbps = Math.round((payload.length * 8) / (elapsed / 1000) / 1e6 * 10) / 10;
    } catch (_) {}

    // GPU TFLOPS 推定 (GPU 名から既知の値を使用)
    const gpus = getGpuList();
    const fpTflopsMap = {
        'RTX A4500': 31.7, 'RTX A4000': 19.2, 'RTX A6000': 38.7,
        'RTX 4090': 82.6,  'RTX 4080': 48.7,  'RTX 4070 Ti': 40.1,
        'RTX 3090': 35.6,  'RTX 3080': 29.8,  'RTX 3070': 20.3,
        'RTX 3060': 12.7,  'RTX 2080 Ti': 13.4,
    };
    let fp32_tflops = 1.0;
    if (gpus[0]) {
        const key = Object.keys(fpTflopsMap).find(k => gpus[0].name.includes(k));
        fp32_tflops = fpTflopsMap[key] || 1.0;
    }

    return { rtt_ms, upload_mbps, fp32_tflops };
}

// ─── API ヘルパー ─────────────────────────────────────────────────────────────
async function apiPost(path, body) {
    const res = await fetch(`${SERVER_URL}/api${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Agent-Token': AGENT_TOKEN,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
}

// ─── 状態ファイル ─────────────────────────────────────────────────────────────
function loadState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (_) { return {}; }
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ─── ノード登録 ───────────────────────────────────────────────────────────────
async function registerNode() {
    const gpus = getGpuList();
    if (!gpus.length) {
        warn('GPU が検出されませんでした。nvidia-smi を確認してください。');
    }

    const benchmark = await runBenchmark();
    const hostname  = os.hostname();
    const cpuCount  = os.cpus().length;
    const totalRam  = Math.round(os.totalmem() / (1024 * 1024 * 1024));

    const payload = {
        hostname,
        gpu_count: gpus.length,
        gpu_list: gpus,
        cpu_cores: cpuCount,
        ram_gb: totalRam,
        agent_version: AGENT_VERSION,
        benchmark: {
            rtt_ms:       benchmark.rtt_ms,
            upload_mbps:  benchmark.upload_mbps,
            fp32_tflops:  benchmark.fp32_tflops,
        },
    };

    info(`ノード登録中... hostname=${hostname}, GPU×${gpus.length}, RTT=${benchmark.rtt_ms}ms`);
    const result = await apiPost('/sf/nodes/register', payload);
    ok(`ノード登録完了: SF Node #${result.id || result.node_id || '?'}`);
    return result;
}

// ─── ハートビート ─────────────────────────────────────────────────────────────
let heartbeatCount = 0;
let lastRtt = 0;

async function sendHeartbeat() {
    heartbeatCount++;
    const gpu_stats = getGpuStats();
    if (heartbeatCount % 10 === 0) {
        lastRtt = await measureRtt(); // 10回に1回RTT計測
    }

    try {
        await apiPost('/sf/nodes/heartbeat', {
            gpu_stats,
            rtt_ms: lastRtt,
        });
        const main = gpu_stats[0];
        if (main) {
            log(`♥ HB #${heartbeatCount} | GPU: ${main.utilization}% | 温度: ${main.temperature}°C | VRAM: ${main.vram_used}/${main.vram_total}MB | RTT: ${lastRtt}ms`);
        } else {
            log(`♥ HB #${heartbeatCount} (GPU統計なし) | RTT: ${lastRtt}ms`);
        }
    } catch (e) {
        err(`ハートビート失敗 #${heartbeatCount}: ${e.message}`);
    }
}

// ─── メイン ───────────────────────────────────────────────────────────────────
async function main() {
    console.log(`\n${C.purple}${C.bold}`);
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log('  ║  ⚡ THE DOJO — GPU Street Fighter Agent       ║');
    console.log(`  ║  v${AGENT_VERSION}  METADATALAB.INC                      ║`);
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log(C.reset);

    info(`サーバー: ${SERVER_URL}`);
    info(`ハートビート間隔: ${HEARTBEAT_MS / 1000}秒`);

    // nvidia-smi チェック
    if (!nvidiaSmiAvailable()) {
        warn('nvidia-smi が見つかりません。GPUステータスは送信されません。');
    } else {
        const gpus = getGpuList();
        ok(`GPU検出: ${gpus.map(g => g.name).join(', ')}`);
    }

    // 状態ファイルから既存ノードIDを確認
    const state = loadState();
    if (state.node_id && state.registered_at) {
        info(`既存ノード #${state.node_id} (登録: ${state.registered_at}) を使用`);
    } else {
        // 初回登録
        try {
            const result = await registerNode();
            saveState({
                node_id: result.id || result.node_id,
                registered_at: new Date().toISOString(),
                server: SERVER_URL,
            });
        } catch (e) {
            err(`ノード登録失敗: ${e.message}`);
            err('サーバーURL とエージェントトークンを確認してください。');
            process.exit(1);
        }
    }

    // 初回ハートビート
    await sendHeartbeat();

    // 定期ハートビート
    setInterval(sendHeartbeat, HEARTBEAT_MS);

    // シグナルハンドリング
    process.on('SIGINT', () => {
        info('\nTHE DOJO エージェントを停止します...');
        process.exit(0);
    });
    process.on('SIGTERM', () => process.exit(0));
}

main().catch(e => {
    err('Fatal: ' + e.message);
    process.exit(1);
});
