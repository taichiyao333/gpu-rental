require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
let compression; try { compression = require('compression'); } catch(_) { compression = null; }

const config = require('./config');
const { runMigrations } = require('./db/migrations');
const { initDb } = require('./db/database');
const { startGpuMonitor, getGpuNodesWithStats } = require('./services/gpuManager');
const { startScheduler } = require('./services/scheduler');
const { attachTerminal } = require('./services/terminal');
const { startBackupScheduler } = require('./services/backup');

// Routes
const authRoutes = require('./routes/auth');
const gpuRoutes = require('./routes/gpus');
const reservationRoutes = require('./routes/reservations');
const podRoutes = require('./routes/pods');
const adminRoutes = require('./routes/admin');
const fileRoutes = require('./routes/files');
const paymentRoutes = require('./routes/payments');
const providerRoutes = require('./routes/providers');
const bankAccountRoutes = require('./routes/bankAccounts');
const { router: priceRoutes } = require('./routes/prices');
const pointRoutes = require('./routes/points');
const outageRoutes = require('./routes/outage');
const couponRoutes = require('./routes/coupons');
const { router: apiKeyRoutes } = require('./routes/apikeys');
const diagnosticsRoutes = require('./routes/diagnostics');
const renderRoutes = require('./routes/render');
const stripeRoutes = require('./routes/stripe');


// ─── Startup Environment Validation ────────────────────────────────────────
const REQUIRED_ENV = ['JWT_SECRET'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
    console.error(`❌ STARTUP FAILED: Missing required environment variables: ${missingEnv.join(', ')}`);
    console.error('   Please set them in your .env file.');
    process.exit(1);
}

