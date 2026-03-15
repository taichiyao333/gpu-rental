/* ── STATE ─────────────────────────────────────────────────────── */
const token = localStorage.getItem('gpu_token');
const user = JSON.parse(localStorage.getItem('gpu_user') || 'null');

// Redirect if not admin
if (!token || !user || user.role !== 'admin') {
    window.location.href = '/portal/';
}

document.getElementById('sfUsername').textContent = user?.username || '—';

/* API base: auto-detect local vs remote */
const API = (function () {
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return '';
    return 'https://pubmed-apartments-unix-implementation.trycloudflare.com';
})();

/* ── API ───────────────────────────────────────────────────────── */
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
        if (res.status === 429) throw new Error('リクエストが多すぎます。少し待ってから再度お試しください。');
        throw new Error('HTTP ' + res.status + ' - サーバーエラーが発生しました');
    }
    if (!res.ok) throw new Error(data.error || data.message || 'API Error');
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
        case 'coupons': loadCoupons(); break;
        case 'pricing': loadPricingCompare(); break;
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
        document.getElementById('userTableBody').innerHTML = (list || []).map(u => `<tr id="user-row-${u.id}">
          <td class="mono">#${u.id}</td>
          <td><strong>${u.username}</strong></td>
          <td style="color:var(--text2)">${u.email}</td>
          <td><span class="badge ${roleBadge[u.role] || 'b-muted'}">${roleLabel[u.role] || u.role}</span></td>
          <td><span class="badge ${u.status === 'active' ? 'b-success' : 'b-danger'}">${u.status === 'active' ? '有効' : '停止'}</span></td>
          <td class="mono">¥${Math.round(u.wallet_balance || 0).toLocaleString()}</td>
          <td style="color:var(--text3)">${new Date(u.created_at).toLocaleDateString('ja-JP')}</td>
          <td style="display:flex;gap:6px;align-items:center">
            ${u.role !== 'admin'
                ? `<button class="btn btn-ghost btn-sm" onclick="toggleUser(${u.id},'${u.status}')">${u.status === 'active' ? '停止' : '有効化'}</button>
                 <button class="btn btn-danger btn-sm" onclick="confirmDeleteUser(${u.id},'${u.username}','${u.email}')">🗑 削除</button>`
                : '<span style="color:var(--text3);font-size:0.8rem">保護</span>'
            }
          </td>
        </tr>`).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:2rem">ユーザーなし</td></tr>';
    } catch (err) { console.error(err); }
}

async function toggleUser(id, currentStatus) {
    const newStatus = currentStatus === 'active' ? 'suspended' : 'active';
    try { await api(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) }); loadUsers(); } catch (e) { alert(e.message); }
}

/**
 * 2段階確認ダイアログで強制削除
 */
