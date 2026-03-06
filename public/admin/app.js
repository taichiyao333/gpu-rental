/* ── STATE ─────────────────────────────────────────────────────── */
const token = localStorage.getItem('gpu_token');
const user = JSON.parse(localStorage.getItem('gpu_user') || 'null');

// Redirect if not admin
if (!token || !user || user.role !== 'admin') {
    window.location.href = '/portal/';
}

document.getElementById('sfUsername').textContent = user?.username || '—';

/* ── API ───────────────────────────────────────────────────────── */
async function api(path, opts = {}) {
    const res = await fetch(`/api${path}`, {
        ...opts,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...opts.headers },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'API Error');
    return data;
}

/* ── NAVIGATION ────────────────────────────────────────────────── */
let currentSection = 'overview';
document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
        const sec = btn.dataset.section;
        document.getElementById(`section-${sec}`).classList.add('active');
        currentSection = sec;
        loadSection(sec);
    });
});

function loadSection(sec) {
    switch (sec) {
        case 'overview': refreshAll(); break;
        case 'gpus': loadGpus(); break;
        case 'pods': loadPods(); break;
        case 'reservations': loadReservations(); break;
        case 'earnings': loadEarnings(); break;
        case 'payouts': loadPayouts(); break;
        case 'users': loadUsers(); break;
        case 'alerts': loadAlerts(); break;
    }
}

/* ── LOGOUT ────────────────────────────────────────────────────── */
document.getElementById('btnAdminLogout').addEventListener('click', () => {
    localStorage.removeItem('gpu_token'); localStorage.removeItem('gpu_user');
    window.location.href = '/portal/';
});

/* ── CHARTS ────────────────────────────────────────────────────── */
Chart.defaults.color = '#9898b8';
Chart.defaults.borderColor = 'rgba(255,255,255,0.05)';
Chart.defaults.font.family = "'Inter', sans-serif";

const utilHistory = { labels: [], gpu: [], vram: [] };
let chartUtil = null, chartStatus = null, chartRevenue = null;

function initCharts() {
    // Utilization history line chart
    const ctx1 = document.getElementById('chartUtilHistory').getContext('2d');
    chartUtil = new Chart(ctx1, {
        type: 'line',
        data: {
            labels: utilHistory.labels,
            datasets: [
                { label: 'GPU使用率', data: utilHistory.gpu, borderColor: '#6c47ff', backgroundColor: 'rgba(108,71,255,0.1)', fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2 },
                { label: 'VRAM', data: utilHistory.vram, borderColor: '#00d4ff', backgroundColor: 'rgba(0,212,255,0.07)', fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2 },
            ],
        },
        options: { animation: false, plugins: { legend: { labels: { boxWidth: 12, font: { size: 11 } } } }, scales: { y: { min: 0, max: 100, ticks: { callback: v => v + '%' } }, x: { ticks: { maxTicksLimit: 6 } } } },
    });

    // GPU status doughnut
    const ctx2 = document.getElementById('chartGpuStatus').getContext('2d');
    chartStatus = new Chart(ctx2, {
        type: 'doughnut',
        data: {
            labels: ['空きあり', '使用中', 'メンテ', 'オフライン'],
            datasets: [{ data: [0, 0, 0, 0], backgroundColor: ['#00e5a0', '#6c47ff', '#ffb300', '#5a5a7a'], borderWidth: 0, hoverOffset: 4 }],
        },
        options: { plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } }, cutout: '65%' },
    });

    // Revenue bar chart
    const ctx3 = document.getElementById('chartRevenue').getContext('2d');
    chartRevenue = new Chart(ctx3, {
        type: 'bar',
        data: {
            labels: [],
            datasets: [
                { label: '総収益', data: [], backgroundColor: 'rgba(108,71,255,0.6)', borderColor: '#6c47ff', borderWidth: 1, borderRadius: 4 },
                { label: 'プロバイダー', data: [], backgroundColor: 'rgba(0,229,160,0.4)', borderColor: '#00e5a0', borderWidth: 1, borderRadius: 4 },
            ],
        },
        options: { plugins: { legend: { labels: { boxWidth: 12, font: { size: 11 } } } }, scales: { y: { ticks: { callback: v => '¥' + v.toLocaleString() } } } },
    });
}

