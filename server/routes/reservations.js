const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const { POINT_RATE } = require('../config/plans');
const { mailReservationConfirmed, mailProviderPodStarted } = require('../services/email');

/**
 * ISO8601文字列(タイムゾーン付き・なし両対応)をSQLiteのUTC文字列に変換
 * 例: '2026-03-30T19:00:00+09:00' → '2026-03-30 10:00:00'
 *     '2026-03-30T10:00:00' (UTC) → '2026-03-30 10:00:00'
 */
function toUtcSqlite(isoStr) {
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${isoStr}`);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * DBに保存されたUTC文字列 'YYYY-MM-DD HH:MM:SS' を
 * JSTのローカル文字列 'YYYY-MM-DD HH:MM:SS' に変換して返す。
 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
function utcToJstStr(utcStr) {
  if (!utcStr) return utcStr;
  const d = new Date(utcStr.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return utcStr;
  const jst = new Date(d.getTime() + JST_OFFSET_MS);
  const pad = n => String(n).padStart(2, '0');
  return `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth()+1)}-${pad(jst.getUTCDate())} ` +
         `${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())}`;
}

/** 予約オブジェクトのstart_time/end_timeをUTC→JSTに変換 */
function toJstReservation(r) {
  return { ...r, start_time: utcToJstStr(r.start_time), end_time: utcToJstStr(r.end_time) };
}

// GET /api/reservations - my reservations (or all for admin)
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  let reservations;
  if (req.user.role === 'admin') {
    reservations = db.prepare(`
      SELECT r.*, u.username as renter_name, gn.name as gpu_name, gn.price_per_hour,
             p.id as pod_id
      FROM reservations r
      JOIN users u ON r.renter_id = u.id
      JOIN gpu_nodes gn ON r.gpu_id = gn.id
      LEFT JOIN pods p ON p.reservation_id = r.id AND p.status = 'running'
      ORDER BY r.created_at DESC
    `).all();
  } else {
    reservations = db.prepare(`
      SELECT r.*, gn.name as gpu_name, gn.price_per_hour, gn.location,
             p.id as pod_id
      FROM reservations r
      JOIN gpu_nodes gn ON r.gpu_id = gn.id
      LEFT JOIN pods p ON p.reservation_id = r.id AND p.status = 'running'
      WHERE r.renter_id = ?
      ORDER BY r.created_at DESC
    `).all(req.user.id);
  }
  res.json(reservations.map(toJstReservation));
});

// POST /api/reservations - create new reservation
router.post('/', authMiddleware, (req, res) => {
  const { gpu_id, start_time, end_time, notes, docker_template,
          sf_raid_job_id, sf_match_id } = req.body;
  if (!gpu_id || !start_time || !end_time)
    return res.status(400).json({ error: 'gpu_id, start_time, end_time required' });

  const start = new Date(start_time);
  const end = new Date(end_time);
  if (start >= end) return res.status(400).json({ error: 'end_time must be after start_time' });
  if (start < new Date()) return res.status(400).json({ error: 'Cannot book in the past' });

  const db = getDb();

  // タイムゾーン付き文字列をUTC SQLite形式に正規化
  let startUtc, endUtc;
  try {
    startUtc = toUtcSqlite(start_time);
    endUtc   = toUtcSqlite(end_time);
  } catch (e) {
    return res.status(400).json({ error: '日時の形式が不正です: ' + e.message });
  }

  // Check GPU exists
  const gpu = db.prepare('SELECT * FROM gpu_nodes WHERE id = ? AND status != ?').get(gpu_id, 'maintenance');
  if (!gpu) return res.status(404).json({ error: 'GPU not available' });

  // Check for overlapping reservations (UTC文字列で比較)
  const overlap = db.prepare(`
    SELECT id FROM reservations
    WHERE gpu_id = ?
    AND status NOT IN ('cancelled', 'completed')
    AND NOT (end_time <= ? OR start_time >= ?)
  `).get(gpu_id, startUtc, endUtc);

  if (overlap) return res.status(409).json({ error: 'この時間帯はすでに予約されています' });

  // Calculate total price
  const durationHours = (end - start) / 3600000;
  const total_price = durationHours * gpu.price_per_hour;

  // Validate docker_template
  const { TEMPLATES } = require('../services/dockerTemplates');
  const templateId = (docker_template && TEMPLATES[docker_template]) ? docker_template : 'pytorch';

  // ウォレット残高チェック & デポジット差し引き (トランザクション内)
  const renter = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!renter) return res.status(404).json({ error: 'ユーザーが見つかりません' });

  // デポジット = 予約料金全額をポイントに変換 (pt = POINT_RATE内)
  const depositAmount = Math.ceil(total_price / POINT_RATE);

  if (renter.wallet_balance < depositAmount) {
    return res.status(400).json({
      error: `ポイント残高が不足しています。必要: ${depositAmount}pt / 現在: ${Math.floor(renter.wallet_balance)}pt`,
      required: depositAmount,
      balance: Math.floor(renter.wallet_balance),
    });
  }

  // トランザクション: 予約作成 + デポジット差し引き
  const insertReservation = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO reservations (renter_id, gpu_id, start_time, end_time, status, total_price, notes, docker_template, sf_raid_job_id, sf_match_id)
      VALUES (?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?)
    `).run(req.user.id, gpu_id, startUtc, endUtc, total_price, notes || '', templateId,
           sf_raid_job_id || null, sf_match_id || null);

    // ウォレットとポイント残高の両方からデポジット差し引き
    db.prepare('UPDATE users SET wallet_balance = wallet_balance - ?, point_balance = point_balance - ? WHERE id = ?').run(depositAmount, depositAmount, req.user.id);

    return result;
  });

  const result = insertReservation();

  const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(result.lastInsertRowid);
  const resWithGpu = { ...reservation, gpu_name: gpu.name };

  // 予約確認メールを非同期送信
  const user = db.prepare('SELECT username, email FROM users WHERE id = ?').get(req.user.id);
  if (user?.email) {
    mailReservationConfirmed({ to: user.email, username: user.username, reservation: resWithGpu })
      .catch(e => console.error('Reservation mail error:', e.message));
  }

  res.status(201).json({ ...toJstReservation(resWithGpu), deposit_deducted: depositAmount });
});



