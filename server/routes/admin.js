const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { getGpuNodesWithStats } = require('../services/gpuManager');
const { getActivePods } = require('../services/podManager');
const { getRecentLogs } = require('../middleware/securityLogger');

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
  // サブクエリ方式: LEFT JOIN二重結合によるデカルト積を解消
  const users = db.prepare(`
    SELECT u.id, u.username, u.email, u.role, u.status, u.wallet_balance, u.point_balance,
           u.created_at, u.last_login,
           (SELECT COUNT(*) FROM reservations r WHERE r.renter_id = u.id) as total_reservations,
           (SELECT COALESCE(SUM(ul.cost), 0) FROM usage_logs ul WHERE ul.renter_id = u.id) as total_spent
    FROM users u
    ORDER BY u.created_at DESC
    LIMIT 500
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

  try {
    // カスケード削除（sql.jsはtransaction未サポートのため個別実行）
    db.prepare("UPDATE pods SET status = 'terminated' WHERE renter_id = ?").run(targetId);
    db.prepare("UPDATE reservations SET status = 'cancelled' WHERE renter_id = ? AND status IN ('confirmed','pending')").run(targetId);
    db.prepare('DELETE FROM usage_logs WHERE renter_id = ?').run(targetId);
    db.prepare('DELETE FROM users WHERE id = ?').run(targetId);

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
  db.prepare('UPDATE users SET point_balance = point_balance + ?, wallet_balance = wallet_balance + ? WHERE id = ?').run(pts, pts, targetId);

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

// ─── Render Jobs 管理 ──────────────────────────────────────────────────────

// GET /api/admin/render-jobs — 全レンダリングジョブ一覧（管理者専用）
router.get('/render-jobs', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const { status, limit = 100 } = req.query;

    let sql = `
        SELECT rj.*,
               u.username AS user_name,
               u.email    AS user_email
        FROM render_jobs rj
        LEFT JOIN users u ON rj.user_id = u.id
        ${status ? "WHERE rj.status = ?" : ""}
        ORDER BY rj.created_at DESC
        LIMIT ?
    `;
    const params = status ? [status, parseInt(limit)] : [parseInt(limit)];
    const jobs = db.prepare(sql).all(...params);

    res.json(jobs.map(j => ({
        ...j,
        output_name: j.output_path ? require('path').basename(j.output_path) : '',
    })));
});

// GET /api/admin/render-jobs/stats — 統計情報
router.get('/render-jobs/stats', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const stats = db.prepare(`
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'running'   THEN 1 ELSE 0 END) AS running,
            SUM(CASE WHEN status = 'done'      THEN 1 ELSE 0 END) AS done,
            SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'queued'    THEN 1 ELSE 0 END) AS queued,
            SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
        FROM render_jobs
    `).get();
    res.json(stats);
});

// GET /api/admin/render-jobs/:id/error — エラーログ取得
router.get('/render-jobs/:id/error', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const job = db.prepare('SELECT id, status, error_log, input_path, output_path, format, ffmpeg_args FROM render_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

// POST /api/admin/render-jobs/:id/cancel — 強制キャンセル（管理者）
router.post('/render-jobs/:id/cancel', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const job = db.prepare('SELECT * FROM render_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // render.js の _procs Map にアクセスするためrequireする
    try {
        const renderRouteModule = require('./render');
        if (renderRouteModule._procs) {
            const live = renderRouteModule._procs.get(parseInt(req.params.id));
            if (live?.proc) {
                live.proc.kill('SIGTERM');
                setTimeout(() => { try { live.proc?.kill('SIGKILL'); } catch (_) { } }, 3000);
            }
            renderRouteModule._procs.delete(parseInt(req.params.id));
        }
    } catch (_) { /* renderモジュール未ロード or _procsが未エクスポートの場合を無視 */ }

    db.prepare("UPDATE render_jobs SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(job.id);

    console.log(`🛑 Admin cancelled render job #${job.id} (user #${job.user_id})`);
    res.json({ success: true, message: `ジョブ #${job.id} をキャンセルしました` });
});


// --- API Key Management (Admin) ---