/* ── OVERVIEW ──────────────────────────────────────────────────── */
async function refreshAll() {
    document.getElementById('lastUpdated').textContent = `最終更新: ${new Date().toLocaleTimeString('ja-JP')}`;
    try {
        const ovr = await api('/admin/overview');
        document.getElementById('kActivePods').textContent = ovr.activePods ?? 0;
        document.getElementById('kAvailGpus').textContent = (ovr.gpus || []).filter(g => g.status === 'available').length;
        document.getElementById('kTotalUsers').textContent = ovr.totalUsers ?? 0;
        document.getElementById('kMonthRevenue').textContent = '¥' + Math.round(ovr.monthRevenue || 0).toLocaleString();
        document.getElementById('kTotalRes').textContent = ovr.totalReservations ?? 0;

        // GPU stats
        const gpus = ovr.gpus || [];
        const avgUtil = gpus.reduce((s, g) => s + (g.stats?.gpuUtil || 0), 0) / (gpus.length || 1);
        document.getElementById('kUtilization').textContent = Math.round(avgUtil) + '%';

        // GPU Monitor Cards
        renderGpuMonitorCards(gpus);

        // Doughnut
        if (chartStatus) {
            const counts = [
                gpus.filter(g => g.status === 'available').length,
                gpus.filter(g => g.status === 'rented').length,
                gpus.filter(g => g.status === 'maintenance').length,
                gpus.filter(g => g.status === 'offline').length,
            ];
            chartStatus.data.datasets[0].data = counts;
            chartStatus.update('none');
        }

        // Push util history
        if (chartUtil && gpus.length) {
            const now = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const gpu0 = gpus[0];
            utilHistory.labels.push(now);
            utilHistory.gpu.push(gpu0.stats?.gpuUtil || 0);
            utilHistory.vram.push(gpu0.stats?.vramTotal ? Math.round((gpu0.stats.vramUsed / gpu0.stats.vramTotal) * 100) : 0);
            if (utilHistory.labels.length > 30) { utilHistory.labels.shift(); utilHistory.gpu.shift(); utilHistory.vram.shift(); }
            chartUtil.update('none');
        }

        // Activity feed
        renderActivityFeed(ovr.recentAlerts || [], ovr.recentPods || []);
    } catch (err) {
        console.error('Overview error:', err);
    }
}