// DELETE /api/reservations/:id - cancel
router.delete('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(req.params.id);
  if (!reservation) return res.status(404).json({ error: 'Not found' });
  if (reservation.renter_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Forbidden' });
  if (reservation.status === 'active')
    return res.status(400).json({ error: 'Cannot cancel active session. Stop the pod first.' });
  if (reservation.status === 'cancelled')
    return res.status(400).json({ error: 'Already cancelled' });

  // キャンセル時の返金処理 (confirmedのみ返金)
  let refundAmount = 0;
  const refundableStatuses = ['confirmed', 'pending'];
  if (refundableStatuses.includes(reservation.status)) {
    // デポジット (料金→ポイント変換済み) を返金
    refundAmount = Math.ceil((reservation.total_price || 0) / POINT_RATE);
  }

  const cancelReservation = db.transaction(() => {
    db.prepare("UPDATE reservations SET status = 'cancelled' WHERE id = ?").run(req.params.id);
    if (refundAmount > 0) {
      db.prepare('UPDATE users SET wallet_balance = wallet_balance + ?, point_balance = point_balance + ? WHERE id = ?').run(refundAmount, refundAmount, reservation.renter_id);
    }
  });

  cancelReservation();

  const msg = refundAmount > 0
    ? `予約をキャンセルしました。${refundAmount}pt を返金しました。`
    : '予約をキャンセルしました。';

  res.json({ success: true, refunded: refundAmount, message: msg });
});


// GET /api/reservations/active-pod - get my active pod
router.get('/my/active-pod', authMiddleware, (req, res) => {
  const db = getDb();
  const pod = db.prepare(`
    SELECT p.*, gn.name as gpu_name, gn.device_index, r.start_time, r.end_time,
           r.sf_raid_job_id, r.sf_match_id
    FROM pods p
    JOIN gpu_nodes gn ON p.gpu_id = gn.id
    JOIN reservations r ON p.reservation_id = r.id
    WHERE p.renter_id = ? AND p.status = 'running'
    LIMIT 1
  `).get(req.user.id);
  res.json(pod || null);
});

