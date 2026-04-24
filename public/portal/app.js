/* ─── State ─────────────────────────────────────────────────────── */
const state = {
    token: localStorage.getItem('gpu_token') || null,
    user: JSON.parse(localStorage.getItem('gpu_user') || 'null'),
    gpus: [],
    selectedGpuId: null,
    reservations: [],
};

// API base: '' = same origin (works for both local dev and any production domain/tunnel)
const API = (function () {
    // Always use relative paths 窶・same-origin works for all environments
    return '';
})();
let socket = null;

/* ─── Utilities ─────────────────────────────────────────────────── */
function showToast(msg, type = 'info') {
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4000);
}

async function apiFetch(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
    const res = await fetch(`${API}/api${path}`, { ...opts, headers: { ...headers, ...opts.headers } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'API Error');
    return data;
}


// JST蜈ｱ騾壹ヵ繧ｩ繝ｼ繝槭ャ繝磯未謨ｰ
const JST = { timeZone: 'Asia/Tokyo' };
function formatDate(d) {
    return new Date(d).toLocaleString('ja-JP', { ...JST, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtJp(d) {
    return new Date(d).toLocaleString('ja-JP', { ...JST, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtJpDate(d) {
    return new Date(d).toLocaleDateString('ja-JP', { ...JST, year: 'numeric', month: '2-digit', day: '2-digit' });
}
function fmtJpTime(d) {
    return new Date(d).toLocaleTimeString('ja-JP', { ...JST, hour: '2-digit', minute: '2-digit' });
}

function formatMins(mins) {
    const h = Math.floor(mins / 60), m = mins % 60;
    return h > 0 ? `${h}時間${m}分` : `${m}分`;
}

/* ─── Auth ──────────────────────────────────────────────────────── */
function updateNavAuth() {
    const auth = document.getElementById('navAuth');
    const user = document.getElementById('navUser');
    const username = document.getElementById('navUsername');
    const adminBtn = document.getElementById('btnAdmin');
    const workspaceBtn = document.getElementById('btnWorkspace');
    const lobbyBtn = document.getElementById('btnLobby');

    if (state.user) {
        auth.classList.add('hidden');
        user.classList.remove('hidden');
        username.textContent = `👤 ${state.user.username}`;
        if (state.user.role === 'admin') adminBtn.classList.remove('hidden');
        // THE LOBBY 繝懊ち繝ｳ: token繧痴essionStorage縺ｫ繧ょ酔譛・(THE LOBBY逕ｨ)
        if (state.token) sessionStorage.setItem('token', state.token);
        if (lobbyBtn) lobbyBtn.style.display = 'inline-flex';
    } else {
        auth.classList.remove('hidden');
        user.classList.add('hidden');
        if (lobbyBtn) lobbyBtn.style.display = 'none';
    }
}


document.getElementById('btnLogin').addEventListener('click', () => {
    openAuthModal('login');
});
document.getElementById('btnRegister').addEventListener('click', () => {
    openAuthModal('register');
});
document.getElementById('heroReserve').addEventListener('click', () => {
    // login guard removed
    document.getElementById('gpus').scrollIntoView({ behavior: 'smooth' });
});
document.getElementById('heroProvide').addEventListener('click', () => {
    window.location.href = '/provider/';
});
document.getElementById('btnLogout').addEventListener('click', () => {
    localStorage.removeItem('gpu_token');
    localStorage.removeItem('gpu_user');
    state.token = null;
    state.user = null;
    updateNavAuth();
    showToast('ログアウトしました', 'info');
});

function openAuthModal(tab) {
    document.getElementById('authOverlay').classList.remove('hidden');
    if (tab === 'register') {
        document.getElementById('tabRegister').click();
    }
}
document.getElementById('authClose').addEventListener('click', () => {
    document.getElementById('authOverlay').classList.add('hidden');
});
document.getElementById('authOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('authOverlay'))
        document.getElementById('authOverlay').classList.add('hidden');
});

// Tab switching
document.getElementById('tabLogin').addEventListener('click', () => {
    document.getElementById('tabLogin').classList.add('active');
    document.getElementById('tabRegister').classList.remove('active');
    document.getElementById('loginForm').classList.remove('hidden');
    document.getElementById('registerForm').classList.add('hidden');
});
document.getElementById('tabRegister').addEventListener('click', () => {
    document.getElementById('tabRegister').classList.add('active');
    document.getElementById('tabLogin').classList.remove('active');
    document.getElementById('registerForm').classList.remove('hidden');
    document.getElementById('loginForm').classList.add('hidden');
});

// Login
document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('loginError');
    errEl.classList.add('hidden');
    try {
        // reCAPTCHA v3 token
        let captcha_token = null;
        if (window.grecaptcha && window._recaptchaSiteKey) {
            captcha_token = await new Promise(r => window.grecaptcha.ready(() =>
                window.grecaptcha.execute(window._recaptchaSiteKey, { action: 'login' }).then(r)
            ));
        }
        const data = await apiFetch('/auth/login', {
            method: 'POST',
            body: JSON.stringify({
                email: document.getElementById('loginEmail').value,
                password: document.getElementById('loginPassword').value,
                captcha_token,
            }),
        });
        state.token = data.token;
        state.user = data.user;
        localStorage.setItem('gpu_token', data.token);
        localStorage.setItem('gpu_user', JSON.stringify(data.user));
        document.getElementById('authOverlay').classList.add('hidden');
        updateNavAuth();
        connectSocket();
        showToast(`ようこそ！${data.user.username}さん`, 'success');
        loadMyReservations();
    } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
    }
});

// Register
document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('regError');
    errEl.classList.add('hidden');
    try {
        // reCAPTCHA v3 token
        let captcha_token = null;
        if (window.grecaptcha && window._recaptchaSiteKey) {
            captcha_token = await new Promise(r => window.grecaptcha.ready(() =>
                window.grecaptcha.execute(window._recaptchaSiteKey, { action: 'register' }).then(r)
            ));
        }
        const data = await apiFetch('/auth/register', {
            method: 'POST',
            body: JSON.stringify({
                username: document.getElementById('regUsername').value,
                email: document.getElementById('regEmail').value,
                password: document.getElementById('regPassword').value,
                captcha_token,
            }),
        });
        state.token = data.token;
        state.user = data.user;
        localStorage.setItem('gpu_token', data.token);
        localStorage.setItem('gpu_user', JSON.stringify(data.user));
        document.getElementById('authOverlay').classList.add('hidden');
        updateNavAuth();
        connectSocket();
        showToast('登録しました！ようこそ！', 'success');
    } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
    }
});

/* ─── 繝代せ繝ｯ繝ｼ繝峨Μ繧ｻ繝・ヨ ───────────────────────────────────────────── */

// 縲後ヱ繧ｹ繝ｯ繝ｼ繝峨ｒ縺雁ｿ倥ｌ縺ｮ譁ｹ縲阪Μ繝ｳ繧ｯ
document.getElementById('forgotPasswordLink').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('authOverlay').classList.add('hidden');
    openResetModal();
});

// 繝ｪ繧ｻ繝・ヨ繝｢繝ｼ繝繝ｫ繧帝幕縺・
function openResetModal(showStep2 = false) {
    const overlay = document.getElementById('resetOverlay');
    overlay.classList.remove('hidden');
    if (showStep2) {
        document.getElementById('resetStep1').classList.add('hidden');
        document.getElementById('resetStep2').classList.remove('hidden');
    } else {
        document.getElementById('resetStep1').classList.remove('hidden');
        document.getElementById('resetStep2').classList.add('hidden');
    }
    // 繧ｨ繝ｩ繝ｼ繝ｻ謌仙粥繝｡繝・そ繝ｼ繧ｸ繧偵け繝ｪ繧｢
    ['forgotError', 'forgotSuccess', 'resetError', 'resetSuccess'].forEach(id => {
        const el = document.getElementById(id);
        el.classList.add('hidden');
        el.textContent = '';
    });
}

// 繝ｪ繧ｻ繝・ヨ繝｢繝ｼ繝繝ｫ繧帝哩縺倥ｋ
document.getElementById('resetClose').addEventListener('click', () => {
    document.getElementById('resetOverlay').classList.add('hidden');
    // URL縺九ｉreset_token繧帝勁蜴ｻ
    const url = new URL(window.location.href);
    url.searchParams.delete('reset_token');
    window.history.replaceState({}, '', url.toString());
});
document.getElementById('resetOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('resetOverlay')) {
        document.getElementById('resetOverlay').classList.add('hidden');
    }
});
document.getElementById('backToLoginLink').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('resetOverlay').classList.add('hidden');
    openAuthModal('login');
});

// Step1: 繝｡繝ｼ繝ｫ繧｢繝峨Ξ繧ｹ繧帝∽ｿ｡縺励※繝ｪ繧ｻ繝・ヨ繝｡繝ｼ繝ｫ繧定ｦ∵ｱ・
document.getElementById('forgotForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('forgotError');
    const successEl = document.getElementById('forgotSuccess');
    const btn = document.getElementById('forgotSubmitBtn');
    errEl.classList.add('hidden');
    successEl.classList.add('hidden');
    btn.disabled = true;
        btn.textContent = '送信中...';
    try {
        const data = await apiFetch('/auth/forgot-password', {
            method: 'POST',
            body: JSON.stringify({ email: document.getElementById('forgotEmail').value }),
        });
        successEl.textContent = data.message || 'リセットメールを送信しました。メールをご確認ください。';
        successEl.classList.remove('hidden');
        btn.textContent = '送信済み';
    } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = 'リセットメールを送信';
    }
});

// Step2: 譁ｰ縺励＞繝代せ繝ｯ繝ｼ繝峨ｒ險ｭ螳・
document.getElementById('resetPasswordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('resetError');
    const successEl = document.getElementById('resetSuccess');
    errEl.classList.add('hidden');
    successEl.classList.add('hidden');

    const newPw = document.getElementById('newPassword').value;
    const newPwConfirm = document.getElementById('newPasswordConfirm').value;
    if (newPw !== newPwConfirm) {
        errEl.textContent = 'パスワードが一致しません';
        errEl.classList.remove('hidden');
        return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const resetToken = urlParams.get('reset_token');
    if (!resetToken) {
        errEl.textContent = 'リセットトークンが見つかりません。メールのリンクをクリックしてください。';
        errEl.classList.remove('hidden');
        return;
    }

    try {
        const data = await apiFetch('/auth/reset-password', {
            method: 'POST',
            body: JSON.stringify({ token: resetToken, password: newPw }),
        });
        successEl.textContent = data.message || 'パスワードを変更しました。';
        successEl.classList.remove('hidden');
        // URL縺九ｉ繝医・繧ｯ繝ｳ繧帝勁蜴ｻ
        const url = new URL(window.location.href);
        url.searchParams.delete('reset_token');
        window.history.replaceState({}, '', url.toString());
        // 3遘貞ｾ後↓繝ｭ繧ｰ繧､繝ｳ繝｢繝ｼ繝繝ｫ繧定｡ｨ遉ｺ
        setTimeout(() => {
            document.getElementById('resetOverlay').classList.add('hidden');
            openAuthModal('login');
            showToast('パスワードを変更しました。新しいパスワードでログインしてください。', 'success');
        }, 2500);
    } catch (err) {
        errEl.textContent = err.message;
        errEl.classList.remove('hidden');
    }
});

