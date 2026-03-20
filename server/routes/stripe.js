/**
 * Stripe Connect 完全実装ルート
 * 
 * エンドポイント:
 * POST /api/stripe/connect/onboard      プロバイダーのStripe Connect onboarding
 * GET  /api/stripe/connect/status       Connect接続状態確認
 * GET  /api/stripe/connect/dashboard    Stripeダッシュボードリンク（プロバイダー）
 * POST /api/stripe/connect/disconnect   接続解除
 * POST /api/stripe/checkout/points      ポイント購入（Stripe Checkout）
 * POST /api/stripe/checkout/session     予約直接決済（Stripe Checkout）
 * POST /api/stripe/webhook              Stripe Webhook
 * GET  /api/stripe/admin/accounts       全Connectアカウント一覧（管理者）
 * POST /api/stripe/admin/payout/:id     プロバイダーへ手動送金（管理者）
 */
const express = require('express');
const router  = express.Router();
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { getDb } = require('../db/database');
const config  = require('../config');
const { mailPointPurchased, mailReservationConfirmed } = require('../services/email');

// ─── Stripe instance ─────────────────────────────────────────────
function getStripe() {
    if (!process.env.STRIPE_SECRET_KEY) return null;
    const Stripe = require('stripe');
    return new Stripe(process.env.STRIPE_SECRET_KEY, {
        apiVersion: '2024-12-18.acacia',
    });
}

// プラットフォームの手数料率（10%）
const PLATFORM_FEE_RATE = 0.10;

/* ═══════════════════════════════════════════════════════════
   CONNECT — プロバイダーオンボーディング
═══════════════════════════════════════════════════════════ */

/**
 * POST /api/stripe/connect/onboard
 * プロバイダーがStripe Connectアカウントを作成し、onboarding URLを取得
 */
router.post('/connect/onboard', authMiddleware, async (req, res) => {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

    const db   = getDb();
    const user = db.prepare('SELECT id, email, stripe_account_id FROM users WHERE id = ?').get(req.user.id);

    try {
        let accountId = user.stripe_account_id;

        // 既存アカウントが未完成（古いstandard / 未使用）の場合は新規Express作成
        let needsNew = !accountId;
        if (accountId && !needsNew) {
            try {
                const existing = await stripe.accounts.retrieve(accountId);
                // standard + charges disabledなら再作成
                if (existing.type === 'standard' && !existing.charges_enabled) {
                    needsNew = true;
                }
            } catch (_) { needsNew = true; }
        }

        if (needsNew) {
            // Express アカウント作成（本番Platform Profile承認済み）
            const account = await stripe.accounts.create({
                type:    'express',
                country: 'JP',
                email:   user.email,
                capabilities: {
                    card_payments: { requested: true },
                    transfers:     { requested: true },
                },
                business_profile: {
                    mcc:                 '5734', // コンピュータソフトウェア
                    url:                 'https://gpurental.jp',
                    product_description: 'GPU rental provider on GPURental platform',
                },
            });
            accountId = account.id;

            // DBに保存
            db.prepare('UPDATE users SET stripe_account_id = ?, stripe_connected = 0 WHERE id = ?')
              .run(accountId, req.user.id);
            console.log(`📝 Created live Express account ${accountId} for user ${req.user.id}`);
        }

        // onboarding link 生成
        const baseUrl = process.env.BASE_URL || 'https://gpurental.jp';
        const link = await stripe.accountLinks.create({
            account:     accountId,
            refresh_url: `${baseUrl}/provider/?stripe=refresh`,
            return_url:  `${baseUrl}/provider/?stripe=connected`,
            type:        'account_onboarding',
            collect:     'eventually_due',
        });

        console.log(`✅ Stripe Connect onboarding started for user ${req.user.id}: ${accountId}`);
        res.json({ url: link.url, accountId });
    } catch (err) {
        console.error('Stripe Connect onboard error:', err);
        res.status(500).json({ error: err.message });
    }
});


/**
 * GET /api/stripe/connect/status
 * プロバイダーのStripe Connect接続状態を返す
 */
