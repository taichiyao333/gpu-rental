/* 笏笏 STATE 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
const token = localStorage.getItem('gpu_token');
const user = JSON.parse(localStorage.getItem('gpu_user') || 'null');

// Redirect if not admin
if (!token || !user || user.role !== 'admin') {
    window.location.href = '/portal/';
}

document.getElementById('sfUsername').textContent = user?.username || '窶・;

/* API base: auto-detect local vs remote */
const API = (function () {
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return '';
    return ''; // same-origin
})();

/* 笏笏 API 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
async function api(path, opts = {}) {
    const res = await fetch(`${API}/api${path}`, {
        ...opts,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...opts.headers },
    });
    // Try to parse as JSON - if rate limited (429), server returns plain text
    let data;
    try {
        data = await res.json();
    } catch (_) {
        if (res.status === 429) throw new Error('繝ｪ繧ｯ繧ｨ繧ｹ繝医′螟壹☆縺弱∪縺吶ょｰ代＠蠕・▲縺ｦ縺九ｉ蜀榊ｺｦ縺願ｩｦ縺励￥縺縺輔＞縲・);
        throw new Error('HTTP ' + res.status + ' - 繧ｵ繝ｼ繝舌・繧ｨ繝ｩ繝ｼ縺檎匱逕溘＠縺ｾ縺励◆');
    }
    if (!res.ok) throw new Error(data.error || data.message || 'API Error');
    return data;
}

/* 笏笏 NAVIGATION 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
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
        case 'coupons': loadCoupons(); break;
        case 'pricing': loadPricingCompare(); break;
        case 'render-jobs': loadRenderJobs(); break;
        case 'backup': loadBackups(); loadKpiSummary(); break;
        case 'outage': loadOutageSection(); break;
        case 'apikeys': loadApiKeys(); break;
        case 'monitoring': loadMonitoring(); break;
        case 'purchases': loadPurchases(); break;
        case 'sf-nodes': loadSfNodes(); break;
        case 'sf-raid-jobs': loadSfRaidJobs(); break;
    }
}

/* 笏笏 LOGOUT 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
document.getElementById('btnAdminLogout').addEventListener('click', () => {
    localStorage.removeItem('gpu_token'); localStorage.removeItem('gpu_user');
    window.location.href = '/portal/';
});

/* 笏笏 CHARTS 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
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
                { label: '繝励Ο繝舌う繝繝ｼ', data: [], backgroundColor: 'rgba(0,229,160,0.4)', borderColor: '#00e5a0', borderWidth: 1, borderRadius: 4 },
            ],
        },
        options: { plugins: { legend: { labels: { boxWidth: 12, font: { size: 11 } } } }, scales: { y: { ticks: { callback: v => '¥' + v.toLocaleString() } } } },
    });
}

/* 笏笏 OVERVIEW 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
async function refreshAll() {
    document.getElementById('lastUpdated').textContent = `譛邨よ峩譁ｰ: ${new Date().toLocaleTimeString('ja-JP')}`;
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
    if (!gpus.length) { grid.innerHTML = '<div style="color:var(--text3);font-size:0.85rem;grid-column:1/-1;padding:1rem">GPU縺檎匳骭ｲ縺輔ｌ縺ｦ縺・∪縺帙ｓ</div>'; return; }
    grid.innerHTML = gpus.map(gpu => {
        const s = gpu.stats || {};
        const util = s.gpuUtil || 0;
        const vramPct = s.vramTotal ? Math.round((s.vramUsed / s.vramTotal) * 100) : 0;
        const temp = s.temperature || 0;
        const pwr = s.powerDraw || 0;
        const pwrPct = s.powerLimit ? Math.round((pwr / s.powerLimit) * 100) : 0;
        const hot = temp > (gpu.temp_threshold || 85);
        const statusLabel = { available: '空きあり', rented: '使用中', maintenance: 'メンテ'ｸｭ', offline: 'オフライン' }[gpu.status] || gpu.status;
        const badgeCls = { available: 'b-success', rented: 'b-primary', maintenance: 'b-warning', offline: 'b-muted' }[gpu.status];
        return `
        <div class="gpu-card">
          <div class="gpu-card-header">
            <div><div class="gpu-card-name">${gpu.name}</div><div style="font-size:0.72rem;color:var(--text3);margin-top:2px">${gpu.location} ﾂｷ ${Math.round(gpu.vram_total / 1024)}GB VRAM</div></div>
            <span class="badge ${badgeCls}">${statusLabel}</span>
          </div>
          <div class="gauge"><div class="gauge-hd"><span class="gauge-label">GPU菴ｿ逕ｨ邇・/span><span class="gauge-val">${util}%</span></div><div class="gauge-track"><div class="gauge-fill gf-util" style="width:${util}%"></div></div></div>
          <div class="gauge"><div class="gauge-hd"><span class="gauge-label">VRAM</span><span class="gauge-val">${s.vramUsed || 0}/${s.vramTotal || 0} MB (${vramPct}%)</span></div><div class="gauge-track"><div class="gauge-fill gf-vram" style="width:${vramPct}%"></div></div></div>
          <div class="gauge"><div class="gauge-hd"><span class="gauge-label">貂ｩ蠎ｦ</span><span class="gauge-val" style="color:${hot ? 'var(--danger)' : 'inherit'}">${temp}ﾂｰC${hot ? ' 笞' : ''}
</span></div><div class="gauge-track"><div class="gauge-fill gf-temp${hot ? ' hot' : ''}" style="width:${Math.min(100, temp)}%"></div></div></div>
          <div class="gauge"><div class="gauge-hd"><span class="gauge-label">髮ｻ蜉・/span><span class="gauge-val">${Math.round(pwr)}W / ${Math.round(s.powerLimit || 0)}W</span></div><div class="gauge-track"><div class="gauge-fill gf-pwr" style="width:${pwrPct}%"></div></div></div>
          <div class="gpu-meta">
            <div class="gpu-meta-item">P-State: <span>${(s && s.pstate) || '-'}</span></div>
            <div class="gpu-meta-item">Driver: <span>${gpu.driver_version || '-'}</span></div>
            <div class="gpu-meta-item">ﾂ･: <span>${gpu.price_per_hour?.toLocaleString() || '-'}/h</span></div>
            <div class="gpu-meta-item" style="margin-left:auto"><button class="btn btn-ghost btn-sm" onclick="openGpuModal(${gpu.id})">險ｭ螳・/button></div>
          </div>
        </div>`;
    }).join('');
}

function renderActivityFeed(alerts, pods) {
    const feed = document.getElementById('activityFeed');
    const items = [
        ...alerts.map(a => ({ msg: `粕 ${a.message}`, time: a.created_at, color: a.severity === 'critical' ? 'var(--danger)' : a.severity === 'warning' ? 'var(--warning)' : 'var(--accent)' })),
        ...pods.map(p => ({ msg: `噫 Pod #${p.id} - ${p.renter_name || 'User'}`, time: p.started_at, color: 'var(--success)' })),
    ].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 15);

    if (!items.length) {
        feed.innerHTML = '<li class="feed-item"><div class="feed-msg" style="color:var(--text3)">繧｢繧ｯ繝・ぅ繝薙ユ繧｣縺ｪ縺・/div></li>';
        return;
    }
    feed.innerHTML = items.map(i => `
      <li class="feed-item">
        <div class="feed-dot" style="background:${i.color}"></div>
        <div class="feed-msg">${i.msg}</div>
        <div class="feed-time">${new Date(i.time).toLocaleTimeString('ja-JP')}</div>
      </li>`).join('');
}

/* 笏笏 GPUS TABLE 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
async function loadGpus() {
    try {
        const gpus = await api('/gpus');
        const stat = await api('/admin/overview').catch(() => ({ gpus: [] }));
        const statsMap = {};
        (stat.gpus || []).forEach(g => statsMap[g.id] = g.stats);

        const statusLabel = { available: '空きあり', rented: '使用中', maintenance: 'メンテ'ｸｭ', offline: 'オフライン' };
        const badgeCls = { available: 'b-success', rented: 'b-primary', maintenance: 'b-warning', offline: 'b-muted' };

        document.getElementById('gpuTableBody').innerHTML = gpus.map(g => {
            const s = statsMap[g.id] || {};
            return `<tr>
              <td><strong>${g.name}</strong></td>
              <td class="mono">${Math.round(g.vram_total / 1024)} GB</td>
              <td><span class="badge ${badgeCls[g.status] || 'b-muted'}">${statusLabel[g.status] || g.status}</span></td>
              <td class="mono">${s.gpuUtil || 0}%</td>
              <td class="mono" style="color:${(s.temperature || 0) > 85 ? 'var(--danger)' : 'inherit'}">${s.temperature || 0}ﾂｰC</td>
              <td class="mono">¥${g.price_per_hour?.toLocaleString()}</td>
              <td>${g.location}</td>
              <td><button class="btn btn-ghost btn-sm" onclick="openGpuModal(${g.id})">邱ｨ髮・/button></td>
            </tr>`;
        }).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:2rem">GPU縺ｪ縺・/td></tr>';
    } catch (err) { console.error(err); }
}

/* 笏笏 PODS TABLE 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
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
              <td><button class="btn btn-danger btn-sm" onclick="stopPod(${p.id})">蛛懈ｭ｢</button></td>
            </tr>`;
        }).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:2rem">遞ｼ蜒堺ｸｭPod縺ｪ縺・/td></tr>';
    } catch (err) { console.error(err); }
}

async function stopPod(podId) {
    if (!confirm(`Pod #${podId} 繧貞ｼｷ蛻ｶ蛛懈ｭ｢縺励∪縺吶°・歔)) return;
    try { await api(`/pods/${podId}`, { method: 'DELETE' }); loadPods(); } catch (e) { alert(e.message); }
}

/* 笏笏 RESERVATIONS TABLE 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
async function loadReservations() {
    try {
        const list = await api('/admin/reservations');
        const statusLabel = { pending: '遒ｺ隱堺ｸｭ', confirmed: '遒ｺ螳壽ｸ・, active: '遞ｼ蜒堺ｸｭ', completed: '完了', cancelled: '繧ｭ繝｣繝ｳ繧ｻ繝ｫ', paid: '謾ｯ謇墓ｸ・ };
        const badgeCls = { pending: 'b-warning', confirmed: 'b-primary', active: 'b-success', completed: 'b-muted', cancelled: 'b-muted', paid: 'b-success' };
        document.getElementById('reservTableBody').innerHTML = (list || []).map(r => `<tr>
          <td class="mono">#${r.id}</td>
          <td>${r.renter_name || r.renter_id}</td>
          <td>${r.gpu_name}</td>
          <td>${new Date(r.start_time).toLocaleString('ja-JP')}</td>
          <td>${new Date(r.end_time).toLocaleString('ja-JP')}</td>
          <td><span class="badge ${badgeCls[r.status] || 'b-muted'}">${statusLabel[r.status] || r.status}</span></td>
          <td class="mono">¥${r.total_price ? Math.round(r.total_price).toLocaleString() : '窶・}</td>
          <td>${r.status === 'pending' ? `<button class="btn btn-ghost btn-sm" onclick="confirmRes(${r.id})">遒ｺ螳・/button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:2rem">莠育ｴ・↑縺・/td></tr>';
    } catch (err) { console.error(err); }
}

async function confirmRes(id) {
    try { await api(`/reservations/${id}/confirm`, { method: 'POST' }); loadReservations(); } catch (e) { alert(e.message); }
}

/* 笏笏 EARNINGS 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
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
        </tr>`).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:2rem">繝・・繧ｿ縺ｪ縺・/td></tr>';
    } catch (err) { console.error(err); }
}

/* 笏笏 PAYOUTS 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
async function loadPayouts() {
    try {
        const list = await api('/admin/payouts');
        document.getElementById('payoutTableBody').innerHTML = (list || []).map(p => `<tr>
          <td class="mono">#${p.id}</td>
          <td>${p.provider_name || p.provider_id}</td>
          <td class="mono" style="color:var(--success)">¥${Math.round(p.amount).toLocaleString()}</td>
          <td><span class="badge ${p.status === 'paid' ? 'b-success' : 'b-warning'}">${p.status === 'paid' ? '謾ｯ謇墓ｸ・ : '逕ｳ隲倶ｸｭ'}</span></td>
          <td>${new Date(p.created_at).toLocaleString('ja-JP')}</td>
          <td>${p.status === 'pending' ? `<button class="btn btn-primary btn-sm" onclick="markPaid(${p.id})">謾ｯ謇輔＞螳御ｺ・/button>` : '窶・}</td>
        </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:2rem">蜃ｺ驥醍筏隲九↑縺・/td></tr>';
    } catch (err) { console.error(err); }
}

async function markPaid(id) {
    try { await api(`/admin/payouts/${id}/paid`, { method: 'POST' }); loadPayouts(); } catch (e) { alert(e.message); }
}

let _usersLoading = false;
/* 笏笏 USERS 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
async function loadUsers() {
    if (_usersLoading) return;
    _usersLoading = true;
    const tbody = document.getElementById('userTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:2rem;color:var(--text3)"><span style="font-size:1.2rem">&#8987;</span> '+'\u30ed\u30fc\u30c9\u4e2d...</td></tr>';
    try {
        const list = await api('/admin/users');
        const roleBadge = { admin: 'b-danger', provider: 'b-primary', user: 'b-muted' };
        const roleLabel = { admin: '邂｡逅・・, provider: '繝励Ο繝舌う繝繝ｼ', user: '繝ｦ繝ｼ繧ｶ繝ｼ' };
        document.getElementById('userTableBody').innerHTML = (list || []).map(u => `<tr id="user-row-${u.id}">
          <td class="mono">#${u.id}</td>
          <td><strong>${u.username}</strong></td>
          <td style="color:var(--text2)">${u.email}</td>
          <td><span class="badge ${roleBadge[u.role] || 'b-muted'}">${roleLabel[u.role] || u.role}</span></td>
          <td><span class="badge ${u.status === 'active' ? 'b-success' : 'b-danger'}">${u.status === 'active' ? '有効' : '蛛懈ｭ｢'}</span></td>
          <td class="mono">¥${Math.round(u.wallet_balance || 0).toLocaleString()}</td>
          <td class="mono" style="color:var(--accent)">${Math.round(u.point_balance || 0).toLocaleString()} pt</td>
          <td style="color:var(--text3)">${new Date(u.created_at).toLocaleDateString('ja-JP')}</td>
          <td style="display:flex;gap:6px;align-items:center">
            ${u.role !== 'admin'
                ? `<button class="btn btn-ghost btn-sm" onclick="toggleUser(${u.id},'${u.status}')">${u.status === 'active' ? '蛛懈ｭ｢' : '譛牙柑蛹・}</button>
                 <button class="btn btn-danger btn-sm" onclick="confirmDeleteUser(${u.id},'${u.username}','${u.email}')">卵 削除</button>`
                : '<span style="color:var(--text3);font-size:0.8rem">菫晁ｭｷ</span>'
            }
          </td>
        </tr>`).join('') || '<tr><td colspan="9" style="text-align:center;color:var(--text3);padding:2rem">繝ｦ繝ｼ繧ｶ繝ｼ縺ｪ縺・/td></tr>';
    } catch (err) {
        console.error('loadUsers error:', err);
        const tb = document.getElementById('userTableBody');
        if (tb) tb.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:2rem;color:var(--danger)">\u8aad\u307f\u8fbc\u307f\u30a8\u30e9\u30fc: ' + err.message + '</td></tr>';
    } finally {
        _usersLoading = false;
    }
}

async function toggleUser(id, currentStatus) {
    const newStatus = currentStatus === 'active' ? 'suspended' : 'active';
    try { await api(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) }); loadUsers(); } catch (e) { alert(e.message); }
}

/**
 * 2谿ｵ髫守｢ｺ隱阪ム繧､繧｢繝ｭ繧ｰ縺ｧ蠑ｷ蛻ｶ蜑企勁
 */
