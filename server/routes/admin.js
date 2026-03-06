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
  const { status, price_per_hour, temp_threshold } = req.body;
  const updates = []; const params = [];
  if (status !== undefined) { updates.push('status = ?'); params.push(status); }
  if (price_per_hour !== undefined) { updates.push('price_per_hour = ?'); params.push(price_per_hour); }
  if (temp_threshold !== undefined) { updates.push('temp_threshold = ?'); params.push(temp_threshold); }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE gpu_nodes SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

module.exports = router;

