const express = require('express');
const router = express.Router();
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { getDb } = require('../db/database');
const config = require('../config');
const { fetchGpuStats } = require('../services/gpuManager');
const { DEFAULT_CATALOG } = require('./prices');

/* ─── GPU Catalog helpers ─────────────────────────────────────────── */
/**
 * nvidia-smi で返ってくる名称と DEFAULT_CATALOG を照合する。
 * 例: "NVIDIA GeForce RTX 4090" -> モデル "RTX 4090" にマッチ
 */
function matchCatalog(smiName, db) {
    // 1) DB にカスタム価格があれば優先
    const customRows = (() => {
        try { return db.prepare('SELECT * FROM gpu_price_catalog WHERE enabled=1').all(); }
        catch { return []; }
    })();

    const allModels = [
        ...customRows.map(r => ({ model: r.model, price_per_hour: r.price_per_hour, source: 'db' })),
        ...DEFAULT_CATALOG.map(d => ({ model: d.model, price_per_hour: d.default_price, source: 'default' })),
    ];

    // nvidia-smi の名称を正規化（NVIDIA / GeForce / NVIDIA GeForce 除去）
    const normalize = (s) => s.toUpperCase()
        .replace(/\bNVIDIA\s+GEFORCE\b/g, '')
        .replace(/\bNVIDIA\b/g, '')
        .replace(/\bGEFORCE\b/g, '')
        .trim();

    const normSmi = normalize(smiName);

    // Step1: 完全一致（正規化後）
    for (const entry of allModels) {
        if (normalize(entry.model) === normSmi) {
            return { ...entry, supported: true };
        }
    }

    // Step2: 部分一致 — 長いモデル名から先にチェック（短い名前の誤マッチ防止）
    const sortedModels = [...allModels].sort((a, b) => b.model.length - a.model.length);
    for (const entry of sortedModels) {
        const m = normalize(entry.model);
        if (normSmi === m || normSmi.includes(m) && m.length >= 5) {
            return { ...entry, supported: true };
        }
    }

    return { model: null, price_per_hour: null, source: null, supported: false };
}


/**
 * GET /api/providers/detect-gpu
 * サーバー側で nvidia-smi を実行し、検出GPUとカタログ照合結果を返す
 */
router.get('/detect-gpu', authMiddleware, async (req, res) => {
    try {
        const gpus = await fetchGpuStats();
        if (!gpus || gpus.length === 0) {
            return res.json({
                success: false,
                error: 'nvidia-smi で GPU が検出されませんでした。NVIDIAドライバがインストールされているか確認してください。',
                gpus: [],
            });
        }
        const db = getDb();
        const result = gpus.map(g => {
            const catalog = matchCatalog(g.name, db);
            return {
                device_index: g.index,
                name: g.name,
                vram_total_mb: g.vramTotal,
                vram_gb: Math.round(g.vramTotal / 1024),
                driver_version: g.driverVersion,
                temperature: g.temperature,
                pstate: g.pstate,
                // catalog match
                supported: catalog.supported,
                matched_model: catalog.model,
                catalog_price: catalog.price_per_hour,
                catalog_source: catalog.source,
                reason: catalog.supported
                    ? null
                    : `"${g.name}" は現在サポートされているGPUリストに含まれていません。`,
            };
        });

        res.json({ success: true, gpus: result, detected_count: result.length });
    } catch (err) {
        res.json({
            success: false,
            error: 'GPU検出に失敗しました: ' + err.message,
            gpus: [],
        });
    }
});


/**
 * GET /api/providers - List all approved GPU providers
 */
router.get('/', (req, res) => {
    const db = getDb();
    const providers = db.prepare(`
    SELECT u.id, u.username, u.created_at,
           COUNT(gn.id) as gpu_count,
           SUM(gn.vram_total) as total_vram,
           COUNT(r.id) as total_rentals
    FROM users u
    JOIN gpu_nodes gn ON gn.provider_id = u.id
    LEFT JOIN reservations r ON r.gpu_id = gn.id AND r.status = 'completed'
    GROUP BY u.id
    ORDER BY gpu_count DESC
  `).all();
    res.json(providers);
});