function renderGpuMonitorCards(gpus) {
    const grid = document.getElementById('gpuMonitorGrid');
    if (!gpus.length) { grid.innerHTML = '<div style="color:var(--text3);font-size:0.85rem;grid-column:1/-1;padding:1rem">GPUが登録されていません</div>'; return; }
    grid.innerHTML = gpus.map(gpu => {
        const s = gpu.stats || {};
        const util = s.gpuUtil || 0;
        const vramPct = s.vramTotal ? Math.round((s.vramUsed / s.vramTotal) * 100) : 0;
        const temp = s.temperature || 0;
        const pwr = s.powerDraw || 0;
        const pwrPct = s.powerLimit ? Math.round((pwr / s.powerLimit) * 100) : 0;
        const hot = temp > (gpu.temp_threshold || 85);
        const statusLabel = { available: '空きあり', rented: '使用中', maintenance: 'メンテ中', offline: 'オフライン' }[gpu.status] || gpu.status;
        const badgeCls = { available: 'b-success', rented: 'b-primary', maintenance: 'b-warning', offline: 'b-muted' }[gpu.status];
        return `
        <div class="gpu-card">
          <div class="gpu-card-header">
            <div><div class="gpu-card-name">${gpu.name}</div><div style="font-size:0.72rem;color:var(--text3);margin-top:2px">${gpu.location} · ${Math.round(gpu.vram_total / 1024)}GB VRAM</div></div>
            <span class="badge ${badgeCls}">${statusLabel}</span>
          </div>
          <div class="gauge"><div class="gauge-hd"><span class="gauge-label">GPU使用率</span><span class="gauge-val">${util}%</span></div><div class="gauge-track"><div class="gauge-fill gf-util" style="width:${util}%"></div></div></div>
          <div class="gauge"><div class="gauge-hd"><span class="gauge-label">VRAM</span><span class="gauge-val">${s.vramUsed || 0}/${s.vramTotal || 0} MB (${vramPct}%)</span></div><div class="gauge-track"><div class="gauge-fill gf-vram" style="width:${vramPct}%"></div></div></div>
          <div class="gauge"><div class="gauge-hd"><span class="gauge-label">温度</span><span class="gauge-val" style="color:${hot ? 'var(--danger)' : 'inherit'}">${temp}°C${hot ? ' ⚠' : ''}
</span></div><div class="gauge-track"><div class="gauge-fill gf-temp${hot ? ' hot' : ''}" style="width:${Math.min(100, temp)}%"></div></div></div>
          <div class="gauge"><div class="gauge-hd"><span class="gauge-label">電力</span><span class="gauge-val">${Math.round(pwr)}W / ${Math.round(s.powerLimit || 0)}W</span></div><div class="gauge-track"><div class="gauge-fill gf-pwr" style="width:${pwrPct}%"></div></div></div>
          <div class="gpu-meta">
            <div class="gpu-meta-item">P-State: <span>${s.pstate || '-'}</span></div>
            <div class="gpu-meta-item">Driver: <span>${gpu.driver_version || '-'}</span></div>
            <div class="gpu-meta-item">¥: <span>${gpu.price_per_hour?.toLocaleString() || '-'}/h</span></div>
            <div class="gpu-meta-item" style="margin-left:auto"><button class="btn btn-ghost btn-sm" onclick="openGpuModal(${gpu.id})">設定</button></div>
          </div>
        </div>`;
    }).join('');
}

function renderActivityFeed(alerts, pods) {
    const feed = document.getElementById('activityFeed');
    const items = [
        ...alerts.map(a => ({ msg: `🔔 ${a.message}`, time: a.created_at, color: a.severity === 'critical' ? 'var(--danger)' : a.severity === 'warning' ? 'var(--warning)' : 'var(--accent)' })),
        ...pods.map(p => ({ msg: `🚀 Pod #${p.id} - ${p.renter_name || 'User'}`, time: p.started_at, color: 'var(--success)' })),
    ].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 15);

    if (!items.length) {
        feed.innerHTML = '<li class="feed-item"><div class="feed-msg" style="color:var(--text3)">アクティビティなし</div></li>';
        return;
    }
    feed.innerHTML = items.map(i => `
      <li class="feed-item">
        <div class="feed-dot" style="background:${i.color}"></div>
        <div class="feed-msg">${i.msg}</div>
        <div class="feed-time">${new Date(i.time).toLocaleTimeString('ja-JP')}</div>
      </li>`).join('');
}

/* ── GPUS TABLE ─────────────────────────────────────────────────── */
async function loadGpus() {
    try {
        const gpus = await api('/gpus');
        const stat = await api('/admin/overview').catch(() => ({ gpus: [] }));
        const statsMap = {};
        (stat.gpus || []).forEach(g => statsMap[g.id] = g.stats);

        const statusLabel = { available: '空きあり', rented: '使用中', maintenance: 'メンテ中', offline: 'オフライン' };
        const badgeCls = { available: 'b-success', rented: 'b-primary', maintenance: 'b-warning', offline: 'b-muted' };

        document.getElementById('gpuTableBody').innerHTML = gpus.map(g => {
            const s = statsMap[g.id] || {};
            return `<tr>
              <td><strong>${g.name}</strong></td>
              <td class="mono">${Math.round(g.vram_total / 1024)} GB</td>
              <td><span class="badge ${badgeCls[g.status] || 'b-muted'}">${statusLabel[g.status] || g.status}</span></td>
              <td class="mono">${s.gpuUtil || 0}%</td>
              <td class="mono" style="color:${(s.temperature || 0) > 85 ? 'var(--danger)' : 'inherit'}">${s.temperature || 0}°C</td>
              <td class="mono">¥${g.price_per_hour?.toLocaleString()}</td>
              <td>${g.location}</td>
              <td><button class="btn btn-ghost btn-sm" onclick="openGpuModal(${g.id})">編集</button></td>
            </tr>`;
        }).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:2rem">GPUなし</td></tr>';
    } catch (err) { console.error(err); }
}