// GET /api/admin/apikeys — 全ユーザーのAPIキー一覧
router.get('/apikeys', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const keys = db.prepare(
        'SELECT k.id, k.name, k.key_prefix, k.is_active, k.created_at, k.last_used_at,' +
        ' u.id as user_id, u.username, u.email, u.role' +
        ' FROM user_api_keys k' +
        ' JOIN users u ON u.id = k.user_id' +
        ' ORDER BY k.created_at DESC'
    ).all();
    res.json(keys);
});

// PATCH /api/admin/apikeys/:id/toggle — 有効化/無効化
router.patch('/apikeys/:id/toggle', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const key = db.prepare('SELECT * FROM user_api_keys WHERE id = ?').get(parseInt(req.params.id));
    if (!key) return res.status(404).json({ error: 'APIキーが見つかりません' });
    const newState = key.is_active ? 0 : 1;
    db.prepare('UPDATE user_api_keys SET is_active = ? WHERE id = ?').run(newState, key.id);
    res.json({ success: true, is_active: newState === 1 });
});

// DELETE /api/admin/apikeys/:id — 強制削除
router.delete('/apikeys/:id', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const result = db.prepare('DELETE FROM user_api_keys WHERE id = ?').run(parseInt(req.params.id));
    if (result.changes === 0) return res.status(404).json({ error: 'APIキーが見つかりません' });
    res.json({ success: true });
});

// ─── Backup Management ──────────────────────────────────────────────────────

// GET /api/admin/backups — バックアップ一覧
router.get('/backups', authMiddleware, adminOnly, (req, res) => {
    const { listBackups } = require('../services/backup');
    res.json(listBackups());
});

// POST /api/admin/backups/run — 手動バックアップ実行
router.post('/backups/run', authMiddleware, adminOnly, async (req, res) => {
    const { runBackup } = require('../services/backup');
    const result = await runBackup();
    if (result) {
        res.json({ success: true, file: require('path').basename(result.file), size: result.size });
    } else {
        res.status(500).json({ error: 'Backup failed' });
    }
});

// ─── Revenue Stats API (admin dashboard charts) ─────────────────────────────

// GET /api/admin/stats/revenue?days=30 — 日別売上グラフデータ
router.get('/stats/revenue', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const days = Math.min(parseInt(req.query.days) || 30, 365);

    const rows = db.prepare(`
        SELECT
            date(created_at) as date,
            SUM(amount_yen)  as revenue,
            COUNT(*)         as count
        FROM point_purchases
        WHERE status = 'completed'
          AND created_at >= date('now', ? || ' days')
        GROUP BY date(created_at)
        ORDER BY date ASC
    `).all('-' + days);

    // GPU利用収益（usage_logs）
    const usageRows = db.prepare(`
        SELECT
            date(logged_at)   as date,
            SUM(cost)         as gpu_revenue,
            SUM(provider_payout) as payout
        FROM usage_logs
        WHERE logged_at >= date('now', ? || ' days')
        GROUP BY date(logged_at)
        ORDER BY date ASC
    `).all('-' + days);

    res.json({ point_sales: rows, gpu_usage: usageRows, days });
});

// GET /api/admin/stats/users?days=30 — ユーザー登録推移
router.get('/stats/users', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const days = Math.min(parseInt(req.query.days) || 30, 365);

    const rows = db.prepare(`
        SELECT
            date(created_at) as date,
            COUNT(*)         as new_users,
            SUM(CASE WHEN role='provider' THEN 1 ELSE 0 END) as new_providers
        FROM users
        WHERE created_at >= date('now', ? || ' days')
        GROUP BY date(created_at)
        ORDER BY date ASC
    `).all('-' + days);

    res.json({ registrations: rows, days });
});