router.get('/connect/status', authMiddleware, async (req, res) => {
    const stripe = getStripe();
    const db     = getDb();
    const user   = db.prepare('SELECT stripe_account_id FROM users WHERE id = ?').get(req.user.id);

    if (!user?.stripe_account_id) {
        return res.json({ connected: false, accountId: null });
    }

    if (!stripe) {
        return res.json({ connected: true, accountId: user.stripe_account_id, stripeDisabled: true });
    }

    try {
        const account = await stripe.accounts.retrieve(user.stripe_account_id);
        const connected = account.details_submitted && account.charges_enabled;

        // DBのステータスを更新
        db.prepare('UPDATE users SET stripe_connected = ? WHERE id = ?')
          .run(connected ? 1 : 0, req.user.id);

        res.json({
            connected,
            accountId:       account.id,
            chargesEnabled:  account.charges_enabled,
            payoutsEnabled:  account.payouts_enabled,
            detailsSubmitted: account.details_submitted,
            requirements:    account.requirements,
            email:           account.email,
            country:         account.country,
        });
    } catch (err) {
        console.error('Stripe status error:', err.message);
        res.json({ connected: false, accountId: user.stripe_account_id, error: err.message });
    }
});

/**
 * GET /api/stripe/connect/dashboard
 * Stripeダッシュボードへのログインリンクを返す（プロバイダー）
 */