// 繝壹・繧ｸ隱ｭ縺ｿ霎ｼ縺ｿ譎・ URL縺ｫ reset_token 縺後≠繧句ｴ蜷医・閾ｪ蜍輔〒Step2繧定｡ｨ遉ｺ
(function checkResetToken() {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('reset_token')) {
        // 繝壹・繧ｸ隱ｭ縺ｿ霎ｼ縺ｿ蠕後↓繝｢繝ｼ繝繝ｫ繧帝幕縺・
        window.addEventListener('DOMContentLoaded', () => openResetModal(true), { once: true });
        if (document.readyState !== 'loading') openResetModal(true);
    }
})();


/* ─── GPU List ──────────────────────────────────────────────────── */
async function loadGpus() {
    try {
        const gpus = await apiFetch('/gpus');
        state.gpus = gpus;
        renderGpuGrid(gpus);
        // GPU逋ｻ骭ｲ謨ｰ繧呈峩譁ｰ・医ヵ繧ｩ繝ｼ繝ｫ繝舌ャ繧ｯ・・
        const el = document.getElementById('statGpus');
        if (el && el.textContent === '-') el.textContent = gpus.length;
    } catch (err) {
        console.error('Failed to load GPUs:', err);
    }
}

/* ─── Hero Statistics (live counts) ─────────────────────────────── */
function animateCount(el, target, suffix = '') {
    if (!el) return;
    const start = 0;
    const duration = 800;
    const startTime = performance.now();
    const tick = (now) => {
        const progress = Math.min((now - startTime) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
        el.textContent = Math.round(start + (target - start) * eased) + suffix;
        if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}

async function loadHeroStats() {
    try {
        const stats = await fetch(`${API}/api/gpus/stats`).then(r => r.json());
        animateCount(document.getElementById('statGpus'), stats.gpu_total || 0);
        animateCount(document.getElementById('statAvail'), stats.gpu_avail || 0);
        animateCount(document.getElementById('statUsers'), stats.user_count || 0);
    } catch (err) {
        // 繝輔か繝ｼ繝ｫ繝舌ャ繧ｯ: loadGpus 縺ｮ邨先棡繧剃ｽｿ縺・
        console.warn('Stats API not available, using GPU list fallback');
    }
}

function renderGpuGrid(gpus) {
    const grid = document.getElementById('gpuGrid');
    if (!gpus.length) {
        grid.innerHTML = '<p style="color: var(--text2); text-align:center; grid-column:1/-1; padding:3rem">現在利用可能なGPUはありません</p>';
        return;
    }
    grid.innerHTML = gpus.map(gpu => {
        const stats = gpu.stats || {};
        const gpuUtil = stats.gpuUtil || 0;
        const vramPct = stats.vramTotal ? Math.round((stats.vramUsed / stats.vramTotal) * 100) : 0;
        const temp = stats.temperature || 0;
        const tempPct = Math.min(100, Math.round((temp / 100) * 100));
        const statusClass = `status-${gpu.status}`;
        const statusLabel = { available: '空き有り', rented: '使用中', maintenance: 'メンテ中', offline: 'オフライン' }[gpu.status] || gpu.status;
        const vramGB = Math.round(gpu.vram_total / 1024);

        // 謗･邯夂紫 (uptime_rate)
        const uptime = gpu.uptime_rate !== undefined && gpu.uptime_rate !== null ? parseFloat(gpu.uptime_rate) : 100;
        const sessionCount = gpu.session_count || 0;
        const uptimeColor = uptime >= 99.5 ? '#00e5a0' : uptime >= 98 ? '#a3e635' : uptime >= 95 ? '#fbbf24' : '#ff4757';
        const uptimeLabel = sessionCount === 0 ? '新規' : uptime.toFixed(1) + '%';
        const uptimeBar = sessionCount === 0 ? 100 : uptime;

        return `
      <div class="gpu-node-card ${statusClass}" data-gpu-id="${gpu.id}" onclick="openReserveModal(${gpu.id})">
        <div class="card-header">
          <div>
            <div class="card-name">${gpu.name}</div>
            <div class="card-location">📍 ${gpu.location}</div>
          </div>
          <span class="status-badge status-${gpu.status}">${statusLabel}</span>
        </div>
        <div class="card-specs">
          <div class="spec"><span class="spec-label">VRAM</span><span class="spec-val">${vramGB} GB</span></div>
          <div class="spec"><span class="spec-label">Driver</span><span class="spec-val">${gpu.driver_version || '-'}</span></div>
          <div class="spec"><span class="spec-label">温度</span><span class="spec-val">${temp ? temp + '°C' : '-'}</span></div>
          <div class="spec"><span class="spec-label">P-State</span><span class="spec-val">${stats.pstate || '-'}</span></div>
        </div>
        <div class="card-usage">
          <div class="usage-row">
            <span class="usage-label">GPU</span>
            <div class="usage-bar"><div class="usage-fill fill-gpu" style="width:${gpuUtil}%"></div></div>
            <span class="usage-val">${gpuUtil}%</span>
          </div>
          <div class="usage-row">
            <span class="usage-label">VRAM</span>
            <div class="usage-bar"><div class="usage-fill fill-vram" style="width:${vramPct}%"></div></div>
            <span class="usage-val">${vramPct}%</span>
          </div>
          <div class="usage-row">
            <span class="usage-label">Temp</span>
            <div class="usage-bar"><div class="usage-fill fill-temp" style="width:${tempPct}%"></div></div>
            <span class="usage-val">${temp ? temp + '°C' : '-'}</span>
          </div>
        </div>
        <!-- 謗･邯夂紫繝舌・ -->
        <div class="uptime-section">
          <div class="uptime-header">
            <span class="uptime-label-text">🔗 稼働率</span>
            <span class="uptime-value" style="color:${uptimeColor}">${uptimeLabel}</span>
            <span class="uptime-sessions">${sessionCount > 0 ? sessionCount + 'セッション実績' : '初回'}</span>
          </div>
          <div class="uptime-bar">
            <div class="uptime-fill" style="width:${uptimeBar}%; background:${uptimeColor}"></div>
          </div>
          ${uptime < 99.5 && sessionCount > 0 ? `<div class="uptime-warn">⚠️ 過去に接続が途切れたことがあります</div>` : ''}
        </div>
        <div class="card-footer">
          <div class="card-price">¥${gpu.price_per_hour.toLocaleString()}<span>/時間</span></div>
          ${gpu.status === 'available'
                ? `<button class="btn btn-primary" onclick="event.stopPropagation(); openReserveModal(${gpu.id})">予約する</button>`
                : `<button class="btn btn-ghost" disabled>利用不可</button>`}
        </div>
      </div>
    `;
    }).join('');
}

// Filter

document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const filter = btn.dataset.filter;
        const filtered = filter === 'all' ? state.gpus
            : filter === 'available' ? state.gpus.filter(g => g.status === 'available')
                : state.gpus.filter(g => g.location === 'Home PC');
        renderGpuGrid(filtered);
    });
});

/* ─── Reserve Modal 窶・Calendar ──────────────────────────────────── */
const calState = {
    year: null, month: null,   // currently displayed month
    selectedDate: null,        // Date object (year/month/day only)
    selectedHour: null,        // 0窶・3
    duration: 2,               // hours (minimum 1)
    gpu: null,
    // availability cache: key = 'YYYY-MM-DD', value = array of booked {start, end} ranges
    availCache: {},
    monthReservations: [],     // raw reservations for current month
};

function openReserveModal(gpuId) {
    if (!state.user) { openAuthModal('login'); return; }
    const gpu = state.gpus.find(g => g.id === gpuId);
    if (!gpu || gpu.status !== 'available') return;

    state.selectedGpuId = gpuId;
    calState.gpu = gpu;
    calState.selectedDate = null;
    calState.selectedHour = null;
    calState.duration = 2;

    // GPU info header
    document.getElementById('modalGpuName').textContent = gpu.name;
    document.getElementById('modalGpuMeta').textContent =
        `${Math.round((gpu.vram_total || 0) / 1024)} GB VRAM · ${gpu.location || 'Home PC'}`;
    document.getElementById('modalGpuPrice').textContent =
        `¥${gpu.price_per_hour.toLocaleString()}/h`;

    // Init calendar to current month
    const now = new Date();
    calState.year = now.getFullYear();
    calState.month = now.getMonth();

    calRenderCalendar();
    calRenderTimeGrid();
    calSetDuration(2);
    calUpdateSummary();

    document.getElementById('modalOverlay').classList.remove('hidden');

    // Fetch availability for current month in background
    calFetchAvailability();

    // Docker繝・Φ繝励Ξ繝ｼ繝医ｒ謠冗判
    renderDockerTemplates();
}

// ── Docker Templates ─────────────────────────────────────────────
const DOCKER_TEMPLATES = [
    {
        id: 'pytorch',
        icon: '🔥',
        name: 'PyTorch 2.1',
        desc: 'CUDA 12.1 + PyTorch 2.1\nTransformers / Diffusers included',
        purpose: 'AI/ML',
        color: '#ee4c2c',
        tags: ['AI', 'LLM', 'SD'],
    },
    {
        id: 'comfyui',
        icon: '🖼',
        name: 'ComfyUI',
        desc: 'Stable Diffusion WebUI\nComfyUI + 主要ノード同梱',
        purpose: 'AI/ML',
        color: '#7c5cbf',
        tags: ['画像生成', 'SD'],
    },
    {
        id: 'jupyter',
        icon: '📓',
        name: 'JupyterLab',
        desc: 'CUDA + JupyterLab 4.x\npandas / scikit-learn / matplotlib',
        purpose: '学習/教育',
        color: '#f37626',
        tags: ['学習', 'Python'],
    },
    {
        id: 'ollama',
        icon: '🦙',
        name: 'Ollama LLM',
        desc: 'Ollama + モデル自動ダウンロード\nllama3, mistral等をすぐ実行',
        purpose: 'AI/ML',
        color: '#00a67e',
        tags: ['LLM', 'Chat'],
    },
    {
        id: 'blender',
        icon: '🎬',
        name: 'Blender',
        desc: 'Blender 4.x + EEVEE GPU\n動画・3DCGレンダリング',
        purpose: '動画レンダリング',
        color: '#ea7600',
        tags: ['3DCG', 'Render'],
    },
    {
        id: 'base',
        icon: '🐧',
        name: 'Ubuntu 22.04',
        desc: 'CUDA 12.1 + Python 3.11\nカスタム環境のベース',
        purpose: 'その他',
        color: '#4a90d9',
        tags: ['汎用'],
    },
];

let _selectedTemplate = null;

