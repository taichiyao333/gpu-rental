const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const https = require('https');
const { getDb } = require('../db/database');
const config = require('../config');
const { mailWelcome, mailPasswordReset } = require('../services/email');

// 笏笏 繝ｭ繧ｰ繧､繝ｳ繝悶Ν繝ｼ繝医ヵ繧ｩ繝ｼ繧ｹ蟇ｾ遲・ 隧ｦ陦後Ο繝・け 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏
const loginAttempts = new Map(); // { email: { count, lockedUntil } }
const MAX_ATTEMPTS  = 10;
const LOCK_DURATION = 30 * 60 * 1000; // 30蛻・
function checkLoginLock(email) {
    const rec = loginAttempts.get(email);
    if (!rec) return { locked: false };
    if (Date.now() < rec.lockedUntil) {
        const remaining = Math.ceil((rec.lockedUntil - Date.now()) / 60000);
        return { locked: true, remaining };
    }
    return { locked: false };
}
function recordFailedLogin(email) {
    const rec = loginAttempts.get(email) || { count: 0, lockedUntil: 0 };
    rec.count++;
    if (rec.count >= MAX_ATTEMPTS) {
        rec.lockedUntil = Date.now() + LOCK_DURATION;
        console.warn('[Security] Account locked: ' + email + ' (' + rec.count + ' failed attempts)');
    }
    loginAttempts.set(email, rec);
}
function clearLoginLock(email) { loginAttempts.delete(email); }
// 蜿､縺・Ο繝・け繝ｬ繧ｳ繝ｼ繝峨ｒ1譎る俣縺翫″縺ｫ繧ｯ繝ｪ繝ｼ繝ｳ繧｢繝・・
setInterval(() => {
    const now = Date.now();
    loginAttempts.forEach((rec, email) => {
        if (rec.lockedUntil && now > rec.lockedUntil + LOCK_DURATION) loginAttempts.delete(email);
    });
}, 60 * 60 * 1000);
// 笏笏 reCAPTCHA v3 讀懆ｨｼ 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏
async function verifyCaptcha(token) {
    const secretKey = process.env.RECAPTCHA_SECRET_KEY;
    if (!secretKey || !token) return true;
    return new Promise((resolve) => {
        const params = `secret=${encodeURIComponent(secretKey)}&response=${encodeURIComponent(token)}`;
        const options = {
            hostname: 'www.google.com',
            path: '/recaptcha/api/siteverify',
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(params) }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json.success && json.score >= 0.3);
                } catch { resolve(false); }
            });
        });
        req.on('error', () => resolve(true));
        req.write(params);
        req.end();
    });
}