function confirmDeleteUser(id, username, email) {
    // 譌｢蟄倥Δ繝ｼ繝繝ｫ縺後≠繧後・髯､蜴ｻ
    document.getElementById('deleteUserModal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'deleteUserModal';
    modal.style.cssText = `
        position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;
        display:flex;align-items:center;justify-content:center;
        backdrop-filter:blur(6px);animation:fadeIn 0.15s ease`;
    modal.innerHTML = `
        <div style="background:#12122a;border:1px solid rgba(255,71,87,0.4);border-radius:16px;
                    padding:32px;max-width:440px;width:90%;box-shadow:0 24px 64px rgba(0,0,0,0.7)">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
                <span style="font-size:2rem">卵</span>
                <div>
                    <div style="font-size:1.1rem;font-weight:700;color:#ff4757">繝ｦ繝ｼ繧ｶ繝ｼ繧貞ｼｷ蛻ｶ蜑企勁</div>
                    <div style="font-size:0.8rem;color:#9898b8;margin-top:2px">縺薙・謫堺ｽ懊・蜈・↓謌ｻ縺帙∪縺帙ｓ</div>
                </div>
            </div>
            <div style="background:rgba(255,71,87,0.08);border:1px solid rgba(255,71,87,0.2);
                        border-radius:10px;padding:14px 16px;margin-bottom:20px">
                <div style="font-size:0.85rem;color:#9898b8;margin-bottom:4px">蜑企勁蟇ｾ雎｡</div>
                <div style="font-weight:700">${username}</div>
                <div style="font-size:0.82rem;color:#6c6c9a">${email} &nbsp;ﾂｷ&nbsp; ID: ${id}</div>
            </div>
            <div style="font-size:0.85rem;color:#ff4757;margin-bottom:6px">
                笞 莉･荳九・繝・・繧ｿ縺悟・縺ｦ蜑企勁縺輔ｌ縺ｾ縺呻ｼ・
            </div>
            <ul style="font-size:0.8rem;color:#9898b8;margin:0 0 20px 18px;line-height:1.9">
                <li>繧｢繧ｫ繧ｦ繝ｳ繝域ュ蝣ｱ繝ｻ繝代せ繝ｯ繝ｼ繝・/li>
                <li>蜈ｨ莠育ｴ・ｱ･豁ｴ・育ｨｼ蜒堺ｸｭ縺ｯ蠑ｷ蛻ｶ邨ゆｺ・ｼ・/li>
                <li>菴ｿ逕ｨ繝ｭ繧ｰ繝ｻ隱ｲ驥大ｱ･豁ｴ</li>
            </ul>
            <div style="margin-bottom:16px">
                <label style="font-size:0.82rem;color:#9898b8;display:block;margin-bottom:6px">
                    遒ｺ隱阪・縺溘ａ <strong style="color:#fff">${username}</strong> 縺ｨ蜈･蜉帙＠縺ｦ縺九ｉ蜑企勁縺励※縺上□縺輔＞
                </label>
                <input id="deleteConfirmInput" type="text" placeholder="繝ｦ繝ｼ繧ｶ繝ｼ蜷阪ｒ蜈･蜉・.."
                    style="width:100%;padding:10px 14px;background:#0a0a1a;border:1px solid rgba(255,255,255,0.15);
                           border-radius:8px;color:#eee;font-size:0.9rem;outline:none;box-sizing:border-box"
                    oninput="checkDeleteInput('${username}')"/>
            </div>
            <div style="display:flex;gap:10px;justify-content:flex-end">
                <button class="btn btn-ghost" onclick="document.getElementById('deleteUserModal').remove()">
                    繧ｭ繝｣繝ｳ繧ｻ繝ｫ
                </button>
                <button id="deleteConfirmBtn" class="btn btn-danger" disabled
                    onclick="executeDeleteUser(${id}, '${username}')">
                    卵 蠑ｷ蛻ｶ蜑企勁縺吶ｋ
                </button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    // Esc 縺ｧ髢峨§繧・
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    document.getElementById('deleteConfirmInput').focus();
}

function checkDeleteInput(username) {
    const val = document.getElementById('deleteConfirmInput')?.value || '';
    const btn = document.getElementById('deleteConfirmBtn');
    if (btn) btn.disabled = (val !== username);
}

async function executeDeleteUser(id, username) {
    const btn = document.getElementById('deleteConfirmBtn');
    if (btn) { btn.disabled = true; btn.textContent = '蜑企勁荳ｭ...'; }
    try {
        await api(`/admin/users/${id}?force=true`, { method: 'DELETE' });
        document.getElementById('deleteUserModal')?.remove();
        // 繝・・繝悶Ν陦後ｒ豸医☆・亥叉譎ょ渚譏・・
        document.getElementById(`user-row-${id}`)?.remove();
        showDeleteToast(`笨・${username} 繧貞炎髯､縺励∪縺励◆`);
    } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = '卵 蠑ｷ蛻ｶ蜑企勁縺吶ｋ'; }
        alert('蜑企勁螟ｱ謨・ ' + e.message);
    }
}

function showDeleteToast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `position:fixed;bottom:24px;right:24px;background:#1a1a3a;
        border:1px solid rgba(255,71,87,0.4);border-radius:10px;padding:12px 20px;
        color:#ff6b6b;font-size:0.875rem;font-weight:600;z-index:99999;
        box-shadow:0 8px 24px rgba(0,0,0,0.5);animation:fadeIn 0.2s ease`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
}

function showToast(msg, type = 'info') {
    const colors = {
        success: { bg: 'rgba(0,229,160,0.12)', border: 'rgba(0,229,160,0.4)', text: '#00e5a0' },
        error:   { bg: 'rgba(255,71,87,0.12)',  border: 'rgba(255,71,87,0.4)',  text: '#ff6b6b' },
        warning: { bg: 'rgba(255,179,0,0.12)',  border: 'rgba(255,179,0,0.4)',  text: '#ffb300' },
        info:    { bg: 'rgba(108,71,255,0.12)', border: 'rgba(108,71,255,0.4)', text: '#a78bfa' },
    };
    const c = colors[type] || colors.info;
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = [
        'position:fixed', 'bottom:24px', 'right:24px',
        `background:${c.bg}`, `border:1px solid ${c.border}`,
        'border-radius:10px', 'padding:12px 20px',
        `color:${c.text}`, 'font-size:0.875rem', 'font-weight:600',
        'z-index:99999', 'max-width:380px',
        'box-shadow:0 8px 24px rgba(0,0,0,0.5)',
        'transition:opacity .3s', 'word-break:break-word',
    ].join(';');
    t.className = 'admin-toast';
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 4000);
}



/* 笏笏 ALERTS 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
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
          <td>${a.gpu_id || '窶・}</td>
          <td style="color:var(--text3)">${new Date(a.created_at).toLocaleString('ja-JP')}</td>
          <td><span class="badge ${a.resolved ? 'b-success' : 'b-warning'}">${a.resolved ? '隗｣豎ｺ貂医∩' : '譛ｪ隗｣豎ｺ'}</span></td>
        </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:2rem">繧｢繝ｩ繝ｼ繝医↑縺・/td></tr>';
    } catch (err) { console.error(err); }
}

/* 笏笏 GPU MODAL 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
let _editingGpuId = null;
async function openGpuModal(gpuId) {
    _editingGpuId = gpuId;
    document.getElementById('gpuModalTitle').textContent = gpuId ? `GPU險ｭ螳・#${gpuId}` : 'GPU霑ｽ蜉';
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

/* 笏笏 WEBSOCKET 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
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

/* 笏笏 ADMIN API MISSING ENDPOINTS 窶・add helpers 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
// Patch admin overview to include pods/alerts
async function enrichOverview(ovr) {
    try {
        const alerts = await api('/admin/alerts').catch(() => []);
        ovr.recentAlerts = (alerts || []).slice(0, 10);
    } catch { }
    return ovr;
}

/* 笏笏 INIT 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
initCharts();
refreshAll();
setInterval(() => { if (currentSection === 'overview') refreshAll(); }, 8000);

/* 笏笏 GPU SF 繝弱・繝臥屮隕・笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
async function loadSfNodes() {
    const tbody   = document.getElementById('sfNodeTableBody');
    const summary = document.getElementById('sfNodeSummary');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:2rem;color:var(--text3)">ロード中...</td></tr>';

    try {
        const data  = await api('/admin/sf/nodes');
        const nodes = data.nodes || [];
        const stats = data.stats || {};

        // ── サマリー統計カード ─────────────────────────────────────────
        if (summary) {
            summary.innerHTML = [
                { label: 'ONLINE/IDLE', val: stats.online  ?? nodes.filter(n => n.status === 'idle').length, color: '#00e5a0' },
                { label: 'BUSY',        val: stats.busy    ?? nodes.filter(n => n.status === 'busy').length, color: '#ffd700' },
                { label: 'OFFLINE',     val: stats.offline ?? nodes.filter(n => n.status === 'offline').length, color: '#5a5a7a' },
                { label: 'TOTAL TF',    val: (stats.total_tflops ?? 0).toFixed(1)+' TF', color: '#00d4ff' },
                { label: 'NODES',       val: stats.total ?? nodes.length, color: '#a78bfa' },
            ].map(s => `<div class="stat-card" style="border-left:3px solid ${s.color}">
                <div style="font-size:1.6rem;font-weight:700;color:${s.color}">${s.val}</div>
                <div style="font-size:.8rem;color:var(--text2);margin-top:.25rem">${s.label}</div>
            </div>`).join('');
        }

        const STATUS_BADGE = {
            idle:        { cls: 'b-success',  text: 'IDLE' },
            online:      { cls: 'b-success',  text: 'ONLINE' },
            busy:        { cls: 'b-warning',  text: 'BUSY' },
            offline:     { cls: 'b-muted',    text: 'OFFLINE' },
            maintenance: { cls: 'b-danger',   text: 'MAINT' },
        };

        tbody.innerHTML = nodes.map(n => {
            const age = n.last_seen ? Math.round((Date.now() - new Date(n.last_seen)) / 1000) : 9999;
            const ageColor = age < 30 ? '#00e5a0' : age < 120 ? '#ffb300' : '#ff4757';
            const sb = STATUS_BADGE[n.status] || { cls: 'b-muted', text: n.status };
            const upMbps = n.upload_mbps;
            const gpuShort = (() => { try { const g = JSON.parse(n.gpu_specs||'[]'); return g[0]?.name?.replace(/NVIDIA\s+/i,'').substring(0,18) || '?'; } catch { return '?'; } })();
            const isOffline = n.status === 'offline' || age > 120;

            return `<tr>
              <td class="mono">#${n.id}</td>
              <td><strong>${n.hostname || '–'}</strong><div style="font-size:.72rem;color:var(--text3)">${n.provider_name || ''}</div></td>
              <td style="font-size:.8rem">${gpuShort}</td>
              <td>${n.location || '–'}</td>
              <td><span class="badge ${sb.cls}">${sb.text}</span></td>
              <td class="mono" style="color:#00d4ff">${(n.fp32_tflops||0).toFixed(1)} TF</td>
              <td class="mono">${n.rtt_ms ? n.rtt_ms.toFixed(0)+'ms' : '–'}</td>
              <td class="mono" style="color:${ageColor}">${age < 9999 ? age+'s前' : '–'}</td>
              <td style="display:flex;gap:.35rem;flex-wrap:wrap">
                ${!isOffline ? `<button class="btn btn-ghost btn-xs"
                    onclick="setSfNodeStatus(${n.id},'offline')"
                    title="強制オフライン">⏹</button>` : ''}
                ${n.status === 'offline' ? `<button class="btn btn-ghost btn-xs"
                    onclick="setSfNodeStatus(${n.id},'idle')"
                    title="IDLEに復帰">▶</button>` : ''}
                <button class="btn btn-danger btn-xs"
                    onclick="deleteSfNode(${n.id},'${(n.hostname||'').replace(/'/g,'')}')"
                    title="削除">🗑</button>
              </td>
            </tr>`;
        }).join('') || '<tr><td colspan="9" style="text-align:center;color:var(--text3);padding:2rem">登録済みノードなし</td></tr>';

    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:1rem;color:var(--danger)">${err.message}</td></tr>`;
    }

async function setSfNodeStatus(nodeId, status) {
    if (!confirm(`ノード #${nodeId} のステータスを「${status}」に変更しますか？`)) return;
    try {
        await api(`/admin/sf/nodes/${nodeId}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
        showToast(`ノード #${nodeId} → ${status} に変更しました`, 'success');
        loadSfNodes();
    } catch (err) {
        showToast('ステータス変更失敗: ' + err.message, 'error');
    }

async function deleteSfNode(nodeId, hostname) {
    if (!confirm(`ノード #${nodeId} (${hostname}) を削除しますか？この操作は取り消せません。`)) return;
    try {
        await api(`/admin/sf/nodes/${nodeId}`, { method: 'DELETE' });
        showToast(`ノード #${nodeId} を削除しました`, 'success');
        loadSfNodes();
    } catch (err) {
        showToast('削除失敗: ' + (err.message || ''), 'error');
    }

async function bulkOfflineSfNodes() {
    if (!confirm('heartbeat タイムアウトした全ノードをオフラインに変更しますか？')) return;
    try {
        const d = await api('/admin/sf/nodes/bulk-offline', { method: 'POST' });
        showToast(`${d.affected}件のノードをオフラインに変更しました`, 'success');
        loadSfNodes();
    } catch (err) {
        showToast('一括オフライン失敗: ' + err.message, 'error');
    }



/* 笏笏 MAINTENANCE MODE 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
let _maintEnabled = false;

async function loadMaintenanceStatus() {
    try {
        const data = await api('/admin/maintenance');
        _maintEnabled = data.enabled;
        updateMaintUI(data);
    } catch (e) {
        showToast('メンテ'Δ繝ｼ繝臥憾諷九・蜿門ｾ励↓螟ｱ謨励＠縺ｾ縺励◆', 'error');
    }
}

function updateMaintUI(data) {
    const enabled = data.enabled;
    const card = document.getElementById('maintStatusCard');
    const icon = document.getElementById('maintStatusIcon');
    const title = document.getElementById('maintStatusTitle');
    const sub = document.getElementById('maintStatusSub');
    const badge = document.getElementById('maintStatusBadge');
    const togLabel = document.getElementById('maintToggleLabel');
    const track = document.getElementById('maintToggleTrack');
    const thumb = document.getElementById('maintToggleThumb');
    const navBadge = document.getElementById('maintBadge');

    if (enabled) {
        // ON state
        card.style.background = 'rgba(255,71,87,.12)';
        card.style.borderColor = 'rgba(255,71,87,.5)';
        icon.textContent = '閥';
        title.textContent = 'メンテ'リ繝ｳ繧ｹ荳ｭ';
        sub.textContent = `メッセージ: ${data.message || ''} / 險ｭ螳夊・ ${data.updated_by || '窶・}`;
        badge.style.background = '#ff4757';
        badge.style.color = '#fff';
        badge.textContent = 'MAINTENANCE';
        togLabel.textContent = 'メンテ'リ繝ｳ繧ｹ繝｢繝ｼ繝峨′ON縺ｧ縺・;
        track.style.background = '#ff4757';
        thumb.style.marginLeft = '32px';
        thumb.style.background = '#fff';
        if (navBadge) navBadge.style.display = 'inline';
        if (data.message) {
            const ta = document.getElementById('maintMessage');
            if (ta) ta.value = data.message;
        }
    } else {
        // OFF state
        card.style.background = 'rgba(0,229,160,.06)';
        card.style.borderColor = 'rgba(0,229,160,.3)';
        icon.textContent = '泙';
        title.textContent = '正常稼働中';
        sub.textContent = 'サービスは正常に稼働しています';
        badge.style.background = '#00e5a0';
        badge.style.color = '#000';
        badge.textContent = 'ONLINE';
        togLabel.textContent = 'メンテ'リ繝ｳ繧ｹ繝｢繝ｼ繝峨ｒON縺ｫ縺吶ｋ';
        track.style.background = '#2a2a4a';
        thumb.style.marginLeft = '2px';
        thumb.style.background = '#5a5a7a';
        if (navBadge) navBadge.style.display = 'none';
    }
}

function toggleMaintenance() {
    _maintEnabled = !_maintEnabled;
    applyMaintenance(_maintEnabled);
}

async function applyMaintenance(enable) {
    const message = document.getElementById('maintMessage')?.value?.trim()
        || '縺溘□縺・∪繝｡繝ｳ繝・リ繝ｳ繧ｹ荳ｭ縺ｧ縺吶ゅ＠縺ｰ繧峨￥縺雁ｾ・■縺上□縺輔＞縲・;

    const confirmMsg = enable
        ? '笞・・繝｡繝ｳ繝・リ繝ｳ繧ｹ繝｢繝ｼ繝峨ｒON縺ｫ縺励∪縺吶・n繝ｦ繝ｼ繧ｶ繝ｼ縺ｯ繧ｵ繝ｼ繝薙せ縺ｫ繧｢繧ｯ繧ｻ繧ｹ縺ｧ縺阪↑縺上↑繧翫∪縺吶・n譛ｬ蠖薙↓繧医ｍ縺励＞縺ｧ縺吶°・・
        : 'メンテ'リ繝ｳ繧ｹ繝｢繝ｼ繝峨ｒOFF縺ｫ縺励※繧ｵ繝ｼ繝薙せ繧貞・髢九＠縺ｾ縺吶・n繧医ｍ縺励＞縺ｧ縺吶°・・;

    if (!confirm(confirmMsg)) return;

    try {
        const data = await api('/admin/maintenance', {
            method: 'POST',
            body: JSON.stringify({ enabled: enable, message }),
        });
        _maintEnabled = enable;
        updateMaintUI(data);
        showToast(
            enable ? '閥 繝｡繝ｳ繝・リ繝ｳ繧ｹ繝｢繝ｼ繝峨ｒON縺ｫ縺励∪縺励◆' : '泙 繝｡繝ｳ繝・リ繝ｳ繧ｹ繝｢繝ｼ繝峨ｒOFF縺ｫ縺励∪縺励◆',
            enable ? 'warning' : 'success'
        );
    } catch (e) {
        showToast('エラー: ' + e.message, 'error');
    }
}

// 繧ｻ繧ｯ繧ｷ繝ｧ繝ｳ蛻・ｊ譖ｿ縺域凾縺ｫ繝｡繝ｳ繝・憾諷九ｒ繝ｭ繝ｼ繝・
const _origNavClick = document.querySelectorAll('.nav-item');
document.addEventListener('click', e => {
    const btn = e.target.closest('[data-section="maintenance"]');
    if (btn) loadMaintenanceStatus();
});

// ============================================================
// 次・・繧ｯ繝ｼ繝昴Φ邂｡逅・
// ============================================================

async function loadCoupons() {
    // 邨ｱ險・
    try {
        const stats = await api('/admin/coupons/stats');
        document.getElementById('couponStats').innerHTML = [
            { label: '有効クーポン', value: stats.active_coupons, color: 'var(--success)' },
            { label: '発行数', value: stats.total_coupons, color: 'var(--accent)' },
            { label: '総使用回数', value: stats.total_uses, color: 'var(--primary)' },
            { label: '総割引額', value: '¥' + (stats.total_discount_yen || 0).toLocaleString(), color: 'var(--warning)' },
        ].map(s => `<div class="stat-card" style="border-left:3px solid ${s.color}">
            <div style="font-size:1.6rem;font-weight:700;color:${s.color}">${s.value}</div>
            <div style="font-size:.8rem;color:var(--text2);margin-top:.25rem">${s.label}</div>
        </div>`).join('');
    } catch (_) { }

    // 繧ｯ繝ｼ繝昴Φ荳隕ｧ
    try {
        const coupons = await api('/coupons');
        const tbody = coupons.map(c => {
            const expired = c.valid_until && new Date(c.valid_until) < new Date();
            const status = !c.is_active ? '無効' : expired ? '期限切れ' : '有効';
            const stColor = !c.is_active ? 'var(--danger)' : expired ? 'var(--warning)' : 'var(--success)';
            return `<tr>
                <td><code style="background:rgba(108,71,255,.15);padding:.2rem .6rem;border-radius:4px;font-size:.9rem">${c.code}</code></td>
                <td>${c.discount_type === 'percent' ? c.discount_value + '%OFF' : '¥' + c.discount_value.toLocaleString() + '円引き'}</td>
                <td>${c.description || '窶・}</td>
                <td>${c.used_count}${c.max_uses ? ' / ' + c.max_uses : ' / 辟｡髯・}</td>
                <td>${c.valid_until ? c.valid_until.split('T')[0] : '無期限'}</td>
                <td><span style="color:${stColor};font-weight:600">${status}</span></td>
                <td>
                    <button class="btn btn-ghost" style="font-size:.8rem;padding:.3rem .6rem" onclick="toggleCoupon(${c.id})">
                        ${c.is_active ? '無効化' : '有効化'}
                    </button>
                    <button class="btn btn-ghost" style="font-size:.8rem;padding:.3rem .6rem;color:var(--danger)" onclick="deleteCoupon(${c.id})">削除</button>
                </td>
            </tr>`;
        }).join('');
        document.getElementById('couponList').innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:.875rem">
            <thead><tr style="color:var(--text2);border-bottom:1px solid var(--border)">
                <th style="padding:.75rem;text-align:left">コード</th>
                <th style="padding:.75rem;text-align:left">割引</th>
                <th style="padding:.75rem;text-align:left">説明</th>
                <th style="padding:.75rem;text-align:left">使用回数</th>
                <th style="padding:.75rem;text-align:left">有効期限</th>
                <th style="padding:.75rem;text-align:left">ステータス</th>
                <th style="padding:.75rem;text-align:left">操作</th>
            </tr></thead>
            <tbody>${tbody || '<tr><td colspan="7" style="padding:2rem;text-align:center;color:var(--text3)">繧ｯ繝ｼ繝昴Φ縺ｪ縺・/td></tr>'}</tbody>
        </table>`;
    } catch (e) {
        document.getElementById('couponList').innerHTML = `<div style="padding:1rem;color:var(--danger)">${e.message}</div>`;
    }
}

function openCreateCouponModal() {
    const m = document.getElementById('couponModal');
    m.style.display = 'flex';
    document.getElementById('cpCode').value = '';
    document.getElementById('cpDesc').value = '';
    document.getElementById('cpValue').value = '';
    document.getElementById('cpMaxUses').value = '100';
    document.getElementById('cpUntil').value = '';
}
function closeCouponModal() {
    document.getElementById('couponModal').style.display = 'none';
}

async function submitCreateCoupon() {
    const code = document.getElementById('cpCode').value.trim().toUpperCase();
    const desc = document.getElementById('cpDesc').value.trim();
    const type = document.getElementById('cpType').value;
    const val = parseInt(document.getElementById('cpValue').value);
    const maxUses = parseInt(document.getElementById('cpMaxUses').value) || null;
    const validUntil = document.getElementById('cpUntil').value || null;
    if (!code || !val) return showToast('繧ｳ繝ｼ繝峨→蛟､縺ｯ蠢・医〒縺・, 'error');
    try {
        await api('/coupons', {
            method: 'POST',
            body: JSON.stringify({ code, description: desc, discount_type: type, discount_value: val, max_uses: maxUses, valid_until: validUntil }),
        });
        showToast(`✅ クーポン「${code}」を発行しました！`, 'success');
        closeCouponModal();
        loadCoupons();
    } catch (e) {
        showToast('発行エラー: ' + e.message, 'error');
    }
}

async function toggleCoupon(id) {
    try {
        const r = await api(`/coupons/${id}/toggle`, { method: 'PATCH' });
        showToast(r.is_active ? '✅ 有効化しました' : '無効化しました', 'info');
        loadCoupons();
    } catch (e) { showToast(e.message, 'error'); }
}

async function deleteCoupon(id) {
    if (!confirm('このクーポンを削除しますか？')) return;
    try {
        await api(`/coupons/${id}`, { method: 'DELETE' });
        showToast('削除しました', 'success');
        loadCoupons();
    } catch (e) { showToast(e.message, 'error'); }
}

// ============================================================
// 投 RunPod 萓｡譬ｼ逶｣隕・
// ============================================================

async function loadPricingCompare() {
    document.getElementById('pricingTable').innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text2)">隱ｭ縺ｿ霎ｼ縺ｿ荳ｭ...</div>';
    try {
        const data = await api('/admin/pricing/compare');
        if (data.last_fetched) {
            document.getElementById('pricingLastFetch').textContent =
                `譛邨ょ叙蠕・ ${new Date(data.last_fetched).toLocaleString('ja-JP')} 窶・${data.count}遞ｮ鬘杼;
        } else {
            document.getElementById('pricingLastFetch').textContent = '譛ｪ蜿門ｾ励ゅ贋ｻ翫☆縺仙叙蠕励九ｒ繧ｯ繝ｪ繝・け縺励※縺上□縺輔＞縲・;
        }
        renderPricingTable(data.comparisons || []);
    } catch (e) {
        document.getElementById('pricingTable').innerHTML = `<div style="padding:1rem;color:var(--danger)">${e.message}</div>`;
    }
}

function renderPricingTable(comparisons) {
    if (!comparisons.length) {
        document.getElementById('pricingTable').innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text3)">繝・・繧ｿ縺ｪ縺暦ｼ医贋ｻ翫☆縺仙叙蠕励九〒蜿門ｾ暦ｼ・/div>';
        return;
    }
    const rows = comparisons.map(c => {
        const status = c.is_competitive === null ? '' : c.is_competitive ? '笨・ : '笞・・;
        const gpuRentalCell = c.gpurental_price
            ? `¥${c.gpurental_price.toLocaleString()}/hr`
            : '<span style="color:var(--text3)">未登録</span>';
        const diffCell = c.diff_jpy !== null
            ? `<span style="color:${c.diff_jpy > 0 ? 'var(--warning)' : 'var(--success)'}">${c.diff_jpy > 0 ? '+' : ''}¥${c.diff_jpy.toLocaleString()}</span>`
            : '窶・;
        const applybtn = c.suggested_price_jpy
            ? `<button class="btn btn-ghost" style="font-size:.75rem;padding:.25rem .5rem" onclick="applyPrice('${c.gpu_name}',${c.suggested_price_jpy})">驕ｩ逕ｨ</button>`
            : '';
        return `<tr style="border-bottom:1px solid var(--border)">
            <td style="padding:.6rem .75rem">${status}</td>
            <td style="padding:.6rem .75rem;font-size:.85rem">${c.gpu_name}</td>
            <td style="padding:.6rem .75rem;text-align:right;color:var(--text2)">${c.vram_gb}GB</td>
            <td style="padding:.6rem .75rem;text-align:right">¥${(c.runpod_price_jpy || 0).toLocaleString()}/hr</td>
            <td style="padding:.6rem .75rem;text-align:right">${gpuRentalCell}</td>
            <td style="padding:.6rem .75rem;text-align:right">${diffCell}</td>
            <td style="padding:.6rem .75rem;text-align:right;color:var(--accent)">¥${(c.suggested_price_jpy || 0).toLocaleString()}/hr</td>
            <td style="padding:.6rem .75rem">${applybtn}</td>
        </tr>`;
    }).join('');
    document.getElementById('pricingTable').innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:.85rem">
        <thead><tr style="color:var(--text2);border-bottom:1px solid var(--border)">
            <th style="padding:.6rem .75rem">状態</th>
            <th style="padding:.6rem .75rem;text-align:left">GPU名</th>
            <th style="padding:.6rem .75rem;text-align:right">VRAM</th>
            <th style="padding:.6rem .75rem;text-align:right">RunPod</th>
            <th style="padding:.6rem .75rem;text-align:right">GPURental</th>
            <th style="padding:.6rem .75rem;text-align:right">差額</th>
            <th style="padding:.6rem .75rem;text-align:right">推奨価格</th>
            <th style="padding:.6rem .75rem">適用</th>
        </tr></thead>
        <tbody>${rows}</tbody>
    </table>`;
}

async function fetchRunPodPrices() {
    showToast('売 RunPod縺九ｉ萓｡譬ｼ繧貞叙蠕嶺ｸｭ...', 'info');
    try {
        const result = await api('/admin/pricing/fetch', { method: 'POST' });
        showToast(`✅ ${result.count}種類のGPUの価格を取得しました`, 'success');
        loadPricingCompare();
    } catch (e) { showToast('取得エラー: ' + e.message, 'error'); }
}

async function applyPrice(gpuName, priceJpy) {
    if (!confirm(`${gpuName} の価格を ¥${priceJpy.toLocaleString()}/hr に変更しますか？`)) return;
    try {
        const r = await api('/admin/pricing/apply', {
            method: 'POST',
            body: JSON.stringify({ gpu_name: gpuName, price_jpy: priceJpy }),
        });
        showToast(r.changes > 0 ? `笨・萓｡譬ｼ繧帝←逕ｨ縺励∪縺励◆` : '隧ｲ蠖敵PU縺ｪ縺・, r.changes > 0 ? 'success' : 'warning');
        loadPricingCompare();
    } catch (e) { showToast(e.message, 'error'); }
}

// ============================================================
// 汐 繝ｬ繝ｳ繝繝ｪ繝ｳ繧ｰ繧ｸ繝ｧ繝也ｮ｡逅・
// ============================================================

async function loadRenderJobs() {
    // 邨ｱ險・KPI
    try {
        const stats = await api('/admin/render-jobs/stats');
        const se = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v ?? 0; };
        se('rjTotal',   stats.total);
        se('rjRunning', stats.running);
        se('rjDone',    stats.done);
        se('rjFailed',  stats.failed);
        se('rjQueued',  stats.queued);

        // 蜃ｦ逅・ｸｭ繧ｸ繝ｧ繝悶′縺ゅｌ縺ｰ繝翫ン繝舌ャ繧ｸ繧定｡ｨ遉ｺ
        const badge = document.getElementById('renderJobsBadge');
        if (badge) {
            const active = (stats.running || 0) + (stats.queued || 0);
            if (active > 0) { badge.textContent = active; badge.style.display = ''; }
            else { badge.style.display = 'none'; }
        }

        const cntEl = document.getElementById('rjCount');
        if (cntEl) cntEl.textContent = `蜈ｨ ${stats.total || 0} 莉ｶ`;
    } catch (err) { console.error('render-jobs stats:', err); }

    // 繧ｸ繝ｧ繝紋ｸ隕ｧ
    const tbody = document.getElementById('renderJobsTableBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:2rem"><div class="spinner"></div></td></tr>';
    try {
        const filter = document.getElementById('renderJobStatusFilter')?.value || '';
        const url = '/admin/render-jobs' + (filter ? `?status=${filter}` : '');
        const jobs = await api(url);

        if (!jobs || !jobs.length) {
            tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--text3);padding:2rem">繧ｸ繝ｧ繝悶↑縺・/td></tr>';
            return;
        }

        const statusConfig = {
            queued:    { label: '蠕・ｩ滉ｸｭ',   cls: 'b-warning', icon: '竢ｳ' },
            running:   { label: '蜃ｦ逅・ｸｭ',   cls: 'b-primary', icon: '売' },
            done:      { label: '完了',     cls: 'b-success', icon: '笨・ },
            failed:    { label: '螟ｱ謨・,     cls: 'b-danger',  icon: '笶・ },
            cancelled: { label: '繧ｭ繝｣繝ｳ繧ｻ繝ｫ', cls: 'b-muted',   icon: '竢ｹ' },
        };

        tbody.innerHTML = jobs.map(j => {
            const sc = statusConfig[j.status] || { label: j.status, cls: 'b-muted', icon: '' };
            const inputName = (j.input_path || '').split(/[\\/]/).pop() || '窶・;
            const outputName = j.output_name || (j.output_path ? j.output_path.split(/[\\/]/).pop() : '窶・);
            const startedAt = j.started_at ? new Date(j.started_at).toLocaleString('ja-JP') : '窶・;
            const finishedAt = j.finished_at ? new Date(j.finished_at).toLocaleString('ja-JP') : '窶・;

            const progressBar = j.status === 'running'
                ? `<div style="display:flex;align-items:center;gap:6px">
                    <div style="flex:1;height:5px;background:rgba(255,255,255,.1);border-radius:3px;overflow:hidden;min-width:60px">
                        <div style="height:100%;width:${j.progress || 0}%;background:linear-gradient(90deg,var(--primary),#8b5cf6);transition:width .5s"></div>
                    </div>
                    <span style="font-size:.72rem;color:var(--text2);white-space:nowrap">${j.progress || 0}%</span>
                   </div>`
                : j.status === 'done'
                    ? '<span style="color:var(--success);font-size:.8rem">笨・100%</span>'
                    : '<span style="color:var(--text3);font-size:.8rem">窶・/span>';

            const actions = [];
            if (j.status === 'failed') {
                actions.push(`<button class="btn btn-ghost btn-sm" onclick="showRenderJobError(${j.id})" title="繧ｨ繝ｩ繝ｼ繝ｭ繧ｰ髢ｲ隕ｧ">剥 隧ｳ邏ｰ</button>`);
            }
            if (['running', 'queued'].includes(j.status)) {
                actions.push(`<button class="btn btn-danger btn-sm" onclick="adminCancelRenderJob(${j.id})">&#9209; 繧ｭ繝｣繝ｳ繧ｻ繝ｫ</button>`);
            }
            if (j.status === 'done') {
                actions.push(`<button class="btn btn-ghost btn-sm" onclick="showRenderJobError(${j.id})" title="隧ｳ邏ｰ遒ｺ隱・>剥 隧ｳ邏ｰ</button>`);
            }

            return `<tr>
              <td class="mono">#${j.id}</td>
              <td>${j.user_name || j.user_id}<br><span style="font-size:.72rem;color:var(--text3)">${j.user_email || ''}</span></td>
              <td title="${j.input_path || ''}"><span style="font-size:.8rem;max-width:140px;display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${inputName}</span></td>
              <td title="${j.output_path || ''}"><span style="font-size:.8rem;max-width:140px;display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--success)">${outputName}</span></td>
              <td><span class="badge b-muted">${j.format || '窶・}</span></td>
              <td><span class="badge ${sc.cls}">${sc.icon} ${sc.label}</span></td>
              <td style="min-width:100px">${progressBar}</td>
              <td style="font-size:.78rem;color:var(--text3)">${startedAt}</td>
              <td style="font-size:.78rem;color:var(--text3)">${finishedAt}</td>
              <td style="display:flex;gap:4px;flex-wrap:wrap">${actions.join('') || '<span style="color:var(--text3);font-size:.78rem">窶・/span>'}</td>
            </tr>`;
        }).join('');
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:2rem;color:var(--danger)">${err.message}</td></tr>`;
    }
}

async function adminCancelRenderJob(jobId) {
    if (!confirm(`繧ｸ繝ｧ繝・#${jobId} 繧貞ｼｷ蛻ｶ繧ｭ繝｣繝ｳ繧ｻ繝ｫ縺励∪縺吶°・歔)) return;
    try {
        await api(`/admin/render-jobs/${jobId}/cancel`, { method: 'POST' });
        showToast(`竢ｹ 繧ｸ繝ｧ繝・#${jobId} 繧偵く繝｣繝ｳ繧ｻ繝ｫ縺励∪縺励◆`, 'success');
        loadRenderJobs();
    } catch (e) { showToast('繧ｭ繝｣繝ｳ繧ｻ繝ｫ螟ｱ謨・ ' + e.message, 'error'); }
}

async function showRenderJobError(jobId) {
    const modal = document.getElementById('renderJobErrorModal');
    if (!modal) return;
    modal.style.display = 'flex';
    document.getElementById('rjErrJobId').textContent  = `#${jobId}`;
    document.getElementById('rjErrStatus').textContent = '隱ｭ縺ｿ霎ｼ縺ｿ荳ｭ...';
    document.getElementById('rjErrFormat').textContent = '';
    document.getElementById('rjErrInput').textContent  = '';
    document.getElementById('rjErrOutput').textContent = '';
    document.getElementById('rjErrCmd').textContent    = '';
    document.getElementById('rjErrLog').textContent    = '';
    try {
        const job = await api(`/admin/render-jobs/${jobId}/error`);
        const sc = { queued:'蠕・ｩ滉ｸｭ', running:'蜃ｦ逅・ｸｭ', done:'完了', failed:'螟ｱ謨・, cancelled:'繧ｭ繝｣繝ｳ繧ｻ繝ｫ' };
        document.getElementById('rjErrStatus').textContent = sc[job.status] || job.status;
        document.getElementById('rjErrStatus').style.color = job.status === 'failed' ? 'var(--danger)' : job.status === 'done' ? 'var(--success)' : 'inherit';
        document.getElementById('rjErrFormat').textContent = job.format || '窶・;
        document.getElementById('rjErrInput').textContent  = job.input_path || '窶・;
        document.getElementById('rjErrOutput').textContent = job.output_path || '窶・;
        // ffmpeg_args is JSON array
        try {
            const args = JSON.parse(job.ffmpeg_args || '[]');
            document.getElementById('rjErrCmd').textContent = 'ffmpeg ' + args.join(' ');
        } catch { document.getElementById('rjErrCmd').textContent = job.ffmpeg_args || ''; }
        document.getElementById('rjErrLog').textContent = job.error_log || '(繧ｨ繝ｩ繝ｼ繝ｭ繧ｰ縺ｪ縺・';
    } catch (err) {
        document.getElementById('rjErrStatus').textContent = '蜿門ｾ怜､ｱ謨・;
        document.getElementById('rjErrLog').textContent = err.message;
    }
}

function closeRenderErrorModal() {
    const m = document.getElementById('renderJobErrorModal');
    if (m) m.style.display = 'none';
}

// render-jobs 繧ｻ繧ｯ繧ｷ繝ｧ繝ｳ驕ｷ遘ｻ譎ゅ↓繝ｭ繝ｼ繝・
document.addEventListener('click', e => {
    const btn = e.target.closest('[data-section="render-jobs"]');
    if (btn) setTimeout(() => loadRenderJobs(), 50);
});

// 螳壽悄譖ｴ譁ｰ: 30遘偵＃縺ｨ縺ｫ蜃ｦ逅・ｸｭ繧ｸ繝ｧ繝匁焚繧狸PI譚ｱ豸√↓蜿肴丐
setInterval(async () => {
    try {
        const stats = await api('/admin/render-jobs/stats');
        const badge = document.getElementById('renderJobsBadge');
        if (badge) {
            const active = (stats.running || 0) + (stats.queued || 0);
            if (active > 0) { badge.textContent = active; badge.style.display = ''; }
            else { badge.style.display = 'none'; }
        }
        // render-jobs 繧ｻ繧ｯ繧ｷ繝ｧ繝ｳ陦ｨ遉ｺ荳ｭ縺ｪ繧芽・蜍墓峩譁ｰ
        if (currentSection === 'render-jobs') {
            const se = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v ?? 0; };
            se('rjTotal',   stats.total);
            se('rjRunning', stats.running);
            se('rjDone',    stats.done);
            se('rjFailed',  stats.failed);
            se('rjQueued',  stats.queued);
        }
    } catch (_) { }
}, 30000);

/* 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武
   笞｡ OUTAGE MANAGEMENT
笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武 */

async function loadOutageSection() {
    await populateOutageGpuSelect();
    await loadOutageReports();
    await updateOutageBadge();
}

async function populateOutageGpuSelect() {
    try {
        const gpus = await api('/admin/gpus');
        const sel = document.getElementById('outageGpuId');
        if (!sel) return;
        const current = sel.value;
        sel.innerHTML = '<option value="">GPU繧帝∈謚・..</option>';
        (gpus || []).forEach(g => {
            const opt = document.createElement('option');
            opt.value = g.id;
            opt.textContent = `#${g.id} ${g.name} (${g.location || 'Home'}) 窶・${g.status}`;
            sel.appendChild(opt);
        });
        if (current) sel.value = current;
    } catch (e) {
        console.error('GPU list failed:', e.message);
    }
}

function showOutageForm() {
    const card = document.getElementById('outageFormCard');
    if (card) {
        card.style.display = '';
        // 繝・ヵ繧ｩ繝ｫ繝・ 莉翫°繧・譎る俣蜑阪應ｻ・
        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        const fmt = d => d.toISOString().slice(0, 16);
        document.getElementById('outageStart').value = fmt(oneHourAgo);
        document.getElementById('outageEnd').value = fmt(now);
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

function hideOutageForm() {
    const card = document.getElementById('outageFormCard');
    if (card) card.style.display = 'none';
    const msg = document.getElementById('outageFormMsg');
    if (msg) { msg.style.display = 'none'; msg.innerHTML = ''; }
    const prev = document.getElementById('outagePreview');
    if (prev) { prev.style.display = 'none'; prev.innerHTML = ''; }
}

async function submitOutageReport() {
    const gpuId = document.getElementById('outageGpuId')?.value;
    const start = document.getElementById('outageStart')?.value;
    const end = document.getElementById('outageEnd')?.value;
    const reason = document.getElementById('outageReason')?.value || '';
    const msgEl = document.getElementById('outageFormMsg');
    const prevEl = document.getElementById('outagePreview');

    function showMsg(html, isError = false) {
        if (!msgEl) return;
        msgEl.style.display = '';
        msgEl.style.background = isError ? 'rgba(255,71,87,.08)' : 'rgba(0,229,160,.08)';
        msgEl.style.border = isError ? '1px solid rgba(255,71,87,.2)' : '1px solid rgba(0,229,160,.2)';
        msgEl.style.borderRadius = '8px';
        msgEl.style.padding = '0.75rem 1rem';
        msgEl.style.fontSize = '0.85rem';
        msgEl.innerHTML = html;
    }

    if (!gpuId) return showMsg('笞・・GPU繧帝∈謚槭＠縺ｦ縺上□縺輔＞', true);
    if (!start || !end) return showMsg('笞・・髫懷ｮｳ髢句ｧ九・邨ゆｺ・律譎ゅｒ蜈･蜉帙＠縺ｦ縺上□縺輔＞', true);
    if (new Date(start) >= new Date(end)) return showMsg('笞・・邨ゆｺ・律譎ゅ・髢句ｧ区律譎ゅｈ繧雁ｾ後↓縺励※縺上□縺輔＞', true);

    // 蝣ｱ蜻・竊・繝励Ξ繝薙Η繝ｼ陦ｨ遉ｺ
    try {
        msgEl.style.display = 'none';
        const data = await api('/outage/report', {
            method: 'POST',
            body: JSON.stringify({
                gpu_id: parseInt(gpuId),
                outage_start: new Date(start).toISOString(),
                outage_end: new Date(end).toISOString(),
                reason,
            }),
        });

        const mins = Math.round((new Date(end) - new Date(start)) / 60000);
        const affCount = data.affected_reservations || 0;

        if (prevEl) {
            prevEl.style.display = '';
            prevEl.innerHTML = `
                <div style="display:flex;gap:2rem;flex-wrap:wrap;margin-bottom:0.75rem">
                    <div><span style="color:var(--text3);font-size:0.75rem">髫懷ｮｳID</span><br><strong>#${data.report_id}</strong></div>
                    <div><span style="color:var(--text3);font-size:0.75rem">髫懷ｮｳ譎る俣</span><br><strong>${mins} 蛻・/strong></div>
                    <div><span style="color:var(--text3);font-size:0.75rem">蠖ｱ髻ｿ莠育ｴ・焚</span><br><strong style="color:${affCount > 0 ? 'var(--danger)' : 'var(--success)'}">${affCount} 莉ｶ</strong></div>
                </div>
                ${affCount > 0 ? `
                <div style="font-size:0.78rem;color:var(--text2);margin-bottom:0.5rem">蠖ｱ髻ｿ繧貞女縺代◆莠育ｴ・</div>
                <div style="display:flex;flex-direction:column;gap:4px">
                    ${(data.affected || []).map(a => `<div style="background:rgba(255,255,255,.03);border-radius:6px;padding:6px 10px;font-size:0.78rem">
                        側 <strong>${a.user}</strong> 窶・${a.gpu} 窶・${new Date(a.start_time).toLocaleString('ja-JP')} 縲・${new Date(a.end_time).toLocaleString('ja-JP')}
                    </div>`).join('')}
                </div>
                <div style="margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid rgba(255,255,255,.06)">
                    <button class="btn btn-primary" onclick="executeCompensation(${data.report_id})" style="background:linear-gradient(135deg,#ff4757,#c0392b)">
                        氏 莉翫☆縺占｣懷─繝昴う繝ｳ繝医ｒ驟榊ｸ・☆繧・
                    </button>
                    <span style="font-size:0.75rem;color:var(--text3);margin-left:1rem">髫懷ｮｳ譎る俣豈斐↓蠢懊§縺ｦ繝昴う繝ｳ繝医ｒ閾ｪ蜍戊ｨ育ｮ・/span>
                </div>` : '<div style="color:var(--success)">笨・蠖ｱ髻ｿ繧貞女縺代◆莠育ｴ・↑縺暦ｼ郁｣懷─蟇ｾ雎｡縺ｪ縺暦ｼ・/div>'}
            `;
        }

        showMsg(`笨・髫懷ｮｳ #${data.report_id} 繧貞ｱ蜻翫＠縺ｾ縺励◆`, false);
        await loadOutageReports();
        await updateOutageBadge();
    } catch (e) {
        showMsg(`❌ エラー: ${e.message}`, true);
    }
}

async function executeCompensation(reportId) {
    if (!confirm(`障害 #${reportId} の補償ポイントを付与しますか？\nこの操作は取り消せません。`)) return;
    try {
        const data = await api(`/outage/${reportId}/compensate`, { method: 'POST' });
        const mins = data.outage_minutes || 0;
        const pts = data.total_points_issued || 0;
        const cnt = data.affected_count || 0;
        alert(`笨・陬懷─螳御ｺ・ｼ―n\n髫懷ｮｳ譎る俣: ${mins} 蛻・n陬懷─蟇ｾ雎｡: ${cnt} 莉ｶ\n驟榊ｸ・・繧､繝ｳ繝亥粋險・ ${pts.toLocaleString()} pt\n(¥${(pts * 10).toLocaleString()} 逶ｸ蠖・`);
        hideOutageForm();
        await loadOutageReports();
        await updateOutageBadge();
    } catch (e) {
        alert(`❌ 補償エラー: ${e.message}`);
    }
}

async function loadOutageReports() {
    const tbody = document.getElementById('outageTableBody');
    if (!tbody) return;
    try {
        const reports = await api('/outage');
        if (!reports.length) {
            tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--text3);padding:2rem">髫懷ｮｳ繝ｬ繝昴・繝医↑縺・/td></tr>';
            return;
        }
        tbody.innerHTML = reports.map(r => {
            const startD = new Date(r.outage_start);
            const endD = new Date(r.outage_end);
            const mins = Math.round((endD - startD) / 60000);
            const isPending = r.status === 'pending';
            const statusBadge = isPending
                ? '<span style="background:rgba(251,191,36,.15);color:#fbbf24;border:1px solid rgba(251,191,36,.3);border-radius:4px;padding:2px 8px;font-size:0.72rem;font-weight:700">譛ｪ陬懷─</span>'
                : '<span style="background:rgba(0,229,160,.12);color:var(--success);border:1px solid rgba(0,229,160,.2);border-radius:4px;padding:2px 8px;font-size:0.72rem;font-weight:700">陬懷─貂・/span>';
            const pts = r.total_compensated_points || 0;
            return `<tr>
                <td style="color:var(--text3);font-size:0.8rem">#${r.id}</td>
                <td style="font-weight:600">${r.gpu_name || '-'}</td>
                <td style="font-size:0.8rem">${startD.toLocaleString('ja-JP')}</td>
                <td style="font-size:0.8rem">${endD.toLocaleString('ja-JP')}</td>
                <td style="font-family:monospace">${mins} 蛻・/td>
                <td style="color:var(--text2);font-size:0.8rem;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.reason || ''}">${r.reason || '窶・}</td>
                <td>窶・/td>
                <td style="font-family:monospace;color:${pts > 0 ? 'var(--success)' : 'var(--text3)'}">
                    ${pts > 0 ? `+${pts.toLocaleString()} pt` : '窶・}
                </td>
                <td>${statusBadge}</td>
                <td>
                    ${isPending ? `<button class="btn" style="font-size:0.75rem;padding:4px 12px;background:linear-gradient(135deg,#ff4757,#c0392b);color:#fff;border:none;cursor:pointer" onclick="executeCompensation(${r.id})">氏 陬懷─螳溯｡・/button>` : '<span style="color:var(--text3);font-size:0.78rem">螳御ｺ・/span>'}
                </td>
            </tr>`;
        }).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--danger);padding:2rem">繧ｨ繝ｩ繝ｼ: ${e.message}</td></tr>`;
    }
}

async function updateOutageBadge() {
    try {
        const reports = await api('/outage');
        const pending = (reports || []).filter(r => r.status === 'pending').length;
        const badge = document.getElementById('outageBadge');
        if (badge) {
            if (pending > 0) { badge.textContent = pending; badge.style.display = ''; }
            else { badge.style.display = 'none'; }
        }
    } catch (_) { }
}

// 蛻晄悄繝舌ャ繧ｸ譖ｴ譁ｰ
setTimeout(updateOutageBadge, 2000);
// 5蛻・＃縺ｨ縺ｫ繝舌ャ繧ｸ譖ｴ譁ｰ
setInterval(updateOutageBadge, 5 * 60 * 1000);

// outage繧ｻ繧ｯ繧ｷ繝ｧ繝ｳ蛻・崛譎ゅ↓GPU繝ｪ繧ｹ繝医ｂ譛譁ｰ蛹・
document.addEventListener('click', e => {
    const btn = e.target.closest('[data-section="outage"]');
    if (btn) setTimeout(() => loadOutageSection(), 50);
});

/* 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武
   泊 API KEY MANAGEMENT
笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武 */

let _allApiKeys = [];   // 繧ｭ繝｣繝・す繝･・域､懃ｴ｢繝輔ぅ繝ｫ繧ｿ逕ｨ・・

async function loadApiKeys() {
    const tbody = document.getElementById('apiKeyTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:2rem"><div class="spinner"></div></td></tr>';

    try {
        const keys = await api('/admin/apikeys');
        _allApiKeys = keys || [];
        updateApiKeyStats(_allApiKeys);
        renderApiKeyTable(_allApiKeys);
    } catch (e) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--danger);padding:2rem">繧ｨ繝ｩ繝ｼ: ${e.message}</td></tr>`;
    }
}

function updateApiKeyStats(keys) {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const active   = keys.filter(k => k.is_active).length;
    const inactive = keys.filter(k => !k.is_active).length;
    const usedToday = keys.filter(k => k.last_used_at && (now - new Date(k.last_used_at).getTime()) < oneDayMs).length;

    const se = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    se('akTotal',    keys.length);
    se('akActive',   active);
    se('akInactive', inactive);
    se('akUsedToday', usedToday);
}

function filterApiKeys() {
    const q = (document.getElementById('akSearch')?.value || '').toLowerCase();
    const filtered = q
        ? _allApiKeys.filter(k =>
            (k.username || '').toLowerCase().includes(q) ||
            (k.email    || '').toLowerCase().includes(q) ||
            (k.name     || '').toLowerCase().includes(q) ||
            (k.key_prefix || '').toLowerCase().includes(q))
        : _allApiKeys;
    renderApiKeyTable(filtered);
}

function renderApiKeyTable(keys) {
    const tbody = document.getElementById('apiKeyTableBody');
    if (!tbody) return;

    if (!keys.length) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:2rem">API繧ｭ繝ｼ縺瑚ｦ九▽縺九ｊ縺ｾ縺帙ｓ</td></tr>';
        return;
    }

    const fmtDate = s => s ? new Date(s).toLocaleString('ja-JP', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '窶・;
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;

    tbody.innerHTML = keys.map(k => {
        const isActive = !!k.is_active;
        const usedRecently = k.last_used_at && (now - new Date(k.last_used_at).getTime()) < oneDayMs;
        const statusBadge = isActive
            ? '<span style="background:rgba(0,229,160,.12);color:var(--success);border:1px solid rgba(0,229,160,.2);border-radius:4px;padding:2px 8px;font-size:0.72rem;font-weight:700">譛牙柑</span>'
            : '<span style="background:rgba(255,255,255,.05);color:var(--text3);border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-size:0.72rem;font-weight:700">辟｡蜉ｹ</span>';
        const toggleLabel = isActive ? '竢ｸ 辟｡蜉ｹ蛹・ : '笆ｶ 譛牙柑蛹・;
        const toggleColor = isActive ? 'color:#fbbf24' : 'color:var(--success)';
        const lastUsed = k.last_used_at
            ? `<span style="color:${usedRecently ? 'var(--accent)' : 'var(--text2)'}">${fmtDate(k.last_used_at)}${usedRecently ? ' 泙' : ''}</span>`
            : '<span style="color:var(--text3)">譛ｪ菴ｿ逕ｨ</span>';

        return `<tr>
            <td style="color:var(--text3);font-size:0.8rem">#${k.id}</td>
            <td>
                <div style="font-weight:600;font-size:0.85rem">${k.username || '窶・}</div>
                <div style="font-size:0.75rem;color:var(--text3)">${k.email || ''}</div>
            </td>
            <td style="font-size:0.85rem">${k.name || 'My API Key'}</td>
            <td style="font-family:monospace;font-size:0.8rem;color:var(--text2)">${k.key_prefix || '窶・}</td>
            <td style="font-size:0.8rem;color:var(--text2)">${fmtDate(k.created_at)}</td>
            <td style="font-size:0.8rem">${lastUsed}</td>
            <td>${statusBadge}</td>
            <td style="display:flex;gap:6px;flex-wrap:wrap">
                <button class="btn" style="font-size:0.72rem;padding:3px 10px;${toggleColor};background:transparent;border:1px solid var(--border)"
                    onclick="toggleApiKey(${k.id}, ${isActive})">${toggleLabel}</button>
                <button class="btn" style="font-size:0.72rem;padding:3px 10px;color:var(--danger);background:transparent;border:1px solid rgba(255,71,87,.3)"
                    onclick="deleteApiKey(${k.id}, '${k.username}')">卵 削除</button>
            </td>
        </tr>`;
    }).join('');
}

async function toggleApiKey(id, currentlyActive) {
    try {
        const data = await api(`/admin/apikeys/${id}/toggle`, { method: 'PATCH' });
        // 繧ｭ繝｣繝・す繝･譖ｴ譁ｰ
        const key = _allApiKeys.find(k => k.id === id);
        if (key) key.is_active = data.is_active ? 1 : 0;
        updateApiKeyStats(_allApiKeys);
        filterApiKeys();
    } catch (e) {
        alert(`繧ｨ繝ｩ繝ｼ: ${e.message}`);
    }
}

async function deleteApiKey(id, username) {
    if (!confirm(`繝ｦ繝ｼ繧ｶ繝ｼ縲・{username}縲阪・API繧ｭ繝ｼ #${id} 繧貞炎髯､縺励∪縺吶°・歃n縺薙・謫堺ｽ懊・蜿悶ｊ豸医○縺ｾ縺帙ｓ縲Ａ)) return;
    try {
        await api(`/admin/apikeys/${id}`, { method: 'DELETE' });
        _allApiKeys = _allApiKeys.filter(k => k.id !== id);
        updateApiKeyStats(_allApiKeys);
        filterApiKeys();
    } catch (e) {
        alert(`蜑企勁繧ｨ繝ｩ繝ｼ: ${e.message}`);
    }
}

// apikeys繧ｻ繧ｯ繧ｷ繝ｧ繝ｳ蛻・崛譎ゅ↓閾ｪ蜍輔Ο繝ｼ繝・
document.addEventListener('click', e => {
    const btn = e.target.closest('[data-section="apikeys"]');
    if (btn) setTimeout(() => loadApiKeys(), 50);
});

/* 笏笏 KPI SUMMARY (譁ｰAPI騾｣謳ｺ) 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
async function loadKpiSummary() {
    try {
        const s = await api('/admin/stats/summary');
        // 螢ｲ荳階PI繧ｫ繝ｼ繝画峩譁ｰ
        const monthRevEl = document.getElementById('kMonthRevenue');
        if (monthRevEl && s.revenue) {
            monthRevEl.textContent = '¥' + Math.round(s.revenue.month || 0).toLocaleString();
        }
        // 霑ｽ蜉KPI縺後≠繧後・譖ｴ譁ｰ
        const kTotalRevEl = document.getElementById('kTotalRevenue');
        if (kTotalRevEl && s.revenue) {
            kTotalRevEl.textContent = '¥' + Math.round(s.revenue.total || 0).toLocaleString();
        }
        const kTotalPayoutEl = document.getElementById('kTotalPayout');
        if (kTotalPayoutEl && s.payouts) {
            kTotalPayoutEl.textContent = '¥' + Math.round(s.payouts.total || 0).toLocaleString();
        }
        const kAvgSessionEl = document.getElementById('kAvgSession');
        if (kAvgSessionEl && s.sessions) {
            kAvgSessionEl.textContent = s.sessions.avg_minutes + '蛻・;
        }
    } catch(e) {
        console.warn('KPI summary error:', e.message);
    }
}

/* 笏笏 REVENUE CHART (譁ｰAPI菴ｿ逕ｨ) 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
async function loadRevenueChart(days = 30) {
    try {
        const data = await api('/admin/stats/revenue?days=' + days);
        if (!chartRevenue) return;

        const sales = data.point_sales || [];
        const allDates = [...new Set(sales.map(r => r.date))].sort();
        const salesMap = {};
        sales.forEach(r => { salesMap[r.date] = r.revenue || 0; });

        chartRevenue.data.labels = allDates;
        chartRevenue.data.datasets[0].data = allDates.map(d => Math.round(salesMap[d] || 0));
        chartRevenue.data.datasets[0].label = '繝昴う繝ｳ繝亥｣ｲ荳・;

        // 2逡ｪ逶ｮ縺ｮ繝・・繧ｿ繧ｻ繝・ヨ・・PU菴ｿ逕ｨ蜿守寢・・
        const usage = data.gpu_usage || [];
        const usageMap = {};
        usage.forEach(r => { usageMap[r.date] = r.gpu_revenue || 0; });
        chartRevenue.data.datasets[1].data = allDates.map(d => Math.round(usageMap[d] || 0));
        chartRevenue.data.datasets[1].label = 'GPU蜿守寢';
        chartRevenue.update();
    } catch(e) {
        console.warn('Revenue chart error:', e.message);
    }
}

/* 笏笏 BACKUP MANAGEMENT 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
let _backups = [];

async function loadBackups() {
    try {
        _backups = await api('/admin/backups');
        renderBackupTable();
    } catch(e) {
        console.warn('Backup load error:', e.message);
    }
}

function renderBackupTable() {
    const tbody = document.getElementById('backupTableBody');
    if (!tbody) return;
    if (!_backups.length) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text3);padding:2rem">繝舌ャ繧ｯ繧｢繝・・縺ｪ縺・/td></tr>';
        return;
    }
    tbody.innerHTML = _backups.map(b => {
        const date = new Date(b.created_at).toLocaleString('ja-JP');
        const sizeKB = Math.round(b.size / 1024);
        return `<tr>
          <td class="mono" style="font-size:0.82rem">${b.name}</td>
          <td style="color:var(--text2)">${sizeKB} KB</td>
          <td style="color:var(--text2)">${date}</td>
        </tr>`;
    }).join('');
}

async function runManualBackup() {
    const btn = document.getElementById('btnRunBackup');
    if (btn) { btn.disabled = true; btn.textContent = '螳溯｡御ｸｭ...'; }
    try {
        const r = await api('/admin/backups/run', { method: 'POST' });
        showToast('笨・繝舌ャ繧ｯ繧｢繝・・螳御ｺ・ ' + r.file + ' (' + Math.round(r.size/1024) + 'KB)', 'success');
        await loadBackups();
    } catch(e) {
        showToast('笶・繝舌ャ繧ｯ繧｢繝・・螟ｱ謨・ ' + e.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '淀 莉翫☆縺舌ヰ繝・け繧｢繝・・'; }
    }
}

/* 笏笏 overview縺ｫ譁ｰAPI騾｣謳ｺ繧堤ｵｱ蜷・笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
// 譌｢蟄倥・refreshAll縺悟ｮ御ｺ・＠縺溘ｉKPI繧ｵ繝槭Μ繝ｼ縺ｨ蜿守寢繧ｰ繝ｩ繝輔ｂ譖ｴ譁ｰ
const _origRefreshAll = typeof refreshAll === 'function' ? refreshAll : null;
if (_origRefreshAll) {
    window._fullRefreshAll = async function() {
        await _origRefreshAll();
        await Promise.allSettled([loadKpiSummary(), loadRevenueChart(30)]);
    };
}

/* 笏笏 蛻晄悄蛹・笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏 */
document.addEventListener('DOMContentLoaded', () => {
    // 繝舌ャ繧ｯ繧｢繝・・繧ｻ繧ｯ繧ｷ繝ｧ繝ｳ縺ｮ繝懊ち繝ｳ
    const backupBtn = document.getElementById('btnRunBackup');
    if (backupBtn) backupBtn.addEventListener('click', runManualBackup);

    // overview繧ｻ繧ｯ繧ｷ繝ｧ繝ｳ陦ｨ遉ｺ譎ゅ↓譁ｰAPI繧ょ他縺ｶ
    setTimeout(() => {
        loadKpiSummary();
        loadRevenueChart(30);
    }, 1500);
});

/* 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊・   剥 HEALTH MONITOR
笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊・*/

async function loadMonitoring() {
    const tbody = document.getElementById('monitorTableBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:2rem"><div class="spinner"></div></td></tr>';
    try {
        const data = await api('/admin/health/latest');
        if (!data || !data.results) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text3);padding:2rem">繝・・繧ｿ縺ｪ縺・窶・縲御ｻ翫☆縺仙ｮ溯｡後阪〒繝倥Ν繧ｹ繝√ぉ繝・け繧帝幕蟋九＠縺ｦ縺上□縺輔＞</td></tr>';
            return;
        }
        document.getElementById('monitorLastRun').textContent = '譛邨ゅメ繧ｧ繝・け: ' + new Date(data.timestamp).toLocaleString('ja-JP');
        const banner = document.getElementById('monitorStatusBanner');
        const sc = { HEALTHY:{bg:'rgba(0,229,160,.12)',border:'rgba(0,229,160,.4)',text:'#00e5a0',icon:'笨・,label:'蜈ｨ鬆・岼豁｣蟶ｸ'}, WARNING:{bg:'rgba(255,179,0,.12)',border:'rgba(255,179,0,.4)',text:'#ffb300',icon:'笞・・,label:data.warnings+'莉ｶ縺ｮ隴ｦ蜻・}, DEGRADED:{bg:'rgba(255,71,87,.12)',border:'rgba(255,71,87,.4)',text:'#ff4757',icon:'笶・,label:data.errors+'莉ｶ縺ｮ繧ｨ繝ｩ繝ｼ'} }[data.status] || {bg:'rgba(255,179,0,.12)',border:'rgba(255,179,0,.4)',text:'#ffb300',icon:'笶・,label:data.status};
        banner.style.cssText = `display:flex;background:${sc.bg};border:1px solid ${sc.border};border-radius:12px;padding:1rem 1.5rem;margin-bottom:1.5rem;align-items:center;gap:1rem;font-weight:600;color:${sc.text}`;
        banner.innerHTML = `<span style="font-size:1.5rem">${sc.icon}</span><span>STATUS: ${data.status} 窶・${sc.label}</span><span style="margin-left:auto;font-size:0.8rem;font-weight:400">${data.total_checks}鬆・岼 (${data.duration_ms}ms)</span>`;
        const navBadge = document.getElementById('monitorBadge');
        if (navBadge) { if (data.errors>0||data.warnings>0){navBadge.style.display='';navBadge.textContent=(data.errors>0?'!':data.warnings);}else{navBadge.style.display='none';} }
        const kv = (id, val, ok) => { const el=document.getElementById(id); if(el){el.textContent=val;el.parentElement.className=`kpi ${ok?'c-success':'c-danger'}`;} };
        const results = data.results;
        kv('mkLocal',    results.find(r=>r.check==='HTTP:Local')?.level==='OK'?'OK':'DOWN', results.find(r=>r.check==='HTTP:Local')?.level==='OK');
        kv('mkExternal', results.find(r=>r.check==='HTTP:External')?.level!=='ERROR'?'OK':'DOWN', results.find(r=>r.check==='HTTP:External')?.level!=='ERROR');
        kv('mkStripe',   results.find(r=>r.check==='Stripe:API')?.level==='OK'?'OK':'NG', results.find(r=>r.check==='Stripe:API')?.level==='OK');
        const whItem=results.find(r=>r.check==='Stripe:Webhook'); const whCnt=whItem?.level==='OK'?0:(whItem?.detail?.length||'?'); kv('mkWebhook', whCnt+'莉ｶ', whCnt===0);
        const pendItem=results.find(r=>r.check==='DB:PendingPurchases'); const pendCnt=pendItem?.level==='OK'?0:(pendItem?.detail?.length||'?'); kv('mkPending', pendCnt+'莉ｶ', pendCnt===0);
        const diskItem=results.find(r=>r.check==='Disk:C:'); const diskVal=diskItem?.message?.match(/\d+GB/)?diskItem.message.match(/\d+GB/)[0]:'窶・; kv('mkDisk', diskVal, diskItem?.level==='OK');
        const levelIcon={OK:'笨・,WARN:'笞・・,ERROR:'笶・,INFO:'邃ｹ・・};
        const levelCls={OK:'var(--success)',WARN:'var(--warning)',ERROR:'var(--danger)',INFO:'var(--accent)'};
        tbody.innerHTML = results.map(r=>`<tr><td><span style="color:${levelCls[r.level]||'var(--text2)'};font-size:1.1rem">${levelIcon[r.level]||'?'}</span></td><td style="font-family:monospace;font-size:0.82rem">${r.check}</td><td>${r.message}</td><td style="font-size:0.75rem;color:var(--text3);max-width:280px;word-break:break-all">${r.detail?JSON.stringify(r.detail).substring(0,100)+'...':''}</td></tr>`).join('');
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="4" style="color:var(--danger);padding:1.5rem">繧ｨ繝ｩ繝ｼ: ${err.message}<br>竊・<code>node scripts/health-check.js</code> 繧貞ｮ溯｡後＠縺ｦ縺上□縺輔＞</td></tr>`;
    }

async function runHealthCheck() {
    showToast('繝倥Ν繧ｹ繝√ぉ繝・け繧帝幕蟋九＠縺ｾ縺励◆...', 'info');
    try {
        await api('/admin/health/run', { method: 'POST' });
        setTimeout(loadMonitoring, 4000);
        showToast('笨・螳御ｺ・らｵ先棡繧定ｪｭ縺ｿ霎ｼ縺ｿ荳ｭ...', 'success');
    } catch (e) {
        showToast('螳溯｡後お繝ｩ繝ｼ: ' + e.message, 'error');
    }

/* 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊・   諜 PURCHASES 豎ｺ貂域価隱咲ｮ｡逅・笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊・*/

async function loadPurchases() {
    const tbody = document.getElementById('purchasesTableBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:2rem"><div class="spinner"></div></td></tr>';
    try {
        const status = document.getElementById('purchaseStatusFilter')?.value || 'pending';
        const qs = status ? `?status=${status}` : '';
        const rows = await api('/admin/purchases' + qs);
        const allRows = await api('/admin/purchases').catch(()=>[]);
        const pending = allRows.filter(r=>r.status==='pending').length;
        const completed = allRows.filter(r=>r.status==='completed').length;
        const totalPt = allRows.filter(r=>r.status==='completed').reduce((s,r)=>s+(r.points||0),0);
        const el = (id,v) => { const e=document.getElementById(id); if(e) e.textContent=v; };
        el('puPending', pending+'莉ｶ'); el('puCompleted', completed+'莉ｶ'); el('puTotalPt', totalPt.toLocaleString()+' pt');
        const badge=document.getElementById('purchasesBadge'); if(badge){if(pending>0){badge.textContent=pending;badge.style.display='';}else{badge.style.display='none';}}
        const stBadge={pending:'b-warning',completed:'b-success',failed:'b-danger'};
        const stLabel={pending:'譛ｪ莉倅ｸ・,completed:'完了',failed:'螟ｱ謨・};
        tbody.innerHTML = (rows||[]).map(p=>`<tr>
            <td class="mono">#${p.id}</td>
            <td><div>${p.username||'窶・}</div><div style="font-size:0.75rem;color:var(--text3)">${p.email||''}</div></td>
            <td>${p.plan_name}</td>
            <td class="mono" style="color:var(--accent)">¥${(p.amount_yen||0).toLocaleString()}</td>
            <td class="mono" style="color:var(--warning)">${p.points} pt</td>
            <td><span class="badge ${stBadge[p.status]||'b-muted'}">${stLabel[p.status]||p.status}</span></td>
            <td style="color:var(--text3);font-size:0.8rem">${p.created_at?new Date(p.created_at).toLocaleString('ja-JP'):'窶・}</td>
            <td>${p.status==='pending'?`<button class="btn btn-primary btn-sm" onclick="approvePurchase(${p.id})">謇ｿ隱堺ｻ倅ｸ・/button><button class="btn btn-ghost btn-sm" style="margin-left:4px" onclick="approvePurchase(${p.id},true)">蠑ｷ蛻ｶ</button>`:'窶・}</td>
        </tr>`).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:2rem">繝・・繧ｿ縺ｪ縺・/td></tr>';
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="8" style="color:var(--danger);padding:1.5rem">${err.message}</td></tr>`;
    }

async function approvePurchase(id, force=false) {
    if (!confirm(force?`Purchase #${id} 繧貞ｼｷ蛻ｶ莉倅ｸ弱＠縺ｾ縺呻ｼ・tripe讀懆ｨｼ縺ｪ縺暦ｼ峨ゅｈ繧阪＠縺・〒縺吶°・歔:`Purchase #${id} 繧呈価隱阪＠縺ｦ繝昴う繝ｳ繝医ｒ莉倅ｸ弱＠縺ｾ縺吶°・歔)) return;
    try {
        const result = await api(`/admin/purchases/${id}/approve${force?'?force=1':''}`, {method:'POST'});
        showToast(result.already_granted?'譌｢縺ｫ莉倅ｸ取ｸ医∩縺ｧ縺・:`笨・+${result.points_added}pt 繧・${result.user?.email} 縺ｫ莉倅ｸ弱＠縺ｾ縺励◆`, result.already_granted?'info':'success');
        loadPurchases();
    } catch (err) {
        showToast('謇ｿ隱榊､ｱ謨・ ' + err.message, 'error');
    }

/* ─── SF RAID JOBS ──────────────────────────────────────────────── */
async function loadSfRaidJobs() {
    const tbody = document.getElementById('sfRaidJobTableBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:2rem;color:var(--text3)">ロード中...</td></tr>';
    const sf = document.getElementById('sfRaidStatusFilter');
    const statusFilter = sf ? sf.value : '';
    try {
        const url = '/admin/sf/raid-jobs' + (statusFilter ? '?status=' + statusFilter : '');
        const data = await api(url);
        const jobs = Array.isArray(data) ? data : (data.jobs || []);

        const total     = jobs.length;
        const active    = jobs.filter(j => ['dispatched','running'].includes(j.status)).length;
        const completed = jobs.filter(j => j.status === 'completed').length;
        const failed    = jobs.filter(j => j.status === 'failed').length;
        const revenue   = jobs.filter(j => j.status === 'completed').reduce((s, j) => s + (j.payment_amount_yen || 0), 0);
        const todayDate = new Date();
        const today     = jobs.filter(j => {
            if (!j.completed_at) return false;
            const d = new Date(j.completed_at);
            return d.getFullYear() === todayDate.getFullYear() && d.getMonth() === todayDate.getMonth() && d.getDate() === todayDate.getDate();
        }).length;

        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        set('sfRaidTotal',     total);
        set('sfRaidActive',    active);
        set('sfRaidCompleted', completed);
        set('sfRaidRevenue',   '¥' + Math.round(revenue).toLocaleString());
        set('sfRaidToday',     today);
        set('sfRaidFailed',    failed);

        const badge = document.getElementById('sfRaidBadge');
        if (badge) { badge.textContent = active; badge.style.display = active > 0 ? '' : 'none'; }

        const ICON = { payment_pending:'⏳', paid:'💳', dispatched:'📡', running:'🔥', completed:'✅', failed:'❌', cancelled:'🚫' };

        if (!jobs.length) {
            tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--text3);padding:2rem">ジョブはありません</td></tr>';
            return;
        }

        tbody.innerHTML = jobs.slice(0, 50).map(j => {
            const icon   = ICON[j.status] || '?';
            const created    = j.created_at   ? new Date(j.created_at).toLocaleString('ja-JP')   : '—';
            const completedAt= j.completed_at ? new Date(j.completed_at).toLocaleString('ja-JP') : '—';
            const nodeCount  = j.node_count || '—';
            const payMethod  = j.payment_method === 'points' ? '🏆 PT' : '💳 現金';
            const ops = ['dispatched','running'].includes(j.status)
                ? `<button class="btn btn-danger btn-sm" onclick="event.stopPropagation();cancelSfRaidJob(${j.id})">停止</button>`
                : j.status === 'payment_pending'
                ? `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();forceCompleteSfJob(${j.id})">強制完了</button>`
                : '<span style="color:var(--text3);font-size:.78rem">—</span>';
            return `<tr style="cursor:pointer" onclick="toggleSfJobDetail(${j.id}, this)">
              <td class="mono">#${j.id} <span id="sfChevron${j.id}" style="font-size:.7rem;color:var(--text3)">▶</span></td>
              <td><strong>${j.username || j.user_id || '—'}</strong></td>
              <td><span class="sf-badge ${j.status}">${icon} ${j.status}</span></td>
              <td style="font-size:.8rem;color:var(--text2)">${payMethod}</td>
              <td class="mono">${j.payment_amount_yen ? '¥'+Math.round(j.payment_amount_yen).toLocaleString() : '—'}</td>
              <td class="mono" style="color:#6c47ff">${j.points_used ? j.points_used.toLocaleString()+' pt' : '—'}</td>
              <td class="mono">${nodeCount}</td>
              <td style="font-size:.78rem;color:var(--text3)">${created}</td>
              <td style="font-size:.78rem;color:var(--text3)">${completedAt}</td>
              <td>${ops}</td>
            </tr>
            <tr id="sfJobDetail${j.id}" style="display:none">
              <td colspan="10" style="padding:0;background:rgba(0,0,0,0.25)">
                <div id="sfJobDetailContent${j.id}" style="padding:1rem 1.5rem;font-size:.8rem;color:var(--text2)">
                  読み込み中...
                </div>
              </td>
            </tr>`;
        }).join('');

    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:1rem;color:var(--danger)">${err.message}</td></tr>`;
    }

async function toggleSfJobDetail(jobId, rowEl) {
    const detailRow = document.getElementById(`sfJobDetail${jobId}`);
    const chevron   = document.getElementById(`sfChevron${jobId}`);
    if (!detailRow) return;

    if (detailRow.style.display !== 'none') {
        detailRow.style.display = 'none';
        if (chevron) chevron.textContent = '▶';
        return;
    }

    detailRow.style.display = '';
    if (chevron) chevron.textContent = '▼';

    const content = document.getElementById(`sfJobDetailContent${jobId}`);
    if (!content) return;

    try {
        const j = await api(`/admin/sf/raid-jobs/${jobId}`);

        // MRP ジョブID リスト
        const mrpIds = j.mrp_job_ids || [];
        const mrpHtml = mrpIds.length > 0
            ? mrpIds.map((id, i) => `<span style="font-family:monospace;background:rgba(108,71,255,0.12);padding:2px 6px;border-radius:4px;margin:2px;display:inline-block">ノード${i+1}: ${id.slice(0,12)}...</span>`).join('')
            : '<span style="color:var(--text3)">MRP ジョブID なし</span>';

        // RAID プラン
        let planHtml = '';
        if (j.raid_plan_json) {
            try {
                const plan = typeof j.raid_plan_json === 'string' ? JSON.parse(j.raid_plan_json) : j.raid_plan_json;
                const nodes = plan.raid_plan || [];
                planHtml = nodes.map(n => `
                    <div style="display:flex;gap:1rem;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
                        <span style="width:120px;color:var(--text3);font-size:.75rem">📍 ${n.location || '不明'}</span>
                        <span style="flex:1;font-family:monospace;font-size:.75rem">${n.gpu_name || n.provider_name || '—'}</span>
                        <span style="color:#6c47ff;font-size:.75rem">F${n.frame_start}–${n.frame_end} (${n.frame_pct}%)</span>
                        <span style="color:#fbbf24;font-size:.75rem">${n.fp32_tflops ? n.fp32_tflops.toFixed(1)+' TF' : '—'}</span>
                    </div>`).join('');
            } catch (_) { planHtml = '<span style="color:var(--danger)">プラン解析エラー</span>'; }
        }

        // 出力URL
        const dlHtml = j.output_url
            ? `<a href="${j.output_url}" target="_blank" download style="color:#00d4ff;font-size:.8rem">⬇ 成果物をダウンロード</a>`
            : '<span style="color:var(--text3)">output_url なし</span>';

        content.innerHTML = `
            <div style="display:grid;gap:.75rem">
                <div>
                    <div style="color:var(--text3);font-size:.72rem;margin-bottom:.25rem">MRP ジョブ ID</div>
                    ${mrpHtml}
                </div>
                ${planHtml ? `<div>
                    <div style="color:var(--text3);font-size:.72rem;margin-bottom:.25rem">RAID ノード配分</div>
                    ${planHtml}
                </div>` : ''}
                <div style="display:flex;gap:2rem;align-items:center">
                    <div>
                        <div style="color:var(--text3);font-size:.72rem">成果物</div>
                        ${dlHtml}
                    </div>
                    ${j.coupon_code ? `<div>
                        <div style="color:var(--text3);font-size:.72rem">クーポン</div>
                        <span style="color:#4ade80;font-size:.8rem">${j.coupon_code}</span>
                    </div>` : ''}
                </div>
            </div>`;
    } catch (e) {
        if (content) content.innerHTML = `<span style="color:var(--danger)">詳細取得失敗: ${e.message}</span>`;
    }

async function cancelSfRaidJob(jobId) {
    if (!confirm(`SF Raid Job #${jobId} を停止しますか?`)) return;
    try { await api(`/admin/sf/raid-jobs/${jobId}/cancel`, { method: 'POST' }); showToast('✅ 停止しました', 'success'); loadSfRaidJobs(); }
    catch (e) { showToast('❌ ' + e.message, 'error'); }

async function forceCompleteSfJob(jobId) {
    if (!confirm(`SF Raid Job #${jobId} を強制完了しますか?`)) return;
    try { await api(`/admin/sf/raid-jobs/${jobId}/force-complete`, { method: 'POST' }); showToast('✅ 強制完了しました', 'success'); loadSfRaidJobs(); }
    catch (e) { showToast('❌ ' + e.message, 'error'); }
}