// POST /api/reservations/:id/start - 手動でPodを即時起動
router.post('/:id/start', authMiddleware, (req, res) => {
  const db = getDb();
  const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(req.params.id);
  if (!reservation) return res.status(404).json({ error: '予約が見つかりません' });
  if (reservation.renter_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Forbidden' });
  if (!['confirmed', 'pending'].includes(reservation.status))
    return res.status(400).json({ error: `この予約はすでに ${reservation.status} 状態です` });

  // 既存の稼働中Podがあればそれを返す
  const existingPod = db.prepare(
    "SELECT * FROM pods WHERE reservation_id = ? AND status = 'running'"
  ).get(reservation.id);
  if (existingPod) {
    return res.json({ success: true, pod: existingPod, alreadyRunning: true });
  }

  try {
    const { createPod } = require('../services/podManager');
    const pod = createPod(reservation.id);

    // プロバイダーへ利用開始メール
    try {
      const gpuInfo = db.prepare(`
        SELECT gn.name as gpu_name, gn.price_per_hour, u.email as provider_email, u.username as provider_name
        FROM gpu_nodes gn JOIN users u ON gn.provider_id = u.id
        WHERE gn.id = ?
      `).get(reservation.gpu_id);
      const renter = db.prepare('SELECT username FROM users WHERE id = ?').get(reservation.renter_id);
      if (gpuInfo?.provider_email) {
        const durationH = (new Date(reservation.end_time) - new Date(reservation.start_time)) / 3600000;
        const earn = Math.round(durationH * gpuInfo.price_per_hour * (parseFloat(process.env.PROVIDER_PAYOUT_RATE) || 0.8));
        mailProviderPodStarted({
          to:           gpuInfo.provider_email,
          providerName: gpuInfo.provider_name,
          renterName:   renter?.username || 'ユーザー',
          gpuName:      gpuInfo.gpu_name,
          startTime:    reservation.start_time,
          endTime:      reservation.end_time,
          earnAmount:   earn,
        }).catch(e => console.error('Provider start mail error:', e.message));
      }
    } catch(mailErr) { console.error('Provider mail lookup error:', mailErr.message); }

    // Socket.IO通知
    try {
      const { io } = require('../index');
      const { getWorkspaceUrl } = require('../services/podManager');
      if (io) {
        const wsUrl = getWorkspaceUrl(pod.id);
        io.to(`user_${pod.renter_id}`).emit('pod:started', {
          podId:         pod.id,
          workspace_url: wsUrl,
          message: 'GPU が利用可能になりました。ワークスペースに接続してください。',
        });
      }
    } catch (_) { /* io が取れなくても続行 */ }

    res.json({ success: true, pod });
  } catch (err) {
    res.status(500).json({ error: 'Pod起動に失敗しました: ' + err.message });
  }
});


// ─── POST /api/reservations/sf-confirm ─────────────────────────────────────
// THE LOBBY が SF Raid Job 確定後、自動的に予約+Pod起動をトリガーするエンドポイント。
// sf_raid_jobs の status を 'dispatched' に更新し、ワークスペース URL を返す。
// Body: { sf_raid_job_id, gpu_id, duration_hours, docker_template }
router.post('/sf-confirm', authMiddleware, async (req, res) => {
    const { sf_raid_job_id, sf_match_id, gpu_id, duration_hours = 1, docker_template = 'pytorch' } = req.body;
    if (!sf_raid_job_id && !sf_match_id) {
        return res.status(400).json({ error: 'sf_raid_job_id または sf_match_id が必要です' });
    }
    if (!gpu_id) return res.status(400).json({ error: 'gpu_id required' });

    const db = getDb();

    // SF ジョブ確認
    let sfJob = null;
    if (sf_raid_job_id) {
        sfJob = db.prepare('SELECT * FROM sf_raid_jobs WHERE id = ? AND user_id = ?').get(sf_raid_job_id, req.user.id);
        if (!sfJob) return res.status(404).json({ error: 'SF レイドジョブが見つかりません' });
        if (!['paid', 'payment_pending'].includes(sfJob.status)) {
            return res.status(400).json({ error: `ジョブのステータス (${sfJob.status}) では確定できません` });
        }
    }

    // GPU 確認
    const gpu = db.prepare("SELECT * FROM gpu_nodes WHERE id = ? AND status != 'maintenance'").get(gpu_id);
    if (!gpu) return res.status(404).json({ error: 'GPU が利用できません' });

    const now      = new Date();
    const endTime  = new Date(now.getTime() + duration_hours * 3600 * 1000);
    const startUtc = toUtcSqlite(now.toISOString());
    const endUtc   = toUtcSqlite(endTime.toISOString());
    const { TEMPLATES } = require('../services/dockerTemplates');
    const templateId = TEMPLATES[docker_template] ? docker_template : 'pytorch';

    const result = db.transaction(() => {
        // 予約作成 (ポイント精算済みのため total_price=0)
        const r = db.prepare(`
            INSERT INTO reservations (renter_id, gpu_id, start_time, end_time, status, total_price, docker_template, sf_raid_job_id, sf_match_id)
            VALUES (?, ?, ?, ?, 'confirmed', 0, ?, ?, ?)
        `).run(req.user.id, gpu_id, startUtc, endUtc, templateId, sf_raid_job_id || null, sf_match_id || null);

        // SF ジョブを dispatched に更新
        if (sf_raid_job_id) {
            db.prepare("UPDATE sf_raid_jobs SET status='dispatched', dispatched_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?")
              .run(sf_raid_job_id);
        }

        return r;
    })();

    const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(result.lastInsertRowid);
    const { getWorkspaceUrl } = require('../services/podManager');

    console.log(`[SF-Confirm] Reservation #${reservation.id} created for SF Job #${sf_raid_job_id || sf_match_id} by user #${req.user.id}`);

    // workspace_url は SF コンテキストパラメータ付き
    const wsUrl = sf_raid_job_id
        ? `/workspace/?pod=pending&raid_job=${sf_raid_job_id}`
        : `/workspace/?pod=pending&match=${sf_match_id}`;

    res.status(201).json({
        success: true,
        reservation_id: reservation.id,
        workspace_url: wsUrl,
        sf_raid_job_id: sf_raid_job_id || null,
        sf_match_id:    sf_match_id    || null,
        message: 'レイドジョブを受付ました。Pod が起動次第ワークスペースへ自動接続されます。',
    });
});

module.exports = router;
