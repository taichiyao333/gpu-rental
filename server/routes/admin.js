const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { getGpuNodesWithStats } = require('../services/gpuManager');
const { getActivePods } = require('../services/podManager');

// GET /api/admin/overview
router.get('/overview', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();

  const activePods = getActivePods().length;
  const totalUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'user'").get().c;
  const waitingGpus = db.prepare("SELECT COUNT(*) as c FROM gpu_nodes WHERE status = 'available'").get().c;
  const todayRevenue = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total FROM usage_logs
    WHERE date(logged_at) = date('now')
  `).get().total;
  const monthRevenue = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total FROM usage_logs
    WHERE strftime('%Y-%m', logged_at) = strftime('%Y-%m', 'now')
  `).get().total;
  const gpuUtilization = activePods > 0
    ? Math.round((activePods / Math.max(1, db.prepare("SELECT COUNT(*) as c FROM gpu_nodes").get().c)) * 100)
    : 0;

  const recentAlerts = db.prepare(`
    SELECT * FROM alerts WHERE resolved = 0 ORDER BY created_at DESC LIMIT 10
  `).all();

  res.json({
    activePods,
    totalUsers,
    waitingGpus,
    todayRevenue,
    monthRevenue,
    gpuUtilization,
    recentAlerts,
    gpus: getGpuNodesWithStats(),
  });
});