// GET /api/admin/stats/summary — KPIサマリー
router.get('/stats/summary', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();

    const totalRevenue = db.prepare(`SELECT COALESCE(SUM(amount_yen),0) as v FROM point_purchases WHERE status='completed'`).get().v;
    const monthRevenue = db.prepare(`SELECT COALESCE(SUM(amount_yen),0) as v FROM point_purchases WHERE status='completed' AND created_at >= date('now','-30 days')`).get().v;
    const totalUsers   = db.prepare(`SELECT COUNT(*) as v FROM users WHERE role='user'`).get().v;
    const totalProviders = db.prepare(`SELECT COUNT(*) as v FROM users WHERE role='provider'`).get().v;
    const totalGpus    = db.prepare(`SELECT COUNT(*) as v FROM gpu_nodes`).get().v;
    const activeGpus   = db.prepare(`SELECT COUNT(*) as v FROM gpu_nodes WHERE status='available' OR status='rented'`).get().v;
    const totalSessions = db.prepare(`SELECT COUNT(*) as v FROM usage_logs`).get().v;
    const avgSession   = db.prepare(`SELECT COALESCE(AVG(duration_minutes),0) as v FROM usage_logs`).get().v;
    const totalPayout  = db.prepare(`SELECT COALESCE(SUM(provider_payout),0) as v FROM usage_logs`).get().v;

    res.json({
        revenue: { total: totalRevenue, month: monthRevenue },
        users: { total: totalUsers, providers: totalProviders },
        gpus: { total: totalGpus, active: activeGpus },
        sessions: { total: totalSessions, avg_minutes: Math.round(avgSession) },
        payouts: { total: totalPayout },
    });
});


// ─── Stripe 購入履歴・手動承認 ───────────────────────────────────────────────

// GET /api/admin/purchases?status=pending — 購入履歴一覧
router.get('/purchases', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const { status, limit = 50 } = req.query;
    const safeStatus = (status || '').replace(/[^a-z]/g, '');
    const where = safeStatus ? `WHERE pp.status = '${safeStatus}'` : '';
    const rows = db.prepare(`
        SELECT pp.*, u.username, u.email
        FROM point_purchases pp
        JOIN users u ON pp.user_id = u.id
        ${where}
        ORDER BY pp.created_at DESC
        LIMIT ?
    `).all(parseInt(limit));
    res.json(rows);
});

// POST /api/admin/purchases/:id/approve — pending購入を手動でcompleted（ポイント付与）
router.post('/purchases/:id/approve', authMiddleware, adminOnly, async (req, res) => {
    const db = getDb();
    const purchase = db.prepare('SELECT * FROM point_purchases WHERE id = ?').get(parseInt(req.params.id));
    if (!purchase) return res.status(404).json({ error: '購入レコードが見つかりません' });
    if (purchase.status === 'completed') return res.json({ ok: true, message: '既に付与済みです', already_granted: true });

    // Stripe sessionが存在する場合は検証
    let stripeVerified = false;
    if (purchase.epsilon_order && purchase.epsilon_order.startsWith('cs_')) {
        try {
            const Stripe = require('stripe');
            const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' });
            const session = await stripe.checkout.sessions.retrieve(purchase.epsilon_order);
            stripeVerified = session.payment_status === 'paid';
            if (!stripeVerified && !req.query.force) {
                return res.status(400).json({ error: `Stripeの支払いステータスが paid ではありません (${session.payment_status})。強制付与は ?force=1 で実行できます。` });
            }
        } catch (e) {
            if (!req.query.force) return res.status(400).json({ error: `Stripe検証エラー: ${e.message}。強制付与は ?force=1 で実行できます。` });
        }
    }

    // ポイント付与
    db.prepare("UPDATE point_purchases SET status = 'completed', paid_at = datetime('now') WHERE id = ?")
      .run(purchase.id);
    db.prepare('UPDATE users SET point_balance = point_balance + ?, wallet_balance = wallet_balance + ? WHERE id = ?')
      .run(purchase.points, purchase.points, purchase.user_id);
    db.prepare("INSERT INTO point_logs (user_id, points, type, description, ref_id) VALUES (?, ?, 'purchase', ?, ?)")
      .run(purchase.user_id, purchase.points, `管理者手動承認: ${purchase.plan_name}`, purchase.id);

    const user = db.prepare('SELECT username, email, point_balance FROM users WHERE id = ?').get(purchase.user_id);
    console.log(`✅ [Admin approve] Purchase #${purchase.id} → ${purchase.points}pt → user #${purchase.user_id} (${user?.email}) by admin #${req.user.id}`);

    res.json({
        ok: true,
        points_added: purchase.points,
        user: { id: purchase.user_id, email: user?.email, new_balance: user?.point_balance },
        stripe_verified: stripeVerified,
        forced: !!req.query.force,
    });
});