function confirmDeleteUser(id, username, email) {
    // 既存モーダルがあれば除去
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
                <span style="font-size:2rem">🗑</span>
                <div>
                    <div style="font-size:1.1rem;font-weight:700;color:#ff4757">ユーザーを強制削除</div>
                    <div style="font-size:0.8rem;color:#9898b8;margin-top:2px">この操作は元に戻せません</div>
                </div>
            </div>
            <div style="background:rgba(255,71,87,0.08);border:1px solid rgba(255,71,87,0.2);
                        border-radius:10px;padding:14px 16px;margin-bottom:20px">
                <div style="font-size:0.85rem;color:#9898b8;margin-bottom:4px">削除対象</div>
                <div style="font-weight:700">${username}</div>
                <div style="font-size:0.82rem;color:#6c6c9a">${email} &nbsp;·&nbsp; ID: ${id}</div>
            </div>
            <div style="font-size:0.85rem;color:#ff4757;margin-bottom:6px">
                ⚠ 以下のデータが全て削除されます：
            </div>
            <ul style="font-size:0.8rem;color:#9898b8;margin:0 0 20px 18px;line-height:1.9">
                <li>アカウント情報・パスワード</li>
                <li>全予約履歴（稼働中は強制終了）</li>
                <li>使用ログ・課金履歴</li>
            </ul>
            <div style="margin-bottom:16px">
                <label style="font-size:0.82rem;color:#9898b8;display:block;margin-bottom:6px">
                    確認のため <strong style="color:#fff">${username}</strong> と入力してから削除してください
                </label>
                <input id="deleteConfirmInput" type="text" placeholder="ユーザー名を入力..."
                    style="width:100%;padding:10px 14px;background:#0a0a1a;border:1px solid rgba(255,255,255,0.15);
                           border-radius:8px;color:#eee;font-size:0.9rem;outline:none;box-sizing:border-box"
                    oninput="checkDeleteInput('${username}')"/>
            </div>
            <div style="display:flex;gap:10px;justify-content:flex-end">
                <button class="btn btn-ghost" onclick="document.getElementById('deleteUserModal').remove()">
                    キャンセル
                </button>
                <button id="deleteConfirmBtn" class="btn btn-danger" disabled
                    onclick="executeDeleteUser(${id}, '${username}')">
                    🗑 強制削除する
                </button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    // Esc で閉じる
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
    if (btn) { btn.disabled = true; btn.textContent = '削除中...'; }
    try {
        await api(`/admin/users/${id}?force=true`, { method: 'DELETE' });
        document.getElementById('deleteUserModal')?.remove();
        // テーブル行を消す（即時反映）
        document.getElementById(`user-row-${id}`)?.remove();
        showDeleteToast(`✅ ${username} を削除しました`);
    } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = '🗑 強制削除する'; }
        alert('削除失敗: ' + e.message);
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

/* ── MAINTENANCE MODE ────────────────────────────────────────────── */
let _maintEnabled = false;

