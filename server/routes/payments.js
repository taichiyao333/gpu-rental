const express = require('express');
const router = express.Router();
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { getDb } = require('../db/database');
const config = require('../config');

// Lazy-load Stripe (only if key is configured)
function getStripe() {
    if (!config.stripe.secretKey) return null;
    const Stripe = require('stripe');
    return new Stripe(config.stripe.secretKey, { apiVersion: '2024-12-18.acacia' });
}

// ─── POST /api/payments/create-session ──────────────────────────
// Create a Stripe Checkout Session for a reservation
router.post('/create-session', authMiddleware, async (req, res) => {
    const { reservation_id } = req.body;
    if (!reservation_id) return res.status(400).json({ error: 'reservation_id required' });

    const db = getDb();
    const reservation = db.prepare(`
    SELECT r.*, gn.name as gpu_name, gn.price_per_hour
    FROM reservations r
    JOIN gpu_nodes gn ON r.gpu_id = gn.id
    WHERE r.id = ? AND r.renter_id = ?
  `).get(reservation_id, req.user.id);

    if (!reservation) return res.status(404).json({ error: 'Reservation not found' });
    if (reservation.status !== 'confirmed') return res.status(400).json({ error: 'Reservation is not in confirmed state' });

    const stripe = getStripe();

    // Mock payment if Stripe not configured
    if (!stripe) {
        db.prepare("UPDATE reservations SET status = 'paid' WHERE id = ?").run(reservation_id);
        return res.json({
            mode: 'mock',
            message: 'Stripe not configured — payment marked as paid (demo mode)',
            reservationId: reservation_id,
        });
    }

    try {
        const durationHours = (new Date(reservation.end_time) - new Date(reservation.start_time)) / 3600000;
        const amountYen = Math.round(durationHours * reservation.price_per_hour);

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'payment',
            locale: 'ja',
            line_items: [{
                price_data: {
                    currency: 'jpy',
                    product_data: {
                        name: `GPU Rental: ${reservation.gpu_name}`,
                        description: `${durationHours.toFixed(1)}時間 (${new Date(reservation.start_time).toLocaleString('ja-JP')} ～ ${new Date(reservation.end_time).toLocaleString('ja-JP')})`,
                    },
                    unit_amount: amountYen,
                },
                quantity: 1,
            }],
            metadata: {
                reservation_id: String(reservation_id),
                user_id: String(req.user.id),
            },
            success_url: `${config.baseUrl}/portal/?payment=success&reservation=${reservation_id}`,
            cancel_url: `${config.baseUrl}/portal/?payment=cancelled`,
        });

        // Store session ID
        db.prepare("UPDATE reservations SET stripe_session_id = ? WHERE id = ?")
            .run(session.id, reservation_id);

        res.json({ sessionId: session.id, url: session.url });
    } catch (err) {
        console.error('Stripe error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/payments/webhook ─────────────────────────────────
// Stripe webhook — handle payment_intent.succeeded
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const stripe = getStripe();
    if (!stripe) return res.json({ received: true });

    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, config.stripe.webhookSecret);
    } catch (err) {
        return res.status(400).json({ error: `Webhook error: ${err.message}` });
    }

    const db = getDb();

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const reservationId = session.metadata.reservation_id;
        const sfRaidJobId   = session.metadata.sf_raid_job_id;
        const paymentType   = session.metadata.type;

        if (paymentType === 'sf_raid' && sfRaidJobId) {
            // SF Raid Job — Stripe 決済完了
            db.prepare(`
                UPDATE sf_raid_jobs
                SET status = 'paid', payment_method = 'stripe',
                    paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status = 'payment_pending'
            `).run(sfRaidJobId);
            console.log(`✅ SF Raid Job #${sfRaidJobId} marked as paid via Stripe`);
        } else if (reservationId) {
            // 通常の GPU 予約 Stripe 決済
            db.prepare("UPDATE reservations SET status = 'paid' WHERE id = ? AND status = 'confirmed'")
                .run(reservationId);
            console.log(`✅ Payment completed for reservation #${reservationId}`);
        }
    }

    res.json({ received: true });
});