/* ── PODS TABLE ─────────────────────────────────────────────────── */
async function loadPods() {
    try {
        const pods = await api('/admin/pods');
        document.getElementById('podTableBody').innerHTML = (pods || []).filter(p => p.status === 'running').map(p => {
            const elapsed = Math.round((Date.now() - new Date(p.started_at)) / 60000);
            const cost = elapsed * (p.price_per_hour || 0) / 60;
            return `<tr>
              <td class="mono">#${p.id}</td>
              <td>${p.renter_name || p.renter_id}</td>
              <td>${p.gpu_name}</td>
              <td>${new Date(p.started_at).toLocaleString('ja-JP')}</td>
              <td>${new Date(p.expires_at).toLocaleString('ja-JP')}</td>
              <td class="mono" style="color:var(--success)">¥${Math.round(cost).toLocaleString()}</td>
              <td><button class="btn btn-danger btn-sm" onclick="stopPod(${p.id})">停止</button></td>
            </tr>`;
        }).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:2rem">稼働中Podなし</td></tr>';
    } catch (err) { console.error(err); }
}

async function stopPod(podId) {
    if (!confirm(`Pod #${podId} を強制停止しますか？`)) return;
    try { await api(`/pods/${podId}`, { method: 'DELETE' }); loadPods(); } catch (e) { alert(e.message); }
}