// POST /api/admin/purchases/bulk-cancel — 全pending購入を一括cancelled
// ⚠️ :id/cancel より前に定義すること（'bulk-cancel'が:idにマッチするのを防ぐ）
router.post('/purchases/bulk-cancel', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const { ids } = req.body; // optional: specific IDs
    let result;
    if (ids && Array.isArray(ids) && ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        result = db.prepare("UPDATE point_purchases SET status = 'cancelled' WHERE id IN (" + placeholders + ") AND status = 'pending'").run(...ids);
    } else {
        result = db.prepare("UPDATE point_purchases SET status = 'cancelled' WHERE status = 'pending'").run();
    }
    console.log('[Admin bulk-cancel] ' + result.changes + ' purchases cancelled by admin #' + req.user.id);
    res.json({ ok: true, cancelled_count: result.changes });
});

// POST /api/admin/purchases/:id/cancel — pending購入をcancelledに変更（ポイント付与なし）
router.post('/purchases/:id/cancel', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const purchase = db.prepare('SELECT * FROM point_purchases WHERE id = ?').get(parseInt(req.params.id));
    if (!purchase) return res.status(404).json({ error: '購入レコードが見つかりません' });
    if (purchase.status !== 'pending') return res.status(400).json({ error: '既に ' + purchase.status + ' です' });

    db.prepare("UPDATE point_purchases SET status = 'cancelled' WHERE id = ?").run(purchase.id);
    console.log('[Admin cancel] Purchase #' + purchase.id + ' cancelled by admin #' + req.user.id);
    res.json({ ok: true, cancelled: purchase.id });
});

// GET /api/admin/security/logs - セキュリティイベントログ（管理者専用）
router.get('/security/logs', authMiddleware, adminOnly, (req, res) => {
    const lines = parseInt(req.query.lines || '200', 10);
    const logs  = getRecentLogs(Math.min(lines, 1000));
    const summary = logs.reduce((acc, log) => {
        acc[log.event] = (acc[log.event] || 0) + 1;
        return acc;
    }, {});
    res.json({ total: logs.length, summary, logs });
});

// ─── ヘルスチェック API ─────────────────────────────────────────────────────

const path = require('path');
const fs   = require('fs');
const HEALTH_LATEST = path.join(__dirname, '../../logs/health/latest.json');

// GET /api/admin/health/latest — 最新ヘルスチェック結果
router.get('/health/latest', authMiddleware, adminOnly, (req, res) => {
    try {
        if (!fs.existsSync(HEALTH_LATEST)) {
            return res.json(null); // まだ一度も実行されていない
        }
        const data = JSON.parse(fs.readFileSync(HEALTH_LATEST, 'utf8'));
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/health/run — ヘルスチェックをその場で実行
router.post('/health/run', authMiddleware, adminOnly, (req, res) => {
    const { execFile } = require('child_process');
    const scriptPath = path.join(__dirname, '../../scripts/health-check.js');

    // バックグラウンドで実行（レスポンスはすぐ返す）
    res.json({ ok: true, message: 'Health check started in background' });

    execFile(process.execPath, [scriptPath], {
        cwd: path.join(__dirname, '../..'),
        timeout: 60000,
        env: { ...process.env },
    }, (err, stdout, stderr) => {
        if (err) console.error('[health/run] Error:', err.message);
        else console.log('[health/run] Done:\n' + stdout.slice(-500));
    });
});

// POST /api/admin/balance-sync — 全ユーザーの残高を再計算して同期
router.post('/balance-sync', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const { POINT_RATE } = require('../config/plans');
    const users = db.prepare('SELECT id, username, point_balance, wallet_balance FROM users').all();
    const results = [];

    const syncBalance = db.transaction(() => {
        for (const u of users) {
            // point_logs は既にポイント単位
            const logsSum = db.prepare('SELECT COALESCE(SUM(points), 0) as total FROM point_logs WHERE user_id = ?').get(u.id);
            // provider_payout は円単位 → ポイントに変換
            const providerEarnings = db.prepare('SELECT COALESCE(SUM(provider_payout), 0) as total FROM usage_logs WHERE provider_id = ?').get(u.id);
            // total_price は円単位 → ポイントに変換
            const activeDeposits = db.prepare("SELECT COALESCE(SUM(total_price), 0) as total FROM reservations WHERE renter_id = ? AND status IN ('active', 'confirmed')").get(u.id);
            // payouts.amount は円単位 → ポイントに変換
            const paidOut = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM payouts WHERE provider_id = ? AND status = 'paid'").get(u.id);

            const correct = (logsSum.total || 0)
                + (providerEarnings.total || 0) / POINT_RATE
                - Math.ceil((activeDeposits.total || 0) / POINT_RATE)
                - (paidOut.total || 0) / POINT_RATE;
            const needsFix = Math.abs(u.point_balance - correct) > 0.01 || Math.abs(u.wallet_balance - correct) > 0.01;

            if (needsFix) {
                db.prepare('UPDATE users SET point_balance = ?, wallet_balance = ? WHERE id = ?').run(correct, correct, u.id);
                results.push({ id: u.id, username: u.username, before: { pt: u.point_balance, wallet: u.wallet_balance }, after: correct });
            }
        }
    });

    syncBalance();
    res.json({ success: true, fixed: results.length, details: results });
});


// ─── GPU Street Fighter — Raid Jobs 管理 (Admin) ───────────────────────────

// GET /api/admin/sf/raid-jobs — レイドジョブ一覧
router.get('/sf/raid-jobs', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const { status, limit = 100 } = req.query;

    // テーブルが存在しない場合は空を返す
    const tableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sf_raid_jobs'"
    ).get();
    if (!tableExists) return res.json({ jobs: [], total: 0 });

    const where = status ? `WHERE rj.status = ?` : '';
    const params = status
        ? [status, parseInt(limit)]
        : [parseInt(limit)];

    const jobs = db.prepare(`
        SELECT
            rj.*,
            u.username  AS user_name,
            u.email     AS user_email
        FROM sf_raid_jobs rj
        LEFT JOIN users u ON rj.user_id = u.id
        ${where}
        ORDER BY rj.created_at DESC
        LIMIT ?
    `).all(...params);

    const total = db.prepare(
        `SELECT COUNT(*) as c FROM sf_raid_jobs ${where ? where.replace('rj.', '') : ''}`
    ).get(status ? [status] : []).c;

    res.json({ jobs, total });
});


