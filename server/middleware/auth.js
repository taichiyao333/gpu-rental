const jwt = require('jsonwebtoken');
const config = require('../config');
const { getDb } = require('../db/database');

function authMiddleware(req, res, next) {
    // Support Bearer header OR ?token= query parameter (for download links)
    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
    } else if (req.query.token) {
        token = req.query.token;
    }

    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }
    try {
        const decoded = jwt.verify(token, config.jwt.secret);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

function adminOnly(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

function providerOrAdmin(req, res, next) {
    if (req.user.role !== 'admin' && req.user.role !== 'provider') {
        return res.status(403).json({ error: 'Provider or admin access required' });
    }
    next();
}

/**
 * THE DOJO エージェント専用認証
 * X-Agent-Token ヘッダー または ?agent_token= クエリで認証。
 * users.agent_token と照合し、一致したプロバイダーユーザーを req.user にセット。
 * JWT authMiddleware より軽量で長期トークン運用に向く。
 */
function agentTokenMiddleware(req, res, next) {
    const token =
        req.headers['x-agent-token'] ||
        req.query.agent_token ||
        null;

    if (!token) {
        return res.status(401).json({ error: 'Agent token required (X-Agent-Token header)' });
    }

    try {
        const db = getDb();
        const user = db.prepare(
            `SELECT id, username, email, role, agent_token FROM users WHERE agent_token = ?`
        ).get(token);

        if (!user) {
            return res.status(401).json({ error: 'Invalid agent token' });
        }

        req.user = { id: user.id, username: user.username, role: user.role, agent_token: user.agent_token };
        next();
    } catch (err) {
        console.error('[agentTokenMiddleware]', err.message);
        return res.status(500).json({ error: 'Auth error' });
    }
}

/**
 * authMiddleware または agentTokenMiddleware のどちらでも通過できる複合ミドルウェア。
 * SF ハートビートは JWT ユーザーからも、エージェントトークンからも受け付ける。
 */
function authOrAgent(req, res, next) {
    const hasBearer = req.headers.authorization?.startsWith('Bearer ');
    const hasAgent  = req.headers['x-agent-token'] || req.query.agent_token;

    if (hasAgent && !hasBearer) {
        return agentTokenMiddleware(req, res, next);
    }
    return authMiddleware(req, res, next);
}

module.exports = { authMiddleware, adminOnly, providerOrAdmin, agentTokenMiddleware, authOrAgent };