router.get('/connect/dashboard', authMiddleware, async (req, res) => {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

    const db   = getDb();
    const user = db.prepare('SELECT stripe_account_id FROM users WHERE id = ?').get(req.user.id);

    if (!user?.stripe_account_id) {
        return res.status(400).json({ error: 'Stripe Connect not connected' });
    }

    try {
        const loginLink = await stripe.accounts.createLoginLink(user.stripe_account_id);
        res.json({ url: loginLink.url });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/stripe/connect/disconnect
 * Stripeアカウント連携解除（アカウントは削除せずDBのIDをクリア）
 */
router.post('/connect/disconnect', authMiddleware, async (req, res) => {
    const db = getDb();
    db.prepare('UPDATE users SET stripe_account_id = NULL, stripe_connected = 0 WHERE id = ?')
      .run(req.user.id);
    res.json({ success: true });
});

/* ═══════════════════════════════════════════════════════════
   CHECKOUT — ポイント購入（Stripe）
═══════════════════════════════════════════════════════════ */

/**
 * POST /api/stripe/checkout/points
 * ポイントプランをStripe Checkoutで購入
 * Body: { plan_id, coupon_code? }
 */
router.post('/checkout/points', authMiddleware, async (req, res) => {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured. Set STRIPE_SECRET_KEY in .env' });

    const { plan_id, coupon_code } = req.body;
    const db = getDb();

    // プラン定義（points.jsと同じ）
    const PLANS = {
        plan_1h:   { name: '1時間チケット',   hours: 1,   amount_yen: 800,    points: 80   },
        plan_3h:   { name: '3時間チケット',   hours: 3,   amount_yen: 2400,   points: 240  },
        plan_10h:  { name: '10時間チケット',  hours: 10,  amount_yen: 7500,   points: 750  },
        plan_30h:  { name: '30時間チケット',  hours: 30,  amount_yen: 21000,  points: 2100 },
        plan_100h: { name: '100時間チケット', hours: 100, amount_yen: 65000,  points: 6500 },
    };

    const plan = PLANS[plan_id];
    if (!plan) return res.status(400).json({ error: 'Invalid plan_id' });

    let finalAmount = plan.amount_yen;
    let couponDbId  = null;

    // クーポン適用
    if (coupon_code) {
        const coupon = db.prepare(`
            SELECT * FROM coupons
            WHERE code = ? AND is_active = 1
            AND (valid_until IS NULL OR valid_until > datetime('now'))
            AND (max_uses IS NULL OR used_count < max_uses)
        `).get(coupon_code.trim().toUpperCase());

        if (coupon) {
            if (coupon.discount_type === 'percent') {
                finalAmount = Math.round(finalAmount * (1 - coupon.discount_value / 100));
            } else {
                finalAmount = Math.max(0, finalAmount - coupon.discount_value);
            }
            couponDbId = coupon.id;
        }
    }

    try {
        // DB に購入レコード作成
        const purchase = db.prepare(`
            INSERT INTO point_purchases
            (user_id, plan_name, hours, points, amount_yen, status, coupon_id, coupon_discount_yen)
            VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
        `).run(
            req.user.id,
            plan_id,
            plan.hours,
            plan.points,
            finalAmount,
            couponDbId,
            plan.amount_yen - finalAmount,
        );

        const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

        // Stripe Checkout session 作成
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode:                 'payment',
            locale:               'ja',
            line_items: [{
                price_data: {
                    currency:     'jpy',
                    product_data: {
                        name:        `GPURental ${plan.name}`,
                        description: `${plan.hours}時間分の利用ポイント (${plan.points}pt)`,
                        images:      ['https://gpurental.jp/favicon.ico'],
                    },
                    unit_amount: finalAmount,
                },
                quantity: 1,
            }],
            metadata: {
                type:        'point_purchase',
                purchase_id: String(purchase.lastInsertRowid),
                user_id:     String(req.user.id),
                plan_id,
                points:      String(plan.points),
            },
            success_url: `${baseUrl}/mypage/?payment=success&purchase=${purchase.lastInsertRowid}`,
            cancel_url:  `${baseUrl}/mypage/?payment=cancelled`,
            customer_email: db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id)?.email,
        });

        // session IDをDBに保存
        db.prepare("UPDATE point_purchases SET epsilon_order = ? WHERE id = ?")
          .run(session.id, purchase.lastInsertRowid);

        res.json({
            sessionId:  session.id,
            url:        session.url,
            purchaseId: purchase.lastInsertRowid,
        });
    } catch (err) {
        console.error('Stripe checkout error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/stripe/checkout/session
 * 予約を直接Stripe Checkoutで支払い（Connect経由でプロバイダーへ自動送金）
 * Body: { reservation_id }
 */
router.post('/checkout/session', authMiddleware, async (req, res) => {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

    const { reservation_id } = req.body;
    const db = getDb();

    const reservation = db.prepare(`
        SELECT r.*, gn.name as gpu_name, gn.price_per_hour, gn.provider_id,
               u.stripe_account_id as provider_stripe_id
        FROM reservations r
        JOIN gpu_nodes gn ON r.gpu_id = gn.id
        JOIN users u ON gn.provider_id = u.id
        WHERE r.id = ? AND r.renter_id = ?
    `).get(reservation_id, req.user.id);

    if (!reservation) return res.status(404).json({ error: 'Reservation not found' });
    if (!['confirmed','pending'].includes(reservation.status)) {
        return res.status(400).json({ error: `Reservation status is '${reservation.status}'` });
    }

    try {
        const durationHours = (new Date(reservation.end_time) - new Date(reservation.start_time)) / 3600000;
        const totalYen      = Math.round(durationHours * reservation.price_per_hour);
        const platformFee   = Math.round(totalYen * PLATFORM_FEE_RATE);
        const baseUrl       = process.env.BASE_URL || 'http://localhost:3000';

        const sessionOptions = {
            payment_method_types: ['card'],
            mode:                 'payment',
            locale:               'ja',
            line_items: [{
                price_data: {
                    currency:     'jpy',
                    product_data: {
                        name:        `GPU Rental: ${reservation.gpu_name}`,
                        description: `${durationHours.toFixed(1)}時間 (${new Date(reservation.start_time).toLocaleString('ja-JP')})`,
                    },
                    unit_amount: totalYen,
                },
                quantity: 1,
            }],
            metadata: {
                type:           'reservation',
                reservation_id: String(reservation_id),
                user_id:        String(req.user.id),
            },
            success_url: `${baseUrl}/portal/?payment=success&reservation=${reservation_id}`,
            cancel_url:  `${baseUrl}/portal/?payment=cancelled`,
        };

        // プロバイダーがStripe Connectに接続している場合 → 自動送金
        if (reservation.provider_stripe_id) {
            sessionOptions.payment_intent_data = {
                application_fee_amount: platformFee,
                transfer_data: {
                    destination: reservation.provider_stripe_id,
                },
            };
        }

        const session = await stripe.checkout.sessions.create(sessionOptions);

        // DBにsession IDを保存
        db.prepare("UPDATE reservations SET stripe_session_id = ? WHERE id = ?")
          .run(session.id, reservation_id);

        res.json({ sessionId: session.id, url: session.url, amount: totalYen, platformFee });
    } catch (err) {
        console.error('Stripe session error:', err);
        res.status(500).json({ error: err.message });
    }
});

/* ═══════════════════════════════════════════════════════════
   WEBHOOK
═══════════════════════════════════════════════════════════ */

/**
 * POST /api/stripe/webhook
 * Stripeからのイベント（署名検証あり）
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const stripe = getStripe();
    if (!stripe) return res.json({ received: true });

    const sig    = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
        console.error('Webhook signature error:', err.message);
        return res.status(400).json({ error: `Webhook error: ${err.message}` });
    }

    const db = getDb();

    switch (event.type) {
        // ─── チェックアウト完了 ───────────────────────────────
        case 'checkout.session.completed': {
            const session  = event.data.object;
            const meta     = session.metadata;

            if (meta.type === 'point_purchase') {
                // ポイント購入完了
                const purchase = db.prepare('SELECT * FROM point_purchases WHERE id = ?').get(Number(meta.purchase_id));
                if (purchase && purchase.status === 'pending') {
                    db.prepare("UPDATE point_purchases SET status = 'completed', paid_at = datetime('now'), epsilon_trans = ? WHERE id = ?")
                      .run(session.payment_intent, purchase.id);

                    db.prepare('UPDATE users SET point_balance = point_balance + ? WHERE id = ?')
                      .run(purchase.points, purchase.user_id);

                    db.prepare(`
                        INSERT INTO point_logs (user_id, points, type, description, ref_id)
                        VALUES (?, ?, 'purchase', ?, ?)
                    `).run(purchase.user_id, purchase.points, `Stripeで${purchase.plan_name}購入`, purchase.id);

                    // クーポン使用数更新
                    if (purchase.coupon_id) {
                        db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?')
                          .run(purchase.coupon_id);
                        db.prepare(`INSERT INTO coupon_uses (coupon_id, user_id, purchase_id, discount_yen) VALUES (?, ?, ?, ?)`)
                          .run(purchase.coupon_id, purchase.user_id, purchase.id, purchase.coupon_discount_yen || 0);
                    }

                    // ✉️ ポイント購入完了メール送信
                    const buyer = db.prepare('SELECT username, email FROM users WHERE id = ?').get(purchase.user_id);
                    if (buyer?.email) {
                        mailPointPurchased({
                            to:       buyer.email,
                            username: buyer.username,
                            purchase: {
                                ...purchase,
                                plan_name:  purchase.plan_name,
                                points:     purchase.points,
                                amount_yen: purchase.amount_yen,
                                payment_method: 'Stripe',
                            },
                        }).catch(e => console.error('Mail error:', e.message));
                    }

                    console.log(`✅ Point purchase #${purchase.id}: +${purchase.points}pt for user ${purchase.user_id}`);
                }

            } else if (meta.type === 'reservation') {
                // 予約直接支払い完了
                const reservationId = meta.reservation_id;
                db.prepare("UPDATE reservations SET status = 'paid' WHERE id = ? AND status IN ('pending','confirmed')")
                  .run(Number(reservationId));

                // ✉️ 予約確定メール送信
                const resData = db.prepare(`
                    SELECT r.*, gn.name as gpu_name, gn.price_per_hour, u.username, u.email
                    FROM reservations r
                    JOIN gpu_nodes gn ON r.gpu_id = gn.id
                    JOIN users u ON r.renter_id = u.id
                    WHERE r.id = ?
                `).get(Number(reservationId));
                if (resData?.email) {
                    mailReservationConfirmed({
                        to:          resData.email,
                        username:    resData.username,
                        reservation: resData,
                    }).catch(e => console.error('Mail error:', e.message));
                }

                console.log(`✅ Reservation #${reservationId} paid via Stripe`);
            }
            break;
        }

        // ─── 支払い失敗 ───────────────────────────────────────
        case 'checkout.session.expired':
        case 'payment_intent.payment_failed': {
            const obj  = event.data.object;
            const meta = obj.metadata || {};
            if (meta.type === 'point_purchase' && meta.purchase_id) {
                db.prepare("UPDATE point_purchases SET status = 'failed' WHERE id = ? AND status = 'pending'")
                  .run(Number(meta.purchase_id));
            }
            console.log(`⚠️ Payment failed/expired: ${event.type}`);
            break;
        }

        // ─── Connect アカウント更新 ────────────────────────────
        case 'account.updated': {
            const account  = event.data.object;
            const connected = account.details_submitted && account.charges_enabled ? 1 : 0;
            db.prepare('UPDATE users SET stripe_connected = ? WHERE stripe_account_id = ?')
              .run(connected, account.id);
            console.log(`↔️ Stripe account ${account.id} updated: connected=${connected}`);
            break;
        }

        // ─── 送金完了 ─────────────────────────────────────────
        case 'transfer.created': {
            const transfer = event.data.object;
            console.log(`💸 Transfer to ${transfer.destination}: ¥${transfer.amount}`);
            break;
        }

        case 'payment_intent.succeeded':
            console.log(`💳 PaymentIntent succeeded: ${event.data.object.id}`);
            break;

        default:
            // その他のイベントは無視
            break;
    }

    res.json({ received: true });
});

/* ═══════════════════════════════════════════════════════════
   ADMIN — Stripe Connect管理
═══════════════════════════════════════════════════════════ */

/**
 * GET /api/stripe/admin/accounts
 * Stripe Connectアカウント一覧（管理者用）
 */
router.get('/admin/accounts', authMiddleware, adminOnly, async (req, res) => {
    const stripe = getStripe();
    const db     = getDb();

    const providers = db.prepare(`
        SELECT id, username, email, stripe_account_id, stripe_connected, wallet_balance
        FROM users
        WHERE stripe_account_id IS NOT NULL
        ORDER BY id DESC
    `).all();

    if (!stripe) {
        return res.json(providers.map(p => ({ ...p, stripeInfo: null })));
    }

    // Stripe APIからリアルタイム情報取得
    const results = await Promise.all(providers.map(async p => {
        try {
            const account = await stripe.accounts.retrieve(p.stripe_account_id);
            return {
                ...p,
                stripeInfo: {
                    chargesEnabled:   account.charges_enabled,
                    payoutsEnabled:   account.payouts_enabled,
                    detailsSubmitted: account.details_submitted,
                    country:          account.country,
                    currency:         account.default_currency,
                },
            };
        } catch {
            return { ...p, stripeInfo: { error: 'Could not fetch' } };
        }
    }));

    res.json(results);
});

/**
 * POST /api/stripe/admin/payout/:userId
 * 特定プロバイダーへの手動送金（管理者用）
 * Body: { amount_yen }
 */
router.post('/admin/payout/:userId', authMiddleware, adminOnly, async (req, res) => {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

    const { amount_yen } = req.body;
    if (!amount_yen || amount_yen < 100) {
        return res.status(400).json({ error: '最低送金額は¥100です' });
    }

    const db = getDb();
    const provider = db.prepare('SELECT id, stripe_account_id, wallet_balance FROM users WHERE id = ?')
                       .get(Number(req.params.userId));

    if (!provider?.stripe_account_id) {
        return res.status(400).json({ error: 'プロバイダーがStripe Connectに接続していません' });
    }

    try {
        const transfer = await stripe.transfers.create({
            amount:      Math.round(amount_yen),
            currency:    'jpy',
            destination: provider.stripe_account_id,
            description: `GPURental payout to provider #${provider.id}`,
        });

        // DB更新：wallet_balanceを減算
        db.prepare('UPDATE users SET wallet_balance = MAX(0, wallet_balance - ?) WHERE id = ?')
          .run(amount_yen, provider.id);

        db.prepare(`
            INSERT INTO payouts (provider_id, amount, status, period_from, period_to, notes)
            VALUES (?, ?, 'paid', date('now','-1 month'), date('now'), ?)
        `).run(provider.id, amount_yen, `Stripe transfer: ${transfer.id}`);

        console.log(`✅ Admin payout ¥${amount_yen} to provider #${provider.id} via Stripe: ${transfer.id}`);
        res.json({ success: true, transferId: transfer.id, amount: amount_yen });
    } catch (err) {
        console.error('Payout error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
