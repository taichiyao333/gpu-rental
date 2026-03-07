/**
 * Points & Tickets API
 * GET  /api/points/balance          - my point balance
 * GET  /api/points/logs             - my point history
 * GET  /api/points/plans            - available ticket plans
 * POST /api/points/purchase         - initiate GMO Epsilon payment
 * POST /api/points/epsilon/callback - payment callback (webhook)
 * GET  /api/points/epsilon/return   - redirect after payment
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const crypto = require('crypto');

// 1 point = 10 yen
const POINT_RATE = 10;

// GMO Epsilon settings (from .env)
const EPSILON_CONTRACT_CODE = process.env.EPSILON_CONTRACT_CODE || 'TEST_CONTRACT';
const EPSILON_URL = process.env.EPSILON_URL || 'https://beta.epsilon.jp/cgi-bin/order/lcard_order.cgi';
const EPSILON_CALLBACK = process.env.EPSILON_CALLBACK ||
    'https://pubmed-apartments-unix-implementation.trycloudflare.com/api/points/epsilon/callback';
const EPSILON_RETURN = process.env.EPSILON_RETURN ||
    'https://pubmed-apartments-unix-implementation.trycloudflare.com/portal/';

// ─── Ticket Plans ────────────────────────────────────────────────────────────
const TICKET_PLANS = [
    { id: 'plan_1h', name: '1時間チケット', hours: 1, price_per_hour: 800, discount: 0, badge: '' },
    { id: 'plan_3h', name: '3時間チケット', hours: 3, price_per_hour: 800, discount: 0, badge: '' },
    { id: 'plan_10h', name: '10時間チケット', hours: 10, price_per_hour: 750, discount: 6, badge: '💡 おすすめ' },
    { id: 'plan_30h', name: '30時間チケット', hours: 30, price_per_hour: 700, discount: 12, badge: '🔥 人気' },
    { id: 'plan_100h', name: '100時間チケット', hours: 100, price_per_hour: 650, discount: 18, badge: '👑 ベスト' },
];

function calcPlan(plan) {
    const amountYen = Math.round(plan.hours * plan.price_per_hour);
    const points = amountYen / POINT_RATE;
    return { ...plan, amount_yen: amountYen, points };
}

// ─── GET /api/points/balance ─────────────────────────────────────────────────
router.get('/balance', authMiddleware, (req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT point_balance, wallet_balance FROM users WHERE id = ?').get(req.user.id);
    res.json({
        point_balance: user?.point_balance || 0,
        point_rate: POINT_RATE,
        yen_value: (user?.point_balance || 0) * POINT_RATE,
    });
});

// ─── GET /api/points/logs ────────────────────────────────────────────────────
router.get('/logs', authMiddleware, (req, res) => {
    const db = getDb();
    const logs = db.prepare(
        "SELECT * FROM point_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
    ).all(req.user.id);
    res.json(logs);
});

// ─── GET /api/points/plans ───────────────────────────────────────────────────
router.get('/plans', (req, res) => {
    res.json(TICKET_PLANS.map(calcPlan));
});

// ─── POST /api/points/purchase ───────────────────────────────────────────────
// Initiate GMO Epsilon payment; returns redirect URL
router.post('/purchase', authMiddleware, (req, res) => {
    const { plan_id } = req.body;
    const plan = TICKET_PLANS.find(p => p.id === plan_id);
    if (!plan) return res.status(400).json({ error: '無効なプランIDです' });

    const db = getDb();
    const user = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(req.user.id);
    const p = calcPlan(plan);

    // Create pending purchase record
    const orderNum = `GPU${Date.now()}${req.user.id}`;
    const purchase = db.prepare(`
        INSERT INTO point_purchases
          (user_id, plan_name, hours, points, amount_yen, status, epsilon_order, gpu_id)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, 1)
    `).run(user.id, plan.name, plan.hours, p.points, p.amount_yen, orderNum);

    // Build GMO Epsilon payment params
    // Docs: https://www.epsilon.jp/api_manual.html
    const params = new URLSearchParams({
        contract_code: EPSILON_CONTRACT_CODE,
        order_number: orderNum,
        item_code: plan.id,
        item_name: encodeURIComponent(plan.name),
        item_price: p.amount_yen,
        user_id: `user_${user.id}`,
        user_name: encodeURIComponent(user.username),
        user_mail_add: user.email,
        st_code: '10',               // 10=クレジットカード
        mission_code: '1',                // 1=単発
        process_code: '1',                // 1=購入
        success_url: `${EPSILON_CALLBACK}?status=success&order=${orderNum}&purchase_id=${purchase.lastInsertRowid}`,
        failure_url: `${EPSILON_CALLBACK}?status=failure&order=${orderNum}`,
        cancel_url: `${EPSILON_CALLBACK}?status=cancel&order=${orderNum}`,
    });

    // For testing, if no contract code is set, simulate success immediately
    if (EPSILON_CONTRACT_CODE === 'TEST_CONTRACT') {
        const pid = purchase.lastInsertRowid;
        // Auto-approve in test mode
        db.prepare("UPDATE point_purchases SET status='completed', paid_at=CURRENT_TIMESTAMP WHERE id=?").run(pid);
        db.prepare("UPDATE users SET point_balance = point_balance + ? WHERE id=?").run(p.points, user.id);
        db.prepare(`INSERT INTO point_logs (user_id, points, type, description, ref_id)
                    VALUES (?, ?, 'purchase', ?, ?)`).run(user.id, p.points, `${plan.name}を購入`, pid);

        return res.json({
            success: true,
            test_mode: true,
            points_added: p.points,
            amount_yen: p.amount_yen,
            message: `✅ テストモード: ${p.points}pt (¥${p.amount_yen.toLocaleString()}) を付与しました`,
        });
    }

    const paymentUrl = `${EPSILON_URL}?${params.toString()}`;
    res.json({ redirect_url: paymentUrl, order_number: orderNum });
});

// ─── POST /api/points/epsilon/callback ──────────────────────────────────────
// GMO Epsilon payment result notification (webhook / redirect)
router.get('/epsilon/callback', (req, res) => {
    const { status, order, purchase_id } = req.query;
    const db = getDb();

    if (status === 'success') {
        const pid = parseInt(purchase_id);
        const purchase = db.prepare('SELECT * FROM point_purchases WHERE id = ? AND epsilon_order = ?').get(pid, order);
        if (purchase && purchase.status === 'pending') {
            db.prepare("UPDATE point_purchases SET status='completed', paid_at=CURRENT_TIMESTAMP WHERE id=?").run(pid);
            db.prepare("UPDATE users SET point_balance = point_balance + ? WHERE id=?").run(purchase.points, purchase.user_id);
            db.prepare(`INSERT INTO point_logs (user_id, points, type, description, ref_id)
                        VALUES (?, ?, 'purchase', ?, ?)`).run(
                purchase.user_id, purchase.points, `${purchase.plan_name}を購入`, pid
            );
        }
        res.redirect(`${EPSILON_RETURN}?payment=success&points=${purchase?.points || 0}`);
    } else if (status === 'failure') {
        const pid = parseInt(purchase_id) || 0;
        if (pid) db.prepare("UPDATE point_purchases SET status='failed' WHERE id=?").run(pid);
        res.redirect(`${EPSILON_RETURN}?payment=failed`);
    } else {
        res.redirect(`${EPSILON_RETURN}?payment=cancelled`);
    }
});

// ─── GET /api/points/purchases ───────────────────────────────────────────────
router.get('/purchases', authMiddleware, (req, res) => {
    const db = getDb();
    const purchases = db.prepare(
        "SELECT * FROM point_purchases WHERE user_id = ? ORDER BY created_at DESC LIMIT 20"
    ).all(req.user.id);
    res.json(purchases);
});

module.exports = router;