// GET /api/admin/sf/raid-jobs/stats — ステータス集計 + 売上
router.get('/sf/raid-jobs/stats', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();

    const tableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sf_raid_jobs'"
    ).get();
    if (!tableExists) {
        return res.json({
            total: 0, paid: 0, dispatched: 0, completed: 0, failed: 0,
            total_revenue_yen: 0, month_revenue_yen: 0,
            avg_nodes: 0, total_tflops_consumed: 0,
        });
    }

    const stats = db.prepare(`
        SELECT
            COUNT(*)                                                     AS total,
            SUM(CASE WHEN status = 'paid'       THEN 1 ELSE 0 END)      AS paid,
            SUM(CASE WHEN status = 'dispatched' THEN 1 ELSE 0 END)      AS dispatched,
            SUM(CASE WHEN status = 'completed'  THEN 1 ELSE 0 END)      AS completed,
            SUM(CASE WHEN status = 'failed'     THEN 1 ELSE 0 END)      AS failed,
            COALESCE(SUM(amount_yen), 0)                                 AS total_revenue_yen,
            COALESCE(SUM(CASE WHEN created_at >= date('now','-30 days')
                               THEN amount_yen ELSE 0 END), 0)           AS month_revenue_yen,
            COALESCE(AVG(
                CAST(json_extract(plan_summary, '$.node_count') AS REAL)
            ), 0)                                                        AS avg_nodes,
            COALESCE(SUM(
                CAST(json_extract(plan_summary, '$.total_tflops') AS REAL)
            ), 0)                                                        AS total_tflops_consumed
        FROM sf_raid_jobs
    `).get();

    // 日別売上 (直近30日)
    const daily = db.prepare(`
        SELECT
            date(created_at) AS date,
            COUNT(*)         AS count,
            SUM(amount_yen)  AS revenue_yen
        FROM sf_raid_jobs
        WHERE status IN ('paid','dispatched','completed')
          AND created_at >= date('now', '-30 days')
        GROUP BY date(created_at)
        ORDER BY date ASC
    `).all();

    res.json({ ...stats, daily });
});