function renderDockerTemplates() {
    const container = document.getElementById('dockerTemplates');
    if (!container) return;
    _selectedTemplate = null;
    container.innerHTML = DOCKER_TEMPLATES.map(t => `
        <div class="docker-tpl-card" id="tpl_${t.id}" onclick="selectDockerTemplate('${t.id}')"
            style="border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:.5rem .6rem;cursor:pointer;transition:all .2s;display:flex;align-items:center;gap:.5rem">
            <span style="font-size:1.3rem;line-height:1">${t.icon}</span>
            <div style="min-width:0">
                <div style="font-size:.8rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t.name}</div>
                <div style="font-size:.7rem;color:var(--text3)">${t.tags.join(' · ')}</div>
            </div>
        </div>
    `).join('');

    // 繝・ヵ繧ｩ繝ｫ繝医〒譛蛻昴・繝・Φ繝励Ξ繝ｼ繝医ｒ驕ｸ謚・
    selectDockerTemplate('pytorch');
}

function selectDockerTemplate(id) {
    _selectedTemplate = DOCKER_TEMPLATES.find(t => t.id === id);
    if (!_selectedTemplate) return;

    // 繧ｫ繝ｼ繝峨・繝上う繝ｩ繧､繝・
    document.querySelectorAll('.docker-tpl-card').forEach(el => {
        el.style.border = '1px solid rgba(255,255,255,0.1)';
        el.style.background = 'transparent';
    });
    const selected = document.getElementById(`tpl_${id}`);
    if (selected) {
        selected.style.border = `1px solid ${_selectedTemplate.color}`;
        selected.style.background = `${_selectedTemplate.color}18`;
    }

    // 隧ｳ邏ｰ繝代ロ繝ｫ
    const detail = document.getElementById('templateDetail');
    if (detail) {
        detail.style.display = 'block';
        detail.innerHTML = `<strong>${_selectedTemplate.icon} ${_selectedTemplate.name}</strong><br>${_selectedTemplate.desc.replace(/\n/g, '<br>')}`;
    }

    // 蛻ｩ逕ｨ逶ｮ逧・ｒ閾ｪ蜍輔そ繝・ヨ
    const notes = document.getElementById('notes');
    if (notes) {
        const opt = Array.from(notes.options).find(o => o.value === _selectedTemplate.purpose);
        if (opt) notes.value = _selectedTemplate.purpose;
    }
}

/* ── Calendar rendering ── */
function calRenderCalendar() {
    const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
    document.getElementById('calMonthLabel').textContent =
        `${calState.year}年 ${MONTHS[calState.month]}`;

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;

    const firstDay = new Date(calState.year, calState.month, 1).getDay();
    const daysInMonth = new Date(calState.year, calState.month + 1, 0).getDate();
    const daysInPrev = new Date(calState.year, calState.month, 0).getDate();

    let html = '';
    // Previous month padding
    for (let i = firstDay - 1; i >= 0; i--) {
        html += `<div class="cal-day cal-day-other">${daysInPrev - i}</div>`;
    }
    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(calState.year, calState.month, d);
        const isPast = date < new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const isToday = `${calState.year}-${calState.month}-${d}` === todayStr;
        const isSel = calState.selectedDate &&
            calState.selectedDate.getFullYear() === calState.year &&
            calState.selectedDate.getMonth() === calState.month &&
            calState.selectedDate.getDate() === d;

        // Busy indicator
        const booked = isPast ? 0 : calBookedHoursCount(calState.year, calState.month, d);
        const isFull = booked >= 24;
        const isBusy = booked >= 12;
        const isPartial = booked > 0;

        let cls = 'cal-day';
        if (isPast) cls += ' cal-day-past';
        else if (isSel) cls += ' cal-day-selected';
        else if (isFull) cls += ' cal-day-full';
        else if (isToday) cls += ' cal-day-today';

        // Colored dots below date number
        let dots = '';
        if (!isPast && !isSel && isPartial) {
            const dotColor = isFull ? '#ff4757' : isBusy ? '#ffb300' : '#00e5a0';
            dots = `<span class="cal-dot" style="background:${dotColor}"></span>`;
        }

        const clickFn = (isPast || isFull) ? '' : `onclick="calSelectDay(${d})"`;
        const title = isFull ? '予約満員' : booked > 0 ? `${booked}時間予約中` : '';
        html += `<div class="${cls}" ${clickFn} title="${title}">${d}${dots}</div>`;
    }
    // Next month padding
    const total = firstDay + daysInMonth;
    const rem = total % 7 === 0 ? 0 : 7 - (total % 7);
    for (let i = 1; i <= rem; i++) {
        html += `<div class="cal-day cal-day-other">${i}</div>`;
    }
    document.getElementById('calDays').innerHTML = html;
}

function calSelectDay(d) {
    calState.selectedDate = new Date(calState.year, calState.month, d);
    calState.selectedHour = null;
    calRenderCalendar();
    calRenderTimeGrid();
    calUpdateSummary();
}

/* ── Availability fetch ── */
async function calFetchAvailability() {
    if (!calState.gpu) return;
    const pad = n => String(n).padStart(2, '0');
    const monthStr = `${calState.year}-${pad(calState.month + 1)}`;
    try {
        const slots = await apiFetch(`/gpus/${calState.gpu.id}/availability?month=${monthStr}`);
        calState.monthReservations = slots;
        // Build cache keyed by date
        calState.availCache = {};
        for (const s of slots) {
            const st = new Date(s.start_time);
            const en = new Date(s.end_time);
            // Iterate each day the reservation spans
            const cur = new Date(st);
            while (cur < en) {
                const key = `${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}`;
                if (!calState.availCache[key]) calState.availCache[key] = [];
                const dayStart = new Date(cur); dayStart.setHours(0, 0, 0, 0);
                const dayEnd = new Date(cur); dayEnd.setHours(23, 59, 59, 999);
                calState.availCache[key].push({
                    start: Math.max(st.getHours(), cur.toDateString() === st.toDateString() ? st.getHours() : 0),
                    end: Math.min(en.getHours() + (en.getMinutes() > 0 ? 1 : 0), cur.toDateString() === en.toDateString() ? (en.getHours() + (en.getMinutes() > 0 ? 1 : 0)) : 24),
                    status: s.status,
                });
                cur.setDate(cur.getDate() + 1);
                cur.setHours(0, 0, 0, 0);
            }
        }
        calRenderCalendar();
        if (calState.selectedDate) calRenderTimeGrid();
    } catch (e) {
        // silently ignore
    }
}

// Returns array of booked hour numbers for a given Date
function calGetBookedHours(date) {
    if (!date) return [];
    const pad = n => String(n).padStart(2, '0');
    const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const ranges = calState.availCache[key] || [];
    const booked = new Set();
    for (const r of ranges) {
        for (let h = r.start; h < r.end; h++) booked.add(h);
    }
    return booked;
}

// Returns how many hours are booked on a given day (0窶・4)
function calBookedHoursCount(year, month, day) {
    const pad = n => String(n).padStart(2, '0');
    const key = `${year}-${pad(month + 1)}-${pad(day)}`;
    const ranges = calState.availCache[key] || [];
    let count = 0;
    for (const r of ranges) count += (r.end - r.start);
    return Math.min(24, count);
}

/* ── Time slot rendering (0:00 窶・23:00, 1h blocks) ── */
function calRenderTimeGrid() {
    // Show placeholder if no date selected
    if (!calState.selectedDate) {
        document.getElementById('calTimeGrid').innerHTML =
            '<div style="grid-column:1/-1;text-align:center;color:var(--text3);font-size:0.78rem;padding:1.5rem 0.5rem">← まず左のカレンダーで日付を選んでください</div>';
        return;
    }

    const now = new Date();
    const isToday = calState.selectedDate.toDateString() === now.toDateString();
    const bookedHours = calGetBookedHours(calState.selectedDate); // Set of booked hours

    let html = '';
    for (let h = 0; h < 24; h++) {
        const isPast = isToday && h <= now.getHours();
        const isBooked = bookedHours.has(h);
        const isActive = calState.selectedHour === h;
        const hh = String(h).padStart(2, '0');

        let cls = 'cal-time-slot';
        let label = `${hh}:00`;
        let onclick = '';
        let title = '';

        if (isPast) {
            cls += ' past';
            label = `${hh}:00`;
        } else if (isBooked) {
            cls += ' booked';
            label = `${hh}:00<br><span class="slot-tag">予約済</span>`;
            title = `${hh}:00 は予約済みです`;
        } else if (isActive) {
            cls += ' active';
            onclick = `onclick="calSelectHour(${h})"`;
        } else {
            cls += ' free';
            onclick = `onclick="calSelectHour(${h})"`;
            title = `${hh}:00 から予約可能`;
        }

        html += `<div class="${cls}" ${onclick} title="${title}">${label}</div>`;
    }

    // Legend
    html += `<div class="cal-time-legend">
        <span class="ctl-item"><span class="ctl-dot free"></span>空き</span>
        <span class="ctl-item"><span class="ctl-dot booked"></span>予約中</span>
        <span class="ctl-item"><span class="ctl-dot past"></span>過去</span>
    </div>`;

    document.getElementById('calTimeGrid').innerHTML = html;
}

function calSelectHour(h) {
    calState.selectedHour = h;
    calRenderTimeGrid();
    calUpdateSummary();
}

/* ── Duration ── */
function calSetDuration(hrs) {
    calState.duration = Math.max(1, parseInt(hrs) || 1);
    // update duration buttons
    document.querySelectorAll('.cal-dur-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.dur) === calState.duration);
    });
    // update custom input
    const input = document.getElementById('customDuration');
    if (input) input.value = calState.duration;
    calUpdateSummary();
}

// Duration button events
document.querySelectorAll('.cal-dur-btn').forEach(btn => {
    btn.addEventListener('click', () => calSetDuration(parseInt(btn.dataset.dur)));
});
document.getElementById('customDuration')?.addEventListener('input', function () {
    calSetDuration(parseInt(this.value) || 1);
});

/* ── Summary + Submit button ── */
function calUpdateSummary() {
    const gpu = calState.gpu;
    const ready = calState.selectedDate !== null && calState.selectedHour !== null && gpu;

    if (!ready) {
        document.getElementById('sumStart').textContent = '-';
        document.getElementById('sumEnd').textContent = '-';
        document.getElementById('sumHours').textContent = '-';
        document.getElementById('sumTotal').textContent = '-';
        const btn = document.getElementById('submitReserve');
        btn.disabled = true;
        btn.textContent = calState.selectedDate
            ? '開始時刻を選んでください'
            : '日付と時刻を選択してください';
        return;
    }

    const startDt = new Date(calState.selectedDate);
    startDt.setHours(calState.selectedHour, 0, 0, 0);
    const endDt = new Date(startDt.getTime() + calState.duration * 3600000);

    const fmtDt = dt => {
        const y = dt.getFullYear(), mo = dt.getMonth() + 1, d = dt.getDate();
        const h = String(dt.getHours()).padStart(2, '0');
        return `${y}/${mo}/${d} ${h}:00`;
    };

    const total = Math.round(calState.duration * gpu.price_per_hour);
    const totalPt = Math.ceil(total / 10); // 1pt = 10円

    document.getElementById('sumStart').textContent = fmtDt(startDt);
    document.getElementById('sumEnd').textContent = fmtDt(endDt);
    document.getElementById('sumHours').textContent = `${calState.duration}時間`;
    document.getElementById('sumTotal').textContent = `¥${total.toLocaleString()}（${totalPt.toLocaleString()}pt）`;

    const btn = document.getElementById('submitReserve');
    btn.disabled = false;
    btn.textContent = `予約を確定する (${totalPt.toLocaleString()}pt)`;
}