/**
 * POST /api/providers/register - Register as a GPU provider
 * Any logged-in user can register as provider
 */
router.post('/register', authMiddleware, (req, res) => {
    const { gpu_name, device_index, vram_gb, driver_version, price_per_hour, location } = req.body;

    if (!gpu_name || vram_gb === undefined)
        return res.status(400).json({ error: 'gpu_name and vram_gb are required' });

    const db = getDb();

    // Upgrade user role to provider if not already admin/provider
    if (req.user.role === 'user') {
        db.prepare("UPDATE users SET role = 'provider' WHERE id = ?").run(req.user.id);
    }

    // Register GPU
    const result = db.prepare(`
    INSERT INTO gpu_nodes (provider_id, device_index, name, vram_total, driver_version, price_per_hour, location, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'offline')
  `).run(
        req.user.id,
        device_index ?? 0,
        gpu_name,
        Math.round((vram_gb || 0) * 1024),
        driver_version || '',
        price_per_hour || 500,
        location || 'Home PC'
    );

    const gpu = db.prepare('SELECT * FROM gpu_nodes WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, gpu, message: 'GPUが登録されました。オンラインになると自動で利用可能になります。' });
});

/**
 * GET /api/providers/my-gpus - My registered GPUs + earnings
 */
router.get('/my-gpus', authMiddleware, (req, res) => {
    const db = getDb();
    const gpus = db.prepare(`
    SELECT gn.*,
           COUNT(DISTINCT r.id) as total_reservations,
           COALESCE(SUM(ul.duration_minutes), 0) as total_minutes,
           COALESCE(SUM(ul.provider_payout), 0) as total_earned
    FROM gpu_nodes gn
    LEFT JOIN reservations r ON r.gpu_id = gn.id AND r.status = 'completed'
    LEFT JOIN usage_logs ul ON ul.gpu_id = gn.id
    WHERE gn.provider_id = ?
    GROUP BY gn.id
  `).all(req.user.id);

    const user = db.prepare('SELECT wallet_balance FROM users WHERE id = ?').get(req.user.id);
    res.json({ gpus, wallet_balance: user?.wallet_balance || 0 });
});

/**
 * PATCH /api/providers/gpus/:id - Update my GPU settings
 */
router.patch('/gpus/:id', authMiddleware, (req, res) => {
    const db = getDb();
    const gpu = db.prepare('SELECT * FROM gpu_nodes WHERE id = ? AND provider_id = ?')
        .get(req.params.id, req.user.id);
    if (!gpu) return res.status(404).json({ error: 'GPU not found or not yours' });

    const { price_per_hour, status, location, temp_threshold } = req.body;
    const updates = []; const params = [];
    if (price_per_hour !== undefined) { updates.push('price_per_hour = ?'); params.push(price_per_hour); }
    if (status) { updates.push('status = ?'); params.push(status); }
    if (location) { updates.push('location = ?'); params.push(location); }
    if (temp_threshold) { updates.push('temp_threshold = ?'); params.push(temp_threshold); }

    if (updates.length) {
        params.push(req.params.id);
        db.prepare(`UPDATE gpu_nodes SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }
    res.json({ success: true });
});

/**
 * GET /api/providers/earnings - Detailed earnings breakdown
 */
router.get('/earnings', authMiddleware, (req, res) => {
    const db = getDb();
    const { period = 'monthly' } = req.query;
    const fmt = period === 'daily' ? '%Y-%m-%d' : '%Y-%m';

    const summary = db.prepare(`
    SELECT strftime(?, ul.logged_at) as period,
           gn.name as gpu_name,
           COUNT(*) as sessions,
           COALESCE(SUM(ul.duration_minutes), 0) as total_minutes,
           COALESCE(SUM(ul.cost), 0) as gross_revenue,
           COALESCE(SUM(ul.provider_payout), 0) as net_payout
    FROM usage_logs ul
    JOIN gpu_nodes gn ON ul.gpu_id = gn.id
    WHERE ul.provider_id = ?
    GROUP BY period, gn.id
    ORDER BY period DESC
    LIMIT 60
  `).all(fmt, req.user.id);

    res.json(summary);
});

module.exports = router;