async function loadMaintenanceStatus() {
    try {
        const data = await api('/admin/maintenance');
        _maintEnabled = data.enabled;
        updateMaintUI(data);
    } catch (e) {
        showToast('メンテモード状態の取得に失敗しました', 'error');
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
        icon.textContent = '🔴';
        title.textContent = 'メンテナンス中';
        sub.textContent = `メッセージ: ${data.message || ''} / 設定者: ${data.updated_by || '—'}`;
        badge.style.background = '#ff4757';
        badge.style.color = '#fff';
        badge.textContent = 'MAINTENANCE';
        togLabel.textContent = 'メンテナンスモードがONです';
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
        icon.textContent = '🟢';
        title.textContent = '通常稼働中';
        sub.textContent = 'サービスは正常に稼働しています';
        badge.style.background = '#00e5a0';
        badge.style.color = '#000';
        badge.textContent = 'ONLINE';
        togLabel.textContent = 'メンテナンスモードをONにする';
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
        || 'ただいまメンテナンス中です。しばらくお待ちください。';

    const confirmMsg = enable
        ? '⚠️ メンテナンスモードをONにします。\nユーザーはサービスにアクセスできなくなります。\n本当によろしいですか？'
        : 'メンテナンスモードをOFFにしてサービスを再開します。\nよろしいですか？';

    if (!confirm(confirmMsg)) return;

    try {
        const data = await api('/admin/maintenance', {
            method: 'POST',
            body: JSON.stringify({ enabled: enable, message }),
        });
        _maintEnabled = enable;
        updateMaintUI(data);
        showToast(
            enable ? '🔴 メンテナンスモードをONにしました' : '🟢 メンテナンスモードをOFFにしました',
            enable ? 'warning' : 'success'
        );
    } catch (e) {
        showToast('エラー: ' + e.message, 'error');
    }
}

// セクション切り替え時にメンテ状態をロード
const _origNavClick = document.querySelectorAll('.nav-item');
document.addEventListener('click', e => {
    const btn = e.target.closest('[data-section="maintenance"]');
    if (btn) loadMaintenanceStatus();
});

// ============================================================
// 🎟️ クーポン管理
// ============================================================

async function loadCoupons() {
    // 統計
    try {
        const stats = await api('/admin/coupons/stats');
        document.getElementById('couponStats').innerHTML = [
            { label: '有効クーポン', value: stats.active_coupons, color: 'var(--success)' },
            { label: '総発行数', value: stats.total_coupons, color: 'var(--accent)' },
            { label: '総使用回数', value: stats.total_uses, color: 'var(--primary)' },
            { label: '総割引額', value: '¥' + (stats.total_discount_yen || 0).toLocaleString(), color: 'var(--warning)' },
        ].map(s => `<div class="stat-card" style="border-left:3px solid ${s.color}">
            <div style="font-size:1.6rem;font-weight:700;color:${s.color}">${s.value}</div>
            <div style="font-size:.8rem;color:var(--text2);margin-top:.25rem">${s.label}</div>
        </div>`).join('');
    } catch (_) { }

    // クーポン一覧
    try {
        const coupons = await api('/coupons');
        const tbody = coupons.map(c => {
            const expired = c.valid_until && new Date(c.valid_until) < new Date();
            const status = !c.is_active ? '無効' : expired ? '期限切れ' : '有効';
            const stColor = !c.is_active ? 'var(--danger)' : expired ? 'var(--warning)' : 'var(--success)';
            return `<tr>
                <td><code style="background:rgba(108,71,255,.15);padding:.2rem .6rem;border-radius:4px;font-size:.9rem">${c.code}</code></td>
                <td>${c.discount_type === 'percent' ? c.discount_value + '%OFF' : '¥' + c.discount_value.toLocaleString() + '割引'}</td>
                <td>${c.description || '—'}</td>
                <td>${c.used_count}${c.max_uses ? ' / ' + c.max_uses : ' / 無限'}</td>
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
            <tbody>${tbody || '<tr><td colspan="7" style="padding:2rem;text-align:center;color:var(--text3)">クーポンなし</td></tr>'}</tbody>
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
    if (!code || !val) return showToast('コードと値は必須です', 'error');
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
// 📊 RunPod 価格監視
// ============================================================

async function loadPricingCompare() {
    document.getElementById('pricingTable').innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text2)">読み込み中...</div>';
    try {
        const data = await api('/admin/pricing/compare');
        if (data.last_fetched) {
            document.getElementById('pricingLastFetch').textContent =
                `最終取得: ${new Date(data.last_fetched).toLocaleString('ja-JP')} — ${data.count}種類`;
        } else {
            document.getElementById('pricingLastFetch').textContent = '未取得。《今すぐ取得》をクリックしてください。';
        }
        renderPricingTable(data.comparisons || []);
    } catch (e) {
        document.getElementById('pricingTable').innerHTML = `<div style="padding:1rem;color:var(--danger)">${e.message}</div>`;
    }
}

function renderPricingTable(comparisons) {
    if (!comparisons.length) {
        document.getElementById('pricingTable').innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text3)">データなし（《今すぐ取得》で取得）</div>';
        return;
    }
    const rows = comparisons.map(c => {
        const status = c.is_competitive === null ? '' : c.is_competitive ? '✅' : '⚠️';
        const gpuRentalCell = c.gpurental_price
            ? `¥${c.gpurental_price.toLocaleString()}/hr`
            : '<span style="color:var(--text3)">未登録</span>';
        const diffCell = c.diff_jpy !== null
            ? `<span style="color:${c.diff_jpy > 0 ? 'var(--warning)' : 'var(--success)'}">${c.diff_jpy > 0 ? '+' : ''}¥${c.diff_jpy.toLocaleString()}</span>`
            : '—';
        const applybtn = c.suggested_price_jpy
            ? `<button class="btn btn-ghost" style="font-size:.75rem;padding:.25rem .5rem" onclick="applyPrice('${c.gpu_name}',${c.suggested_price_jpy})">適用</button>`
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
    showToast('🔄 RunPodから価格を取得中...', 'info');
    try {
        const result = await api('/admin/pricing/fetch', { method: 'POST' });
        showToast(`✅ ${result.count}種類GPUの価格を取得しました`, 'success');
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
        showToast(r.changes > 0 ? `✅ 価格を適用しました` : '該当GPUなし', r.changes > 0 ? 'success' : 'warning');
        loadPricingCompare();
    } catch (e) { showToast(e.message, 'error'); }
}
