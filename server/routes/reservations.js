const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const { POINT_RATE } = require('../config/plans');
const { mailReservationConfirmed, mailProviderPodStarted } = require('../services/email');

/**
 * ISO8601譁・ｭ怜・・医ち繧､繝繧ｾ繝ｼ繝ｳ莉倥″繝ｻ縺ｪ縺嶺ｸ｡蟇ｾ蠢懶ｼ峨ｒSQLite莠呈鋤縺ｮUTC譁・ｭ怜・縺ｫ螟画鋤
 * 萓・ '2026-03-30T19:00:00+09:00' 竊・'2026-03-30 10:00:00'
 *     '2026-03-30T10:00:00' (UTC) 竊・'2026-03-30 10:00:00'
 */
function toUtcSqlite(isoStr) {
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${isoStr}`);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * DB縺ｫ菫晏ｭ倥＆繧後◆UTC譁・ｭ怜・ 'YYYY-MM-DD HH:MM:SS' 繧・
 * JST縺ｮ繝ｭ繝ｼ繧ｫ繝ｫ譁・ｭ怜・ 'YYYY-MM-DD HH:MM:SS' 縺ｫ螟画鋤縺励※霑斐☆縲・
 * 繝輔Ο繝ｳ繝医お繝ｳ繝峨・ new Date('YYYY-MM-DD HH:MM:SS') 縺ｯ繝ｭ繝ｼ繧ｫ繝ｫ譎ょ綾縺ｨ縺励※隗｣驥医☆繧九◆繧√・
 * 縺薙・螟画鋤縺ｧJST譎ょ綾繧呈ｭ｣縺励￥陦ｨ遉ｺ繝ｻ蛻ｩ逕ｨ縺ｧ縺阪ｋ繧医≧縺ｫ縺吶ｋ縲・
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

/** 莠育ｴ・が繝悶ず繧ｧ繧ｯ繝医・start_time/end_time繧旦TC竊谷ST縺ｫ螟画鋤 */
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
  // UTC竊谷ST縺ｫ螟画鋤縺励※繝輔Ο繝ｳ繝医′豁｣縺励￥陦ｨ遉ｺ縺ｧ縺阪ｋ繧医≧縺ｫ縺吶ｋ
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

  // 繧ｿ繧､繝繧ｾ繝ｼ繝ｳ莉倥″譁・ｭ怜・繧旦TC SQLite蠖｢蠑上↓豁｣隕丞喧・・QLite縺ｮdatetime()縺ｯTZ offset繧呈ｭ｣縺励￥謇ｱ縺医↑縺・ｼ・
  let startUtc, endUtc;
  try {
    startUtc = toUtcSqlite(start_time);
    endUtc   = toUtcSqlite(end_time);
  } catch (e) {
    return res.status(400).json({ error: '譌･譎ゅ・蠖｢蠑上′荳肴ｭ｣縺ｧ縺・ ' + e.message });
  }

  // Check GPU exists
  const gpu = db.prepare('SELECT * FROM gpu_nodes WHERE id = ? AND status != ?').get(gpu_id, 'maintenance');
  if (!gpu) return res.status(404).json({ error: 'GPU not available' });

  // Check for overlapping reservations・・TC譁・ｭ怜・縺ｧ豈碑ｼ・ｼ・
  const overlap = db.prepare(`
    SELECT id FROM reservations
    WHERE gpu_id = ?
    AND status NOT IN ('cancelled', 'completed')
    AND NOT (end_time <= ? OR start_time >= ?)
  `).get(gpu_id, startUtc, endUtc);

  if (overlap) return res.status(409).json({ error: '縺薙・譎る俣蟶ｯ縺ｯ縺吶〒縺ｫ莠育ｴ・＆繧後※縺・∪縺・ });

  // Calculate total price
  const durationHours = (end - start) / 3600000;
  const total_price = durationHours * gpu.price_per_hour;

  // Validate docker_template
  const { TEMPLATES } = require('../services/dockerTemplates');
  const templateId = (docker_template && TEMPLATES[docker_template]) ? docker_template : 'pytorch';

  // 笏笏 繧ｦ繧ｩ繝ｬ繝・ヨ谿矩ｫ倥メ繧ｧ繝・け & 繝・・繧ｸ繝・ヨ蠑輔″關ｽ縺ｨ縺暦ｼ医ヨ繝ｩ繝ｳ繧ｶ繧ｯ繧ｷ繝ｧ繝ｳ蜀・ｼ俄楳笏笏笏笏
  const renter = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!renter) return res.status(404).json({ error: '繝ｦ繝ｼ繧ｶ繝ｼ縺瑚ｦ九▽縺九ｊ縺ｾ縺帙ｓ' });

  // 繝・・繧ｸ繝・ヨ = 莠育ｴ・ｷ城｡・蜀・繧偵・繧､繝ｳ繝医↓螟画鋤・・pt = POINT_RATE蜀・ｼ・
  const depositAmount = Math.ceil(total_price / POINT_RATE); // 蜀・・繝昴う繝ｳ繝亥､画鋤

  if (renter.wallet_balance < depositAmount) {
    return res.status(400).json({
      error: `繝昴う繝ｳ繝域ｮ矩ｫ倥′荳崎ｶｳ縺励※縺・∪縺吶ょｿ・ｦ・ ${depositAmount}pt / 迴ｾ蝨ｨ: ${Math.floor(renter.wallet_balance)}pt`,
      required: depositAmount,
      balance: Math.floor(renter.wallet_balance),
    });
  }

  // 繝医Λ繝ｳ繧ｶ繧ｯ繧ｷ繝ｧ繝ｳ: 莠育ｴ・ｽ懈・ + 繝・・繧ｸ繝・ヨ蠑輔″關ｽ縺ｨ縺・
  const insertReservation = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO reservations (renter_id, gpu_id, start_time, end_time, status, total_price, notes, docker_template, sf_raid_job_id, sf_match_id)
      VALUES (?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?)
    `).run(req.user.id, gpu_id, startUtc, endUtc, total_price, notes || '', templateId,
           sf_raid_job_id || null, sf_match_id || null);

    // 繧ｦ繧ｩ繝ｬ繝・ヨ縺ｨ繝昴う繝ｳ繝域ｮ矩ｫ倥・荳｡譁ｹ縺九ｉ繝・・繧ｸ繝・ヨ蟾ｮ縺怜ｼ輔″
    db.prepare('UPDATE users SET wallet_balance = wallet_balance - ?, point_balance = point_balance - ? WHERE id = ?').run(depositAmount, depositAmount, req.user.id);

    return result;
  });

  const result = insertReservation();

  const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(result.lastInsertRowid);
  const resWithGpu = { ...reservation, gpu_name: gpu.name };

  // 莠育ｴ・｢ｺ螳壹Γ繝ｼ繝ｫ繧帝撼蜷梧悄騾∽ｿ｡
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

  // 繧ｭ繝｣繝ｳ繧ｻ繝ｫ譎ゅ・霑秘≡蜃ｦ逅・ｼ・onfirmed縺ｮ縺ｿ霑秘≡・・
  let refundAmount = 0;
  const refundableStatuses = ['confirmed', 'pending'];
  if (refundableStatuses.includes(reservation.status)) {
    // 繝・・繧ｸ繝・ヨ・亥・竊偵・繧､繝ｳ繝亥､画鋤貂医∩・峨ｒ霑秘≡
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
    ? `莠育ｴ・ｒ繧ｭ繝｣繝ｳ繧ｻ繝ｫ縺励∪縺励◆縲・{refundAmount}pt 繧定ｿ秘≡縺励∪縺励◆縲Ａ
    : '莠育ｴ・ｒ繧ｭ繝｣繝ｳ繧ｻ繝ｫ縺励∪縺励◆縲・;

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

// POST /api/reservations/:id/start - 謇句虚縺ｧPod繧貞叉譎りｵｷ蜍・
router.post('/:id/start', authMiddleware, (req, res) => {
  const db = getDb();
  const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(req.params.id);
  if (!reservation) return res.status(404).json({ error: '莠育ｴ・′隕九▽縺九ｊ縺ｾ縺帙ｓ' });
  if (reservation.renter_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Forbidden' });
  if (!['confirmed', 'pending'].includes(reservation.status))
    return res.status(400).json({ error: `縺薙・莠育ｴ・・縺吶〒縺ｫ ${reservation.status} 迥ｶ諷九〒縺兪 });

  // 譌｢蟄倥・遞ｼ蜒堺ｸｭPod縺後≠繧後・縺昴ｌ繧定ｿ斐☆
  const existingPod = db.prepare(
    "SELECT * FROM pods WHERE reservation_id = ? AND status = 'running'"
  ).get(reservation.id);
  if (existingPod) {
    return res.json({ success: true, pod: existingPod, alreadyRunning: true });
  }

  try {
    const { createPod } = require('../services/podManager');
    const pod = createPod(reservation.id);

    // 笨会ｸ・繝励Ο繝舌う繝繝ｼ縺ｸ蛻ｩ逕ｨ髢句ｧ九Γ繝ｼ繝ｫ
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
          renterName:   renter?.username || '繝ｦ繝ｼ繧ｶ繝ｼ',
          gpuName:      gpuInfo.gpu_name,
          startTime:    reservation.start_time,
          endTime:      reservation.end_time,
          earnAmount:   earn,
        }).catch(e => console.error('Provider start mail error:', e.message));
      }
    } catch(mailErr) { console.error('Provider mail lookup error:', mailErr.message); }

    // Socket.IO騾夂衍・・o 縺御ｽｿ縺医ｌ縺ｰ・・
    try {
      const { io } = require('../index');
      const { getWorkspaceUrl } = require('../services/podManager');
      if (io) {
        const wsUrl = getWorkspaceUrl(pod.id);
        io.to(`user_${pod.renter_id}`).emit('pod:started', {
          podId:         pod.id,
          workspace_url: wsUrl,
          message: '噫 GPU縺悟茜逕ｨ蜿ｯ閭ｽ縺ｫ縺ｪ繧翫∪縺励◆・√Ρ繝ｼ繧ｯ繧ｹ繝壹・繧ｹ縺ｫ謗･邯壹＠縺ｦ縺上□縺輔＞縲・,
        });
      }
    } catch (_) { /* io縺悟叙繧後↑縺上※繧らｶ咏ｶ・*/ }

    res.json({ success: true, pod });
  } catch (err) {
    res.status(500).json({ error: 'Pod襍ｷ蜍輔↓螟ｱ謨励＠縺ｾ縺励◆: ' + err.message });
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