// GET /api/admin/sf/raid-jobs/:id — ジョブ詳細
router.get('/sf/raid-jobs/:id', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const job = db.prepare(`
        SELECT rj.*, u.username AS user_name, u.email AS user_email
        FROM sf_raid_jobs rj
        LEFT JOIN users u ON rj.user_id = u.id
        WHERE rj.id = ?
    `).get(req.params.id);
    if (!job) return res.status(404).json({ error: 'ジョブが見つかりません' });
    res.json(job);
});


// PATCH /api/admin/sf/raid-jobs/:id/status — ステータス手動変更
router.patch('/sf/raid-jobs/:id/status', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const { status, note } = req.body;
    const allowed = ['paid', 'dispatched', 'completed', 'failed', 'refunded'];
    if (!allowed.includes(status)) {
        return res.status(400).json({ error: `status は ${allowed.join(' / ')} のいずれか` });
    }
    db.prepare(`
        UPDATE sf_raid_jobs
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(status, req.params.id);

    console.log(`[Admin] SF RaidJob #${req.params.id} → ${status} by admin #${req.user.id}${note ? ' | ' + note : ''}`);
    res.json({ success: true, id: req.params.id, status });
});


// GET /api/admin/sf/point-logs — ポイント消費ログ
router.get('/sf/point-logs', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const tableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='point_logs'"
    ).get();
    if (!tableExists) return res.json([]);

    const { type, limit = 100 } = req.query;
    const where = type ? `WHERE pl.type = ?` : '';
    const params = type ? [type, parseInt(limit)] : [parseInt(limit)];

    const logs = db.prepare(`
        SELECT
            pl.*,
            u.username AS user_name
        FROM point_logs pl
        LEFT JOIN users u ON pl.user_id = u.id
        ${where}
        ORDER BY pl.created_at DESC
        LIMIT ?
    `).all(...params);

    res.json(logs);
});

// ─── POST /api/admin/sf/raid-jobs/:id/cancel ─────────────────────────────────
// 管理者がレイドジョブを強制キャンセル（ポイント返金付き）
router.post('/sf/raid-jobs/:id/cancel', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const job = db.prepare('SELECT * FROM sf_raid_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'ジョブが見つかりません' });

    const cancelable = ['payment_pending', 'paid', 'dispatched', 'running'];
    if (!cancelable.includes(job.status)) {
        return res.status(400).json({ error: `ステータス ${job.status} のジョブはキャンセルできません` });
    }

    db.prepare(`
        UPDATE sf_raid_jobs SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(job.id);

    // ポイント返金 (points払いの場合)
    if (job.payment_method === 'points' && job.points_used > 0) {
        try {
            db.prepare(`UPDATE users SET point_balance = point_balance + ? WHERE id = ?`)
              .run(job.points_used, job.user_id);
            db.prepare(`
                INSERT INTO point_logs (user_id, type, amount, note, created_at)
                VALUES (?, 'refund', ?, ?, CURRENT_TIMESTAMP)
            `).run(job.user_id, job.points_used, `Admin cancel: SF Raid Job #${job.id}`);
        } catch (_) { /* point_logs テーブルが存在しない場合はスキップ */ }
    }

    console.log(`[Admin] SF RaidJob #${job.id} cancelled by admin #${req.user.id}`);
    res.json({ success: true, id: job.id, status: 'cancelled', refunded_points: job.points_used || 0 });
});