// ─── GET /api/payments/history ───────────────────────────────────
router.get('/history', authMiddleware, (req, res) => {
    const db = getDb();
    const logs = db.prepare(`
    SELECT ul.*, gn.name as gpu_name, p.status as pod_status
    FROM usage_logs ul
    JOIN gpu_nodes gn ON ul.gpu_id = gn.id
    LEFT JOIN pods p ON ul.pod_id = p.id
    WHERE ul.renter_id = ?
    ORDER BY ul.logged_at DESC
    LIMIT 50
  `).all(req.user.id);
    res.json(logs);
});

// ─── GET /api/payments/wallet ────────────────────────────────────
// Provider wallet info + earnings history
router.get('/wallet', authMiddleware, (req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT wallet_balance FROM users WHERE id = ?').get(req.user.id);
    const earnings = db.prepare(`
    SELECT ul.*, gn.name as gpu_name
    FROM usage_logs ul
    JOIN gpu_nodes gn ON ul.gpu_id = gn.id
    WHERE ul.provider_id = ?
    ORDER BY ul.logged_at DESC
    LIMIT 50
  `).all(req.user.id);

    const totalEarned = earnings.reduce((s, e) => s + (e.provider_payout || 0), 0);
    const monthEarned = earnings
        .filter(e => new Date(e.logged_at).getMonth() === new Date().getMonth())
        .reduce((s, e) => s + (e.provider_payout || 0), 0);

    res.json({
        balance: user?.wallet_balance || 0,
        totalEarned,
        monthEarned,
        history: earnings,
    });
});

// ─── POST /api/payments/withdraw ─────────────────────────────────
router.post('/withdraw', authMiddleware, (req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT wallet_balance FROM users WHERE id = ?').get(req.user.id);
    if (!user || user.wallet_balance < 1000) {
        return res.status(400).json({ error: '最低出金額は¥1,000です' });
    }

    const amount = user.wallet_balance;
    db.prepare('UPDATE users SET wallet_balance = 0, point_balance = 0 WHERE id = ?').run(req.user.id);
    db.prepare(`
    INSERT INTO payouts (provider_id, amount, status, period_from, period_to)
    VALUES (?, ?, 'pending', date('now', '-1 month'), date('now'))
  `).run(req.user.id, amount);

    res.json({ success: true, amount, message: `¥${Math.round(amount).toLocaleString()}の出金申請を受け付けました` });
});

// ─── POST /api/payments/sf-raid/pay-with-points ──────────────────
// THE LOBBY でポイント払いで SF Raid Job を確定する
// Body: { sf_raid_job_id }
router.post('/sf-raid/pay-with-points', authMiddleware, (req, res) => {
    const { sf_raid_job_id } = req.body;
    if (!sf_raid_job_id) return res.status(400).json({ error: 'sf_raid_job_id required' });

    const db = getDb();
    const job = db.prepare('SELECT * FROM sf_raid_jobs WHERE id = ? AND user_id = ?')
                  .get(sf_raid_job_id, req.user.id);

    if (!job) return res.status(404).json({ error: 'SF レイドジョブが見つかりません' });
    if (job.status !== 'payment_pending') {
        return res.status(400).json({ error: `ジョブのステータスが payment_pending ではありません (${job.status})` });
    }

    const pointsNeeded = job.points_used || Math.ceil(job.payment_amount_yen || 0);
    const user = db.prepare('SELECT point_balance FROM users WHERE id = ?').get(req.user.id);
    if (!user || user.point_balance < pointsNeeded) {
        return res.status(400).json({
            error: `ポイントが不足しています。必要: ${pointsNeeded}pt / 現在: ${Math.floor(user?.point_balance ?? 0)}pt`,
            required: pointsNeeded,
            balance: Math.floor(user?.point_balance ?? 0),
        });
    }

    // トランザクション: ポイント引き落とし + ジョブステータス更新
    db.transaction(() => {
        db.prepare('UPDATE users SET point_balance = point_balance - ? WHERE id = ?')
          .run(pointsNeeded, req.user.id);
        db.prepare(`
            UPDATE sf_raid_jobs
            SET status = 'paid', payment_method = 'points', points_used = ?,
                paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(pointsNeeded, job.id);

        // ポイントログ記録
        try {
            db.prepare(`
                INSERT INTO point_logs (user_id, type, amount, source, source_id, note, created_at)
                VALUES (?, 'spend', ?, 'raid_job', ?, ?, CURRENT_TIMESTAMP)
            `).run(req.user.id, pointsNeeded, String(job.id), `SF Raid Job #${job.id} ポイント決済`);
        } catch (_) { /* point_logs テーブルが存在しない環境ではスキップ */ }
    })();

    console.log(`[SF Payment] Raid Job #${job.id} paid with ${pointsNeeded}pt by user #${req.user.id}`);
    res.json({
        success: true,
        sf_raid_job_id: job.id,
        points_used: pointsNeeded,
        status: 'paid',
        message: `${pointsNeeded}pt でレイドジョブ #${job.id} の決済が完了しました`,
    });
});

