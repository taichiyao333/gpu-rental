const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { getDb } = require('../db/database');
const config = require('../config');

// Cache for current GPU stats
const gpuStatsCache = new Map();

/**
 * Run nvidia-smi and return parsed GPU stats
 */
async function fetchGpuStats() {
    try {
        const query = [
            'index',
            'name',
            'memory.total',
            'memory.used',
            'memory.free',
            'utilization.gpu',
            'utilization.memory',
            'temperature.gpu',
            'power.draw',
            'power.limit',
            'driver_version',
            'pstate',
        ].join(',');

        const { stdout } = await execAsync(
            `nvidia-smi --query-gpu=${query} --format=csv,noheader,nounits`,
            { windowsHide: true }
        );

        const gpus = stdout.trim().split('\n').map((line, index) => {
            const parts = line.split(',').map(s => s.trim());
            return {
                index: parseInt(parts[0]),
                name: parts[1],
                vramTotal: parseInt(parts[2]),
                vramUsed: parseInt(parts[3]),
                vramFree: parseInt(parts[4]),
                gpuUtil: parseFloat(parts[5]) || 0,
                memUtil: parseFloat(parts[6]) || 0,
                temperature: parseFloat(parts[7]) || 0,
                powerDraw: parseFloat(parts[8]) || 0,
                powerLimit: parseFloat(parts[9]) || 0,
                driverVersion: parts[10],
                pstate: parts[11],
            };
        });

        // Update cache
        gpus.forEach(gpu => {
            gpuStatsCache.set(gpu.index, { ...gpu, updatedAt: new Date() });
        });

        return gpus;
    } catch (err) {
        console.error('nvidia-smi error:', err.message);
        return [];
    }
}

/**
 * Get processes running on each GPU
 */
async function fetchGpuProcesses() {
    try {
        const { stdout } = await execAsync(
            'nvidia-smi --query-compute-apps=gpu_index,pid,used_memory,name --format=csv,noheader,nounits',
            { windowsHide: true }
        );
        if (!stdout.trim()) return [];
        return stdout.trim().split('\n').map(line => {
            const p = line.split(',').map(s => s.trim());
            return { gpuIndex: parseInt(p[0]), pid: parseInt(p[1]), memUsed: parseInt(p[2]), name: p[3] };
        });
    } catch {
        return [];
    }
}

/**
 * Get all GPU nodes from DB with real-time stats merged
 * ⚠️ nvidia-smi stats は自機（ローカル）のGPUにのみ適用する
 *    リモートプロバイダーのGPUにはエージェント経由のstatsを使う
 */
function getGpuNodesWithStats() {
    const db = getDb();
    const nodes = db.prepare(`
    SELECT gn.*, u.username as provider_name
    FROM gpu_nodes gn
    JOIN users u ON gn.provider_id = u.id
    ORDER BY gn.id
  `).all();

    return nodes.map(node => {
        const cachedStats = gpuStatsCache.get(node.device_index);
        // ローカルGPU判定: キャッシュにあるGPU名とDBのGPU名が一致する場合のみstatsを適用
        // nvidia-smi は自機GPUのみ返すため、名前が不一致ならリモートGPU
        const isLocal = cachedStats && cachedStats.name === node.name;
        const stats = isLocal ? cachedStats : null;
        return { ...node, stats: stats || null, is_local: !!isLocal };
    });
}


/**
 * Update GPU node status in DB
 */
function updateGpuStatus(gpuId, status) {
    const db = getDb();
    db.prepare('UPDATE gpu_nodes SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?')
        .run(status, gpuId);
}

/**
 * Check temperature alerts
 */
function checkTemperatureAlerts(gpus, io) {
    const db = getDb();
    gpus.forEach(gpu => {
        if (gpu.temperature >= config.gpu.tempAlertThreshold) {
            const node = db.prepare('SELECT id FROM gpu_nodes WHERE device_index = ?').get(gpu.index);
            if (!node) return;

            // Insert alert
            db.prepare(`
        INSERT INTO alerts (type, severity, message, gpu_id)
        VALUES ('temperature', 'critical', ?, ?)
      `).run(`GPU ${gpu.name} temperature ${gpu.temperature}°C exceeds threshold ${config.gpu.tempAlertThreshold}°C`, node.id);

            if (io) {
                io.to('admin').emit('alert:new', {
                    type: 'temperature',
                    severity: 'critical',
                    message: `⚠️ GPU ${gpu.name}: ${gpu.temperature}°C`,
                    gpuIndex: gpu.index,
                });
            }
        }
    });
}

/**
 * Start polling loop
 */
function startGpuMonitor(io) {
    const poll = async () => {
        try {
            const stats = await fetchGpuStats();

            // Broadcast to all connected clients
            if (io && stats.length > 0) {
                io.emit('gpu:stats', stats);
            }

            // Check alerts
            checkTemperatureAlerts(stats, io);

            // Update last_seen in DB
            const db = getDb();
            db.prepare("UPDATE gpu_nodes SET last_seen = CURRENT_TIMESTAMP WHERE location = 'Home PC'").run();

        } catch (err) {
            console.error('GPU monitor error:', err.message);
        }
    };

    poll(); // immediate first run
    const interval = setInterval(poll, config.gpu.pollInterval);
    console.log(`✅ GPU monitor started (every ${config.gpu.pollInterval / 1000}s)`);
    return interval;
}

/**
 * Get cached stats for a specific GPU index
 */
function getCachedStats(deviceIndex) {
    return gpuStatsCache.get(deviceIndex) || null;
}

// ─── GPU Street Fighter: ノード選択 & ディスパッチ ──────────────────────────

