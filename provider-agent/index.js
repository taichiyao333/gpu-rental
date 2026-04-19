/**
 * GPU Provider Agent v2.0.0 — THE DOJO
 *
 * GPU SF (Street Fighter) 対応版エージェント。
 * 初回起動時に「戦闘力測定（ベンチマーク）」を実行し、
 * THE REFEREE (gpurental.jp/api/sf) に登録する。
 *
 * 機能:
 *   1. GPU検出 (nvidia-smi)
 *   2. ベンチマーク測定
 *      - FP32 TFLOPS推算
 *      - ネットワーク速度 (upload / download / RTT)
 *      - ストレージ速度 (read / write)
 *      - 電力・稼働率
 *   3. THE REFEREE への登録 (POST /api/sf/nodes/register)
 *   4. 10秒ごとのheartbeat (POST /api/sf/nodes/heartbeat) + RTT計測
 *   5. SSHトンネル接続 (既存機能を維持)
 *
 * Usage:
 *   node index.js
 *
 * 設定 (config.json or 環境変数):
 *   PLATFORM_URL  = https://gpurental.jp
 *   AGENT_EMAIL   = user@example.com
 *   SSH_HOST      = 127.0.0.1
 *   SSH_PORT      = 22
 *   LOCATION      = 東京 (拠点名)
 */

'use strict';

const net     = require('net');
const os      = require('os');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { execSync, execFileSync } = require('child_process');

// ── Config ───────────────────────────────────────────────────
const CONFIG_FILE = path.join(__dirname, 'config.json');
let config = {
    platformUrl:    process.env.PLATFORM_URL  || 'https://gpurental.jp',
    email:          process.env.AGENT_EMAIL   || '',
    token:          null,
    nodeId:         null,
    sshHost:        process.env.SSH_HOST      || '127.0.0.1',
    sshPort:        parseInt(process.env.SSH_PORT) || 22,
    location:       process.env.LOCATION      || 'Unknown',
    networkRegion:  process.env.NETWORK_REGION || 'ap-northeast-1',
};