// ─── POST /api/payments/sf-raid/create-stripe-session ───────────
// THE LOBBY で Stripe 払いで SF Raid Job を確定する
router.post('/sf-raid/create-stripe-session', authMiddleware, async (req, res) => {
    const { sf_raid_job_id } = req.body;
    if (!sf_raid_job_id) return res.status(400).json({ error: 'sf_raid_job_id required' });

    const db = getDb();
    const job = db.prepare('SELECT * FROM sf_raid_jobs WHERE id = ? AND user_id = ?')
                  .get(sf_raid_job_id, req.user.id);

    if (!job) return res.status(404).json({ error: 'SF レイドジョブが見つかりません' });
    if (job.status !== 'payment_pending') {
        return res.status(400).json({ error: `決済済みか無効なジョブです (${job.status})` });
    }

    const stripe = getStripe();
    if (!stripe) {
        // モック決済
        db.prepare("UPDATE sf_raid_jobs SET status='paid', payment_method='stripe', paid_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(job.id);
        return res.json({ mode: 'mock', status: 'paid', sf_raid_job_id: job.id });
    }

    try {
        const summary = job.summary_json ? JSON.parse(job.summary_json) : {};
        const amountYen = job.payment_amount_yen || summary.estimated_cost_yen || 500;

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'payment',
            locale: 'ja',
            line_items: [{
                price_data: {
                    currency: 'jpy',
                    product_data: {
                        name: `GPU Street Fighter: RAID BATTLE #${job.id}`,
                        description: `ノード数: ${summary.node_count ?? '?'} / 推定完了: ${summary.est_completion_min ?? '?'}分`,
                    },
                    unit_amount: amountYen,
                },
                quantity: 1,
            }],
            metadata: {
                sf_raid_job_id: String(job.id),
                user_id: String(req.user.id),
                type: 'sf_raid',
            },
            success_url: `${config.baseUrl}/lobby/?sf_payment=success&raid_job=${job.id}`,
            cancel_url: `${config.baseUrl}/lobby/?sf_payment=cancelled`,
        });

        db.prepare("UPDATE sf_raid_jobs SET stripe_payment_id = ? WHERE id = ?")
          .run(session.id, job.id);

        res.json({ sessionId: session.id, url: session.url });
    } catch (err) {
        console.error('Stripe SF error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/payments/webhook (上書き拡張) ─────────────────────
// ※ webhookは上の定義と同じパスになるため、SF handling は
//   既存 webhook 内の checkout.session.completed イベントハンドラに
//   metadata.type === 'sf_raid' の分岐として追加が必要。
//   ここでは別ルート POST /api/payments/webhook/sf として補助実装。
//   (本番では上の webhook を統合してください)

module.exports = router;
