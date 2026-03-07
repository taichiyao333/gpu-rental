const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { getActivePods, stopPod, createPod } = require('../services/podManager');
const { getCachedStats } = require('../services/gpuManager');

// GET /api/pods - list active pods
router.get('/', authMiddleware, (req, res) => {
    try {
        const pods = getActivePods();
        const enriched = pods.map(pod => ({
            ...pod,
            gpuStats: getCachedStats(pod.device_index),
            minutesLeft: Math.max(0, Math.round((new Date(pod.expires_at) - new Date()) / 60000)),
        }));
        if (req.user.role === 'admin') return res.json(enriched);
        return res.json(enriched.filter(p => p.renter_id === req.user.id));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/pods/:id - pod detail
router.get('/:id', authMiddleware, (req, res) => {
    const db = getDb();
    const pod = db.prepare(`
    SELECT p.*, gn.name as gpu_name, gn.device_index, u.username as renter_name
    FROM pods p
    JOIN gpu_nodes gn ON p.gpu_id = gn.id
    JOIN users u ON p.renter_id = u.id
    WHERE p.id = ?
  `).get(req.params.id);

    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    if (pod.renter_id !== req.user.id && req.user.role !== 'admin')
        return res.status(403).json({ error: 'Forbidden' });

    res.json({
        ...pod,
        gpuStats: getCachedStats(pod.device_index),
        minutesLeft: Math.max(0, Math.round((new Date(pod.expires_at) - new Date()) / 60000)),
    });
});

// POST /api/pods/:id/stop - stop pod (marks as paused, keeps reservation active)
router.post('/:id/stop', authMiddleware, (req, res) => {
    const db = getDb();
    const pod = db.prepare('SELECT * FROM pods WHERE id = ? AND status = ?').get(req.params.id, 'running');
    if (!pod) return res.status(404).json({ error: 'Active pod not found' });
    if (pod.renter_id !== req.user.id && req.user.role !== 'admin')
        return res.status(403).json({ error: 'Forbidden' });

    const { force } = req.body; // force=true means fully end session

    if (force) {
        // ユーザーが「セッション終了（完全）」を選択した場合
        try {
            const result = stopPod(pod.id, 'user_requested');
            res.json({ success: true, status: 'stopped', ...result });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    } else {
        // 「一時停止」— 予約時間内なら再接続可能
        const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(pod.reservation_id);
        const now = new Date();
        const reservationEnd = new Date(reservation.end_time);

        if (now >= reservationEnd) {
            // 予約時間が過ぎていたら完全終了
            try {
                const result = stopPod(pod.id, 'expired');
                return res.json({ success: true, status: 'stopped', ...result });
            } catch (err) {
                return res.status(500).json({ error: err.message });
            }
        }

        // 予約時間内 → 一時停止（paused）
        db.prepare("UPDATE pods SET status='paused', paused_at=CURRENT_TIMESTAMP WHERE id=?").run(pod.id);
        // GPU を 'available' に戻すが予約は active のまま
        db.prepare("UPDATE gpu_nodes SET status='available' WHERE id=?").run(pod.gpu_id);
        // 使用ログ記録（中断時点）
        const startedAt = new Date(pod.started_at);
        const durationMinutes = Math.round((now - startedAt) / 60000);
        try {
            db.prepare(`INSERT INTO usage_logs
                (pod_id, renter_id, gpu_id, provider_id, duration_minutes, cost, provider_payout)
                VALUES (?, ?, ?, 1, ?, 0, 0)`)
                .run(pod.id, pod.renter_id, pod.gpu_id, durationMinutes);
        } catch (_) { }

        res.json({
            success: true,
            status: 'paused',
            message: '一時停止しました。予約時間内であれば再接続できます。',
            reservation_end: reservation.end_time,
            minutes_remaining: Math.max(0, Math.round((reservationEnd - now) / 60000)),
        });
    }
});

// POST /api/pods/:id/reconnect - 再接続（paused pod または同一予約から新Pod作成）
router.post('/:id/reconnect', authMiddleware, (req, res) => {
    const db = getDb();
    const oldPod = db.prepare('SELECT * FROM pods WHERE id = ?').get(req.params.id);
    if (!oldPod) return res.status(404).json({ error: 'Pod not found' });
    if (oldPod.renter_id !== req.user.id && req.user.role !== 'admin')
        return res.status(403).json({ error: 'Forbidden' });

    // 予約が有効かチェック
    const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(oldPod.reservation_id);
    if (!reservation) return res.status(404).json({ error: '予約が見つかりません' });

    const now = new Date();
    const reservationEnd = new Date(reservation.end_time);
    if (now >= reservationEnd) {
        return res.status(400).json({
            error: '予約時間が終了しています。再接続できません。',
            ended_at: reservation.end_time,
        });
    }

    // 既に running な Pod があればそれを返す
    const runningPod = db.prepare(
        "SELECT * FROM pods WHERE reservation_id = ? AND status = 'running'"
    ).get(reservation.id);
    if (runningPod) {
        return res.json({
            success: true,
            pod: runningPod,
            message: '既に実行中のPodに接続します',
            already_running: true,
        });
    }

    // paused を running に戻す
    if (oldPod.status === 'paused') {
        db.prepare("UPDATE pods SET status='running', paused_at=NULL, reconnect_count=reconnect_count+1 WHERE id=?")
            .run(oldPod.id);
        db.prepare("UPDATE gpu_nodes SET status='rented' WHERE id=?").run(oldPod.gpu_id);
        db.prepare("UPDATE reservations SET status='active' WHERE id=?").run(reservation.id);

        const updatedPod = db.prepare('SELECT * FROM pods WHERE id=?').get(oldPod.id);
        return res.json({
            success: true,
            pod: updatedPod,
            message: '🚀 再接続しました！ワークスペースに接続できます。',
            minutes_remaining: Math.max(0, Math.round((reservationEnd - now) / 60000)),
        });
    }

    // stopped → 新しい Pod を作成（予約を confirmed に戻して createPod）
    if (reservation.status === 'active' || reservation.status === 'completed') {
        db.prepare("UPDATE reservations SET status='confirmed' WHERE id=?").run(reservation.id);
    }
    try {
        const newPod = createPod(reservation.id);
        db.prepare("UPDATE pods SET reconnect_count=reconnect_count+1 WHERE id=?").run(newPod.id);
        return res.json({
            success: true,
            pod: newPod,
            message: '🚀 新しいセッションを開始しました！',
            minutes_remaining: Math.max(0, Math.round((reservationEnd - now) / 60000)),
        });
    } catch (err) {
        return res.status(500).json({ error: '再接続に失敗: ' + err.message });
    }
});

// Admin: force stop
router.post('/:id/force-stop', authMiddleware, adminOnly, (req, res) => {
    try {
        const result = stopPod(parseInt(req.params.id), 'admin_force');
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;


// GET /api/pods - list active pods
router.get('/', authMiddleware, (req, res) => {
    try {
        const pods = getActivePods();
        // Enrich with real-time GPU stats
        const enriched = pods.map(pod => ({
            ...pod,
            gpuStats: getCachedStats(pod.device_index),
            minutesLeft: Math.max(0, Math.round((new Date(pod.expires_at) - new Date()) / 60000)),
        }));

        if (req.user.role === 'admin') return res.json(enriched);
        return res.json(enriched.filter(p => p.renter_id === req.user.id));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/pods/:id - pod detail
router.get('/:id', authMiddleware, (req, res) => {
    const db = getDb();
    const pod = db.prepare(`
    SELECT p.*, gn.name as gpu_name, gn.device_index, u.username as renter_name
    FROM pods p
    JOIN gpu_nodes gn ON p.gpu_id = gn.id
    JOIN users u ON p.renter_id = u.id
    WHERE p.id = ?
  `).get(req.params.id);

    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    if (pod.renter_id !== req.user.id && req.user.role !== 'admin')
        return res.status(403).json({ error: 'Forbidden' });

    res.json({
        ...pod,
        gpuStats: getCachedStats(pod.device_index),
        minutesLeft: Math.max(0, Math.round((new Date(pod.expires_at) - new Date()) / 60000)),
    });
});

// POST /api/pods/:id/stop - stop pod early
router.post('/:id/stop', authMiddleware, (req, res) => {
    const db = getDb();
    const pod = db.prepare('SELECT * FROM pods WHERE id = ? AND status = ?').get(req.params.id, 'running');
    if (!pod) return res.status(404).json({ error: 'Active pod not found' });
    if (pod.renter_id !== req.user.id && req.user.role !== 'admin')
        return res.status(403).json({ error: 'Forbidden' });

    try {
        const result = stopPod(pod.id, 'user_requested');
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: force stop
router.post('/:id/force-stop', authMiddleware, adminOnly, (req, res) => {
    try {
        const result = stopPod(parseInt(req.params.id), 'admin_force');
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