if (fs.existsSync(CONFIG_FILE)) {
    try { Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch (_) {}
}
function saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ── TFLOPS Lookup Table ──────────────────────────────────────
// nvidia-smiで名称を取得してTFLOPS（FP32）を推算するテーブル
// 出典: NVIDIA公式スペックシート
const TFLOPS_TABLE = {
    'RTX 5090':    209.5,
    'RTX 5080':    137.0,
    'RTX 5070 Ti': 107.0,
    'RTX 5070':     77.0,
    'RTX 4090':     82.6,
    'RTX 4080 SUPER': 52.2,
    'RTX 4080':     48.7,
    'RTX 4070 Ti SUPER': 40.0,
    'RTX 4070 Ti':  40.1,
    'RTX 4070 SUPER': 35.5,
    'RTX 4070':     29.1,
    'RTX 4060 Ti':  22.1,
    'RTX 4060':     15.1,
    'RTX 3090 Ti':  40.0,
    'RTX 3090':     35.6,
    'RTX 3080 Ti':  34.1,
    'RTX 3080':     29.8,
    'RTX 3070 Ti':  21.7,
    'RTX 3070':     20.3,
    'RTX A6000':    38.7,
    'RTX A5000':    27.8,
    'RTX A4500':    23.7,
    'RTX A4000':    19.2,
    'RTX A2000':     7.99,
    'A100 80GB':    77.6,
    'A100 40GB':    77.6,
    'H100':        204.9,
    'H200':        235.0,
    'L40S':         91.6,
    'L40':          90.5,
    'L4':           30.3,
};

function estimateTflops(gpuName) {
    const norm = gpuName.replace(/NVIDIA\s+/i, '').replace(/GeForce\s+/i, '').trim();
    for (const [model, tflops] of Object.entries(TFLOPS_TABLE)) {
        if (norm.toUpperCase().includes(model.toUpperCase())) return tflops;
    }
    // VRAMから大まかに推算（フォールバック）
    return null;
}

// ── Display Helpers ──────────────────────────────────────────
function showBanner() {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════╗');
    console.log('║  🥊 GPU Provider Agent v2.0.0  THE DOJO          ║');
    console.log('║  GPU Street Fighter — 戦闘力測定システム            ║');
    console.log('║  ポート開放不要！簡単GPU貸し出し                    ║');
    console.log('╚═══════════════════════════════════════════════════╝');
    console.log('');
}

function showStep(num, total, label) {
    console.log(`\n📋 ステップ ${num}/${total}: ${label}`);
    console.log('');
}

function showProgress(step, total, label, status = 'running') {
    const icons = { running: '⏳', done: '✅', error: '❌', warning: '⚠️' };
    const icon = icons[status] || '⏳';
    const bar = '█'.repeat(step) + '░'.repeat(total - step);
    const pct = Math.round((step / total) * 100);
    if (status === 'running') {
        process.stdout.write(`\r  ${icon} [${bar}] ${pct}% — ${label}...`);
    } else {
        process.stdout.write(`\r  ${icon} [${bar}] ${pct}% — ${label}   \n`);
    }
}

function showError(title, detail, suggestion) {
    console.log('');
    console.log('  ╭──────────────────────────────────────────────╮');
    console.log(`  │  ❌ ${title}`);
    console.log('  ├──────────────────────────────────────────────┤');
    console.log(`  │  問題: ${detail}`);
    if (suggestion) console.log(`  │  解決策: ${suggestion}`);
    console.log('  ╰──────────────────────────────────────────────╯');
    console.log('');
}

function showFighterCard(gpus, benchmark, fighterPower) {
    const gpu0 = gpus[0];
    const tflops = benchmark.fp32_tflops?.toFixed(1) || '?';
    console.log('');
    console.log('  ╔═══════════════════════════════════════════════════╗');
    console.log('  ║  🎮 戦闘力測定結果                                 ║');
    console.log('  ╠═══════════════════════════════════════════════════╣');
    console.log(`  ║  GPU:      ${(gpu0?.name || '不明').padEnd(38)}║`);
    console.log(`  ║  VRAM:     ${String(Math.round((gpu0?.vram || 0)/1024) + 'GB').padEnd(38)}║`);
    console.log(`  ║  算力:     ${String(tflops + ' TFLOPS (FP32)').padEnd(38)}║`);
    console.log(`  ║  上り:     ${String((benchmark.upload_mbps || 0).toFixed(0) + ' Mbps').padEnd(38)}║`);
    console.log(`  ║  下り:     ${String((benchmark.download_mbps || 0).toFixed(0) + ' Mbps').padEnd(38)}║`);
    console.log(`  ║  遅延:     ${String((benchmark.rtt_ms || 0).toFixed(0) + ' ms').padEnd(38)}║`);
    console.log(`  ║  Storage:  ${String((benchmark.storage_write_mbps || 0).toFixed(0) + ' MB/s write').padEnd(38)}║`);
    console.log('  ╠═══════════════════════════════════════════════════╣');
    console.log(`  ║  ⚡ Fighter Power: ${String(fighterPower + ' / 100').padEnd(31)}║`);
    console.log('  ╚═══════════════════════════════════════════════════╝');
    console.log('');
}

// ── GPU Detection ─────────────────────────────────────────────
function detectGPUs() {
    const TOTAL = 4;
    showProgress(1, TOTAL, 'NVIDIAドライバーを確認中');
    try {
        execSync('nvidia-smi --version', { encoding: 'utf8', timeout: 5000 });
    } catch {
        showProgress(1, TOTAL, 'NVIDIAドライバーが見つかりません', 'error');
        showError(
            'NVIDIAドライバーが見つかりません',
            'nvidia-smi コマンドが実行できません。',
            'https://www.nvidia.co.jp/Download/ からドライバーをインストールしてください。'
        );
        return [];
    }
    showProgress(1, TOTAL, 'NVIDIAドライバー検出', 'done');

    showProgress(2, TOTAL, 'GPU情報を読み取り中');
    let output;
    try {
        output = execSync(
            'nvidia-smi --query-gpu=name,memory.total,driver_version,pstate,temperature.gpu,power.draw,utilization.gpu,power.limit' +
            ' --format=csv,noheader',
            { encoding: 'utf8', timeout: 10000 }
        );
    } catch {
        showProgress(2, TOTAL, 'GPU情報の取得に失敗', 'error');
        return [];
    }
    showProgress(2, TOTAL, 'GPU情報を取得完了', 'done');

    showProgress(3, TOTAL, 'GPUスペックを解析中');
    const gpus = output.trim().split('\n').map((line, i) => {
        const parts = line.split(',').map(s => s.trim());
        const [name, vram, driver, pstate, temp, power, util, powerLimit] = parts;
        const tflops = estimateTflops(name);
        return {
            index:       i,
            name,
            vram:        parseInt(vram)      || 0,  // MB
            driver,
            pstate,
            temperature: parseInt(temp)      || 0,
            powerDraw:   parseFloat(power)   || 0,
            gpuUtil:     parseInt(util)      || 0,
            powerLimit:  parseFloat(powerLimit) || 0,
            fp32_tflops: tflops,
        };
    });
    showProgress(3, TOTAL, `${gpus.length}個のGPUを検出`, 'done');

    showProgress(4, TOTAL, 'GPU温度をチェック中');
    const maxTemp = Math.max(...gpus.map(g => g.temperature));
    if (maxTemp > 90) {
        showProgress(4, TOTAL, `GPU温度が高すぎます (${maxTemp}°C)`, 'warning');
    } else {
        showProgress(4, TOTAL, `GPU温度 正常 (${maxTemp}°C)`, 'done');
    }

    return gpus;
}

function detectGPUsQuiet() {
    try {
        const out = execSync(
            'nvidia-smi --query-gpu=name,memory.total,temperature.gpu,utilization.gpu,memory.used,power.draw' +
            ' --format=csv,noheader',
            { encoding: 'utf8', timeout: 10000 }
        );
        return out.trim().split('\n').map((line, i) => {
            const [name, vramTotal, temp, util, vramUsed, power] = line.split(',').map(s => s.trim());
            return {
                index:       i,
                name,
                temperature: parseInt(temp)    || 0,
                utilization: parseInt(util)    || 0,
                vram_used:   parseInt(vramUsed) || 0,
                vram_total:  parseInt(vramTotal) || 0,
                power_draw:  parseFloat(power) || 0,
            };
        });
    } catch { return []; }
}

// ── Benchmark Engine ─────────────────────────────────────────
/**
 * THE DOJO 戦闘力測定
 * 4つのカテゴリを計測して benchmark オブジェクトを返す
 */
async function runBenchmark(gpus, platformUrl) {
    console.log('  ┌─ 戦闘力測定を開始します ─────────────────────────┐');
    console.log('');

    const benchmark = {
        fp32_tflops:        0,
        upload_mbps:        0,
        download_mbps:      0,
        rtt_ms:             0,
        storage_read_mbps:  0,
        storage_write_mbps: 0,
        power_w:            0,
        uptime_rate:        100,
    };

    // ─── 1. Computing Power ───────────────────────────────────
    process.stdout.write('  ⚡ [1/4] 算力（TFLOPS）を測定中... ');
    const maxTflops = Math.max(...gpus.map(g => g.fp32_tflops || 0).filter(v => v > 0));
    if (maxTflops > 0) {
        benchmark.fp32_tflops = maxTflops;
        console.log(`${maxTflops.toFixed(1)} TFLOPS ✅`);
    } else {
        // VRAM容量から概算（テーブルにない場合）
        const maxVram = Math.max(...gpus.map(g => g.vram || 0));
        benchmark.fp32_tflops = Math.max((maxVram / 1024) * 3.5, 1);  // 粗い概算
        console.log(`~${benchmark.fp32_tflops.toFixed(1)} TFLOPS (概算) ⚠️`);
    }

    // ─── 2. Network Speed ─────────────────────────────────────
    process.stdout.write('  📡 [2/4] ネットワーク速度を計測中...');
    try {
        // RTT 測定 (5回計測して中央値)
        const rtts = [];
        for (let i = 0; i < 5; i++) {
            const t0 = Date.now();
            await fetch(`${platformUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
            rtts.push(Date.now() - t0);
        }
        rtts.sort((a, b) => a - b);
        benchmark.rtt_ms = rtts[2]; // 中央値

        // Download速度測定 (512KB)
        const dlStart = Date.now();
        const dlResp = await fetch(`${platformUrl}/api/bench/download`, {
            signal: AbortSignal.timeout(10000)
        });
        const dlBuf = await dlResp.arrayBuffer();
        const dlSec = (Date.now() - dlStart) / 1000;
        benchmark.download_mbps = Math.round((dlBuf.byteLength * 8) / dlSec / 1000000 * 10) / 10;

        // Upload速度測定 (512KB)
        const ulPayload = crypto.randomBytes(512 * 1024);
        const ulStart = Date.now();
        await fetch(`${platformUrl}/api/bench/upload`, {
            method: 'POST',
            body: ulPayload,
            headers: { 'Content-Type': 'application/octet-stream' },
            signal: AbortSignal.timeout(10000),
        });
        const ulSec = (Date.now() - ulStart) / 1000;
        benchmark.upload_mbps = Math.round((ulPayload.length * 8) / ulSec / 1000000 * 10) / 10;

        console.log(` RTT:${benchmark.rtt_ms}ms DL:${benchmark.download_mbps}Mbps UL:${benchmark.upload_mbps}Mbps ✅`);
    } catch (err) {
        console.log(` 計測失敗 (${err.message.substring(0, 30)}) ⚠️`);
        benchmark.rtt_ms        = 999;
        benchmark.download_mbps = 0;
        benchmark.upload_mbps   = 0;
    }

    // ─── 3. Storage Performance ───────────────────────────────
    process.stdout.write('  💾 [3/4] ストレージ速度を計測中...');
    try {
        const tmpFile = path.join(os.tmpdir(), `dojo_bench_${Date.now()}.bin`);
        const blockSize = 4 * 1024 * 1024; // 4MB
        const testData  = Buffer.alloc(blockSize, 0xAB);
        const iterations = 5;

        // Write test
        const wStart = Date.now();
        for (let i = 0; i < iterations; i++) {
            fs.writeFileSync(tmpFile, testData);
        }
        const wSec = (Date.now() - wStart) / 1000;
        benchmark.storage_write_mbps = Math.round((blockSize * iterations) / wSec / 1024 / 1024);

        // Read test
        const rStart = Date.now();
        for (let i = 0; i < iterations; i++) {
            fs.readFileSync(tmpFile);
        }
        const rSec = (Date.now() - rStart) / 1000;
        benchmark.storage_read_mbps = Math.round((blockSize * iterations) / rSec / 1024 / 1024);

        // Cleanup
        try { fs.unlinkSync(tmpFile); } catch (_) {}

        console.log(` Write:${benchmark.storage_write_mbps}MB/s Read:${benchmark.storage_read_mbps}MB/s ✅`);
    } catch (err) {
        console.log(` 計測失敗 ⚠️`);
    }

    // ─── 4. Power & Uptime ────────────────────────────────────
    process.stdout.write('  🌡️  [4/4] 電力・システム安定性を確認中...');
    const totalPowerLimit = gpus.reduce((sum, g) => sum + (g.powerLimit || 0), 0);
    benchmark.power_w = totalPowerLimit || gpus.reduce((sum, g) => sum + (g.powerDraw || 0), 0);
    // uptime はシステム起動時間から参照 (初回は100%と仮定)
    const uptimeHours = os.uptime() / 3600;
    benchmark.uptime_rate = uptimeHours > 24 ? 99.5 : 100;  // 24h未満なら要観察
    console.log(` 電力:${benchmark.power_w.toFixed(0)}W, 稼働率:${benchmark.uptime_rate}% ✅`);

    console.log('');
    console.log('  └─ 戦闘力測定完了 ──────────────────────────────────┘');

    return benchmark;
}


// ── API Helpers ───────────────────────────────────────────────
async function apiRequest(url, options = {}) {
    const resp = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        },
        signal: AbortSignal.timeout(15000),
    });
    const data = await resp.json();
    return { ok: resp.ok, status: resp.status, data };
}

// ── Heartbeat ─────────────────────────────────────────────────
function startHeartbeat(platformUrl, token) {
    const INTERVAL_MS = 10000; // 10秒

    async function beat() {
        try {
            const gpuStats = detectGPUsQuiet();

            // RTT計測（1回のみ）
            const t0 = Date.now();
            await fetch(`${platformUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
            const rtt_ms = Date.now() - t0;

            await fetch(`${platformUrl}/api/sf/nodes/heartbeat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                body: JSON.stringify({ gpu_stats: gpuStats, rtt_ms }),
                signal: AbortSignal.timeout(8000),
            });
        } catch (_) { /* 接続が切れてもheartbeatは継続 */ }
    }

    beat(); // 即時1回目
    return setInterval(beat, INTERVAL_MS);
}

// ── SSH Tunnel ────────────────────────────────────────────────
function connectTunnel(io, token) {
    let ioClient;
    try {
        ioClient = require('socket.io-client').io;
    } catch {
        showError(
            '必要なパッケージが不足しています',
            'socket.io-client がインストールされていません。',
            'npm install socket.io-client を実行してください。'
        );
        process.exit(1);
    }

    const socket = ioClient(`${config.platformUrl}/tunnel`, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 3000,
        reconnectionAttempts: Infinity,
    });

    const sshSessions = new Map();

    socket.on('connect', () => {
        socket.emit('tunnel:auth', { token });
    });

    socket.on('tunnel:ready', (data) => {
        showProgress(2, 2, `トンネル開通 (ポート ${data.port})`, 'done');
        console.log('');
        console.log('  ╔═══════════════════════════════════════════════════╗');
        console.log('  ║  🎉 セットアップ完了！待機中                        ║');
        console.log('  ╠═══════════════════════════════════════════════════╣');
        console.log(`  ║  SSH: ssh -p ${data.port} <user>@gpurental.jp      ║`);
        console.log('  ╠═══════════════════════════════════════════════════╣');
        console.log('  ║  ステータス: 🟢 THE DOJO オンライン                ║');
        console.log('  ║  Ctrl+C でエージェントを停止                        ║');
        console.log('  ╚═══════════════════════════════════════════════════╝');
        console.log('');
    });

    socket.on('tunnel:error', (msg) => {
        showProgress(2, 2, 'トンネルエラー', 'error');
        showError('トンネル認証エラー', msg, 'config.json を削除して再実行してください。');
    });

    socket.on('tunnel:new-session', ({ sessionId, remoteAddress }) => {
        console.log(`  📡 SSHセッション: ${sessionId.substring(0, 20)}... from ${remoteAddress}`);
        const sshSocket = net.createConnection({ host: config.sshHost, port: config.sshPort });
        sshSocket.on('connect', () => console.log(`     ✅ ローカルSSH OK (${config.sshHost}:${config.sshPort})`));
        sshSocket.on('data', chunk => socket.emit('tunnel:data', { sessionId, payload: chunk.toString('base64') }));
        sshSocket.on('end', () => { socket.emit('tunnel:session-close', { sessionId }); sshSessions.delete(sessionId); });
        sshSocket.on('error', err => {
            if (err.code === 'ECONNREFUSED') console.log(`     ⚠️  ローカルSSH接続不可`);
            socket.emit('tunnel:session-close', { sessionId });
            sshSessions.delete(sessionId);
        });
        sshSessions.set(sessionId, sshSocket);
    });

    socket.on('tunnel:data', ({ sessionId, payload }) => {
        const s = sshSessions.get(sessionId);
        if (s && !s.destroyed) s.write(Buffer.from(payload, 'base64'));
    });

    socket.on('tunnel:session-close', ({ sessionId }) => {
        const s = sshSessions.get(sessionId);
        if (s && !s.destroyed) s.end();
        sshSessions.delete(sessionId);
    });

    socket.on('disconnect', reason => {
        console.log(`  🔌 切断: ${reason}. 再接続中...`);
        for (const [, s] of sshSessions) { if (!s.destroyed) s.destroy(); }
        sshSessions.clear();
    });

    socket.on('reconnect', attempt => {
        console.log(`  🔗 再接続成功 (試行 ${attempt}回目)`);
        socket.emit('tunnel:auth', { token });
    });

    socket.on('connect_error', err => {
        if (err.message.includes('ECONNREFUSED')) {
            console.log(`  ⚠️  サーバーに接続できません。再試行中...`);
        } else {
            console.log(`  ⚠️  接続エラー: ${err.message.substring(0, 60)}`);
        }
    });

    return socket;
}


// ── Main ──────────────────────────────────────────────────────
async function main() {
    showBanner();

    // ── Step 1: GPU検出 ──────────────────────────────────────
    showStep(1, 5, 'GPU検出');
    const gpus = detectGPUs();
    if (gpus.length === 0) {
        console.log('セットアップを続行できません。GPUの問題を解決してから再実行してください。');
        process.exit(1);
    }

    console.log('');
    console.log('  検出されたGPU:');
    gpus.forEach(g => {
        const tflopsStr = g.fp32_tflops ? `${g.fp32_tflops} TFLOPS` : '(TFLOPS不明)';
        console.log(`  ┌─ GPU #${g.index}: ${g.name} ─────┐`);
        console.log(`  │  VRAM: ${Math.round(g.vram/1024)}GB   算力: ${tflopsStr}`);
        console.log(`  │  温度: ${g.temperature}°C   ドライバー: ${g.driver}`);
        console.log(`  └────────────────────────────────────────┘`);
    });

    // ── Step 2: 戦闘力測定（ベンチマーク）──────────────────────
    showStep(2, 5, '戦闘力測定（THE DOJO ベンチマーク）');
    const benchmark = await runBenchmark(gpus, config.platformUrl);

    // ── Step 3: サーバーへのログイン ────────────────────────────
    showStep(3, 5, 'プラットフォームにログイン');

    if (!config.token) {
        if (!config.email) {
            showError(
                'メールアドレスが設定されていません',
                'GPURentalアカウントのメールアドレスが必要です。',
                '環境変数 AGENT_EMAIL=your@email.com を設定するか、config.json に追記してください。'
            );
            process.exit(1);
        }

        showProgress(1, 2, `アカウント確認中: ${config.email}`);
        const { ok, data } = await apiRequest(`${config.platformUrl}/api/agent/register`, {
            method: 'POST',
            body: JSON.stringify({
                email:        config.email,
                agentVersion: '2.0.0',
                hostname:     os.hostname(),
                gpus,
            }),
        });

        if (!ok || !data.success) {
            showProgress(1, 2, '登録失敗', 'error');
            showError('サーバー登録エラー', data?.error || '不明なエラー', '先に gpurental.jp でアカウントを作成してください。');
            process.exit(1);
        }
        config.token = data.token;
        config.providerId = data.providerId;
        saveConfig();
        showProgress(1, 2, '登録完了', 'done');
        showProgress(2, 2, `ProviderId: ${data.providerId}`, 'done');
    } else {
        showProgress(1, 2, '保存済みトークンを使用', 'done');
        showProgress(2, 2, 'セッション復元完了', 'done');
    }

    // ── Step 4: THE REFEREE に戦闘力を登録 ──────────────────────
    showStep(4, 5, 'THE REFEREE にノードを登録（戦闘力送信）');
    showProgress(1, 2, 'マッチングサーバーへ送信中');

    try {
        const sfPayload = {
            hostname:      os.hostname(),
            agent_version: '2.0.0',
            gpus: gpus.map(g => ({
                index:          g.index,
                name:           g.name,
                vram_mb:        g.vram,
                driver_version: g.driver,
                temperature:    g.temperature,
            })),
            benchmark,
            location:      config.location,
            network_region: config.networkRegion,
        };

        const { ok, data } = await apiRequest(
            `${config.platformUrl}/api/sf/nodes/register`,
            {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${config.token}` },
                body: JSON.stringify(sfPayload),
            }
        );

        if (ok && data.success) {
            config.nodeId = data.node_id;
            saveConfig();
            showProgress(1, 2, `node_id: ${data.node_id}`, 'done');
            showProgress(2, 2, `Fighter Power: ${data.fighter_power}/100`, 'done');
            showFighterCard(gpus, benchmark, data.fighter_power);
        } else {
            showProgress(1, 2, 'THE REFEREE 登録失敗（スキップ）', 'warning');
            console.log(`  ⚠️  ${data?.error || '不明なエラー'}`);
        }
    } catch (err) {
        showProgress(1, 2, `THE REFEREE 接続失敗: ${err.message.substring(0,40)}`, 'warning');
        console.log('  ⚠️  マッチングシステム非対応のサーバーです。従来モードで継続します。');
    }

    // ── Step 5: トンネル接続 + heartbeat ────────────────────────
    showStep(5, 5, 'トンネル接続 + Heartbeat 開始');
    showProgress(1, 2, `${config.platformUrl} に接続中`);

    // heartbeat（10秒ごとにGPU状態 + RTT を報告）
    startHeartbeat(config.platformUrl, config.token);
    console.log('  ✅ Heartbeat 開始 (10秒間隔でTHE REFEREEへ状態送信)');

    // SSH Tunnel
    connectTunnel(null, config.token);
}

// ── Start ─────────────────────────────────────────────────────
main().catch(err => {
    showError(
        '予期しないエラーが発生しました',
        err.message,
        'この問題が続く場合は、サポートにお問い合わせください。'
    );
    process.exit(1);
});
