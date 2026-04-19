/**
 * GPU Street Fighter (GPU SF) - THE REFEREE API
 * 
 * 格ゲーのマッチングアルゴリズムを用いた分散GPUマッチングシステム
 * 
 * Routes:
 *   POST /api/sf/nodes/register      - THE DOJO エージェント初回登録 + ベンチマーク送信
 *   POST /api/sf/nodes/heartbeat     - 10秒ごとのping + リアルタイムGPU状態更新
 *   POST /api/sf/match               - ジョブ要件を受け取り3つの対戦カードを返す
 *   GET  /api/sf/match/:id           - マッチング結果とステータス確認
 *   POST /api/sf/match/:id/confirm   - カード選択を確定しジョブを開始
 *   POST /api/sf/raid                - レイドバトル: 複数ノードへの分散ジョブ構成を返す
 *   GET  /api/sf/nodes               - 利用可能ノード一覧 (管理者 + 公開情報)
 *   GET  /api/sf/nodes/:id/benchmark - ノードのベンチマーク詳細
 */

const express = require('express');
const { authMiddleware, adminOnly, authOrAgent } = require('../middleware/auth');
const { getDb } = require('../db/database');

/**
 * SF Router Factory
 * io (socket.io Server) を受け取ることでリアルタイム通知が可能になる
 * 使い方: const sfRoutes = require('./routes/sf')(io);
 */