// ─── CORS Origin List ────────────────────────────────────────────────────────
const corsOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
// In development, also allow localhost variants
if (process.env.NODE_ENV !== 'production') {
    corsOrigins.push('http://localhost:3000', 'http://127.0.0.1:3000');
}
const corsOptions = {
    origin: (origin, cb) => {
        // Allow same-origin requests (no Origin header) and whitelisted origins
        if (!origin || corsOrigins.includes(origin) || corsOrigins.includes('*')) return cb(null, true);
        console.warn(`⚠️  CORS blocked: ${origin}`);
        return cb(new Error(`CORS policy: origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
};

// ─── App Setup ───────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: (origin, cb) => corsOptions.origin(origin, cb),
        methods: ['GET', 'POST'],
        credentials: true,
    },
});

// ─── Ensure Storage Directories ──────────────────────────────────────────────
[
    config.storage.basePath,
    config.storage.usersPath,
    config.storage.sharedPath,
    path.dirname(config.storage.dbPath),
].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log('📁 Created:', dir);
    }
});

// ─── Middleware ───────────────────────────────────────────────────────────────
// Trust Cloudflare / reverse proxy headers (required for express-rate-limit behind Cloudflare Tunnel)
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors(corsOptions));
// gzip圧縮 (compressionがインストール済みの場合のみ)
if (compression) {
    app.use(compression({ filter: (req, res) => {
        if (req.headers['x-no-compression']) return false;
        return compression.filter(req, res);
    }}));
    console.log('✅ gzip compression enabled');
}
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Rate limiting
app.use('/api/auth/login', rateLimit(config.rateLimit.login));
// H-4: Password reset endpoints — very strict to prevent token brute-force
app.use('/api/auth/forgot-password', rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 3,
    message: { error: 'パスワードリセットは1時間に3回までです。しばらくお待ちください。' },
    standardHeaders: true,
    legacyHeaders: false,
}));
app.use('/api/auth/reset-password', rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5,
    message: { error: 'リセット操作の上限に達しました。15分後に再試行してください。' },
    standardHeaders: true,
    legacyHeaders: false,
}));
// Admin panel makes many API calls — use a more relaxed limit
app.use('/api/admin', rateLimit({ windowMs: 60 * 1000, max: 500, standardHeaders: true, legacyHeaders: false }));
app.use('/api/', rateLimit(config.rateLimit.api));

// Named pages — static より前に定義することで優先マッチさせる
app.get('/terms.html', (req, res) => res.sendFile(path.join(__dirname, '../public/landing/terms.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, '../public/landing/terms.html')));
app.get('/privacy.html', (req, res) => res.sendFile(path.join(__dirname, '../public/landing/privacy.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, '../public/landing/privacy.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, '../public/landing/pricing.html')));
app.get('/pricing.html', (req, res) => res.sendFile(path.join(__dirname, '../public/landing/pricing.html')));

// Static files - serve each UI as a subdirectory
// キャッシュ設定: CSS/JS/画像は7日間ブラウザキャッシュ, HTMLは毎回確認
const staticOpts = {
    maxAge: '7d',
    setHeaders: (res, filePath) => {
        // HTMLは常に最新を取得（no-cache）
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        } else if (/\.(css|js)$/.test(filePath)) {
            // CSS/JSは長期キャッシュ
            res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
        } else if (/\.(png|jpg|jpeg|gif|svg|ico|webp|woff2|woff|ttf)$/.test(filePath)) {
            // 画像/フォントは30日キャッシュ
            res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
        }
    }
};

app.use(express.static(path.join(__dirname, '../public'), staticOpts));
app.use('/', express.static(path.join(__dirname, '../public/landing'), staticOpts));
app.use('/portal', express.static(path.join(__dirname, '../public/portal'), staticOpts));
app.use('/workspace', express.static(path.join(__dirname, '../public/workspace'), staticOpts));
app.use('/admin', express.static(path.join(__dirname, '../public/admin'), staticOpts));
app.use('/provider', express.static(path.join(__dirname, '../public/provider'), staticOpts));
app.use('/mypage', express.static(path.join(__dirname, '../public/mypage'), staticOpts));


// Root → landing page
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/landing/index.html')));

// /pricing → static のあとに配置（public/pricing.html を直接配信）
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, '../public/pricing.html')));
app.get('/pricing.html', (req, res) => res.sendFile(path.join(__dirname, '../public/pricing.html')));

// SPA fallback routes
app.get('/portal/*', (req, res) => res.sendFile(path.join(__dirname, '../public/portal/index.html')));
app.get('/workspace/*', (req, res) => res.sendFile(path.join(__dirname, '../public/workspace/index.html')));
app.get('/admin/*', (req, res) => res.sendFile(path.join(__dirname, '../public/admin/index.html')));
app.get('/provider/*', (req, res) => res.sendFile(path.join(__dirname, '../public/provider/index.html')));
app.get('/mypage', (req, res) => res.sendFile(path.join(__dirname, '../public/mypage/index.html')));
app.get('/mypage/*', (req, res) => res.sendFile(path.join(__dirname, '../public/mypage/index.html')));

// ─── Maintenance Mode Middleware ───────────────────────────────────────────
// Allow: admin pages, admin API, auth API, health check
// Block: everything else when maintenance is ON
const MAINT_BYPASS = [
    '/api/auth',
    '/api/admin',
    '/api/health',
    '/api/bench',
    '/api/maintenance/status',
    '/api/points/epsilon/callback', // GMO Epsilon: メンテ中でも決済コールバックを処理する
    '/admin',
    '/socket.io',
];


app.use((req, res, next) => {
    if (!global.maintenanceMode?.enabled) return next();
    const bypass = MAINT_BYPASS.some(p => req.path.startsWith(p));
    if (bypass) return next();
    // API requests → JSON 503
    if (req.path.startsWith('/api/')) {
        return res.status(503).json({
            error: 'maintenance',
            message: global.maintenanceMode.message,
        });
    }
    // Page requests → maintenance page
    return res.status(503).sendFile(path.join(__dirname, '../public/maintenance.html'));
});

// ─── Public Maintenance Status (no auth required) ─────────────────────────
// フロントエンドJSが認証なしでメンテ状態を確認するためのパブリックAPI
app.get('/api/maintenance/status', (req, res) => {
    res.json({
        enabled: global.maintenanceMode?.enabled ?? false,
        message: global.maintenanceMode?.message ?? '',
    });
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/gpus', gpuRoutes);
app.use('/api/reservations', reservationRoutes);
app.use('/api/pods', podRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/providers', providerRoutes);
app.use('/api/bank-accounts', bankAccountRoutes);
app.use('/api/points', pointRoutes);
app.use('/api/outage', outageRoutes);
app.use('/api/prices', priceRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/user/apikeys', apiKeyRoutes);
app.use('/api/diagnose', diagnosticsRoutes);
app.use('/api/render', renderRoutes(io));
app.use('/api/stripe', stripeRoutes);
app.use('/api/admin', adminRoutes);

// reCAPTCHA サイトキー公開エンドポイント（秘密キーは返さない）
app.get('/api/config/recaptcha', (req, res) => {
    res.json({ site_key: process.env.RECAPTCHA_SITE_KEY || null });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});


// ─── Bandwidth Benchmark ─────────────────────────────────────────────────────
// ダウンロード速度計測用: ランダム 500KB ペイロード
const BENCH_SIZE = 512 * 1024; // 512 KB
const benchPayload = Buffer.alloc(BENCH_SIZE, 'X');
app.get('/api/bench/download', (req, res) => {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', BENCH_SIZE);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Bench-Time', Date.now());
    res.end(benchPayload);
});
// アップロード速度計測用: body を受け取って時間を返す
app.post('/api/bench/upload', (req, res) => {
    let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; });
    req.on('end', () => {
        res.json({ received_bytes: bytes, server_time: Date.now() });
    });
});


// ─── 404 Handlers ─────────────────────────────────────────────────────────────
// API 404
app.use('/api/*', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found', path: req.path });
});

// Frontend 404 — すべての未知URLに404.htmlを返す
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, '../public/404.html'));
});

// Global error handler
app.use((err, req, res, _next) => {
    console.error('Unhandled error:', err);
    if (req.path.startsWith('/api/')) {
        res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
    } else {
        res.status(500).sendFile(path.join(__dirname, '../public/404.html'));
    }
});



io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // Join room based on user/role
    socket.on('auth', (token) => {
        try {
            const jwt = require('jsonwebtoken');
            const decoded = jwt.verify(token, config.jwt.secret);
            socket.userId = decoded.id;
            socket.userRole = decoded.role;
            socket.join(`user_${decoded.id}`);
            if (decoded.role === 'admin') socket.join('admin');
            socket.emit('auth:ok', { userId: decoded.id, role: decoded.role });
        } catch { /* ignore invalid tokens */ }
    });

    // Terminal attachment request
    socket.on('terminal:attach', async (data) => {
        try {
            if (!socket.userId) return socket.emit('terminal:error', 'Not authenticated');
            const { getDb } = require('./db/database');
            const db = getDb();
            const user = db.prepare('SELECT id,username,role FROM users WHERE id=?').get(socket.userId);
            const pod = data?.podId
                ? db.prepare('SELECT * FROM pods WHERE id=? AND renter_id=?').get(data.podId, socket.userId)
                : db.prepare('SELECT * FROM pods WHERE renter_id=? AND status="running" ORDER BY started_at DESC LIMIT 1').get(socket.userId);
            if (!user) return socket.emit('terminal:error', 'User not found');
            attachTerminal(socket, pod || { workspace_path: require('./config').storage.usersPath + '/' + socket.userId }, user);
        } catch (e) {
            socket.emit('terminal:error', e.message);
        }
    });

    socket.on('disconnect', () => {
        console.log(`🔌 Client disconnected: ${socket.id}`);
    });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function start() {
    console.log('\n🚀 GPU Rental Platform starting...\n');

    // DB Init & Migrations
    await runMigrations();

    // Start GPU monitor
    startGpuMonitor(io);

    // Start scheduler (auto-start/stop pods)
    startScheduler(io);

    // Start DB backup scheduler (daily 3am, keep 7 days)
    startBackupScheduler();
    console.log('✅ DB backup scheduler started');


    // Start server
    server.listen(config.port, () => {
        console.log(`\n✅ Server running at http://localhost:${config.port}`);
        console.log(`📊 Portal:     http://localhost:${config.port}/portal/`);
        console.log(`🛡  Admin:      http://localhost:${config.port}/admin/`);
        console.log(`💻 Workspace:  http://localhost:${config.port}/workspace/`);
        console.log(`🏭 Provider:   http://localhost:${config.port}/provider/`);
        console.log('\n─────────────────────────────────────────────');
        console.log(`📧 Admin: ${process.env.ADMIN_EMAIL || 'taichi.yao@gmail.com'} / [see .env ADMIN_PASSWORD]`);
        console.log('─────────────────────────────────────────────\n');
    });
}

// Export io for use in other modules
module.exports = { io };

start().catch(err => {
    console.error('Failed to start:', err);
    process.exit(1);
});