// GET /api/admin/users
router.get('/users', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT u.id, u.username, u.email, u.role, u.status, u.wallet_balance,
           u.created_at, u.last_login,
           COUNT(r.id) as total_reservations,
           COALESCE(SUM(ul.cost), 0) as total_spent
    FROM users u
    LEFT JOIN reservations r ON r.renter_id = u.id
    LEFT JOIN usage_logs ul ON ul.renter_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `).all();
  res.json(users);
});

// PATCH /api/admin/users/:id - suspend / activate
router.patch('/users/:id', authMiddleware, adminOnly, (req, res) => {
  const { status } = req.body;
  const db = getDb();
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ success: true });
});

// DELETE /api/admin/users/:id - 強制削除（カスケード）
router.delete('/users/:id', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const targetId = parseInt(req.params.id);

  // 自分自身は削除不可
  if (targetId === req.user.id) {
    return res.status(400).json({ error: '自分自身は削除できません' });
  }

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });

  // 稼働中のポッドがある場合は警告（強制削除フラグがなければ拒否）
  const activePod = db.prepare("SELECT id FROM pods WHERE renter_id = ? AND status = 'running'").get(targetId);
  if (activePod && !req.query.force) {
    return res.status(409).json({
      error: 'このユーザーには稼働中のセッションがあります。force=true で強制削除できます',
      activePod: activePod.id,
    });
  }

  // カスケード削除（トランザクション）
  const deleteUser = db.transaction(() => {
    // ポッドを停止
    db.prepare("UPDATE pods SET status = 'terminated' WHERE renter_id = ?").run(targetId);
    // 予約をキャンセル
    db.prepare("UPDATE reservations SET status = 'cancelled' WHERE renter_id = ? AND status IN ('confirmed','pending')").run(targetId);
    // 使用ログ削除
    db.prepare('DELETE FROM usage_logs WHERE renter_id = ?').run(targetId);
    // ユーザー削除
    db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  });

  try {
    deleteUser();
    console.log(`🗑 User #${targetId} (${target.username}) deleted by admin #${req.user.id}`);
    res.json({ success: true, deleted: { id: targetId, username: target.username } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// GET /api/admin/stats - revenue + usage over time
router.get('/stats', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const { period = 'daily', days = 30 } = req.query;

  const format = period === 'monthly' ? '%Y-%m' : '%Y-%m-%d';
  const stats = db.prepare(`
    SELECT strftime(?, logged_at) as period,
           COUNT(*) as sessions,
           COALESCE(SUM(duration_minutes), 0) as total_minutes,
           COALESCE(SUM(cost), 0) as revenue,
           COALESCE(SUM(provider_payout), 0) as provider_payouts
    FROM usage_logs
    WHERE logged_at >= date('now', ?)
    GROUP BY period
    ORDER BY period
  `).all(format, `-${days} days`);

  res.json(stats);
});

// GET /api/admin/alerts
router.get('/alerts', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const alerts = db.prepare(`
    SELECT a.*, gn.name as gpu_name FROM alerts a
    LEFT JOIN gpu_nodes gn ON a.gpu_id = gn.id
    ORDER BY a.created_at DESC LIMIT 50
  `).all();
  res.json(alerts);
});

// PATCH /api/admin/alerts/:id/resolve
router.patch('/alerts/:id/resolve', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  db.prepare("UPDATE alerts SET resolved = 1, resolved_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// GET /api/admin/payouts — payout requests (from payouts table)
router.get('/payouts', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const payouts = db.prepare(`
    SELECT p.*, u.username as provider_name, u.email
    FROM payouts p
    JOIN users u ON p.provider_id = u.id
    ORDER BY p.created_at DESC LIMIT 100
  `).all();
  res.json(payouts);
});

// POST /api/admin/payouts/:id/paid
router.post('/payouts/:id/paid', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  db.prepare("UPDATE payouts SET status = 'paid' WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// GET /api/admin/pods — all pods
router.get('/pods', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const pods = db.prepare(`
    SELECT p.*, u.username as renter_name, gn.name as gpu_name, gn.price_per_hour
    FROM pods p
    JOIN users u ON p.renter_id = u.id
    JOIN gpu_nodes gn ON p.gpu_id = gn.id
    ORDER BY p.started_at DESC LIMIT 50
  `).all();
  res.json(pods);
});

// GET /api/admin/reservations — all reservations
router.get('/reservations', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const list = db.prepare(`
    SELECT r.*, u.username as renter_name, gn.name as gpu_name
    FROM reservations r
    JOIN users u ON r.renter_id = u.id
    JOIN gpu_nodes gn ON r.gpu_id = gn.id
    ORDER BY r.created_at DESC LIMIT 100
  `).all();
  res.json(list);
});

// POST /api/admin/reservations/:id/confirm
router.post('/reservations/:id/confirm', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  db.prepare("UPDATE reservations SET status = 'confirmed' WHERE id = ? AND status = 'pending'").run(req.params.id);
  res.json({ success: true });
});

// PATCH /api/admin/gpus/:id
router.patch('/gpus/:id', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const { name, vram_total, driver_version, location, status, price_per_hour, temp_threshold } = req.body;
  const updates = []; const params = [];
  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (vram_total !== undefined) { updates.push('vram_total = ?'); params.push(vram_total); }
  if (driver_version !== undefined) { updates.push('driver_version = ?'); params.push(driver_version); }
  if (location !== undefined) { updates.push('location = ?'); params.push(location); }
  if (status !== undefined) { updates.push('status = ?'); params.push(status); }
  if (price_per_hour !== undefined) { updates.push('price_per_hour = ?'); params.push(price_per_hour); }
  if (temp_threshold !== undefined) { updates.push('temp_threshold = ?'); params.push(temp_threshold); }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE gpu_nodes SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

// DELETE /api/admin/gpus/:id — GPUを削除（稼働中Podがあれば拒否）
router.delete('/gpus/:id', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const gpuId = parseInt(req.params.id);

  const gpu = db.prepare('SELECT * FROM gpu_nodes WHERE id = ?').get(gpuId);
  if (!gpu) return res.status(404).json({ error: 'GPUが見つかりません' });

  // 稼働中のPodがある場合は削除不可
  const activePod = db.prepare("SELECT id FROM pods WHERE gpu_id = ? AND status IN ('running','paused')").get(gpuId);
  if (activePod) {
    return res.status(400).json({ error: `稼働中のPod (#${activePod.id}) があるため削除できません。先にPodを停止してください。` });
  }

  // 関連データを削除（カスケード）
  try {
    db.prepare('DELETE FROM alerts      WHERE gpu_id = ?').run(gpuId);
    db.prepare('DELETE FROM pods        WHERE gpu_id = ?').run(gpuId);
    db.prepare('DELETE FROM reservations WHERE gpu_id = ?').run(gpuId);
    db.prepare('DELETE FROM usage_logs  WHERE gpu_id = ?').run(gpuId);
    db.prepare('DELETE FROM gpu_nodes   WHERE id = ?').run(gpuId);
    console.log(`🗑 GPU #${gpuId} (${gpu.name}) deleted by admin #${req.user.id}`);
    res.json({ success: true, deleted: gpuId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ボーナスポイント付与 ────────────────────────────────────────────────────

// POST /api/admin/users/:id/bonus
// 管理者がユーザーへボーナスポイントを付与（マイナスで減算も可能）
router.post('/users/:id/bonus', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const targetId = parseInt(req.params.id);
  const { points, reason } = req.body;

  if (!points || isNaN(points)) return res.status(400).json({ error: 'ポイント数を入力してください' });
  if (points === 0) return res.status(400).json({ error: '0ポイントは付与できません' });
  const pts = parseFloat(points);
  if (Math.abs(pts) > 100000) return res.status(400).json({ error: '一度に付与できる上限は100,000ptです' });

  const target = db.prepare('SELECT id, username, email, point_balance FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });

  // 減算の場合、残高チェック
  if (pts < 0 && (target.point_balance || 0) + pts < 0) {
    return res.status(400).json({ error: `残高不足です（現在: ${target.point_balance || 0}pt）` });
  }

  // bonus_logsテーブルが存在しない場合は作成（マイグレーション対応）
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS bonus_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      admin_id    INTEGER NOT NULL,
      points      REAL NOT NULL,
      reason      TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`);
  } catch (e) { /* exists */ }

  // ポイント残高更新
  db.prepare('UPDATE users SET point_balance = point_balance + ? WHERE id = ?').run(pts, targetId);

  // point_logs に記録
  db.prepare(`INSERT INTO point_logs (user_id, points, type, description, ref_id)
              VALUES (?, ?, 'bonus', ?, ?)`).run(
    targetId, pts,
    reason || (pts > 0 ? '運営からのボーナスポイント' : '運営によるポイント調整'),
    req.user.id  // ref_id = 付与した管理者ID
  );

  // bonus_logs に詳細記録
  db.prepare(`INSERT INTO bonus_logs (user_id, admin_id, points, reason)
              VALUES (?, ?, ?, ?)`).run(targetId, req.user.id, pts, reason || '');

  const newBalance = (target.point_balance || 0) + pts;
  console.log(`🎁 Bonus ${pts}pt → User #${targetId} (${target.username}) by Admin #${req.user.id} | Reason: ${reason}`);

  res.json({
    success: true,
    target_user: { id: targetId, username: target.username },
    points_granted: pts,
    new_balance: newBalance,
    message: `${target.username} さんへ ${pts > 0 ? '+' : ''}${pts}pt を付与しました`,
  });
});

// GET /api/admin/bonus-logs
// ボーナス付与履歴一覧
router.get('/bonus-logs', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();

  // テーブルが存在しない場合は空を返す
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS bonus_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      admin_id INTEGER NOT NULL,
      points REAL NOT NULL,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`);
  } catch (e) { /* exists */ }

  const logs = db.prepare(`
    SELECT bl.*,
           u.username  as target_username,
           u.email     as target_email,
           a.username  as admin_username
    FROM bonus_logs bl
    LEFT JOIN users u ON bl.user_id  = u.id
    LEFT JOIN users a ON bl.admin_id = a.id
    ORDER BY bl.created_at DESC
    LIMIT 200
  `).all();

  res.json(logs);
});

// ─── Maintenance Mode ──────────────────────────────────────────────────────
// GET  /api/admin/maintenance        → { enabled: bool, message: string }
// POST /api/admin/maintenance        → { enabled: bool, message: string }

// GET /api/admin/maintenance
router.get('/maintenance', authMiddleware, adminOnly, (req, res) => {
  res.json({
    enabled: global.maintenanceMode?.enabled ?? false,
    message: global.maintenanceMode?.message ?? 'ただいまメンテナンス中です。しばらくお待ちください。',
    updated_at: global.maintenanceMode?.updated_at ?? null,
    updated_by: global.maintenanceMode?.updated_by ?? null,
  });
});

// POST /api/admin/maintenance
router.post('/maintenance', authMiddleware, adminOnly, (req, res) => {
  const { enabled, message } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled (boolean) is required' });
  }
  global.maintenanceMode = {
    enabled,
    message: message || 'ただいまメンテナンス中です。しばらくお待ちください。',
    updated_at: new Date().toISOString(),
    updated_by: req.user?.username || req.user?.email,
  };
  console.log(`🔧 Maintenance mode ${enabled ? 'ENABLED' : 'DISABLED'} by ${req.user?.email}`);
  res.json({ success: true, ...global.maintenanceMode });
});


// ─── RunPod 価格比較 API ────────────────────────────────────────────────────

// GET /api/admin/pricing/compare
router.get('/pricing/compare', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const snapshots = db.prepare('SELECT * FROM runpod_pricing_snapshots ORDER BY vram_gb ASC').all();
    const current   = db.prepare('SELECT * FROM gpu_price_catalog').all();
    const comparisons = snapshots.map(s => {
        const cur = current.find(c =>
            c.model.toLowerCase().includes(s.gpu_name.split(' ').pop().toLowerCase())
        );
        return {
            ...s,
            gpurental_price: cur?.price_per_hour || null,
            gpurental_model: cur?.model || null,
            diff_jpy: cur ? cur.price_per_hour - s.runpod_price_jpy : null,
            is_competitive: cur ? cur.price_per_hour <= s.runpod_price_jpy * 1.2 : null,
        };
    });
    res.json({ last_fetched: snapshots[0]?.fetched_at || null, count: snapshots.length, comparisons, needs_review: comparisons.filter(c => c.is_competitive === false) });
});

// POST /api/admin/pricing/fetch - RunPod価格を手動取得
router.post('/pricing/fetch', authMiddleware, adminOnly, async (req, res) => {
    try {
        const { runPricingSnapshot } = require('../services/pricingMonitor');
        const result = await runPricingSnapshot(getDb());
        res.json({ success: true, ...result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/pricing/apply - 推奨価格を適用
router.post('/pricing/apply', authMiddleware, adminOnly, (req, res) => {
    const { gpu_name, price_jpy } = req.body;
    if (!gpu_name || !price_jpy) return res.status(400).json({ error: 'gpu_name と price_jpy が必要です' });
    const db = getDb();
    const result = db.prepare(`UPDATE gpu_price_catalog SET price_per_hour = ?, updated_at = CURRENT_TIMESTAMP WHERE model LIKE ?`).run(parseInt(price_jpy), `%${gpu_name.split(' ').pop()}%`);
    res.json({ success: true, changes: result.changes });
});

// GET /api/admin/coupons/stats
router.get('/coupons/stats', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    res.json({
        total_coupons:      db.prepare('SELECT COUNT(*) as c FROM coupons').get().c,
        active_coupons:     db.prepare('SELECT COUNT(*) as c FROM coupons WHERE is_active = 1').get().c,
        total_uses:         db.prepare('SELECT COUNT(*) as c FROM coupon_uses').get().c,
        total_discount_yen: db.prepare('SELECT COALESCE(SUM(discount_yen),0) as s FROM coupon_uses').get().s,
        recent_uses: db.prepare(`SELECT cu.*, u.username, c.code FROM coupon_uses cu JOIN users u ON u.id = cu.user_id JOIN coupons c ON c.id = cu.coupon_id ORDER BY cu.used_at DESC LIMIT 20`).all(),
    });
});

module.exports = router;