/**
 * SF ノード選択: レイドジョブに最適なSFノード群を選ぶ
 * @param {number} requestedCount - 必要ノード数
 * @returns {Array} 選択された sf_nodes レコード配列
 */
function selectSfNodesForRaid(requestedCount = 1) {
    const db = getDb();
    const timeout = config.sf?.nodeHeartbeatTimeout ?? 120000;
    const thresholdSec = Math.floor(timeout / 1000);

    // オンライン・アイドル状態のノードを RTT 昇順、fp32_tflops 降順で選択
    const nodes = db.prepare(`
        SELECT *
        FROM sf_nodes
        WHERE status = 'idle'
          AND last_seen > datetime('now', '-${thresholdSec} seconds')
        ORDER BY rtt_ms ASC, fp32_tflops DESC
        LIMIT ?
    `).all(Math.min(requestedCount, config.sf?.maxRaidNodes ?? 50));

    return nodes;
}

/**
 * SF レイドジョブを MRP Orchestrator に送信する
 * - sf_raid_jobs.status を 'running' に更新
 * - 各ノードに対して MRP Orchestrator へ HTTP リクエスト
 *
 * @param {number} raidJobId - sf_raid_jobs.id
 * @returns {{ dispatched: boolean, nodeCount: number, error?: string }}
 */
async function dispatchSfRaidJob(raidJobId) {
    const db = getDb();
    const job = db.prepare('SELECT * FROM sf_raid_jobs WHERE id = ?').get(raidJobId);

    if (!job) return { dispatched: false, error: 'Job not found' };
    if (!['paid', 'dispatched'].includes(job.status)) {
        return { dispatched: false, error: `Invalid status: ${job.status}` };
    }

    let plan = {};
    try { plan = JSON.parse(job.raid_plan_json); } catch (_) {}
    const requestedNodes = plan.node_count || 1;

    // ノード選択
    const selectedNodes = selectSfNodesForRaid(requestedNodes);
    if (selectedNodes.length === 0) {
        console.warn(`[SF Dispatch] No idle SF nodes available for job #${raidJobId}`);
        return { dispatched: false, error: 'No idle SF nodes available' };
    }

    // ステータスを 'running' に更新
    db.prepare(`
        UPDATE sf_raid_jobs
        SET status = 'running', node_count = ?, mrp_job_ids = ?,
            dispatched_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(selectedNodes.length, JSON.stringify(selectedNodes.map(n => n.id)), raidJobId);

    // ノードをビジー状態に
    const nodeIds = selectedNodes.map(n => n.id);
    nodeIds.forEach(id => {
        db.prepare("UPDATE sf_nodes SET status = 'busy' WHERE id = ?").run(id);
    });

    // MRP Orchestrator への通知 (非同期、失敗しても続行)
    const mrpUrl = config.sf?.mrpOrchestratorUrl;
    if (mrpUrl) {
        const payload = {
            job_id:   raidJobId,
            plan:     plan,
            nodes:    selectedNodes.map(n => ({ id: n.id, hostname: n.hostname, rtt_ms: n.rtt_ms })),
        };
        fetch(`${mrpUrl}/api/sf/dispatch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10000),
        }).then(r => {
            if (r.ok) console.log(`[SF Dispatch] MRP notified for job #${raidJobId} (${selectedNodes.length} nodes)`);
            else      console.warn(`[SF Dispatch] MRP responded ${r.status} for job #${raidJobId}`);
        }).catch(e => {
            console.warn(`[SF Dispatch] MRP unreachable for job #${raidJobId}: ${e.message}`);
        });
    } else {
        // MRP URL 未設定 → シミュレーション完了 (开発環境)
        const simDelay = (plan.est_completion_min ?? 1) * 60 * 1000;
        setTimeout(() => {
            try {
                db.prepare(`
                    UPDATE sf_raid_jobs
                    SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ? AND status = 'running'
                `).run(raidJobId);
                nodeIds.forEach(id => db.prepare("UPDATE sf_nodes SET status = 'idle' WHERE id = ?").run(id));
                console.log(`[SF Simulate] Job #${raidJobId} completed (dev mode, ${simDelay / 1000}s)`);
            } catch (_) {}
        }, Math.min(simDelay, 30000)); // 開発環境では最大30秒でシミュレート完了
    }

    console.log(`[SF Dispatch] Job #${raidJobId} dispatched to ${selectedNodes.length} nodes`);
    return { dispatched: true, nodeCount: selectedNodes.length };
}

/**
 * 支払い済み・未ディスパッチのレイドジョブを自動ディスパッチするウォッチドッグ
 * server/index.js から setInterval で呼び出す
 */
async function watchdogDispatchPaidJobs() {
    const db = getDb();
    let paidJobs;
    try {
        paidJobs = db.prepare("SELECT id FROM sf_raid_jobs WHERE status = 'paid'").all();
    } catch (_) { return; }

    for (const job of paidJobs) {
        try {
            const result = await dispatchSfRaidJob(job.id);
            if (!result.dispatched) {
                console.log(`[SF Watchdog] Job #${job.id} not dispatched: ${result.error}`);
            }
        } catch (e) {
            console.error(`[SF Watchdog] Error dispatching job #${job.id}: ${e.message}`);
        }
    }
}

module.exports = {
    fetchGpuStats,
    fetchGpuProcesses,
    getGpuNodesWithStats,
    updateGpuStatus,
    startGpuMonitor,
    getCachedStats,
    // SF ディスパッチ
    selectSfNodesForRaid,
    dispatchSfRaidJob,
    watchdogDispatchPaidJobs,
};