/* ── RESERVATIONS TABLE ─────────────────────────────────────────── */
async function loadReservations() {
    try {
        const list = await api('/admin/reservations');
        const statusLabel = { pending: '確認中', confirmed: '確定済', active: '稼働中', completed: '完了', cancelled: 'キャンセル', paid: '支払済' };
        const badgeCls = { pending: 'b-warning', confirmed: 'b-primary', active: 'b-success', completed: 'b-muted', cancelled: 'b-muted', paid: 'b-success' };
        document.getElementById('reservTableBody').innerHTML = (list || []).map(r => `<tr>
          <td class="mono">#${r.id}</td>
          <td>${r.renter_name || r.renter_id}</td>
          <td>${r.gpu_name}</td>
          <td>${new Date(r.start_time).toLocaleString('ja-JP')}</td>
          <td>${new Date(r.end_time).toLocaleString('ja-JP')}</td>
          <td><span class="badge ${badgeCls[r.status] || 'b-muted'}">${statusLabel[r.status] || r.status}</span></td>
          <td class="mono">¥${r.total_price ? Math.round(r.total_price).toLocaleString() : '—'}</td>
          <td>${r.status === 'pending' ? `<button class="btn btn-ghost btn-sm" onclick="confirmRes(${r.id})">確定</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:2rem">予約なし</td></tr>';
    } catch (err) { console.error(err); }
}

async function confirmRes(id) {
    try { await api(`/reservations/${id}/confirm`, { method: 'POST' }); loadReservations(); } catch (e) { alert(e.message); }
}

/* ── EARNINGS ───────────────────────────────────────────────────── */
async function loadEarnings() {
    try {
        const period = document.getElementById('earningPeriod').value;
        const data = await api(`/providers/earnings?period=${period}`);

        const totRev = data.reduce((s, d) => s + (d.gross_revenue || 0), 0);
        const totProv = data.reduce((s, d) => s + (d.net_payout || 0), 0);
        const totMins = data.reduce((s, d) => s + (d.total_minutes || 0), 0);
        const totSess = data.reduce((s, d) => s + (d.sessions || 0), 0);

        document.getElementById('eTotalRev').textContent = '¥' + Math.round(totRev).toLocaleString();
        document.getElementById('eProvPayout').textContent = '¥' + Math.round(totProv).toLocaleString();
        document.getElementById('eTotalHours').textContent = Math.round(totMins / 60) + 'h';
        document.getElementById('eSessions').textContent = totSess;

        // Revenue chart
        const grouped = {};
        data.forEach(d => { if (!grouped[d.period]) grouped[d.period] = { rev: 0, prov: 0 }; grouped[d.period].rev += d.gross_revenue || 0; grouped[d.period].prov += d.net_payout || 0; });
        const periods = Object.keys(grouped).sort();
        if (chartRevenue) {
            chartRevenue.data.labels = periods;
            chartRevenue.data.datasets[0].data = periods.map(p => Math.round(grouped[p].rev));
            chartRevenue.data.datasets[1].data = periods.map(p => Math.round(grouped[p].prov));
            chartRevenue.update();
        }

        // Table
        document.getElementById('earningsTableBody').innerHTML = data.map(d => `<tr>
          <td class="mono">${d.period}</td>
          <td>${d.gpu_name}</td>
          <td>${d.sessions}</td>
          <td>${Math.round(d.total_minutes / 60 * 10) / 10}h</td>
          <td class="mono">¥${Math.round(d.gross_revenue || 0).toLocaleString()}</td>
          <td class="mono" style="color:var(--success)">¥${Math.round(d.net_payout || 0).toLocaleString()}</td>
          <td class="mono" style="color:var(--accent)">¥${Math.round((d.gross_revenue || 0) * 0.2).toLocaleString()}</td>
        </tr>`).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:2rem">データなし</td></tr>';
    } catch (err) { console.error(err); }
}

/* ── PAYOUTS ────────────────────────────────────────────────────── */
async function loadPayouts() {
    try {
        const list = await api('/admin/payouts');
        document.getElementById('payoutTableBody').innerHTML = (list || []).map(p => `<tr>
          <td class="mono">#${p.id}</td>
          <td>${p.provider_name || p.provider_id}</td>
          <td class="mono" style="color:var(--success)">¥${Math.round(p.amount).toLocaleString()}</td>
          <td><span class="badge ${p.status === 'paid' ? 'b-success' : 'b-warning'}">${p.status === 'paid' ? '支払済' : '申請中'}</span></td>
          <td>${new Date(p.created_at).toLocaleString('ja-JP')}</td>
          <td>${p.status === 'pending' ? `<button class="btn btn-primary btn-sm" onclick="markPaid(${p.id})">支払い完了</button>` : '—'}</td>
        </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:2rem">出金申請なし</td></tr>';
    } catch (err) { console.error(err); }
}

async function markPaid(id) {
    try { await api(`/admin/payouts/${id}/paid`, { method: 'POST' }); loadPayouts(); } catch (e) { alert(e.message); }
}

/* ── USERS ──────────────────────────────────────────────────────── */
async function loadUsers() {
    try {
        const list = await api('/admin/users');
        const roleBadge = { admin: 'b-danger', provider: 'b-primary', user: 'b-muted' };
        const roleLabel = { admin: '管理者', provider: 'プロバイダー', user: 'ユーザー' };
        document.getElementById('userTableBody').innerHTML = (list || []).map(u => `<tr>
          <td class="mono">#${u.id}</td>
          <td><strong>${u.username}</strong></td>
          <td style="color:var(--text2)">${u.email}</td>
          <td><span class="badge ${roleBadge[u.role] || 'b-muted'}">${roleLabel[u.role] || u.role}</span></td>
          <td><span class="badge ${u.status === 'active' ? 'b-success' : 'b-danger'}">${u.status === 'active' ? '有効' : '停止'}</span></td>
          <td class="mono">¥${Math.round(u.wallet_balance || 0).toLocaleString()}</td>
          <td style="color:var(--text3)">${new Date(u.created_at).toLocaleDateString('ja-JP')}</td>
          <td>${u.role !== 'admin' ? `<button class="btn btn-ghost btn-sm" onclick="toggleUser(${u.id},'${u.status}')">${u.status === 'active' ? '停止' : '有効化'}</button>` : '—'}</td>
        </tr>`).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:2rem">ユーザーなし</td></tr>';
    } catch (err) { console.error(err); }
}

async function toggleUser(id, currentStatus) {
    const newStatus = currentStatus === 'active' ? 'suspended' : 'active';
    try { await api(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) }); loadUsers(); } catch (e) { alert(e.message); }
}

/* ── ALERTS ─────────────────────────────────────────────────────── */
async function loadAlerts() {
    try {
        const list = await api('/admin/alerts');
        const unresolved = (list || []).filter(a => !a.resolved).length;
        const badge = document.getElementById('alertsBadge');
        if (unresolved > 0) { badge.textContent = unresolved; badge.style.display = ''; } else { badge.style.display = 'none'; }

        const sevBadge = { critical: 'b-danger', warning: 'b-warning', info: 'b-primary' };
        document.getElementById('alertTableBody').innerHTML = (list || []).map(a => `<tr>
          <td>${a.type}</td>
          <td><span class="badge ${sevBadge[a.severity] || 'b-muted'}">${a.severity}</span></td>
          <td>${a.message}</td>
          <td>${a.gpu_id || '—'}</td>
          <td style="color:var(--text3)">${new Date(a.created_at).toLocaleString('ja-JP')}</td>
          <td><span class="badge ${a.resolved ? 'b-success' : 'b-warning'}">${a.resolved ? '解決済み' : '未解決'}</span></td>
        </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:2rem">アラートなし</td></tr>';
    } catch (err) { console.error(err); }
}

/* ── GPU MODAL ──────────────────────────────────────────────────── */
let _editingGpuId = null;
async function openGpuModal(gpuId) {
    _editingGpuId = gpuId;
    document.getElementById('gpuModalTitle').textContent = gpuId ? `GPU設定 #${gpuId}` : 'GPU追加';
    if (gpuId) {
        try {
            const gpu = await api(`/gpus/${gpuId}`);
            document.getElementById('editGpuStatus').value = gpu.status || 'available';
            document.getElementById('editGpuPrice').value = gpu.price_per_hour || 800;
            document.getElementById('editGpuTemp').value = gpu.temp_threshold || 85;
        } catch { }
    } else {
        document.getElementById('editGpuStatus').value = 'available';
        document.getElementById('editGpuPrice').value = '800';
        document.getElementById('editGpuTemp').value = '85';
    }
    document.getElementById('gpuModal').classList.add('open');
}

function closeModal(id) { document.getElementById(id).classList.remove('open'); }

async function saveGpu() {
    const payload = {
        status: document.getElementById('editGpuStatus').value,
        price_per_hour: parseInt(document.getElementById('editGpuPrice').value),
        temp_threshold: parseInt(document.getElementById('editGpuTemp').value),
    };
    try {
        if (_editingGpuId) {
            await api(`/admin/gpus/${_editingGpuId}`, { method: 'PATCH', body: JSON.stringify(payload) });
        }
        closeModal('gpuModal');
        loadSection(currentSection);
    } catch (e) { alert(e.message); }
}

/* ── WEBSOCKET ──────────────────────────────────────────────────── */
const socket = io();
socket.emit('auth', token);
socket.on('gpu:stats', stats => {
    if (currentSection === 'overview') refreshAll();
    // Update GPU cards inline without full refresh
});
socket.on('alert:new', alert => {
    const badge = document.getElementById('alertsBadge');
    const cur = parseInt(badge.textContent || '0') + 1;
    badge.textContent = cur; badge.style.display = '';
});

/* ── ADMIN API MISSING ENDPOINTS — add helpers ──────────────────── */
// Patch admin overview to include pods/alerts
async function enrichOverview(ovr) {
    try {
        const alerts = await api('/admin/alerts').catch(() => []);
        ovr.recentAlerts = (alerts || []).slice(0, 10);
    } catch { }
    return ovr;
}

/* ── INIT ───────────────────────────────────────────────────────── */
initCharts();
refreshAll();
setInterval(() => { if (currentSection === 'overview') refreshAll(); }, 8000);