// ─── POST /api/admin/sf/raid-jobs/:id/force-complete ────────────────────────
// 管理者がレイドジョブを強制完了（MRP タイムアウト時の手動対応）
router.post('/sf/raid-jobs/:id/force-complete', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const job = db.prepare('SELECT * FROM sf_raid_jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'ジョブが見つかりません' });

    if (job.status === 'completed') {
        return res.status(400).json({ error: '既に完了済みです' });
    }

    db.prepare(`
        UPDATE sf_raid_jobs
        SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(job.id);

    console.log(`[Admin] SF RaidJob #${job.id} force-completed by admin #${req.user.id}`);
    res.json({ success: true, id: job.id, status: 'completed' });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⚡ THE DOJO: SF ノード管理 API
// ═══════════════════════════════════════════════════════════════════════════

// ─── GET /api/admin/sf/nodes ───────────────────────────────────────────────
// THE DOJO エージェントノード一覧 (ステータス・統計付き)
router.get('/sf/nodes', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    try {
        const nodes = db.prepare(`
            SELECT
                n.*,
                u.username   AS provider_name,
                u.email      AS provider_email,
                CASE
                  WHEN datetime(n.last_seen) > datetime('now', '-120 seconds') THEN 'online'
                  ELSE 'offline'
                END AS heartbeat_status
            FROM sf_nodes n
            LEFT JOIN users u ON n.provider_id = u.id
            ORDER BY n.last_seen DESC
        `).all();

        // サマリー統計
        const total   = nodes.length;
        const online  = nodes.filter(n => n.status === 'idle' || n.status === 'online').length;
        const busy    = nodes.filter(n => n.status === 'busy').length;
        const offline = nodes.filter(n => n.status === 'offline').length;
        const totalTf = nodes.reduce((s, n) => s + (n.fp32_tflops || 0), 0);

        res.json({
            nodes,
            stats: { total, online, busy, offline, total_tflops: Math.round(totalTf * 10) / 10 },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/admin/sf/nodes/:id ──────────────────────────────────────────
router.get('/sf/nodes/:id', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    try {
        const node = db.prepare(`
            SELECT n.*, u.username as provider_name, u.email as provider_email
            FROM sf_nodes n LEFT JOIN users u ON n.provider_id = u.id
            WHERE n.id = ?
        `).get(req.params.id);
        if (!node) return res.status(404).json({ error: 'ノードが見つかりません' });

        // このノードに関連する直近5件のレイドジョブ
        let recentJobs = [];
        try {
            recentJobs = db.prepare(`
                SELECT id, status, node_count, points_used, created_at
                FROM sf_raid_jobs
                WHERE mrp_job_ids LIKE ?
                ORDER BY created_at DESC LIMIT 5
            `).all(`%${node.id}%`);
        } catch (_) {}

        res.json({ ...node, recent_jobs: recentJobs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── PATCH /api/admin/sf/nodes/:id/status ─────────────────────────────────
// ノードステータスを強制変更 (idle / busy / offline / maintenance)
router.patch('/sf/nodes/:id/status', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const { status } = req.body;
    const VALID = ['idle', 'busy', 'offline', 'maintenance'];
    if (!VALID.includes(status)) {
        return res.status(400).json({ error: `ステータスは ${VALID.join('/')} のいずれかを指定してください` });
    }

    const node = db.prepare('SELECT id FROM sf_nodes WHERE id = ?').get(req.params.id);
    if (!node) return res.status(404).json({ error: 'ノードが見つかりません' });

    db.prepare('UPDATE sf_nodes SET status = ? WHERE id = ?').run(status, node.id);
    console.log(`[Admin] SF Node #${node.id} status → ${status} by admin #${req.user.id}`);
    res.json({ success: true, id: node.id, status });
});

// ─── DELETE /api/admin/sf/nodes/:id ───────────────────────────────────────
// ノードレコードを削除 (長期オフライン・不正ノードの整理)
router.delete('/sf/nodes/:id', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    const node = db.prepare('SELECT * FROM sf_nodes WHERE id = ?').get(req.params.id);
    if (!node) return res.status(404).json({ error: 'ノードが見つかりません' });

    if (node.status === 'busy') {
        return res.status(400).json({ error: 'busy状態のノードは削除できません。先にオフラインに変更してください。' });
    }

    db.prepare('DELETE FROM sf_nodes WHERE id = ?').run(node.id);
    console.log(`[Admin] SF Node #${node.id} (${node.hostname}) deleted by admin #${req.user.id}`);
    res.json({ success: true, id: node.id, hostname: node.hostname });
});

// ─── POST /api/admin/sf/nodes/bulk-offline ────────────────────────────────
// heartbeat タイムアウトした全ノードを強制オフライン
router.post('/sf/nodes/bulk-offline', authMiddleware, adminOnly, (req, res) => {
    const db = getDb();
    try {
        const result = db.prepare(`
            UPDATE sf_nodes
            SET status = 'offline'
            WHERE status IN ('idle', 'busy')
              AND (last_seen IS NULL OR datetime(last_seen) < datetime('now', '-120 seconds'))
        `).run();
        console.log(`[Admin] Bulk offline: ${result.changes} SF nodes → offline by admin #${req.user.id}`);
        res.json({ success: true, affected: result.changes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
