/**
 * GPU Price Catalog API
 * GET  /api/prices              - public: full price list
 * GET  /api/prices/:model       - public: price for one model
 * POST /api/prices              - admin: upsert price
 * PUT  /api/prices/:model       - admin: update price
 * DELETE /api/prices/:model     - admin: remove custom price (revert to default)
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authMiddleware, adminOnly } = require('../middleware/auth');

// Default catalog (same as pricing.html)
const DEFAULT_CATALOG = [
    // 3000 series
    { model: 'RTX 3060', series: '3000', vram_gb: 12, default_price: 400, tier: 'entry' },
    { model: 'RTX 3070', series: '3000', vram_gb: 8, default_price: 500, tier: 'entry' },
    { model: 'RTX 3070 Ti', series: '3000', vram_gb: 8, default_price: 550, tier: 'entry' },
    { model: 'RTX 3080', series: '3000', vram_gb: 10, default_price: 700, tier: 'mid' },
    { model: 'RTX 3080 Ti', series: '3000', vram_gb: 12, default_price: 750, tier: 'mid' },
    { model: 'RTX 3090', series: '3000', vram_gb: 24, default_price: 900, tier: 'mid' },
    { model: 'RTX 3090 Ti', series: '3000', vram_gb: 24, default_price: 950, tier: 'mid' },
    // 4000 series
    { model: 'RTX 4060', series: '4000', vram_gb: 8, default_price: 450, tier: 'entry' },
    { model: 'RTX 4060 Ti', series: '4000', vram_gb: 16, default_price: 550, tier: 'entry' },
    { model: 'RTX 4070', series: '4000', vram_gb: 12, default_price: 700, tier: 'mid' },
    { model: 'RTX 4070 Ti', series: '4000', vram_gb: 12, default_price: 800, tier: 'mid' },
    { model: 'RTX 4070 Ti Super', series: '4000', vram_gb: 16, default_price: 900, tier: 'mid' },
    { model: 'RTX 4080', series: '4000', vram_gb: 16, default_price: 1050, tier: 'mid' },
    { model: 'RTX 4080 Super', series: '4000', vram_gb: 16, default_price: 1100, tier: 'mid' },
    { model: 'RTX 4090', series: '4000', vram_gb: 24, default_price: 1200, tier: 'pro' },
    // 5000 series
    { model: 'RTX 5070', series: '5000', vram_gb: 12, default_price: 850, tier: 'mid' },
    { model: 'RTX 5070 Ti', series: '5000', vram_gb: 16, default_price: 1000, tier: 'mid' },
    { model: 'RTX 5080', series: '5000', vram_gb: 16, default_price: 1200, tier: 'pro' },
    { model: 'RTX 5090', series: '5000', vram_gb: 32, default_price: 1800, tier: 'pro' },
    // RTX A series
    { model: 'RTX A2000', series: 'rtxa', vram_gb: 12, default_price: 450, tier: 'entry' },
    { model: 'RTX A4000', series: 'rtxa', vram_gb: 16, default_price: 700, tier: 'mid' },
    { model: 'RTX A4500', series: 'rtxa', vram_gb: 20, default_price: 800, tier: 'mid' },
    { model: 'RTX A5000', series: 'rtxa', vram_gb: 24, default_price: 1000, tier: 'pro' },
    { model: 'RTX A6000', series: 'rtxa', vram_gb: 48, default_price: 1600, tier: 'pro' },
    { model: 'RTX A6000 Ada', series: 'rtxa', vram_gb: 48, default_price: 2000, tier: 'hpc' },
    // Datacenter / HPC
    { model: 'Tesla T4', series: 'datacenter', vram_gb: 16, default_price: 600, tier: 'mid' },
    { model: 'A30', series: 'datacenter', vram_gb: 24, default_price: 900, tier: 'mid' },
    { model: 'A100 40GB', series: 'datacenter', vram_gb: 40, default_price: 2500, tier: 'hpc' },
    { model: 'A100 80GB', series: 'datacenter', vram_gb: 80, default_price: 3200, tier: 'hpc' },
    { model: 'H100 SXM5', series: 'datacenter', vram_gb: 80, default_price: 4500, tier: 'hpc' },
    { model: 'H100 PCIe', series: 'datacenter', vram_gb: 80, default_price: 3800, tier: 'hpc' },
    { model: 'H200 SXM5', series: 'datacenter', vram_gb: 141, default_price: 6000, tier: 'hpc' },
    { model: 'L40S', series: 'datacenter', vram_gb: 48, default_price: 1800, tier: 'pro' },
    { model: 'L4', series: 'datacenter', vram_gb: 24, default_price: 800, tier: 'mid' },
];

// Merge defaults with DB overrides
function getMergedPrices(db) {
    const overrides = {};
    try {
        db.prepare('SELECT * FROM gpu_price_catalog').all()
            .forEach(r => { overrides[r.model] = r; });
    } catch { }

    return DEFAULT_CATALOG.map(d => {
        const ov = overrides[d.model];
        return {
            ...d,
            price_per_hour: ov ? ov.price_per_hour : d.default_price,
            is_custom: !!ov,
            enabled: ov ? (ov.enabled !== 0) : true,
            updated_at: ov?.updated_at || null,
        };
    });
}

// GET /api/prices — public
router.get('/', (req, res) => {
    const db = getDb();
    const prices = getMergedPrices(db);
    const { series, tier } = req.query;
    let filtered = prices.filter(p => p.enabled);
    if (series) filtered = filtered.filter(p => p.series === series);
    if (tier) filtered = filtered.filter(p => p.tier === tier);
    res.json(filtered);
});

// GET /api/prices/all — admin: include disabled + custom flag
router.get('/all', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    res.json(getMergedPrices(db));
});

// POST /api/prices — admin: set price for a model
router.post('/', authMiddleware, adminOnly, (req, res) => {
    const { model, price_per_hour, enabled } = req.body;
    if (!model || price_per_hour == null) return res.status(400).json({ error: 'model and price_per_hour required' });
    const db = getDb();
    try {
        db.prepare(`
      INSERT INTO gpu_price_catalog (model, price_per_hour, enabled, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(model) DO UPDATE SET
        price_per_hour = excluded.price_per_hour,
        enabled = excluded.enabled,
        updated_at = CURRENT_TIMESTAMP
    `).run(model, price_per_hour, enabled !== false ? 1 : 0);

        // Also update any gpu_nodes that match this model name
        db.prepare(`UPDATE gpu_nodes SET price_per_hour = ? WHERE name LIKE ?`).run(price_per_hour, `%${model}%`);

        res.json({ success: true, model, price_per_hour });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/prices/:model — admin: revert to default
router.delete('/:model', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM gpu_price_catalog WHERE model = ?').run(req.params.model);
    const def = DEFAULT_CATALOG.find(d => d.model === req.params.model);
    res.json({ success: true, reverted_to: def?.default_price || null });
});

// Export default catalog for seeding
router.get('/catalog/defaults', (req, res) => {
    res.json(DEFAULT_CATALOG);
});

module.exports = { router, DEFAULT_CATALOG };