/* ── Calendar nav ── */
document.getElementById('calPrev')?.addEventListener('click', () => {
    calState.month--;
    if (calState.month < 0) { calState.month = 11; calState.year--; }
    calState.availCache = {};
    calRenderCalendar();
    calFetchAvailability();
});
document.getElementById('calNext')?.addEventListener('click', () => {
    calState.month++;
    if (calState.month > 11) { calState.month = 0; calState.year++; }
    calState.availCache = {};
    calRenderCalendar();
    calFetchAvailability();
});

/* ── Modal open/close ── */
document.getElementById('modalClose').addEventListener('click', () => {
    document.getElementById('modalOverlay').classList.add('hidden');
});
document.getElementById('modalOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modalOverlay'))
        document.getElementById('modalOverlay').classList.add('hidden');
});

/* ── Submit reservation ── */
document.getElementById('submitReserve').addEventListener('click', async () => {
    if (!calState.selectedDate || calState.selectedHour === null) return;

    const errEl = document.getElementById('formError');
    errEl.classList.add('hidden');
    const btn = document.getElementById('submitReserve');
    btn.disabled = true;
    if (btn) { btn.disabled = true; btn.textContent = '処理中...'; }

    const startDt = new Date(calState.selectedDate);
    startDt.setHours(calState.selectedHour, 0, 0, 0);
    const endDt = new Date(startDt.getTime() + calState.duration * 3600000);

    // Validate minimum 1 hour
    if (calState.duration < 1) {
    errEl.textContent = '最低1時間以上を選択してください';
        errEl.classList.remove('hidden');
        btn.disabled = false;
        calUpdateSummary();
        return;
    }
    // Validate not in the past
    if (startDt <= new Date()) {
    errEl.textContent = '過去の時刻は選択できません';
        errEl.classList.remove('hidden');
        btn.disabled = false;
        calUpdateSummary();
        return;
    }

    try {
        const toISO = dt => {
            const pad = n => String(n).padStart(2, '0');
            // JST譏守､ｺ縺ｮISO8601蠖｢蠑上〒騾∽ｿ｡・・09:00・・
            return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:00:00+09:00`;
        };

        const data = await apiFetch('/reservations', {
            method: 'POST',
            body: JSON.stringify({
                gpu_id: state.selectedGpuId,
                start_time: toISO(startDt),
                end_time: toISO(endDt),
                notes: document.getElementById('notes').value,
                docker_template: _selectedTemplate?.id || 'pytorch',
            }),
        });
        document.getElementById('modalOverlay').classList.add('hidden');
        showToast(`${data.gpu_name} の予約が完了しました (${calState.duration}時間)`, 'success');
        loadMyReservations();
        loadGpus();
    } catch (err) {
        // 谿矩ｫ倅ｸ崎ｶｳ繧ｨ繝ｩ繝ｼ縺ｮ蝣ｴ蜷医・迚ｹ蛻･縺ｪ繝｡繝・そ繝ｼ繧ｸ
    if (err.message && err.message.includes('ポイント残高が不足')) {
        errEl.innerHTML = `${err.message} <a href="/mypage/" style="color:#00d4ff;text-decoration:underline">ポイントを購入する</a>`;
        } else {
            errEl.textContent = err.message;
        }
        errEl.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        calUpdateSummary();
    }
});



/* ─── My Reservations ───────────────────────────────────────────── */
async function loadMyReservations() {
    if (!state.user) return;
    try {
        const res = await apiFetch('/reservations');
        state.reservations = res;
        renderReservations(res);
    } catch { }
}

function renderReservations(list) {
    const el = document.getElementById('myReservationsList');
    if (!list.length) {
    el.innerHTML = '<p style="color:var(--text2);padding:1rem;font-size:0.875rem">予約がありません</p>';
        return;
    }
        const statusLabel = { pending: '確認中', confirmed: '確定済み', active: '稼働中', completed: '完了', cancelled: 'キャンセル' }[r.status] || r.status;
    // 繝ｯ繝ｼ繧ｯ繧ｹ繝壹・繧ｹURL: 螟夜Κ繧｢繧ｯ繧ｻ繧ｹ譎ゅ・API・医ヰ繝・け繧ｨ繝ｳ繝会ｼ峨・URL繧剃ｽｿ縺・
    const wsBase = API || location.origin;

    el.innerHTML = list.map(r => {
        const wsBase = API || location.origin;
        // active Pod縺ｮ繝ｯ繝ｼ繧ｯ繧ｹ繝壹・繧ｹ繝ｪ繝ｳ繧ｯ: SF ID縺檎ｴ舌▼縺・※縺・ｌ縺ｰ繝代Λ繝｡繝ｼ繧ｿ莉倥″
        const buildWsUrl = () => {
            const params = new URLSearchParams();
            if (r.pod_id)           params.set('pod',      r.pod_id);
            if (r.sf_raid_job_id)   params.set('raid_job', r.sf_raid_job_id);
            if (r.sf_match_id)      params.set('match',    r.sf_match_id);
            const qs = params.toString();
            return `${wsBase}/workspace/${qs ? '?' + qs : ''}`;
        };

        const actions = r.status === 'active'
            ? `<a href="${buildWsUrl()}" target="_blank" class="btn btn-success btn-sm">▶ ワークスペースを開く${
                r.sf_raid_job_id || r.sf_match_id ? ' 🎮' : ''}</a>`
            : (r.status === 'confirmed' || r.status === 'pending')
                ? `<button class="btn btn-primary btn-sm" onclick="startPod(${r.id})" id="startBtn_${r.id}">▶ 今すぐ起動</button>
                   <button class="btn btn-danger btn-sm" onclick="cancelReservation(${r.id})">キャンセル</button>`
                : '';

        return `
    <div class="reservation-item">
      <div class="res-header">
        <span class="res-gpu">${r.gpu_name}</span>
        <span class="status-badge status-${r.status === 'active' ? 'available' : r.status === 'completed' ? 'offline' : 'rented'}">${statusLabel[r.status] || r.status}</span>
      </div>
      <div class="res-time">📅 ${formatDate(r.start_time)} → ${formatDate(r.end_time)}</div>
      <div class="res-time">📅 ¥${r.total_price ? Math.round(r.total_price).toLocaleString() : '-'}</div>
      <div class="res-actions">${actions}</div>
    </div>`;
    }).join('');
}

// Pod 繧貞叉譎りｵｷ蜍輔＠縺ｦ繝ｯ繝ｼ繧ｯ繧ｹ繝壹・繧ｹ縺ｸ隱伜ｰ・
async function startPod(reservationId) {
    const btn = document.getElementById(`startBtn_${reservationId}`);
    if (btn) { btn.disabled = true; btn.textContent = '起動中...'; }
    try {
        const result = await apiFetch(`/reservations/${reservationId}/start`, { method: 'POST' });
        showToast('✅ GPUが起動しました！ワークスペースに接続します...', 'success');

        // workspace_url 縺ｫ縺ｯ ?raid_job= / ?match= 繝代Λ繝｡繝ｼ繧ｿ縺悟性縺ｾ繧後ｋ蝣ｴ蜷医′縺ゅｋ
        const wsBase = API || location.origin;
        const dest = result.pod?.workspace_url
            || (result.workspace_url)
            || `${wsBase}/workspace/`;

        setTimeout(() => {
            window.open(dest, '_blank');
        }, 1500);

        // 莠育ｴ・Μ繧ｹ繝医ｒ譖ｴ譁ｰ
        setTimeout(() => loadMyReservations(), 2000);
    } catch (err) {
        showToast('起動エラー: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '▶ 今すぐ起動'; }
    }
}

function cancelReservation(id) {
    // 譌｢蟄倥Δ繝ｼ繝繝ｫ繧貞炎髯､
    document.getElementById('cancelResModal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'cancelResModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:9999';
    modal.innerHTML = `
        <div style="background:#13132a;border:1px solid rgba(251,191,36,.35);border-radius:16px;padding:1.75rem;width:420px;max-width:95vw;text-align:center">
            <div style="font-size:2rem;margin-bottom:0.75rem">笞・・/div>
    <h3 style="font-size:1rem;font-weight:800;margin-bottom:0.5rem;color:#e8e8f0">キャンセルについて</h3>
            <p style="color:#9898b8;font-size:0.85rem;margin-bottom:1.25rem;line-height:1.7">
    予約後のキャンセル・返金は<strong style="color:#fbbf24">原則受け付けできません。</strong><br>
    どうしても問題が生じた場合は、<br>運営まで直接お問い合わせください。<br>
                <a href="mailto:info@metadatalab.net"
                   style="color:#00d4ff;font-size:0.82rem;margin-top:0.5rem;display:inline-block">
                    📧 info@metadatalab.net
                </a>
            </p>
            <div style="display:flex;gap:0.75rem;justify-content:center">
                <button onclick="document.getElementById('cancelResModal').remove()"
                    style="padding:8px 28px;border-radius:8px;border:1px solid #2a2a5a;background:transparent;color:#9898b8;cursor:pointer;font-size:0.85rem">
    閉じる
                </button>
    <a href="mailto:info@metadatalab.net?subject=予約キャンセルについて（予約ID:${id})"
                   style="padding:8px 28px;border-radius:8px;border:none;background:linear-gradient(135deg,#6c47ff,#00d4ff);color:#fff;cursor:pointer;font-size:0.85rem;font-weight:700;text-decoration:none;display:inline-flex;align-items:center">
    運営に問い合わせる
                </a>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeTicketModal(); });
    modal.classList.remove('hidden');
    renderTicketPlans();
}

async function executeCancel(id) {
    const btn = document.getElementById('confirmCancelResBtn');
    if (btn) { btn.disabled = true; btn.textContent = '処理中...'; }
    try {
        const result = await apiFetch(`/reservations/${id}`, { method: 'DELETE' });
        document.getElementById('cancelResModal')?.remove();
        const msg = result.refunded > 0
        ? `予約をキャンセルしました。${result.refunded}pt を返還しました。`
            : '予約をキャンセルしました。';
        showToast(msg, 'info');
        loadMyReservations();
        loadGpus();
    } catch (err) {
        document.getElementById('cancelResModal')?.remove();
        showToast(err.message || 'キャンセルに失敗しました', 'error');
    }
}


// Show my reservations panel from username click
document.getElementById('navUsername').addEventListener('click', () => {
    const panel = document.getElementById('myPanel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) loadMyReservations();
});
document.getElementById('panelClose').addEventListener('click', () => {
    document.getElementById('myPanel').classList.add('hidden');
});

/* ─── WebSocket ─────────────────────────────────────────────────── */
function connectSocket() {
    if (socket) socket.disconnect();
    socket = API ? io(API, { transports: ['polling', 'websocket'] }) : io();
    if (state.token) socket.emit('auth', state.token);

    socket.on('gpu:stats', (stats) => {
        stats.forEach(s => {
            const gpu = state.gpus.find(g => g.stats?.index === s.index || g.device_index === s.index);
            if (gpu) gpu.stats = s;
        });
        renderGpuGrid(state.gpus);
    });

    socket.on('pod:started', (data) => {
        showToast(data.message, 'success');
        // workspace_url 縺ｫ縺ｯ ?raid_job= / ?match= 繝代Λ繝｡繝ｼ繧ｿ縺悟性縺ｾ繧後ｋ蝣ｴ蜷医′縺ゅｋ
        const dest = data.workspace_url || '/workspace/';
        setTimeout(() => window.location.href = dest, 1500);
    });

    socket.on('pod:warning', (data) => {
        showToast(data.message, 'info');
    });

    socket.on('pod:stopped', (data) => {
        showToast(data.message, 'info');
        loadMyReservations();
        loadGpus();
    });
}


/* ─── Init ──────────────────────────────────────────────────────── */
updateNavAuth();
loadGpus();
setInterval(loadGpus, 10000); // refresh GPU list every 10s
if (state.token) {
    connectSocket();
    loadMyReservations();
}


/* ─── SF Widget ─────────────────────────────────────────────────── */
async function loadSfWidget() {
    const widget   = document.getElementById('sfWidget');
    const nodeCnt  = document.getElementById('sfNodeCount');
    const nodeDot  = document.getElementById('sfNodeDot');
    const raids    = document.getElementById('sfActiveRaids');
    const done     = document.getElementById('sfCompletedToday');
    const ptCard   = document.getElementById('sfPointCard');
    const ptVal    = document.getElementById('sfUserPoints');

    if (!widget) return;

    // ─ GPU 繝弱・繝画焚: /api/gpus/public 縺九ｉ蛻ｩ逕ｨ蜿ｯ閭ｽ謨ｰ繧堤ｮ怜・
    try {
        const r = await fetch('/api/gpus/public');
        if (r.ok) {
            const gpus = await r.json();
            const online = Array.isArray(gpus)
                ? gpus.filter(g => g.status === 'available' || g.status === 'rented').length
                : 0;
            if (nodeCnt) nodeCnt.textContent = online;
            if (nodeDot) {
                nodeDot.style.background = online > 0 ? '#10b981' : '#6b7280';
                nodeDot.style.animation  = online > 0 ? 'pulse 2s infinite' : 'none';
            }
        }
    } catch (_) {}

    // ─ Raid 邨ｱ險・ 蜈ｬ髢九お繝ｳ繝峨・繧､繝ｳ繝・(隱崎ｨｼ荳崎ｦ・
    try {
        const r = await fetch('/api/sf/stats/public');
        if (r.ok) {
            const d = await r.json();
            if (raids) raids.textContent = d.active_raids    ?? '-';
            if (done)  done.textContent  = d.completed_today ?? '-';
            // 繝弱・繝画焚繧ゆｸ頑嶌縺榊庄閭ｽ (API 縺ｮ譁ｹ縺梧ｭ｣遒ｺ)
            if (nodeCnt && d.online_nodes != null) nodeCnt.textContent = d.online_nodes;
            if (nodeDot && d.online_nodes != null) {
                nodeDot.style.background = d.online_nodes > 0 ? '#10b981' : '#6b7280';
                nodeDot.style.animation  = d.online_nodes > 0 ? 'pulse 2s infinite' : 'none';
            }
        }
    } catch (_) {
    if (raids) raids.textContent = '-';
    if (done)  done.textContent  = '-';
    }

    // ─ 繝ｦ繝ｼ繧ｶ繝ｼ繝昴う繝ｳ繝域ｮ矩ｫ・(繝ｭ繧ｰ繧､繝ｳ譎ゅ・縺ｿ)
    if (state.user && ptCard && ptVal) {
    const bal = state.user.point_balance ?? state.user.wallet_balance ?? '-';
        ptVal.textContent = typeof bal === 'number' ? Math.floor(bal).toLocaleString() : bal;
        ptCard.style.display = 'block';
    }

    // ─ 繧ｦ繧｣繧ｸ繧ｧ繝・ヨ繧定｡ｨ遉ｺ
    widget.style.display = 'block';
    widget.style.animation = 'fadeIn 0.4s ease';
}

// 繧ｦ繧｣繧ｸ繧ｧ繝・ヨ陦ｨ遉ｺ: 蟶ｸ譎り｡ｨ遉ｺ + 30遘偵＃縺ｨ譖ｴ譁ｰ
loadSfWidget();
setInterval(loadSfWidget, 30000);

/* 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊・
    // GPU公開ガイドパネル
笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊・*/
let guideStep = 1;
const GUIDE_TOTAL = 5;

function openGuidePanel() {
    document.getElementById('guideOverlay').classList.remove('hidden');
    document.getElementById('guidePanel').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    guideSetStep(guideStep);
    updateStep2Status();
}

function closeGuidePanel() {
    document.getElementById('guideOverlay').classList.add('hidden');
    document.getElementById('guidePanel').classList.add('hidden');
    document.body.style.overflow = '';
}

function guideNav(dir) {
    guideStep = Math.max(1, Math.min(GUIDE_TOTAL, guideStep + dir));
    guideSetStep(guideStep);
}

function guideSetStep(n) {
    guideStep = n;
    // 繧ｳ繝ｳ繝・Φ繝・・繧頑崛縺・
    document.querySelectorAll('.guide-step').forEach(el => {
        el.classList.toggle('active', parseInt(el.dataset.step) === n);
    });
    // 繧､繝ｳ繧ｸ繧ｱ繝ｼ繧ｿ繝ｼ譖ｴ譁ｰ
    document.querySelectorAll('.gsn-item').forEach(el => {
        const s = parseInt(el.dataset.step);
        el.classList.toggle('active', s === n);
        el.classList.toggle('done', s < n);
    });
    // 繝峨ャ繝域峩譁ｰ
    const dots = document.getElementById('guideNavDots');
    dots.innerHTML = Array.from({ length: GUIDE_TOTAL }, (_, i) =>
        `<span class="${i + 1 === n ? 'active' : ''}"></span>`
    ).join('');
    // 繝懊ち繝ｳ迥ｶ諷・
    document.getElementById('guidePrev').disabled = n === 1;
    const nextBtn = document.getElementById('guideNext');
    if (n === GUIDE_TOTAL) {
        nextBtn.textContent = '完了';
        nextBtn.onclick = closeGuidePanel;
    } else {
        nextBtn.textContent = '次へ →';
        nextBtn.onclick = () => guideNav(1);
    }
    // Step 2縺ｯ繝ｭ繧ｰ繧､繝ｳ迥ｶ諷九ｒ譖ｴ譁ｰ
    if (n === 2) updateStep2Status();
}

function updateStep2Status() {
    const title = document.getElementById('step2Title');
    const desc = document.getElementById('step2Desc');
    const btn = document.getElementById('step2Btn');
    if (!title) return;
    if (state.user) {
        const card = document.getElementById('step2Status');
        card.style.borderColor = 'rgba(0,229,160,0.3)';
        card.style.background = 'rgba(0,229,160,0.06)';
        document.querySelector('#step2Status .gs-ac-icon').textContent = '✓';
    title.textContent = `ログイン済み: ${state.user.username}`;
    desc.textContent = 'アカウントの準備ができています。次のステップへ進んでください。';
        btn.textContent = 'Step 3へ →';
        btn.onclick = () => guideNav(1);
    } else {
        document.querySelector('#step2Status .gs-ac-icon').textContent = '🔐';
    title.textContent = 'ログインしてください';
    desc.textContent = 'プロバイダーとして登録するにはアカウントが必要です。';
    btn.textContent = 'ログイン / 登録';
        btn.onclick = openAuthFromGuide;
    }
}

function openAuthFromGuide() {
    closeGuidePanel();
    document.getElementById('authOverlay').classList.remove('hidden');
}

// GPU閾ｪ蜍墓､懷・・・ebGL 縺ｧ繝ｭ繝ｼ繧ｫ繝ｫPC 縺ｮGPU蜿門ｾ暦ｼ・
async function checkGpuLocal() {
    const btn = document.querySelector('.gs-check-btn');
    const result = document.getElementById('gpuDetectResult');
    btn.textContent = '🔍 検出中...';
    btn.disabled = true;
    result.classList.add('hidden');

    try {
        // ── WebGL 縺ｧ繝悶Λ繧ｦ繧ｶ・医Ο繝ｼ繧ｫ繝ｫPC・峨・GPU繝ｬ繝ｳ繝繝ｩ繝ｼ蜷阪ｒ蜿門ｾ・──
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        let rendererRaw = '';
        if (gl) {
            const dbg = gl.getExtension('WEBGL_debug_renderer_info');
            rendererRaw = dbg
                ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
                : gl.getParameter(gl.RENDERER);
        }

        result.classList.remove('hidden');

        if (!gl || !rendererRaw) {
        result.innerHTML = '<strong>WebGLが無効です</strong><br>';
        result.innerHTML += '<span style="font-size:0.82rem;color:var(--text3)">ChromeまたはFirefoxを使用してください</span>';
            return;
        }

        // ── GPU蜷阪ｒ謨ｴ蠖｢・・ANGLE (NVIDIA, NVIDIA GeForce RTX xxxx ...)" 竊・遏ｭ邵ｮ・・──
        let gpuName = rendererRaw;
        const angleMatch = rendererRaw.match(/ANGLE\s*\([^,]+,\s*([^,\(]+)/i);
        if (angleMatch) gpuName = angleMatch[1].trim();
        // 譛ｫ蟆ｾ縺ｮ荳崎ｦ√↑譁・ｭ怜・繧帝勁蜴ｻ
        gpuName = gpuName.replace(/\s*\(.*\)$/, '').replace(/Direct3D.*$/i, '').trim();

        // ── GPU繧ｫ繧ｿ繝ｭ繧ｰ縺ｨ辣ｧ蜷・──
        const GPU_CATALOG = [
            { keywords: ['H100'], name: 'NVIDIA H100', vram: 80, price: 1800 },
            { keywords: ['A100'], name: 'NVIDIA A100', vram: 80, price: 1500 },
            { keywords: ['A6000'], name: 'NVIDIA RTX A6000', vram: 48, price: 1200 },
            { keywords: ['4090'], name: 'NVIDIA RTX 4090', vram: 24, price: 1200 },
            { keywords: ['4080'], name: 'NVIDIA RTX 4080', vram: 16, price: 900 },
            { keywords: ['4070'], name: 'NVIDIA RTX 4070', vram: 12, price: 700 },
            { keywords: ['4060'], name: 'NVIDIA RTX 4060', vram: 8, price: 500 },
            { keywords: ['A4500'], name: 'NVIDIA RTX A4500', vram: 20, price: 800 },
            { keywords: ['A4000'], name: 'NVIDIA RTX A4000', vram: 16, price: 600 },
            { keywords: ['3090'], name: 'NVIDIA RTX 3090', vram: 24, price: 900 },
            { keywords: ['3080'], name: 'NVIDIA RTX 3080', vram: 10, price: 700 },
            { keywords: ['3070'], name: 'NVIDIA RTX 3070', vram: 8, price: 550 },
            { keywords: ['3060'], name: 'NVIDIA RTX 3060', vram: 12, price: 400 },
            { keywords: ['2080 Ti', '2080Ti'], name: 'NVIDIA RTX 2080 Ti', vram: 11, price: 500 },
            { keywords: ['2080'], name: 'NVIDIA RTX 2080', vram: 8, price: 400 },
            { keywords: ['2070'], name: 'NVIDIA RTX 2070', vram: 8, price: 350 },
            { keywords: ['1080 Ti', '1080Ti'], name: 'NVIDIA GTX 1080 Ti', vram: 11, price: 350 },
            { keywords: ['1080'], name: 'NVIDIA GTX 1080', vram: 8, price: 280 },
            { keywords: ['1070'], name: 'NVIDIA GTX 1070', vram: 8, price: 230 },
            { keywords: ['RX 7900', 'RX7900'], name: 'AMD RX 7900 XTX', vram: 24, price: 800 },
            { keywords: ['RX 6900', 'RX6900'], name: 'AMD RX 6900 XT', vram: 16, price: 600 },
            { keywords: ['RX 6800', 'RX6800'], name: 'AMD RX 6800 XT', vram: 16, price: 500 },
        ];

        const matchedEntry = GPU_CATALOG.find(entry =>
            entry.keywords.some(kw => gpuName.toUpperCase().includes(kw.toUpperCase()))
        );

        const supported = !!matchedEntry;
        const displayName = matchedEntry ? matchedEntry.name : gpuName;
        const vramText = matchedEntry ? `${matchedEntry.vram} GB` : '-';
        const priceText = matchedEntry ? `¥${matchedEntry.price.toLocaleString()}/時間` : '-';

        const badge = supported
            ? `<span style="background:rgba(0,229,160,.15);color:var(--success);font-size:0.7rem;padding:1px 7px;border-radius:4px;font-weight:700">✅ 対応済み</span>`
            : `<span style="background:rgba(255,179,0,.15);color:var(--warning);font-size:0.7rem;padding:1px 7px;border-radius:4px;font-weight:700">⚠️ 要確認</span>`;

        result.innerHTML = `✅ <strong>ローカルPCのGPUを検出しました！</strong><br><br>
<div style="background:rgba(0,229,160,.06);border:1px solid rgba(0,229,160,.2);border-radius:8px;padding:0.75rem;margin-bottom:0.5rem">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><strong>${displayName}</strong>${badge}</div>
  <div style="font-size:0.82rem;color:var(--text2)">
    ${matchedEntry ? `<strong>VRAM:</strong> ${vramText} &nbsp; <strong>推奨価格:</strong> ${priceText}` : ''}
  <div style="margin-top:4px;font-size:0.75rem;color:var(--text3)">検出値: ${gpuName}</div>
  </div>
</div>
${supported
                ? `↪️ Step 3へ進み、上記のGPUを登録してください。`
                : `↪️ GPUカタログに見つかりませんでしたが、手動で登録できます。`}`;

        // チェックリストをチェック済みに
        if (supported) {
            const chk = document.getElementById('chkGpu');
            if (chk) chk.querySelector('.gs-check-icon').textContent = '✓';
        }

    } catch (e) {
        result.classList.remove('hidden');
    result.innerHTML = '❌ GPU検出に失敗しました: ' + e.message;
    }
    btn.textContent = '🔍 再検出する';
    btn.disabled = false;
}



    // 月収シミュレーター
function calcEarnings() {
    const h = parseInt(document.getElementById('earnHours')?.value || 8);
    const p = parseInt(document.getElementById('earnPrice')?.value || 800);
    const monthly = h * p * 30 * 0.8;
    if (document.getElementById('earnHoursVal')) document.getElementById('earnHoursVal').textContent = `${h}時間/日`;
    if (document.getElementById('earnPriceVal')) document.getElementById('earnPriceVal').textContent = `¥${p.toLocaleString()}/日`;
    if (document.getElementById('earnResult')) document.getElementById('earnResult').textContent = `¥${Math.round(monthly).toLocaleString()}`;
}

    // ガイドの gsn-item クリックで直接ステップ移動
document.querySelectorAll('.gsn-item').forEach(el => {
    el.addEventListener('click', () => guideSetStep(parseInt(el.dataset.step)));
});

    // ボタンイベント（ログイン済み・未ログイン両方向に表示するボタン）
document.getElementById('btnProvideGuide')?.addEventListener('click', openGuidePanel);
document.getElementById('btnProvideGuidePublic')?.addEventListener('click', openGuidePanel);
document.getElementById('guideClose')?.addEventListener('click', closeGuidePanel);
document.getElementById('guideOverlay')?.addEventListener('click', closeGuidePanel);

    // ヒーローの「GPUを貸し出す」ボタンもガイドを開く
document.getElementById('heroProvide')?.addEventListener('click', openGuidePanel);

    // 初期化
calcEarnings();


/* 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊・
    // 出金管理モーダル (Withdraw Management)
笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊・*/

function updateWithdrawBtn() {
    const btn = document.getElementById('btnWithdraw');
    if (!btn) return;
    btn.style.display = (state.user && (state.user.role === 'provider' || state.user.role === 'admin')) ? '' : 'none';
}

document.getElementById('btnWithdraw')?.addEventListener('click', openWithdrawModal);

function openWithdrawModal() {
    document.getElementById('withdrawModal')?.classList.remove('hidden');
    document.getElementById('withdrawOverlay')?.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    switchWdTab(0);
    loadWalletBalance();
    loadBankAccounts();
}
function closeWithdrawModal() {
    document.getElementById('withdrawModal')?.classList.add('hidden');
    document.getElementById('withdrawOverlay')?.classList.add('hidden');
    document.body.style.overflow = '';
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeWithdrawModal(); });

function switchWdTab(idx) {
    [0, 1, 2].forEach(i => {
        document.getElementById('wdTab' + i)?.classList.toggle('active', i === idx);
        document.getElementById('wdPane' + i)?.classList.toggle('hidden', i !== idx);
    });
    if (idx === 1) { loadBankAccountsForSelect(); loadWalletBalance(); }
    if (idx === 2) loadPayoutHistory();
}

async function loadWalletBalance() {
    try {
        const me = await apiFetch('/auth/me');
        const bal = Math.round(me.wallet_balance || 0);
        const fmt = 'Y' + bal.toLocaleString();
        const lbl = 'Zandaka: ' + fmt;
        const el1 = document.getElementById('walletBalanceLabel');
        const el2 = document.getElementById('payoutAvailAmt');
        if (el1) el1.textContent = lbl;
        if (el2) el2.textContent = fmt;
        return bal;
    } catch { return 0; }
}

let _bankAccounts = [];

async function loadBankAccounts() {
    const list = document.getElementById('bankAccountList');
    if (!list) return;
    list.innerHTML = '<div class="wd-empty">Reading...</div>';
    try {
        _bankAccounts = await apiFetch('/bank-accounts');
        if (!_bankAccounts.length) {
            list.innerHTML = '<div class="wd-empty">No accounts registered.<br><small>Click below to add one.</small></div>';
            return;
        }
        list.innerHTML = _bankAccounts.map(function (a) {
            var typeLabel = a.account_type === 'checking' ? 'Toza' : 'Futsuu';
            var masked = a.account_number.slice(-4).padStart(a.account_number.length, '*');
            var defBadge = a.is_default ? '<span class="badge-default">Default</span>' : '';
            var defBtn = !a.is_default ? '<button class="btn btn-ghost btn-sm" onclick="setDefaultAccount(' + a.id + ')">Set Default</button>' : '';
            return '<div class="bank-account-card ' + (a.is_default ? 'is-default' : '') + '" id="bac-' + a.id + '">'
                + '<div class="bac-main">'
                + '<div class="bac-bank">  ' + a.bank_name + (a.bank_code ? ' (' + a.bank_code + ')' : '') + defBadge + '</div>'
                + '<div class="bac-detail">' + a.branch_name + (a.branch_code ? ' (' + a.branch_code + ')' : '') + '  ' + typeLabel + '  ' + masked + '</div>'
                + '<div class="bac-holder">' + a.account_holder + '</div>'
                + '</div>'
                + '<div class="bac-actions">'
                + defBtn
                + '<button class="btn btn-danger btn-sm" onclick="deleteAccount(' + a.id + ', \'' + a.bank_name + '\')">Delete</button>'
                + '</div></div>';
        }).join('');
    } catch (e) {
        list.innerHTML = '<div class="wd-empty">Load failed: ' + e.message + '</div>';
    }
}

async function loadBankAccountsForSelect() {
    var sel = document.getElementById('payoutBankSelect');
    if (!sel) return;
    try {
        _bankAccounts = await apiFetch('/bank-accounts');
        sel.innerHTML = '<option value="">Select account</option>'
            + _bankAccounts.map(function (a) {
                var typeLabel = a.account_type === 'checking' ? 'Toza' : 'Futsuu';
                var masked = a.account_number.slice(-4).padStart(a.account_number.length, '*');
                return '<option value="' + a.id + '" ' + (a.is_default ? 'selected' : '') + '>' + a.bank_name + ' ' + a.branch_name + ' ' + typeLabel + ' ' + masked + ' (' + a.account_holder + ')</option>';
            }).join('');
    } catch (e) { }
}

function openAddAccountForm() {
    document.getElementById('addAccountForm')?.classList.remove('hidden');
    ['bfBankName', 'bfBankCode', 'bfBranchName', 'bfBranchCode', 'bfAccountNumber', 'bfAccountHolder'].forEach(function (id) {
        var el = document.getElementById(id); if (el) el.value = '';
    });
    var chk = document.getElementById('bfIsDefault'); if (chk) chk.checked = !_bankAccounts.length;
    var f = document.getElementById('bfBankName'); if (f) f.focus();
}
function closeAddAccountForm() { document.getElementById('addAccountForm')?.classList.add('hidden'); }

async function submitAddAccount() {
    var body = {
        bank_name: document.getElementById('bfBankName').value.trim(),
        bank_code: document.getElementById('bfBankCode').value.trim(),
        branch_name: document.getElementById('bfBranchName').value.trim(),
        branch_code: document.getElementById('bfBranchCode').value.trim(),
        account_type: document.getElementById('bfAccountType').value,
        account_number: document.getElementById('bfAccountNumber').value.trim(),
        account_holder: document.getElementById('bfAccountHolder').value.trim(),
        is_default: document.getElementById('bfIsDefault').checked ? 1 : 0,
    };
    if (!body.bank_name || !body.branch_name || !body.account_number || !body.account_holder) {
        showToast('Please fill all required fields', 'error'); return;
    }
    try {
        await apiFetch('/bank-accounts', { method: 'POST', body: JSON.stringify(body) });
        closeAddAccountForm(); await loadBankAccounts(); showToast('Account registered!', 'success');
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

async function setDefaultAccount(id) {
    try {
        await apiFetch('/bank-accounts/' + id + '/default', { method: 'PATCH' });
        await loadBankAccounts(); showToast('Default account updated', 'success');
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

async function deleteAccount(id, bankName) {
    if (!confirm('Delete account "' + bankName + '"?')) return;
    try {
        await apiFetch('/bank-accounts/' + id, { method: 'DELETE' });
        document.getElementById('bac-' + id)?.remove();
        _bankAccounts = _bankAccounts.filter(function (a) { return a.id !== id; });
        showToast('Account deleted', 'success');
        if (!_bankAccounts.length) loadBankAccounts();
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

async function submitPayout() {
    var bankAccountId = document.getElementById('payoutBankSelect')?.value;
    var amount = parseFloat(document.getElementById('payoutAmount')?.value || 0);
    var notes = document.getElementById('payoutNotes')?.value || '';
    if (!bankAccountId) { showToast('Select a bank account', 'error'); return; }
    if (!amount || amount < 1000) { showToast('Minimum withdrawal: 1000 yen', 'error'); return; }
    var btn = document.querySelector('#payoutForm .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Applying...'; }
    try {
        var result = await apiFetch('/bank-accounts/payout', {
            method: 'POST', body: JSON.stringify({ bank_account_id: parseInt(bankAccountId), amount: amount, notes: notes })
        });
        document.getElementById('payoutForm').classList.add('hidden');
        document.getElementById('payoutSuccess').classList.remove('hidden');
        var acct = _bankAccounts.find(function (a) { return a.id === parseInt(bankAccountId); });
        var typeLabel = acct && acct.account_type === 'checking' ? 'Toza' : 'Futsuu';
        var masked = acct ? acct.account_number.slice(-4).padStart(acct.account_number.length, '*') : '****';
        var detail = document.getElementById('payoutSuccessDetail');
        if (detail) detail.innerHTML =
            '<div>Application #: #' + result.id + '</div>'
            + '<div>Amount: <strong>' + Math.round(amount).toLocaleString() + ' yen</strong></div>'
            + '<div>Bank: ' + (acct ? acct.bank_name : '') + ' ' + (acct ? acct.branch_name : '') + ' ' + typeLabel + ' ' + masked + '</div>'
            + '<div>Holder: ' + (acct ? acct.account_holder : '') + '</div>';
        loadWalletBalance();
        showToast('Withdrawal application submitted!', 'success');
    } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = 'Submit Withdrawal'; }
        showToast('Error: ' + e.message, 'error');
    }
}

function resetPayoutForm() {
    document.getElementById('payoutForm').classList.remove('hidden');
    document.getElementById('payoutSuccess').classList.add('hidden');
    var btn = document.querySelector('#payoutForm .btn-primary');
    if (btn) { btn.disabled = false; btn.textContent = 'Submit Withdrawal'; }
    var amt = document.getElementById('payoutAmount'); if (amt) amt.value = '';
    var notes = document.getElementById('payoutNotes'); if (notes) notes.value = '';
}

async function loadPayoutHistory() {
    var el = document.getElementById('payoutHistoryList');
    if (!el) return;
    el.innerHTML = '<div class="wd-empty">Loading...</div>';
    try {
        var list = await apiFetch('/bank-accounts/payouts');
        if (!list.length) { el.innerHTML = '<div class="wd-empty">No withdrawal history</div>'; return; }
        el.innerHTML = list.map(function (p) {
            var statusLabels = { pending: 'Under Review', paid: 'Paid', rejected: 'Rejected' };
            var statusBadges = { pending: 'b-warning', paid: 'b-success', rejected: 'b-danger' };
            return '<div class="payout-history-row">'
                + '<div>'
                + '<div style="font-weight:600">' + Math.round(p.amount).toLocaleString() + ' yen</div>'
                + '<div class="phr-bank">' + (p.bank_name || '') + '  ' + (p.branch_name || '') + '  #' + p.id + '</div>'
                + '<div style="font-size:0.72rem;color:var(--text3)">' + new Date(p.created_at).toLocaleDateString('ja-JP') + '</div>'
                + '</div>'
                + '<span class="badge ' + (statusBadges[p.status] || 'b-muted') + '">' + (statusLabels[p.status] || p.status) + '</span>'
                + '</div>';
        }).join('');
    } catch (e) { el.innerHTML = '<div class="wd-empty">Error: ' + e.message + '</div>'; }
}

/* ─────────────────────────────────────────────────────────────────── */
/* ─── POINTS & TICKETS ───────────────────────────────────────────── */
/* ─────────────────────────────────────────────────────────────────── */

let _ticketPlans = [];

    // ポイント残高をナビに表示
async function loadPointBalance() {
    if (!state.user) return;
    try {
        const data = await apiFetch('/points/balance');
        const el = document.getElementById('navPointBalance');
        if (el) el.textContent = `${data.point_balance.toLocaleString()} pt`;
    } catch { }
}

    // チケット購入モーダルを開く
async function openTicketModal() {
    const modal = document.getElementById('ticketModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    await renderTicketPlans();
}

function closeTicketModal() {
    const modal = document.getElementById('ticketModal');
    if (modal) { modal.style.display = 'none'; document.body.style.overflow = ''; }
}

async function renderTicketPlans() {
    const container = document.getElementById('ticketPlansContainer');
    if (!container) return;
    container.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text2)">読み込み中...</div>';
    try {
        _ticketPlans = await apiFetch('/points/plans');
    // ポイント残高も更新
        const bal = await apiFetch('/points/balance');
        const balEl = document.getElementById('ticketCurrentBalance');
    if (balEl) balEl.textContent = `現在残高：${bal.point_balance.toLocaleString()}pt`;

        container.innerHTML = _ticketPlans.map(p => `
          <div class="ticket-plan ${p.badge ? 'plan-featured' : ''}" onclick="selectTicketPlan('${p.id}')">
            ${p.badge ? `<span class="plan-badge">${p.badge}</span>` : ''}
            ${p.discount ? `<span class="plan-discount">-${p.discount}%OFF</span>` : ''}
            <div class="plan-name">${p.name}</div>
<div class="plan-hours">${p.hours}時間</div>
<div class="plan-price">¥${p.amount_yen.toLocaleString()}</div>
            <div class="plan-points">= ${p.points.toLocaleString()} pt</div>
            ${p.discount ? `<div class="plan-original">定価 ¥${Math.round(p.hours * 800).toLocaleString()}</div>` : ''}
            <button class="btn btn-primary btn-full" onclick="purchaseTicket('${p.id}',event)">購入する</button>
          </div>
        `).join('');
    } catch (e) {
        container.innerHTML = `<div style="color:var(--danger);padding:1rem">${e.message}</div>`;
    }
}

async function purchaseTicket(planId, event) {
    if (event) event.stopPropagation();
    const plan = _ticketPlans.find(p => p.id === planId);
    if (!plan) return;
    const btn = event?.target;
    if (btn) { btn.disabled = true; btn.textContent = '処理中...'; }
    // クーポンコードを取得
    const couponInput = document.getElementById('couponCodeInput');
    const couponCode = couponInput?.value.trim() || '';
    try {
        const result = await apiFetch('/stripe/checkout/points', {
            method: 'POST',
            body: JSON.stringify({ plan_id: planId, coupon_code: couponCode || undefined, return_to: 'portal' }),
        });
        if (result.test_mode) {
            showToast(`${result.points_added}pt 付与されました！（テストモード）`, 'success');
            loadPointBalance();
            renderTicketPlans();
        } else if (result.url || result.checkout_url || result.redirect_url) {
        showToast('Stripe決済ページに移動します...', 'info');
            setTimeout(() => { window.location.href = result.url || result.checkout_url || result.redirect_url; }, 1000);
        }
    } catch (e) {
        showToast('購入エラー: ' + e.message, 'error');
        if (btn) { btn.disabled = false; btn.textContent = '購入する'; }
    }
}

function createTicketModal() {
    const modal = document.createElement('div');
    modal.id = 'ticketModal';
    modal.className = 'hidden';
    modal.innerHTML = `
      <div class="ticket-modal-box">
        <div class="modal-header">
          <h2>🎟 チケット購入</h2>
          <span class="modal-subtitle" id="ticketCurrentBalance">残高確認中...</span>
          <button class="modal-close" onclick="closeTicketModal()">✕</button>
        </div>
        <div class="ticket-modal-body">
          <div class="ticket-plans-note">
            <span>📌 1pt = 10円相当。GPU予約時に自動消費されます。</span>
          </div>
          <div style="display:flex;gap:.4rem;align-items:center;margin-bottom:0.6rem;padding:0.5rem 0.75rem;background:rgba(108,71,255,0.08);border:1px solid rgba(108,71,255,0.2);border-radius:10px">
            <span style="font-size:0.9rem">🏷️</span>
            <input id="couponCodeInput" type="text" placeholder="クーポンコード（例: BETA2025）"
              style="flex:1;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:.35rem .6rem;color:var(--text);font-size:.8rem;outline:none"
              oninput="couponInputChanged(this.value)" />
            <button onclick="applyCoupon()" style="padding:.35rem .75rem;background:var(--primary);border:none;border-radius:6px;color:#fff;font-size:.75rem;cursor:pointer;white-space:nowrap;font-weight:600">適用</button>
          </div>
          <div id="couponResult" style="display:none;margin-bottom:0.5rem;padding:.45rem 0.75rem;border-radius:8px;font-size:.78rem"></div>
          <div class="ticket-plans-grid" id="ticketPlansContainer">
            <div style="text-align:center;padding:2rem;color:var(--text2);grid-column:1/-1">読み込み中...</div>
          </div>
        </div>
        <div class="ticket-footer">
          <a href="https://stripe.com/jp" target="_blank">🔒 Stripe（クレジットカード）で安全に決済</a>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeTicketModal(); });
    renderTicketPlans();
}

    // クーポン入力変化時にリセット
function couponInputChanged(val) {
    if (!val) {
        const r = document.getElementById('couponResult');
        if (r) r.style.display = 'none';
    }
}

    // クーポン適用ボタン
let _appliedCoupon = null;
async function applyCoupon() {
    const input = document.getElementById('couponCodeInput');
    const result = document.getElementById('couponResult');
    const code = input?.value.trim();
    if (!code) { showToast('クーポンコードを入力してください', 'error'); return; }
    try {
        const data = await apiFetch('/coupons/validate', {
            method: 'POST',
    body: JSON.stringify({ code, amount_yen: 800 }), // 最小のランで固定金額
        });
        _appliedCoupon = data;
        result.style.display = 'block';
        result.style.background = 'rgba(0,229,160,0.1)';
        result.style.border = '1px solid rgba(0,229,160,0.3)';
        result.style.color = '#00e5a0';
        result.innerHTML = `<strong>${data.code}</strong> — ${data.label} が適用されました！`;
        showToast(`クーポン ${data.code} を適用しました`, 'success');
    } catch (e) {
        _appliedCoupon = null;
        result.style.display = 'block';
        result.style.background = 'rgba(255,71,87,0.1)';
        result.style.border = '1px solid rgba(255,71,87,0.3)';
        result.style.color = '#ff4757';
        result.innerHTML = `笶・${e.message}`;
    }
}

/* ━━━ Reconnect (再接続) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
async function reconnectPod(podId) {
    const btn = document.getElementById(`reconnectBtn_${podId}`);
    if (btn) { btn.disabled = true; btn.textContent = '再接続中...'; }
    try {
        const result = await apiFetch(`/pods/${podId}/reconnect`, { method: 'POST' });
        showToast(result.message || '✅ 再接続しました', 'success');
        const wsBase = API || location.origin;
        setTimeout(() => window.open(`${wsBase}/workspace/`, '_blank'), 1200);
        setTimeout(() => loadMyReservations(), 2000);
    } catch (e) {
        showToast('再接続エラー: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '再接続'; }
    }
}

/* ━━━ 予約リストに再接続ボタンを追加（renderReservations 拡張）━━━ */
// Override renderReservations to add reconnect for paused pods
const _origRenderReservations = renderReservations;
function renderReservations(list) {
    const el = document.getElementById('myReservationsList');
    if (!list.length) {
    el.innerHTML = '<p style="color:var(--text2);padding:1rem;font-size:0.875rem">予約がありません</p>';
        return;
    }
    const statusLabel = {
        pending: '確認中', confirmed: '確定済み', active: '稼働中',
    completed: '完了', cancelled: 'キャンセル', paused: '一時停止中'
    };
    const wsBase = API || location.origin;

    el.innerHTML = list.map(r => {
    // 対応する Pod のステータスを確認（.pod_status があれば）
        const isPaused = r.pod_status === 'paused';
        const podId = r.last_pod_id;

        return `
        <div class="reservation-item">
          <div class="res-header">
            <span class="res-gpu">${r.gpu_name}</span>
            <span class="status-badge status-${r.status === 'active' ? 'available' : r.status === 'completed' ? 'offline' : 'rented'}">
              ${statusLabel[r.status] || r.status}
            </span>
          </div>
      <div class="res-time">📅 ${formatDate(r.start_time)} → ${formatDate(r.end_time)}</div>
          <div class="res-time">📅 ¥${r.total_price ? Math.round(r.total_price).toLocaleString() : '-'}</div>
            ${r.compensated_points ? `<span style="color:var(--success);font-size:0.75rem;margin-left:8px">+${r.compensated_points}pt 陬懷─貂・/span>` : ''}
          </div>
          <div class="res-actions">
            ${r.status === 'active'
                ? `<a href="${wsBase}/workspace/" target="_blank" class="btn btn-success btn-sm">▶ ワークスペース</a>
                   ${podId ? `<button class="btn btn-ghost btn-sm" id="reconnectBtn_${podId}" onclick="reconnectPod(${podId})">再接続</button>` : ''}`
                : (r.status === 'confirmed' || r.status === 'pending')
                    ? `<button class="btn btn-primary btn-sm" onclick="startPod(${r.id})" id="startBtn_${r.id}">▶ 今すぐ起動</button>
                       <button class="btn btn-danger btn-sm" onclick="cancelReservation(${r.id})">キャンセル</button>`
                    : ''}
          </div>
        </div>`;
    }).join('');
}

    // 予約データ取得を拡張 - Pod情報を含める
async function loadMyReservations() {
    if (!state.user) return;
    try {
        const res = await apiFetch('/reservations');
    // 各予約に最新 Pod のステータスを付加
        state.reservations = res;
        renderReservations(res);
    } catch { }
}

/* ─── Payment success/failed message from callback ──────────────── */
(function checkPaymentReturn() {
    const params = new URLSearchParams(location.search);
    const payment = params.get('payment');
    const pts     = params.get('points');
    const sid     = params.get('session_id');
    const pid     = params.get('purchase');

    history.replaceState({}, '', location.pathname);

    if (payment === 'success' && sid && pid) {
    // Stripe Checkout からの戻り → verify-payment でポイント付与確認
        const token = localStorage.getItem('gpu_token');
    if (!token) { showToast('✅ 決済完了！ログインしてポイントを確認してください', 'success'); return; }
        fetch(`/api/stripe/verify-payment?session_id=${sid}&purchase_id=${pid}`, {
            headers: { 'Authorization': 'Bearer ' + token }
        }).then(r => r.json()).then(d => {
            if (d.ok) {
                const msg = d.already_granted
                    ? '✓ 未付与ポイントが付与済みです'
            : `✓ ${d.points_added.toLocaleString()}pt が付与されました！`;
                showToast(msg, 'success');
                loadPointBalance();
            } else {
        showToast('🔍 決済確認中...しばらくお待ちください', 'warning');
                setTimeout(() => loadPointBalance(), 3000);
            }
        }).catch(() => {
        showToast('✅ 決済完了！ポイント残高を確認してください', 'success');
            setTimeout(() => loadPointBalance(), 1000);
        });
    } else if (payment === 'success' && pts) {
        showToast(`✅ 決済完了！${Number(pts).toLocaleString()}pt が付与されました`, 'success');
        loadPointBalance();
    } else if (payment === 'failed') {
        showToast('❌ 決済が失敗しました', 'error');
    } else if (payment === 'cancelled') {
        showToast('決済がキャンセルされました', 'info');
    }
})();

/* ━━━ ?tab=register で登録モーダルを自動表示 ━━━━━━━━━━━━━━━━━━━━━━━━━ */
(function checkTabParam() {
    const params = new URLSearchParams(location.search);
    const tab = params.get('tab');
    if (tab === 'register' && !state.user) {
    // DOMContentLoaded 後に開く
        const open = () => openAuthModal('register');
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', open, { once: true });
        } else {
    setTimeout(open, 300); // 他の初期化処理が終わってから
        }
    // URL から tab パラメータを除去（ブラウザ履歴をきれいに）
        const url = new URL(location.href);
        url.searchParams.delete('tab');
        history.replaceState({}, '', url.toString());
    }
})();

    // チケット購入ボタンをナビに追加
document.addEventListener('DOMContentLoaded', () => {
    const nav = document.getElementById('navActions') || document.querySelector('.nav-actions') || document.querySelector('nav');
    if (nav) {
        const ticketBtn = document.createElement('button');
        ticketBtn.id = 'navTicketBtn';
        ticketBtn.className = 'btn btn-primary btn-sm';
        ticketBtn.style.cssText = 'background:linear-gradient(135deg,#f59e0b,#ef4444);margin-right:8px';
        ticketBtn.textContent = '🎟 チケット購入';
        ticketBtn.addEventListener('click', openTicketModal);
        nav.insertBefore(ticketBtn, nav.firstChild);

    // ポイント残高表示
        const balSpan = document.createElement('span');
        balSpan.id = 'navPointBalance';
        balSpan.style.cssText = 'font-size:0.75rem;color:var(--accent);margin-right:8px;font-family:monospace';
        balSpan.textContent = '0 pt';
        nav.insertBefore(balSpan, nav.firstChild);
    }
    loadPointBalance();

    // ━━ ヒーロー統計をリアルタイムロード ━━
    loadHeroStats();
    loadGpus();
    // 30秒ごとに自動更新
    setInterval(() => {
        loadHeroStats();
        loadGpus();
    }, 30000);
});


/* ── MOBILE MENU ─────────────────────────────────────────────── */
function toggleMobileMenu() {
    const drawer = document.getElementById('navDrawer');
    const btn    = document.getElementById('navHamburger');
    if (!drawer) return;
    const isOpen = drawer.classList.toggle('open');
    btn && btn.classList.toggle('open', isOpen);
    document.body.style.overflow = isOpen ? 'hidden' : '';
}
function closeMobileMenu() {
    const drawer = document.getElementById('navDrawer');
    const btn    = document.getElementById('navHamburger');
    if (!drawer) return;
    drawer.classList.remove('open');
    btn && btn.classList.remove('open');
    document.body.style.overflow = '';
}
    // ログイン状態変化時にドロワーを更新
function syncDrawerAuth(user) {
    const authSec = document.getElementById('drawerAuthSection');
    const userSec = document.getElementById('drawerUserSection');
    const nameEl  = document.getElementById('drawerUsername');
    const adminLink = document.getElementById('drawerAdmin');
    if (!authSec || !userSec) return;
    if (user) {
        authSec.style.display = 'none';
        userSec.style.display = 'flex';
    if (nameEl) nameEl.textContent = '👤 ' + (user.username || user.email || 'ユーザー');
        if (adminLink) adminLink.classList.toggle('hidden', user.role !== 'admin');
    } else {
        authSec.style.display = 'flex';
        userSec.style.display = 'none';
    }
}


/* ─── THE DOJO エージェントトークン管理 ─────────────────────────────────────
   プロバイダー向け: マイページに「THE DOJO 設定」セクションを追加
   - GET  /api/auth/agent-token
   - POST /api/auth/agent-token/regenerate
   ──────────────────────────────────────────────────────────────────────── */

async function loadAgentToken() {
    const el = document.getElementById('agentTokenValue');
    const section = document.getElementById('theDojoSection');
    if (!state.user || (state.user.role !== 'provider' && state.user.role !== 'admin')) {
        if (section) section.style.display = 'none';
        return;
    }
    if (section) section.style.display = '';
    if (!el) return;
    try {
        const data = await apiFetch('/auth/agent-token');
        el.textContent = data.agent_token;
    } catch (e) {
        if (el) el.textContent = '取得エラー: ' + e.message;
    }
}

async function regenerateAgentToken() {
    if (!confirm('エージェントトークンを再生成します。\n既存の THE DOJO エージェント設定は無効になります。続けますか?')) return;
    try {
        const data = await apiFetch('/auth/agent-token/regenerate', { method: 'POST' });
        const el = document.getElementById('agentTokenValue');
        if (el) el.textContent = data.agent_token;
        showToast('✅ エージェントトークンを再生成しました', 'success');
    } catch (e) {
        showToast('❌ 再生成失敗: ' + e.message, 'error');
    }
}

function copyAgentToken() {
    const el = document.getElementById('agentTokenValue');
    if (!el) return;
    navigator.clipboard.writeText(el.textContent).then(() => {
        showToast('📋 トークンをコピーしました', 'success');
    }).catch(() => {
        showToast('コピーに失敗しました', 'error');
    });
}

// ページ読み込み時・ログイン後に実行
(function initAgentToken() {
    document.addEventListener('DOMContentLoaded', () => {
        // ログイン状態が確定してからロード
        const check = setInterval(() => {
            if (state.user !== undefined) {
                clearInterval(check);
                loadAgentToken();
            }
        }, 300);
    });
})();