// POST /api/auth/register
router.post('/register', async (req, res) => {
    const { username, email, password, captcha_token } = req.body;
    if (!username || !email || !password)
        return res.status(400).json({ error: '縺吶∋縺ｦ縺ｮ繝輔ぅ繝ｼ繝ｫ繝峨′蠢・ｦ√〒縺・ });
    if (password.length < 8)
        return res.status(400).json({ error: '繝代せ繝ｯ繝ｼ繝峨・8譁・ｭ嶺ｻ･荳翫↓縺励※縺上□縺輔＞' });
    if (!/[A-Z]/.test(password) && !/[0-9]/.test(password) && password.length < 12)
        return res.status(400).json({ error: '繝代せ繝ｯ繝ｼ繝峨・8譁・ｭ嶺ｻ･荳翫√∪縺溘・螟ｧ譁・ｭ励・謨ｰ蟄励ｒ蜷ｫ繧√※縺上□縺輔＞' });
    if (username.length < 3)
        return res.status(400).json({ error: '繝ｦ繝ｼ繧ｶ繝ｼ蜷阪・3譁・ｭ嶺ｻ･荳翫↓縺励※縺上□縺輔＞' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return res.status(400).json({ error: '譛牙柑縺ｪ繝｡繝ｼ繝ｫ繧｢繝峨Ξ繧ｹ繧貞・蜉帙＠縺ｦ縺上□縺輔＞' });

    // reCAPTCHA讀懆ｨｼ
    const captchaOk = await verifyCaptcha(captcha_token);
    if (!captchaOk) return res.status(400).json({ error: '閾ｪ蜍暮∽ｿ｡縺ｮ逍代＞縺後≠繧翫∪縺吶ゅｂ縺・ｸ蠎ｦ縺願ｩｦ縺励￥縺縺輔＞' });

    const db = getDb();
    try {
        const hash = bcrypt.hashSync(password, 12);
        const result = db.prepare(
            'INSERT INTO users (username, email, password_hash, status) VALUES (?, ?, ?, ?)'
        ).run(username, email, hash, 'active');
        const user = db.prepare('SELECT id, username, email, role, wallet_balance, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
        mailWelcome({ to: user.email, username: user.username }).catch(e => console.error('Welcome mail error:', e.message));
        res.status(201).json({ token, user });
    } catch (err) {
        if (err.message.includes('UNIQUE')) return res.status(409).json({ error: '縺薙・繝ｦ繝ｼ繧ｶ繝ｼ蜷阪∪縺溘・繝｡繝ｼ繝ｫ繧｢繝峨Ξ繧ｹ縺ｯ縺吶〒縺ｫ菴ｿ逕ｨ縺輔ｌ縺ｦ縺・∪縺・ });
        res.status(500).json({ error: err.message });
    }
});


// POST /api/auth/login
router.post('/login', async (req, res) => {
    const { email, password, captcha_token } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    // 繝ｭ繝・け繝√ぉ繝・け
    const lockStatus = checkLoginLock(email);
    if (lockStatus.locked) {
        return res.status(429).json({
            error: `繧｢繧ｫ繧ｦ繝ｳ繝医・荳譎ゅΟ繝・け縺輔ｌ縺ｦ縺・∪縺吶らｴ・{lockStatus.remaining}蛻・ｾ後↓蜀崎ｩｦ陦後＠縺ｦ縺上□縺輔＞縲Ａ
        });
    }

    // reCAPTCHA讀懆ｨｼ
    const captchaOk = await verifyCaptcha(captcha_token);
    if (!captchaOk) return res.status(400).json({ error: '閾ｪ蜍暮∽ｿ｡縺ｮ逍翫＞縺後≠繧翫∪縺吶ゅｂ縺・ｸ蠎ｦ縺願ｩｦ縺励￥縺縺輔＞' });

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND status = ?').get(email, 'active');
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        recordFailedLogin(email); // 螟ｱ謨励き繧ｦ繝ｳ繝医い繝・・
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    clearLoginLock(email); // 謌仙粥繝ｭ繧ｰ繧､繝ｳ縺ｧ繧ｫ繧ｦ繝ｳ繧ｿ繝ｪ繧ｻ繝・ヨ
    db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email, role: user.role, wallet_balance: user.wallet_balance } });
});

// GET /api/auth/me
router.get('/me', require('../middleware/auth').authMiddleware, (req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT id, username, email, role, wallet_balance, created_at, last_login FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
});

// 笏笏笏 繝代せ繝ｯ繝ｼ繝峨Μ繧ｻ繝・ヨ 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏

// POST /api/auth/forgot-password
// 繝｡繝ｼ繝ｫ繧｢繝峨Ξ繧ｹ繧貞女縺大叙繧翫√Μ繧ｻ繝・ヨ繝医・繧ｯ繝ｳ繧堤函謌舌＠縺ｦ繝｡繝ｼ繝ｫ繧帝∽ｿ｡
router.post('/forgot-password', (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: '繝｡繝ｼ繝ｫ繧｢繝峨Ξ繧ｹ繧貞・蜉帙＠縺ｦ縺上□縺輔＞' });

    const db = getDb();
    // status 縺ｫ髢｢繧上ｉ縺壹Γ繝ｼ繝ｫ繧｢繝峨Ξ繧ｹ縺御ｸ閾ｴ縺吶ｋ繝ｦ繝ｼ繧ｶ繝ｼ繧呈､懃ｴ｢
    // ・・uspended繝ｦ繝ｼ繧ｶ繝ｼ繧ゅヱ繧ｹ繝ｯ繝ｼ繝峨Μ繧ｻ繝・ヨ縺ｧ縺阪ｋ繧医≧縺ｫ縺吶ｋ・・
    const user = db.prepare('SELECT id, username, email, status FROM users WHERE email = ?').get(email);

    // 繧ｻ繧ｭ繝･繝ｪ繝・ぅ縺ｮ縺溘ａ縲√Θ繝ｼ繧ｶ繝ｼ縺悟ｭ伜惠縺励↑縺上※繧ょ酔縺倥Ξ繧ｹ繝昴Φ繧ｹ繧定ｿ斐☆
    if (!user) {
        console.log(`[forgot-password] Email not found: ${email}`);
        return res.json({ message: '繝｡繝ｼ繝ｫ縺悟ｭ伜惠縺吶ｋ蝣ｴ蜷医・縲√Μ繧ｻ繝・ヨ逕ｨ縺ｮ繝｡繝ｼ繝ｫ繧偵♀騾√ｊ縺励∪縺励◆縲・ });
    }

    // 繝医・繧ｯ繝ｳ逕滓・・・2繝舌う繝医・繝ｩ繝ｳ繝繝譁・ｭ怜・・・
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000); // 3譎る俣蠕・

    // 繝・・繝悶Ν縺悟ｭ伜惠縺励↑縺・ｴ蜷医・ exec() 縺ｧ菴懈・・・igrations 縺ｧ菴懈・貂医∩縺ｮ縺ｯ縺壹□縺悟ｿｵ縺ｮ縺溘ａ・・
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS password_resets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token TEXT NOT NULL UNIQUE,
            expires_at TEXT NOT NULL,
            used INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
    } catch (e) { /* table already exists */ }

    // 蜿､縺・ヨ繝ｼ繧ｯ繝ｳ繧貞炎髯､・亥酔荳繝ｦ繝ｼ繧ｶ繝ｼ縺ｮ譛ｪ菴ｿ逕ｨ繝医・繧ｯ繝ｳ・・
    try {
        db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
    } catch (e) { /* ignore */ }

    // 譁ｰ縺励＞繝医・繧ｯ繝ｳ繧剃ｿ晏ｭ・
    db.prepare(
        'INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)'
    ).run(user.id, token, expiresAt.toISOString());

    // 繝代せ繝ｯ繝ｼ繝峨Μ繧ｻ繝・ヨ繝｡繝ｼ繝ｫ繧帝∽ｿ｡
    mailPasswordReset({ to: user.email, username: user.username, token })
        .catch(e => console.error('Reset mail error:', e.message));

    // C-1: Only log reset token in development (never in production)
    if (process.env.NODE_ENV !== 'production') {
        console.log(`泊 [DEV ONLY] Password reset token for ${email}: ${token}`);
    } else {
        console.log(`泊 Password reset requested for user #${user.id}`);
    }
    res.json({ message: '繝｡繝ｼ繝ｫ縺悟ｭ伜惠縺吶ｋ蝣ｴ蜷医・縲√Μ繧ｻ繝・ヨ逕ｨ縺ｮ繝｡繝ｼ繝ｫ繧偵♀騾√ｊ縺励∪縺励◆縲・ });
});

// POST /api/auth/reset-password
// 繝医・繧ｯ繝ｳ繧呈､懆ｨｼ縺励※譁ｰ縺励＞繝代せ繝ｯ繝ｼ繝峨ｒ險ｭ螳・
router.post('/reset-password', (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: '繝医・繧ｯ繝ｳ縺ｨ繝代せ繝ｯ繝ｼ繝峨′蠢・ｦ√〒縺・ });
    if (password.length < 8) return res.status(400).json({ error: '繝代せ繝ｯ繝ｼ繝峨・8譁・ｭ嶺ｻ･荳翫↓縺励※縺上□縺輔＞' });

    const db = getDb();

    // 繝・・繝悶Ν縺悟ｭ伜惠縺励↑縺・ｴ蜷医・ exec() 縺ｧ菴懈・・亥ｿｵ縺ｮ縺溘ａ・・
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS password_resets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token TEXT NOT NULL UNIQUE,
            expires_at TEXT NOT NULL,
            used INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
    } catch (e) { /* exists */ }

    const reset = db.prepare(
        'SELECT * FROM password_resets WHERE token = ? AND used = 0'
    ).get(token);

    console.log(`[reset-password] token=${token.substring(0, 16)}... found=${!!reset}`);
    if (!reset) {
        // DB蜀・・蜈ｨ繝医・繧ｯ繝ｳ謨ｰ繧ゅΟ繧ｰ縺励※繝・ヰ繝・げ繧貞ｮｹ譏薙↓
        try {
            const count = db.prepare('SELECT COUNT(*) as c FROM password_resets').get();
            console.log(`[reset-password] total tokens in DB: ${count.c}`);
        } catch (e) { /* ignore */ }
        return res.status(400).json({ error: '繝医・繧ｯ繝ｳ縺檎┌蜉ｹ縺ｾ縺溘・譛滄剞蛻・ｌ縺ｧ縺・ });
    }

    // 譛牙柑譛滄剞繝√ぉ繝・け
    if (new Date() > new Date(reset.expires_at)) {
        db.prepare('DELETE FROM password_resets WHERE id = ?').run(reset.id);
        console.log(`[reset-password] token expired at ${reset.expires_at}`);
        return res.status(400).json({ error: '繝医・繧ｯ繝ｳ縺ｮ譛牙柑譛滄剞縺悟・繧後※縺・∪縺吶ゅｂ縺・ｸ蠎ｦ繝ｪ繧ｻ繝・ヨ繧偵♀隧ｦ縺励￥縺縺輔＞' });
    }

    // 繝代せ繝ｯ繝ｼ繝峨ｒ譖ｴ譁ｰ・亥酔譎ゅ↓繧ｹ繝・・繧ｿ繧ｹ繧・active 縺ｫ謌ｻ縺呻ｼ・
    const hash = bcrypt.hashSync(password, 12);
    db.prepare('UPDATE users SET password_hash = ?, status = ? WHERE id = ?').run(hash, 'active', reset.user_id);

    // 繝医・繧ｯ繝ｳ繧貞炎髯､
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(reset.user_id);

    console.log(`笨・Password reset complete for user #${reset.user_id}`);
    res.json({ message: '繝代せ繝ｯ繝ｼ繝峨ｒ螟画峩縺励∪縺励◆縲よ眠縺励＞繝代せ繝ｯ繝ｼ繝峨〒繝ｭ繧ｰ繧､繝ｳ縺励※縺上□縺輔＞縲・ });
});


// ─── THE DOJO エージェントトークン管理 ──────────────────────────────────────

// GET /api/auth/agent-token — 自分の agent_token を取得
router.get('/agent-token', require('../middleware/auth').authMiddleware, (req, res) => {
    const db = getDb();
    const user = db.prepare('SELECT id, agent_token FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません' });
    if (!user.agent_token) {
        const newToken = require('crypto').randomBytes(32).toString('hex');
        db.prepare('UPDATE users SET agent_token = ? WHERE id = ?').run(newToken, user.id);
        user.agent_token = newToken;
    }
    res.json({
        agent_token: user.agent_token,
        usage: {
            header: 'X-Agent-Token',
            example: `curl -H "X-Agent-Token: ${user.agent_token}" -X POST /api/sf/nodes/heartbeat`,
        },
    });
});

// POST /api/auth/agent-token/regenerate — トークン再生成（漏洩対応）
router.post('/agent-token/regenerate', require('../middleware/auth').authMiddleware, (req, res) => {
    const db = getDb();
    const newToken = require('crypto').randomBytes(32).toString('hex');
    db.prepare('UPDATE users SET agent_token = ? WHERE id = ?').run(newToken, req.user.id);
    console.log(`[Auth] Agent token regenerated for user #${req.user.id}`);
    res.json({
        agent_token: newToken,
        message: '新しいエージェントトークンを生成しました。THE DOJO エージェントの設定を更新してください。',
    });
});

module.exports = router;