module.exports = function createSfRouter(io) {
const router = express.Router();

// ─────────────────────────────────────────────────────────────
// THE REFEREE: マッチングスコア計算エンジン
// Score = w1(Latency) + w2(Bandwidth) + w3(ComputingPower)
// ─────────────────────────────────────────────────────────────

const MATCH_MODES = {
    speed_star: {
        label: '⚡ Speed Star',
        desc: '低遅延重視 — Omniverse等のリアルタイム編集向き',
        weights: { latency: 0.6, bandwidth: 0.2, compute: 0.2 },
    },
    heavy_weight: {
        label: '💪 Heavy Weight',
        desc: 'スループット重視 — 大容量テクスチャ・一括レンダリング向き',
        weights: { latency: 0.1, bandwidth: 0.7, compute: 0.2 },
    },
    street_fighter: {
        label: '🥊 Street Fighter',
        desc: 'コスト/効率バランス — 納期余裕の大量連番出力向き',
        weights: { latency: 0.2, bandwidth: 0.3, compute: 0.5 },
    },
};

/**
 * ノードのベンチマーク情報からスコアを計算する
 * 各指標は 0.0〜1.0 に正規化してから重み付け
 * 
 * @param {object} node       - sf_nodes row
 * @param {object} benchmark  - sf_benchmarks row
 * @param {object} jobReq     - ジョブ要件 { data_size_gb, realtime, frames }
 * @param {object} weights    - { latency, bandwidth, compute }
 * @returns {number} 0〜100のスコア
 */
function calcScore(node, benchmark, jobReq, weights) {
    if (!benchmark) return 0;

    // --- Latency スコア (低いほど高スコア) ---
    // RTT の最大許容値を 300ms とし、逆数正規化
    const maxRtt = 300;
    const rtt = Math.min(benchmark.rtt_ms || maxRtt, maxRtt);
    const latencyScore = (maxRtt - rtt) / maxRtt;  // 0〜1

    // --- Bandwidth スコア (高いほど高スコア) ---
    // データ転送推定時間 = job_size_gb / (upload_mbps / 8 / 1024) [秒]
    // 目標転送時間を 60秒 として正規化
    const uploadMbps = benchmark.upload_mbps || 1;
    const uploadGbps = uploadMbps / 8 / 1024;  // GB/s
    const dataSizeGb = jobReq.data_size_gb || 1;
    const transferSec = dataSizeGb / uploadGbps;
    const targetSec = 60;
    const bandwidthScore = Math.min(targetSec / Math.max(transferSec, 1), 1);  // 0〜1

    // --- Compute スコア (高いほど高スコア) ---
    // fp32_tflops を最大 100 として正規化
    const maxTflops = 100;
    const tflops = Math.min(benchmark.fp32_tflops || 0, maxTflops);
    const computeScore = tflops / maxTflops;  // 0〜1

    const raw =
        weights.latency  * latencyScore  +
        weights.bandwidth * bandwidthScore +
        weights.compute  * computeScore;

    return Math.round(raw * 100);  // 0〜100
}

/**
 * オンラインノード一覧+ベンチマークから3つの対戦カードを生成
 */
function buildMatchCards(nodes, jobReq) {
    const cards = {};

    for (const [modeKey, mode] of Object.entries(MATCH_MODES)) {
        // 全ノードにスコアを付けてランク付け
        const ranked = nodes
            .map(n => ({
                ...n,
                score: calcScore(n, n.benchmark, jobReq, mode.weights),
            }))
            .filter(n => n.score > 0)
            .sort((a, b) => b.score - a.score);

        cards[modeKey] = {
            mode: modeKey,
            label: mode.label,
            desc: mode.desc,
            weights: mode.weights,
            top_node: ranked[0] || null,   // ベストマッチノード
            runner_ups: ranked.slice(1, 3), // 次点2つ（フォールバック用）
        };
    }

    return cards;
}


// ─────────────────────────────────────────────────────────────
// POST /api/sf/nodes/register
// THE DOJO エージェントの初回登録 + ベンチマーク結果送信
// ─────────────────────────────────────────────────────────────
router.post('/nodes/register', authMiddleware, (req, res) => {
    const db = getDb();
    const {
        hostname,
        agent_version,
        gpus,          // [{ index, name, vram_mb, driver_version, temperature }]
        benchmark,     // { fp32_tflops, upload_mbps, download_mbps, rtt_ms, storage_read_mbps, storage_write_mbps, power_w, uptime_rate }
        location,      // '東京', '大阪', '名古屋' etc.
        network_region, // 'ap-northeast-1' etc. (将来的なP2Pマッチング用)
    } = req.body;

    if (!gpus || !Array.isArray(gpus) || gpus.length === 0) {
        return res.status(400).json({ error: 'gpus array is required' });
    }

    try {
        // --- 1. sf_nodes にupsert ---
        const existingNode = db.prepare(
            'SELECT id FROM sf_nodes WHERE user_id = ?'
        ).get(req.user.id);

        let nodeId;
        if (existingNode) {
            db.prepare(`
                UPDATE sf_nodes SET
                    hostname        = ?,
                    agent_version   = ?,
                    gpu_specs       = ?,
                    location        = ?,
                    network_region  = ?,
                    status          = 'idle',
                    last_seen       = datetime('now')
                WHERE user_id = ?
            `).run(
                hostname,
                agent_version || '2.0.0',
                JSON.stringify(gpus),
                location || 'Unknown',
                network_region || 'ap-northeast-1',
                req.user.id
            );
            nodeId = existingNode.id;
        } else {
            const result = db.prepare(`
                INSERT INTO sf_nodes
                    (user_id, hostname, agent_version, gpu_specs, location, network_region, status, last_seen)
                VALUES (?, ?, ?, ?, ?, ?, 'online', datetime('now'))
            `).run(
                req.user.id,
                hostname,
                agent_version || '2.0.0',
                JSON.stringify(gpus),
                location || 'Unknown',
                network_region || 'ap-northeast-1'
            );
            nodeId = result.lastInsertRowid;
        }

        // --- 2. sf_benchmarks にベンチマーク保存 ---
        if (benchmark) {
            const existingBench = db.prepare(
                'SELECT id FROM sf_benchmarks WHERE node_id = ?'
            ).get(nodeId);

            if (existingBench) {
                db.prepare(`
                    UPDATE sf_benchmarks SET
                        fp32_tflops         = ?,
                        upload_mbps         = ?,
                        download_mbps       = ?,
                        rtt_ms              = ?,
                        storage_read_mbps   = ?,
                        storage_write_mbps  = ?,
                        power_w             = ?,
                        uptime_rate         = ?,
                        measured_at         = datetime('now')
                    WHERE node_id = ?
                `).run(
                    benchmark.fp32_tflops || 0,
                    benchmark.upload_mbps || 0,
                    benchmark.download_mbps || 0,
                    benchmark.rtt_ms || 0,
                    benchmark.storage_read_mbps || 0,
                    benchmark.storage_write_mbps || 0,
                    benchmark.power_w || 0,
                    benchmark.uptime_rate || 100,
                    nodeId
                );
            } else {
                db.prepare(`
                    INSERT INTO sf_benchmarks
                        (node_id, fp32_tflops, upload_mbps, download_mbps, rtt_ms,
                         storage_read_mbps, storage_write_mbps, power_w, uptime_rate, measured_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                `).run(
                    nodeId,
                    benchmark.fp32_tflops || 0,
                    benchmark.upload_mbps || 0,
                    benchmark.download_mbps || 0,
                    benchmark.rtt_ms || 0,
                    benchmark.storage_read_mbps || 0,
                    benchmark.storage_write_mbps || 0,
                    benchmark.power_w || 0,
                    benchmark.uptime_rate || 100
                );
            }
        }

        // --- 3. Fighter Power スコアを計算して返す ---
        const bench = benchmark || {};
        const fighterPower = calcScore(
            { id: nodeId },
            bench,
            { data_size_gb: 5, realtime: false, frames: 300 }, // デフォルトジョブ想定
            { latency: 0.33, bandwidth: 0.33, compute: 0.34 }  // 均等重み
        );

        res.json({
            success: true,
            node_id: nodeId,
            fighter_power: fighterPower,
            message: `THE DOJO 登録完了。戦闘力: ${fighterPower}/100`,
        });

    } catch (err) {
        console.error('[SF] register error:', err);
        res.status(500).json({ error: err.message });
    }
});


// ─────────────────────────────────────────────────────────────
// POST /api/sf/nodes/heartbeat
// 10秒〜60秒ごとのGPU状態 + RTT更新
// ─────────────────────────────────────────────────────────────
router.post('/nodes/heartbeat', authOrAgent, (req, res) => {
    const db = getDb();
    const { gpu_stats, rtt_ms } = req.body;
    // gpu_stats: [{ index, temperature, utilization, vram_used, vram_total, power_draw }]

    try {
        const node = db.prepare('SELECT id FROM sf_nodes WHERE user_id = ?').get(req.user.id);
        if (!node) {
            return res.status(404).json({ error: 'Node not registered. Call /nodes/register first.' });
        }

        db.prepare(`
            UPDATE sf_nodes SET
                gpu_live_stats = ?,
                status         = 'idle',
                last_seen      = datetime('now')
            WHERE id = ?
        `).run(JSON.stringify(gpu_stats || []), node.id);

        // RTT更新（精度向上のため移動平均を取る）
        if (rtt_ms !== undefined) {
            db.prepare(`
                UPDATE sf_benchmarks SET
                    rtt_ms = ROUND((rtt_ms * 0.8 + ? * 0.2), 1)
                WHERE node_id = ?
            `).run(rtt_ms, node.id);
        }

        res.json({ success: true, node_id: node.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ─────────────────────────────────────────────────────────────
// POST /api/sf/match
// ジョブ要件を送信 → THE REFEREE が3つの対戦カードを返す
// ─────────────────────────────────────────────────────────────
router.post('/match', authMiddleware, (req, res) => {
    const db = getDb();
    const {
        data_size_gb = 1,    // 入力データサイズ (GB)
        frames = 1,          // レンダリングフレーム数
        realtime = false,    // リアルタイム編集か否か
        vram_required_gb = 0, // 必要VRAM (GB)
        preferred_mode = null // 'speed_star' | 'heavy_weight' | 'street_fighter' | null
    } = req.body;

    try {
        // オンライン状態のノードを取得 (5分以内にheartbeat)
        const onlineNodes = db.prepare(`
            SELECT
                n.id, n.user_id, n.hostname, n.location, n.network_region,
                n.gpu_specs, n.gpu_live_stats, n.status, n.last_seen,
                u.username as provider_name,
                gn.price_per_hour,
                b.fp32_tflops, b.upload_mbps, b.download_mbps,
                b.rtt_ms, b.storage_read_mbps, b.storage_write_mbps,
                b.power_w, b.uptime_rate, b.measured_at
            FROM sf_nodes n
            JOIN users u ON u.id = n.user_id
            LEFT JOIN gpu_nodes gn ON gn.provider_id = n.user_id AND gn.status = 'available'
            LEFT JOIN sf_benchmarks b ON b.node_id = n.id
            WHERE n.status IN ('online', 'idle')
              AND datetime(n.last_seen) > datetime('now', '-5 minutes')
            ORDER BY b.fp32_tflops DESC
        `).all();

        // VRAM フィルタリング
        const filteredNodes = onlineNodes.filter(n => {
            if (vram_required_gb <= 0) return true;
            try {
                const specs = JSON.parse(n.gpu_specs || '[]');
                const maxVram = Math.max(...specs.map(g => (g.vram_mb || 0) / 1024));
                return maxVram >= vram_required_gb;
            } catch { return true; }
        }).map(n => ({
            ...n,
            benchmark: {
                fp32_tflops: n.fp32_tflops,
                upload_mbps: n.upload_mbps,
                download_mbps: n.download_mbps,
                rtt_ms: n.rtt_ms,
                storage_read_mbps: n.storage_read_mbps,
                storage_write_mbps: n.storage_write_mbps,
                power_w: n.power_w,
                uptime_rate: n.uptime_rate,
            },
            gpu_specs: (() => { try { return JSON.parse(n.gpu_specs); } catch { return []; } })(),
            gpu_live_stats: (() => { try { return JSON.parse(n.gpu_live_stats); } catch { return []; } })(),
        }));

        if (filteredNodes.length === 0) {
            return res.json({
                success: false,
                error: 'オンラインのノードが見つかりません。しばらく待ってから再試行してください。',
                cards: null,
            });
        }

        const jobReq = { data_size_gb, frames, realtime };
        const cards = buildMatchCards(filteredNodes, jobReq);

        // マッチングリクエストをDBに保存
        const result = db.prepare(`
            INSERT INTO sf_match_requests
                (user_id, job_params, cards_json, status, created_at)
            VALUES (?, ?, ?, 'pending', datetime('now'))
        `).run(
            req.user.id,
            JSON.stringify({ data_size_gb, frames, realtime, vram_required_gb }),
            JSON.stringify(cards)
        );

        res.json({
            success: true,
            match_id: result.lastInsertRowid,
            available_nodes: filteredNodes.length,
            cards,
            preferred_mode,
            message: `${filteredNodes.length}個のノードからマッチング候補を生成しました`,
        });

    } catch (err) {
        console.error('[SF] match error:', err);
        res.status(500).json({ error: err.message });
    }
});


// ─────────────────────────────────────────────────────────────
// GET /api/sf/match/:id
// マッチングリクエストの状態確認
// ─────────────────────────────────────────────────────────────
router.get('/match/:id', authMiddleware, (req, res) => {
    const db = getDb();
    try {
        const match = db.prepare(`
            SELECT * FROM sf_match_requests
            WHERE id = ? AND user_id = ?
        `).get(req.params.id, req.user.id);

        if (!match) return res.status(404).json({ error: 'Match not found' });

        res.json({
            ...match,
            job_params: JSON.parse(match.job_params || '{}'),
            cards_json: JSON.parse(match.cards_json || '{}'),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ─────────────────────────────────────────────────────────────
// POST /api/sf/match/:id/confirm
// 3枚のカードから1枚を選択してジョブを確定
// ─────────────────────────────────────────────────────────────
router.post('/match/:id/confirm', authMiddleware, (req, res) => {
    const db = getDb();
    const { selected_mode } = req.body;  // 'speed_star' | 'heavy_weight' | 'street_fighter'

    if (!MATCH_MODES[selected_mode]) {
        return res.status(400).json({
            error: `Invalid mode. Choose from: ${Object.keys(MATCH_MODES).join(', ')}`
        });
    }

    try {
        const match = db.prepare(`
            SELECT * FROM sf_match_requests
            WHERE id = ? AND user_id = ? AND status = 'pending'
        `).get(req.params.id, req.user.id);

        if (!match) return res.status(404).json({ error: 'Match not found or already confirmed' });

        const cards = JSON.parse(match.cards_json || '{}');
        const selectedCard = cards[selected_mode];

        if (!selectedCard || !selectedCard.top_node) {
            return res.status(400).json({ error: `No available node for mode: ${selected_mode}` });
        }

        const selectedNodeId = selectedCard.top_node.id;

        // マッチングリクエストを確定
        db.prepare(`
            UPDATE sf_match_requests SET
                status        = 'confirmed',
                selected_mode = ?,
                selected_node_id = ?,
                confirmed_at  = datetime('now')
            WHERE id = ?
        `).run(selected_mode, selectedNodeId, match.id);

        // 選択されたノードを 'busy' に
        db.prepare(`
            UPDATE sf_nodes SET status = 'busy'
            WHERE id = ?
        `).run(selectedNodeId);
        // ── ポイント決済: 1on1 マッチ ──────────────────────────────
        // 最低1時間分のポイントを消費する (price_per_hour が未設定の場合は無料)
        const pricePerHour = selectedCard.top_node?.price_per_hour || 0;
        const costYen = Math.ceil(pricePerHour); // 1時間単位 (最低料金)
        let pointsCharged = 0;
        let couponApplied = null;

        if (costYen > 0) {
            const { coupon_code } = req.body;
            let finalCost = costYen;

            // クーポン適用
            if (coupon_code) {
                try {
                    const { validateCoupon } = require('./coupons');
                    const cr = validateCoupon(db, coupon_code, req.user.id, costYen);
                    if (cr.ok) {
                        finalCost = Math.max(0, Math.ceil(cr.final_yen));
                        couponApplied = { code: cr.coupon.code, label: cr.label };
                        db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?').run(cr.coupon.id);
                        try { db.prepare('INSERT INTO coupon_uses (coupon_id, user_id, used_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run(cr.coupon.id, req.user.id); } catch (_) {}
                    }
                } catch (_) {}
            }

            // ポイント残高確認
            const user = db.prepare('SELECT point_balance FROM users WHERE id = ?').get(req.user.id);
            if (!user || user.point_balance < finalCost) {
                return res.status(402).json({
                    error: `ポイントが不足しています。必要: ${finalCost}pt / 現在: ${Math.floor(user?.point_balance ?? 0)}pt`,
                    required: finalCost,
                    balance: Math.floor(user?.point_balance ?? 0),
                });
            }

            db.transaction(() => {
                db.prepare('UPDATE users SET point_balance = point_balance - ? WHERE id = ?').run(finalCost, req.user.id);
                try {
                    const note = couponApplied
                        ? `1on1 Match #${match.id} (${selected_mode}) クーポン ${couponApplied.label} 適用`
                        : `1on1 Match #${match.id} (${selected_mode}) ポイント決済`;
                    db.prepare('INSERT INTO point_logs (user_id, type, amount, source, source_id, note, created_at) VALUES (?, \'spend\', ?, \'match\', ?, ?, CURRENT_TIMESTAMP)')
                      .run(req.user.id, finalCost, String(match.id), note);
                } catch (_) {}
            })();

            pointsCharged = finalCost;
            console.log(`[SF Match] Match #${match.id} charged ${finalCost}pt to user #${req.user.id}${couponApplied ? ` (coupon: ${couponApplied.code})` : ''}`);
        }

        // ── WebSocket: マッチング確定通知 ──────────────────────

        if (io) {
            // 1. 選択したユーザーへ個別通知
            io.to(`user_${req.user.id}`).emit('sf:match_confirmed', {
                match_id:      match.id,
                selected_mode,
                mode_label:    MATCH_MODES[selected_mode].label,
                node: {
                    id:       selectedCard.top_node.id,
                    hostname: selectedCard.top_node.hostname,
                    location: selectedCard.top_node.location,
                    score:    selectedCard.top_node.score,
                },
                timestamp: new Date().toISOString(),
                message: `${MATCH_MODES[selected_mode].label} を確定しました。ジョブ開始！`,
            });

            // 2. 管理者チャンネルにもブロードキャスト
            io.to('admin_channel').emit('sf:node_status_changed', {
                node_id: selectedNodeId,
                status:  'busy',
                match_id: match.id,
            });
        }

        res.json({
            success: true,
            match_id: match.id,
            selected_mode,
            selected_node: selectedCard.top_node,
            mode_info: MATCH_MODES[selected_mode],
            payment: {
                points_charged: pointsCharged,
                coupon: couponApplied,
            },
            message: `${MATCH_MODES[selected_mode].label} を選択しました。ジョブを開始します。`,
        });

    } catch (err) {
        console.error('[SF] confirm error:', err);
        res.status(500).json({ error: err.message });
    }
});



// ─────────────────────────────────────────────────────────────
// GET /api/sf/nodes  - 利用可能ノード一覧
// ─────────────────────────────────────────────────────────────
router.get('/nodes', authMiddleware, (req, res) => {
    const db = getDb();
    try {
        const nodes = db.prepare(`
            SELECT
                n.id, n.hostname, n.location, n.status, n.last_seen,
                u.username as provider_name,
                b.fp32_tflops, b.rtt_ms, b.upload_mbps, b.uptime_rate,
                b.measured_at,
                gn.price_per_hour
            FROM sf_nodes n
            JOIN users u ON u.id = n.user_id
            LEFT JOIN sf_benchmarks b ON b.node_id = n.id
            LEFT JOIN gpu_nodes gn ON gn.provider_id = n.user_id AND gn.status = 'available'
            ORDER BY n.status DESC, b.fp32_tflops DESC
        `).all();

        const result = nodes.map(n => ({
            ...n,
            online: n.status === 'online' || n.status === 'busy',
            fighter_power: calcScore(
                n,
                { fp32_tflops: n.fp32_tflops, upload_mbps: n.upload_mbps, rtt_ms: n.rtt_ms },
                { data_size_gb: 5, realtime: false, frames: 300 },
                { latency: 0.33, bandwidth: 0.33, compute: 0.34 }
            ),
        }));

        res.json({ nodes: result, online_count: result.filter(n => n.online).length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ─────────────────────────────────────────────────────────────
// GET /api/sf/nodes/:id/benchmark  - ノードのベンチマーク詳細
// ─────────────────────────────────────────────────────────────
router.get('/nodes/:id/benchmark', authMiddleware, (req, res) => {
    const db = getDb();
    try {
        const bench = db.prepare(`
            SELECT n.hostname, n.location, n.gpu_specs, b.*
            FROM sf_benchmarks b
            JOIN sf_nodes n ON n.id = b.node_id
            WHERE b.node_id = ?
        `).get(req.params.id);

        if (!bench) return res.status(404).json({ error: 'Benchmark not found' });

        res.json({
            ...bench,
            gpu_specs: (() => { try { return JSON.parse(bench.gpu_specs); } catch { return []; } })(),
            fighter_power_by_mode: Object.entries(MATCH_MODES).reduce((acc, [key, mode]) => {
                acc[key] = calcScore(
                    {},
                    bench,
                    { data_size_gb: 5, realtime: key === 'speed_star', frames: 300 },
                    mode.weights
                );
                return acc;
            }, {}),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ─────────────────────────────────────────────────────────────
// POST /api/sf/raid  - レイドバトルモード
// 複数ノードへの分散ジョブ構成を計算して返す
//
// リクエスト:
//   { total_frames, data_size_gb, vram_required_gb, max_nodes }
//
// レスポンス: 各ノードへの担当フレーム範囲 + 推定完了時間
// ─────────────────────────────────────────────────────────────
router.post('/raid', authMiddleware, (req, res) => {
    const db = getDb();
    const {
        total_frames    = 300,
        data_size_gb    = 5,
        vram_required_gb = 0,
        max_nodes       = 5,   // 最大参加ノード数
    } = req.body;

    if (total_frames < 2) {
        return res.status(400).json({ error: 'total_frames must be 2 or more for raid mode' });
    }

    try {
        // オンラインノードを全取得（TFLOPS降順）
        const onlineNodes = db.prepare(`
            SELECT
                n.id, n.user_id, n.hostname, n.location,
                n.gpu_specs, n.status, n.last_seen,
                u.username as provider_name,
                gn.price_per_hour,
                b.fp32_tflops, b.upload_mbps, b.rtt_ms, b.uptime_rate
            FROM sf_nodes n
            JOIN users u ON u.id = n.user_id
            LEFT JOIN gpu_nodes gn ON gn.provider_id = n.user_id AND gn.status = 'available'
            LEFT JOIN sf_benchmarks b ON b.node_id = n.id
            WHERE n.status IN ('online', 'idle')
              AND datetime(n.last_seen) > datetime('now', '-5 minutes')
            ORDER BY b.fp32_tflops DESC
            LIMIT ?
        `).all(max_nodes);

        // VRAM フィルタリング
        const eligible = onlineNodes.filter(n => {
            if (vram_required_gb <= 0) return true;
            try {
                const specs = JSON.parse(n.gpu_specs || '[]');
                const maxVram = Math.max(...specs.map(g => (g.vram_mb || 0) / 1024));
                return maxVram >= vram_required_gb;
            } catch { return true; }
        });

        if (eligible.length < 2) {
            return res.json({
                success: false,
                error: `レイドバトルには2ノード以上が必要です。現在オンライン: ${eligible.length}ノード`,
                raid_plan: null,
            });
        }

        // ── フレーム分割計算 ──
        // 各ノードの「算力」に比例してフレームを割り当てる
        const totalTflops = eligible.reduce((sum, n) => sum + (n.fp32_tflops || 1), 0);

        let frameStart = 1;
        const raidPlan = eligible.map((node, i) => {
            const isLast = i === eligible.length - 1;
            const share = isLast
                ? total_frames - frameStart + 1   // 端数を最後のノードに
                : Math.round(total_frames * ((node.fp32_tflops || 1) / totalTflops));

            const frameEnd = frameStart + share - 1;
            const framePct = Math.round((share / total_frames) * 100);

            // 推定完了時間: フレーム数 / (TFLOPS スケール) → 秒 (粗い概算)
            // ここでは 1 TFLOP s = 1フレーム/秒 として正規化した概算
            const estSeconds = Math.round(share / Math.max(node.fp32_tflops || 1, 0.1));

            const gpuSpecs = (() => { try { return JSON.parse(node.gpu_specs || '[]'); } catch { return []; } })();
            const gpuName = gpuSpecs[0]?.name || node.hostname || '不明';

            const result = {
                node_id:       node.id,
                hostname:      node.hostname,
                location:      node.location,
                provider_name: node.provider_name,
                gpu_name:      gpuName,
                fp32_tflops:   node.fp32_tflops || 0,
                rtt_ms:        node.rtt_ms || 0,
                price_per_hour: node.price_per_hour || 0,
                frame_start:   frameStart,
                frame_end:     frameEnd,
                frame_count:   share,
                frame_pct:     framePct,
                est_seconds:   estSeconds,
                uptime_rate:   node.uptime_rate || 100,
            };

            frameStart = frameEnd + 1;
            return result;
        });

        // 全体推定時間 = 最も遅いノードが完了するまでの時間（並列稼働）
        const maxEstSeconds = Math.max(...raidPlan.map(n => n.est_seconds));
        const totalCost = raidPlan.reduce((sum, n) => sum + (n.price_per_hour * (n.est_seconds / 3600)), 0);

        res.json({
            success: true,
            raid_plan: raidPlan,
            summary: {
                node_count:          eligible.length,
                total_frames,
                est_completion_sec:  maxEstSeconds,
                est_completion_min:  Math.round(maxEstSeconds / 60),
                total_tflops:        Math.round(totalTflops * 10) / 10,
                estimated_cost_yen:  Math.round(totalCost),
                speedup_vs_single:   Math.round((raidPlan.reduce((s, n) => s + n.est_seconds, 0) / maxEstSeconds) * 10) / 10,
            },
            message: `${eligible.length}ノードで分散レンダリング — 推定${Math.round(maxEstSeconds / 60)}分で完了`,
        });

    } catch (err) {
        console.error('[SF] raid error:', err);
        res.status(500).json({ error: err.message });
    }
});



// ─────────────────────────────────────────────────────────────
// POST /api/sf/raid/confirm
// レイドバトルをポイントで決済確定し、各ノードへジョブを配信する
//
// Body:
//   raid_plan_json  : POST /api/sf/raid のレスポンス全体 (JSON文字列)
//   payment_method  : 'points' (現在のみ対応; 将来: 'stripe' | 'epsilon')
//   video_url       : 処理対象ファイルURL (MRP Orchestrator への転送に使用)
//   app_id          : 'real-esrgan' | 'jasmy-upscaler' | etc.
// ─────────────────────────────────────────────────────────────
router.post('/raid/confirm', authMiddleware, (req, res) => {
    const db = getDb();
    const { raid_plan_json, payment_method = 'points', video_url, app_id = 'real-esrgan' } = req.body;

    if (!raid_plan_json) {
        return res.status(400).json({ error: 'raid_plan_json is required' });
    }

    let raidData;
    try {
        raidData = typeof raid_plan_json === 'string' ? JSON.parse(raid_plan_json) : raid_plan_json;
    } catch {
        return res.status(400).json({ error: 'Invalid raid_plan_json format' });
    }

    const summary    = raidData.summary;
    const raidPlan   = raidData.raid_plan;
    const costYen    = Math.round(summary?.estimated_cost_yen ?? 0);
    const POINT_RATE = 1;  // 1ポイント = 1円 (plans.js と同値)

    if (!summary || !Array.isArray(raidPlan) || raidPlan.length === 0) {
        return res.status(400).json({ error: '無効なレイドプランです' });
    }

    try {
        // ─ ユーザー確認 ──────────────────────────────────────────────
        const user = db.prepare(
            'SELECT id, point_balance, email FROM users WHERE id = ?'
        ).get(req.user.id);

        if (!user) return res.status(404).json({ error: 'User not found' });

        // ─ ポイント残高チェック ────────────────────────────────────────
        const pointsNeeded = Math.ceil(costYen / POINT_RATE);

        if (payment_method === 'points') {
            if ((user.point_balance || 0) < pointsNeeded) {
                return res.status(402).json({
                    error:          'ポイント残高が不足しています',
                    required_yen:   costYen,
                    required_points: pointsNeeded,
                    current_points: user.point_balance || 0,
                    shortage_points: pointsNeeded - (user.point_balance || 0),
                    purchase_url:   '/portal/#points',     // ポイント購入ページへ
                });
            }
        } else {
            // 将来: Stripe/GMO Epsilon 対応
            return res.status(422).json({ error: `payment_method '${payment_method}' は現在未対応です。'points' を使用してください。` });
        }

        // ─ トランザクション: ポイント引き落とし + ジョブ登録 ──────────
        const txn = db.transaction(() => {
            // 1. sf_raid_jobs に登録
            const insertRaid = db.prepare(`
                INSERT INTO sf_raid_jobs
                    (user_id, raid_plan_json, summary_json, status, payment_method,
                     payment_amount_yen, points_used, paid_at)
                VALUES (?, ?, ?, 'paid', ?, ?, ?, datetime('now'))
            `);
            const raidResult = insertRaid.run(
                req.user.id,
                JSON.stringify(raidData.raid_plan),
                JSON.stringify(summary),
                payment_method,
                costYen,
                pointsNeeded,
            );
            const raidJobId = raidResult.lastInsertRowid;

            // 2. ポイント引き落とし
            db.prepare(`
                UPDATE users SET point_balance = point_balance - ? WHERE id = ?
            `).run(pointsNeeded, req.user.id);

            // 3. ポイントログ記録
            db.prepare(`
                INSERT INTO point_logs (user_id, type, amount, source, source_id, note)
                VALUES (?, 'spend', ?, 'raid_job', ?, ?)
            `).run(
                req.user.id,
                pointsNeeded,
                String(raidJobId),
                `🔥 RAID BATTLE ${raidJobId} — ${summary.node_count}ノード × ${summary.total_tflops}TFLOPS`,
            );

            // 4. 各ノードをジョブ受信待ちに (busy に)
            for (const node of raidPlan) {
                db.prepare(`
                    UPDATE sf_nodes SET status = 'busy' WHERE id = ?
                `).run(node.node_id || node.id);
            }

            return raidJobId;
        });

        const raidJobId = txn();

        // ─ MRP Orchestrator へのジョブ配信 (非同期/ベストエフォート) ───
        // 実際の配信は非同期バックグラウンドで行うが、ここでは構造を示す
        const mrpJobIds = [];
        const MRP_ORCHESTRATOR = process.env.MRP_ORCHESTRATOR_URL || 'http://localhost:8000/v1';

        if (video_url && MRP_ORCHESTRATOR) {
            // バックグラウンドでジョブ配信 (応答を待たない)
            (async () => {
                const http = require('https');
                const httpModule = MRP_ORCHESTRATOR.startsWith('https') ? http : require('http');

                for (const node of raidPlan) {
                    try {
                        const payload = JSON.stringify({
                            user_id:   String(req.user.id),
                            app_id,
                            video_url,
                            options: {
                                scale:       4,
                                frame_start: node.frame_start,
                                frame_end:   node.frame_end,
                                node_id:     node.node_id || node.id,
                                raid_job_id: raidJobId,
                            },
                            priority: 7,
                        });

                        const reqOptions = {
                            method:  'POST',
                            headers: {
                                'Content-Type':   'application/json',
                                'Content-Length': Buffer.byteLength(payload),
                            },
                        };

                        // 非同期 HTTP POST (エラーは無視)
                        const url = new URL(`${MRP_ORCHESTRATOR}/jobs/submit`);
                        reqOptions.hostname = url.hostname;
                        reqOptions.port     = url.port;
                        reqOptions.path     = url.pathname;

                        const nodeReq = httpModule.request(reqOptions, nodeRes => {
                            let body = '';
                            nodeRes.on('data', d => body += d);
                            nodeRes.on('end', () => {
                                try {
                                    const jobData = JSON.parse(body);
                                    mrpJobIds.push(jobData.job_id);
                                } catch {}
                            });
                        });
                        nodeReq.on('error', err => console.warn(`[SF] MRP dispatch error (node ${node.node_id}):`, err.message));
                        nodeReq.write(payload);
                        nodeReq.end();

                    } catch (e) {
                        console.warn(`[SF] ノード ${node.node_id} へのディスパッチ失敗:`, e.message);
                    }
                }

                // MRP job IDs を記録
                if (mrpJobIds.length > 0) {
                    db.prepare(`UPDATE sf_raid_jobs SET mrp_job_ids = ?, status = 'dispatched', dispatched_at = datetime('now') WHERE id = ?`)
                      .run(JSON.stringify(mrpJobIds), raidJobId);
                }
            })();
        }

        // ─ WebSocket: レイドバトル開始通知 ────────────────────────────
        if (io) {
            io.to(`user_${req.user.id}`).emit('sf:raid_confirmed', {
                raid_job_id:  raidJobId,
                summary,
                payment: {
                    method:         payment_method,
                    amount_yen:     costYen,
                    points_used:    pointsNeeded,
                },
                timestamp: new Date().toISOString(),
                message: `🔥 RAID BATTLE 開始！ ${summary.node_count}ノードへジョブを配信中...`,
            });

            io.to('admin_channel').emit('sf:raid_started', {
                raid_job_id: raidJobId,
                user_id:     req.user.id,
                node_count:  summary.node_count,
                total_yen:   costYen,
            });
        }

        // ─ 領収書レスポンス ──────────────────────────────────────────
        const updatedUser = db.prepare('SELECT point_balance FROM users WHERE id = ?').get(req.user.id);

        res.json({
            success:       true,
            raid_job_id:   raidJobId,
            payment: {
                method:          payment_method,
                amount_yen:      costYen,
                points_used:     pointsNeeded,
                remaining_points: updatedUser?.point_balance ?? 0,
            },
            dispatch: {
                node_count:  raidPlan.length,
                mrp_job_ids: mrpJobIds,
                status:      'dispatched',
            },
            receipt_url: `/api/sf/raid/${raidJobId}/receipt`,
            message: `✅ RAID BATTLE 確定！ ${summary.node_count}ノードへ分散ジョブを配信しました。`,
        });

    } catch (err) {
        console.error('[SF] raid/confirm error:', err);
        res.status(500).json({ error: err.message });
    }
});


// ─────────────────────────────────────────────────────────────
// GET /api/sf/raid/:id/receipt  - レイドジョブ領収書
// ─────────────────────────────────────────────────────────────
router.get('/raid/:id/receipt', authMiddleware, (req, res) => {
    const db  = getDb();
    const job = db.prepare(
        'SELECT * FROM sf_raid_jobs WHERE id = ? AND user_id = ?'
    ).get(req.params.id, req.user.id);

    if (!job) return res.status(404).json({ error: 'Raid job not found' });

    res.json({
        raid_job_id:    job.id,
        status:         job.status,
        payment_method: job.payment_method,
        amount_yen:     job.payment_amount_yen,
        points_used:    job.points_used,
        summary:        JSON.parse(job.summary_json || '{}'),
        mrp_job_ids:    JSON.parse(job.mrp_job_ids || '[]'),
        created_at:     job.created_at,
        paid_at:        job.paid_at,
        dispatched_at:  job.dispatched_at,
    });
});


// ─────────────────────────────────────────────────────────────
// WebSocket: ノード状態変更を全クライアントに通知するヘルパー
// heartbeat エンドポイントから呼び出す
// ─────────────────────────────────────────────────────────────
function emitNodeStatusUpdate(io, node) {
    if (!io) return;
    io.emit('sf:node_heartbeat', {
        node_id:   node.id,
        status:    node.status,
        gpu_load:  node.gpu_load,
        vram_used: node.vram_used,
        rtt_ms:    node.rtt_ms,
        timestamp: new Date().toISOString(),
    });
}

// ─────────────────────────────────────────────────────────────
// GET /api/sf/stats/public — 認証不要の概要統計 (ポータルウィジェット用)
// ─────────────────────────────────────────────────────────────
router.get('/stats/public', (req, res) => {
    const db = getDb();

    // オンラインノード数
    let onlineNodes = 0;
    try {
        const r = db.prepare(
            "SELECT COUNT(*) as c FROM sf_nodes WHERE status IN ('idle','busy') AND last_heartbeat > datetime('now','-2 minutes')"
        ).get();
        onlineNodes = r?.c || 0;
    } catch (_) {}

    // アクティブレイドジョブ数
    let activeRaids = 0;
    let completedToday = 0;
    try {
        const tableExists = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='sf_raid_jobs'"
        ).get();
        if (tableExists) {
            activeRaids = db.prepare(
                "SELECT COUNT(*) as c FROM sf_raid_jobs WHERE status IN ('paid','dispatched')"
            ).get()?.c || 0;
            completedToday = db.prepare(
                "SELECT COUNT(*) as c FROM sf_raid_jobs WHERE status='completed' AND date(updated_at)=date('now')"
            ).get()?.c || 0;
        }
    } catch (_) {}

    res.json({
        online_nodes:    onlineNodes,
        active_raids:    activeRaids,
        completed_today: completedToday,
        generated_at:    new Date().toISOString(),
    });
});

return router;
}; // end createSfRouter

// 後方互換: io なしでも動作するようにデフォルトエクスポート
module.exports.createSfRouter = module.exports;
module.exports.MATCH_MODES = MATCH_MODES;
module.exports.calcScore = calcScore;
