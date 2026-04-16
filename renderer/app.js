'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEVICE_COLORS = {
  mac:    '#1d1d1f',
  iphone: '#007AFF',
  ipad:   '#34C759',
};

const DEVICE_LABELS = {
  mac:    'Mac',
  iphone: 'iPhone',
  ipad:   'iPad',
};

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  mode:      'week',  // day | week | month | year
  offset:    0,       // 0 = current period, -1 = previous, etc.
  activeTab: 'overview',
  hasData:   { mac: false, iphone: false, ipad: false },
};

const settings = {
  dailyTargetHours: null,
  showTargetTicks:  true,
};

const charts = {};

// ── Settings persistence ──────────────────────────────────────────────────────

function loadSettings() {
  try {
    const raw = localStorage.getItem('screenlog_settings');
    if (raw) Object.assign(settings, JSON.parse(raw));
  } catch { /* ignore */ }
}

function saveSettings() {
  try {
    localStorage.setItem('screenlog_settings', JSON.stringify(settings));
  } catch { /* ignore */ }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function fmtHours(seconds) {
  if (!seconds || seconds < 1) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function fmtRelTime(unixTs) {
  const diff = Math.floor(Date.now() / 1000) - unixTs;
  if (diff < 60)    return 'just now';
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fmtDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtHour(h) {
  if (h === 0)  return '12am';
  if (h < 12)   return `${h}am`;
  if (h === 12) return '12pm';
  return `${h - 12}pm`;
}

// ── Period bounds ─────────────────────────────────────────────────────────────

function getPeriodBounds(mode, offset) {
  const now = new Date();
  let from, to;

  if (mode === 'day') {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    from = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
    to   = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);

  } else if (mode === 'week') {
    const d = new Date(now);
    const dow = d.getDay(); // 0 = Sun
    d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow) + offset * 7);
    from = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
    to   = new Date(from);
    to.setDate(from.getDate() + 6);
    to.setHours(23, 59, 59);

  } else if (mode === 'month') {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    from = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0);
    to   = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59);

  } else { // year
    const year = now.getFullYear() + offset;
    from = new Date(year, 0, 1, 0, 0, 0);
    to   = new Date(year, 11, 31, 23, 59, 59);
  }

  return [Math.floor(from.getTime() / 1000), Math.floor(to.getTime() / 1000)];
}

function getApiRange() {
  const [from, to] = getPeriodBounds(state.mode, state.offset);
  return [from, Math.floor(Math.min(to, Date.now() / 1000))];
}

// ── Period label ──────────────────────────────────────────────────────────────

function getPeriodLabel(mode, offset) {
  const now = new Date();
  let label, year = '';

  if (mode === 'day') {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    if (offset === 0)       label = 'Today';
    else if (offset === -1) label = 'Yesterday';
    else label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    if (d.getFullYear() !== now.getFullYear()) year = String(d.getFullYear());

  } else if (mode === 'week') {
    const d = new Date(now);
    const dow = d.getDay();
    d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow) + offset * 7);
    const endD = new Date(d);
    endD.setDate(d.getDate() + 6);
    if (offset === 0)       label = 'This Week';
    else if (offset === -1) label = 'Last Week';
    else {
      const s = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const e = endD.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      label = `${s} – ${e}`;
    }
    if (d.getFullYear() !== now.getFullYear()) year = String(d.getFullYear());

  } else if (mode === 'month') {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    if (offset === 0)       label = 'This Month';
    else if (offset === -1) label = 'Last Month';
    else label = d.toLocaleDateString('en-US', { month: 'long' });
    if (d.getFullYear() !== now.getFullYear()) year = String(d.getFullYear());

  } else { // year
    const y = now.getFullYear() + offset;
    if (offset === 0)       label = 'This Year';
    else if (offset === -1) label = 'Last Year';
    else label = String(y);
  }

  return { label, year };
}

// ── Chart helpers ─────────────────────────────────────────────────────────────

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

function activeDeviceKeys() {
  return ['mac', 'iphone', 'ipad'].filter(d => state.hasData[d]);
}

function rowTotal(row) {
  return activeDeviceKeys().reduce((s, d) => s + (row[d] || 0), 0);
}

// ── UI updates ────────────────────────────────────────────────────────────────

function updatePeriodUI() {
  const { label, year } = getPeriodLabel(state.mode, state.offset);
  const periodLabelEl = document.getElementById('period-label');
  const periodYearEl  = document.getElementById('period-year');
  const navNext       = document.getElementById('nav-next');

  periodLabelEl.textContent = label;
  periodYearEl.textContent  = year;

  const isCurrent = state.offset === 0;
  periodLabelEl.classList.toggle('is-current', isCurrent);
  navNext.disabled = isCurrent;
}

function updateModeButtons() {
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === state.mode);
  });

  // Hide "Daily" tab button if mode is "day"
  const dailyTabBtn = document.querySelector('.tab-btn[data-tab="daily"]');
  if (dailyTabBtn) {
    dailyTabBtn.style.display = (state.mode === 'day') ? 'none' : '';
  }
}


// ── Tabs ──────────────────────────────────────────────────────────────────────

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tab}`));
  loadCurrentTab();
}

function loadCurrentTab() {
  if      (state.activeTab === 'overview') loadOverview();
  else if (state.activeTab === 'daily')    loadDaily();
  else if (state.activeTab === 'hourly')   loadHourly();
}

function showTabState(prefix, tabState) {
  document.getElementById(`${prefix}-loading`).style.display = tabState === 'loading' ? '' : 'none';
  document.getElementById(`${prefix}-nodata`).style.display  = tabState === 'nodata'  ? '' : 'none';
  document.getElementById(`${prefix}-wrap`).style.display    = tabState === 'data'    ? '' : 'none';
}

// ── Overview ──────────────────────────────────────────────────────────────────

async function loadOverview() {
  showTabState('ov', 'loading');
  const [from, to] = getApiRange();

  // Fetch app breakdown + daily totals in parallel (daily needed for KPIs)
  const [{ apps }, { days }] = await Promise.all([
    window.api.getScreentime(from, to),
    window.api.getDaily(from, to),
  ]);

  const filtered = apps.filter(a => rowTotal(a) > 0).slice(0, 15);

  if (filtered.length === 0) {
    showTabState('ov', 'nodata');
    document.getElementById('ov-total').textContent  = '—';
    document.getElementById('ov-apps').textContent   = '—';
    document.getElementById('ov-avg').textContent    = '—';
    document.getElementById('ov-kpi').style.display  = 'none';
    return;
  }

  // KPIs (uses daily totals, not per-app data)
  try { renderKpis(days, days.map(d => rowTotal(d)), 'ov'); } catch (e) { console.error('KPI render error:', e); }

  const total = filtered.reduce((s, a) => s + rowTotal(a), 0);
  const numDays = Math.max(1, Math.round((to - from) / 86400));
  document.getElementById('ov-total').textContent = fmtHours(total);
  document.getElementById('ov-apps').textContent  = String(filtered.length);
  document.getElementById('ov-avg').textContent   = fmtHours(total / numDays);

  showTabState('ov', 'data');
  destroyChart('ov');

  const devKeys  = activeDeviceKeys();
  const datasets = devKeys.map(dev => ({
    label:           DEVICE_LABELS[dev],
    data:            filtered.map(a => Math.round((a[dev] || 0) / 60)),
    backgroundColor: DEVICE_COLORS[dev],
  }));

  const canvas = document.getElementById('ov-chart');
  canvas.style.height = `${Math.max(280, filtered.length * 28)}px`;
  canvas.title = 'Double-click any row to rename';

  charts['ov'] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: filtered.map(a => a.display_name),
      datasets
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: devKeys.length > 1,
          position: 'top',
          labels: { boxWidth: 10, font: { size: 11 } },
        },
        tooltip: {
          callbacks: {
            title: (items) => {
              const item = filtered[items[0].dataIndex];
              return item.display_name === item.app ? item.app : `${item.display_name} (${item.app})`;
            },
            label: ctx => ` ${ctx.dataset.label}: ${fmtHours(ctx.raw * 60)}`,
          },
        },
      },
      scales: {
        x: { stacked: true, ticks: { callback: v => fmtHours(v * 60) }, grid: { color: '#f0f0f0' } },
        y: { stacked: true, ticks: { font: { size: 12 } } },
      },
    },
  });

  canvas.ondblclick = (e) => {
    const chart = charts['ov'];
    if (!chart) return;
    const index = Math.round(chart.scales.y.getValueForPixel(e.offsetY));
    if (index < 0 || index >= filtered.length) return;
    showRenamePopover(filtered[index], e.clientX, e.clientY);
  };
}

// ── Daily ─────────────────────────────────────────────────────────────────────

async function loadDaily() {
  showTabState('dy', 'loading');
  const [from, to] = getApiRange();
  const { days } = await window.api.getDaily(from, to);

  const totals = days.map(d => rowTotal(d));
  const grandTotal = totals.reduce((s, v) => s + v, 0);

  if (grandTotal === 0) {
    showTabState('dy', 'nodata');
    document.getElementById('dy-total').textContent = '—';
    document.getElementById('dy-avg').textContent   = '—';
    document.getElementById('dy-peak').textContent  = '—';
    document.getElementById('dy-kpi').style.display  = 'none';
    return;
  }

  const nonZero = totals.filter(v => v > 0);
  const avg     = grandTotal / Math.max(1, nonZero.length);
  const peakIdx = totals.indexOf(Math.max(...totals));

  document.getElementById('dy-total').textContent = fmtHours(grandTotal);
  document.getElementById('dy-avg').textContent   = fmtHours(avg);
  document.getElementById('dy-peak').textContent  = fmtDate(days[peakIdx].date);

  showTabState('dy', 'data');
  destroyChart('dy');

  try { renderKpis(days, totals, 'dy'); } catch (e) { console.error('KPI render error:', e); }

  const targetSec = settings.dailyTargetHours ? settings.dailyTargetHours * 3600 : null;
  const targetMin = settings.dailyTargetHours ? settings.dailyTargetHours * 60   : null;
  const devKeys   = activeDeviceKeys();

  const datasets = devKeys.map(dev => ({
    label:           DEVICE_LABELS[dev],
    data:            days.map(d => Math.round((d[dev] || 0) / 60)),
    backgroundColor: DEVICE_COLORS[dev],
  }));

  // Inline plugin: threshold line + green tick marks above bars that meet the goal
  const targetLinePlugin = {
    id: 'targetLine',
    afterDraw(chart) {
      const { ctx, chartArea, scales: { y } } = chart;

      // ── Threshold line ────────────────────────────────────────────────────
      if (targetMin) {
        const yPx = y.getPixelForValue(targetMin);
        if (yPx >= chartArea.top && yPx <= chartArea.bottom) {
          ctx.save();
          ctx.strokeStyle = '#FF3B30';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(chartArea.left, yPx);
          ctx.lineTo(chartArea.right, yPx);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = '#FF3B30';
          ctx.font = '600 10px -apple-system, BlinkMacSystemFont, sans-serif';
          ctx.textAlign = 'right';
          ctx.fillText(`Goal: ${fmtHours(targetSec)}`, chartArea.right, yPx - 5);
          ctx.restore();
        }
      }

      // ── Green tick marks above bars that meet the goal ────────────────────
      if (!targetSec || !settings.showTargetTicks) return;
      const meta = chart.getDatasetMeta(0);
      if (!meta || !meta.data.length) return;
      ctx.save();
      ctx.strokeStyle = '#34C759';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let i = 0; i < days.length; i++) {
        if (totals[i] <= 0 || totals[i] > targetSec) continue;
        const totalMin = totals[i] / 60;
        const barX = meta.data[i].x;
        const topY  = y.getPixelForValue(totalMin) - 7;
        const s = 4; // half-size of tick
        ctx.beginPath();
        ctx.moveTo(barX - s,       topY + s * 0.2);
        ctx.lineTo(barX - s * 0.1, topY + s);
        ctx.lineTo(barX + s,       topY - s * 0.6);
        ctx.stroke();
      }
      ctx.restore();
    },
  };

  charts['dy'] = new Chart(document.getElementById('dy-chart'), {
    type: 'bar',
    data: { labels: days.map(d => fmtDate(d.date)), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: devKeys.length > 1,
          position: 'top',
          labels: { boxWidth: 10, font: { size: 11 } },
        },
        tooltip: {
          callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmtHours(ctx.raw * 60)}` },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { stacked: true, ticks: { callback: v => fmtHours(v * 60) }, grid: { color: '#f0f0f0' } },
      },
    },
    plugins: [targetLinePlugin],
  });
}

// ── KPI section ───────────────────────────────────────────────────────────────

function renderKpis(days, totals, prefix) {
  const kpiSection = document.getElementById(`${prefix}-kpi`);
  const target = settings.dailyTargetHours;
  if (!target) { kpiSection.style.display = 'none'; return; }

  const targetSec = target * 3600;
  const daysWithData = totals.filter(t => t > 0).length;
  if (daysWithData === 0) { kpiSection.style.display = 'none'; return; }

  const onTarget = totals.filter(t => t > 0 && t <= targetSec).length;
  const rate = Math.round(onTarget / daysWithData * 100);

  // Best streak in the visible period
  let bestStreak = 0, cur = 0;
  for (const t of totals) {
    if (t > 0 && t <= targetSec) { cur++; bestStreak = Math.max(bestStreak, cur); }
    else if (t > 0) cur = 0;
  }

  // Current streak: count backwards from last day that has data
  let currentStreak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (totals[i] === 0) continue;
    if (totals[i] <= targetSec) currentStreak++;
    else break;
  }

  const daysStr = n => n === 1 ? '1 day' : `${n} days`;

  const onTargetEl = document.getElementById(`${prefix}-kpi-on-target`);
  const rateEl     = document.getElementById(`${prefix}-kpi-rate`);
  const streakEl   = document.getElementById(`${prefix}-kpi-streak`);
  const bestEl     = document.getElementById(`${prefix}-kpi-best`);
  if (!onTargetEl || !rateEl || !streakEl || !bestEl) return;

  onTargetEl.textContent = `${onTarget} / ${daysWithData}`;
  onTargetEl.className   = 'value' + (onTarget === daysWithData ? ' value-green' : '');

  rateEl.textContent = `${rate}%`;
  rateEl.className   = 'value' + (rate >= 80 ? ' value-green' : rate < 50 ? ' value-red' : '');

  streakEl.textContent = daysStr(currentStreak);
  bestEl.textContent   = daysStr(bestStreak);

  kpiSection.style.display = '';
}

// ── Hourly ────────────────────────────────────────────────────────────────────

async function loadHourly() {
  showTabState('hr', 'loading');
  const [from, to] = getApiRange();
  const { hours, num_days } = await window.api.getHourly(from, to);

  // Average per-day so the unit is "avg hours per day"
  const avgd = hours.map(h => ({
    ...h,
    mac:    h.mac    / num_days,
    iphone: h.iphone / num_days,
    ipad:   h.ipad   / num_days,
  }));

  const totals     = avgd.map(h => rowTotal(h));
  const grandTotal = totals.reduce((s, v) => s + v, 0);

  if (grandTotal === 0) {
    showTabState('hr', 'nodata');
    document.getElementById('hr-peak').textContent     = '—';
    document.getElementById('hr-peak-val').textContent = '—';
    document.getElementById('hr-quiet').textContent    = '—';
    return;
  }

  const peakIdx = totals.indexOf(Math.max(...totals));
  const nonZeroEntries = totals.map((v, i) => ({ v, i })).filter(x => x.v > 0);
  const quietEntry = nonZeroEntries.reduce((min, x) => x.v < min.v ? x : min, nonZeroEntries[0]);

  document.getElementById('hr-peak').textContent     = fmtHour(hours[peakIdx].hour);
  document.getElementById('hr-peak-val').textContent = fmtHours(totals[peakIdx]);
  document.getElementById('hr-quiet').textContent    = quietEntry ? fmtHour(hours[quietEntry.i].hour) : '—';

  showTabState('hr', 'data');
  destroyChart('hr');

  const devKeys  = activeDeviceKeys();
  const datasets = devKeys.map(dev => ({
    label:           DEVICE_LABELS[dev],
    data:            avgd.map(h => Math.round((h[dev] || 0) / 60)),
    backgroundColor: DEVICE_COLORS[dev],
  }));

  charts['hr'] = new Chart(document.getElementById('hr-chart'), {
    type: 'bar',
    data: { labels: hours.map(h => fmtHour(h.hour)), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: devKeys.length > 1,
          position: 'top',
          labels: { boxWidth: 10, font: { size: 11 } },
        },
        tooltip: {
          callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmtHours(ctx.raw * 60)} avg` },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { stacked: true, ticks: { callback: v => fmtHours(v * 60) }, grid: { color: '#f0f0f0' } },
      },
    },
  });
}

// ── Rename popover ────────────────────────────────────────────────────────────

function showRenamePopover(item, clientX, clientY) {
  const popover = document.getElementById('rename-popover');
  const input   = document.getElementById('rename-input');

  input.value = item.display_name;

  const W = window.innerWidth, H = window.innerHeight;
  const PW = 260, PH = 110;
  popover.style.left = `${Math.min(clientX, W - PW - 12)}px`;
  popover.style.top  = `${Math.min(clientY, H - PH - 12)}px`;
  popover.style.display = 'block';

  input.focus();
  input.select();

  async function commit() {
    const name = input.value.trim();
    popover.style.display = 'none';
    if (name === item.display_name) return;
    await window.api.updateAppName(item.app, name);
    loadOverview();
  }

  function cancel() {
    popover.style.display = 'none';
  }

  document.getElementById('rename-ok').onclick     = commit;
  document.getElementById('rename-cancel').onclick = cancel;
  input.onkeydown = (e) => {
    if (e.key === 'Enter')  commit();
    if (e.key === 'Escape') cancel();
  };
}

// ── Collect button ────────────────────────────────────────────────────────────

async function triggerCollect() {
  const btn = document.getElementById('collect-btn');
  btn.disabled = true;
  btn.classList.add('spinning');
  try {
    const result = await window.api.triggerCollect();
    if (result && !result.ok && result.error) {
      console.warn('Collect error:', result.error);
    }
  } catch (err) {
    console.error('Collect failed:', err);
  } finally {
    btn.disabled = false;
    btn.classList.remove('spinning');
    await refreshLastRun();
    await refreshDevices();
    loadCurrentTab();
  }
}

async function refreshLastRun() {
  try {
    const { runs } = await window.api.getCollectionLog(1);
    const el = document.getElementById('last-run');
    if (runs && runs.length > 0) {
      el.textContent = `Last run: ${fmtRelTime(runs[0].ran_at)}`;
    } else {
      el.textContent = 'Last run: never';
    }
  } catch { /* ignore */ }
}

// ── Devices ───────────────────────────────────────────────────────────────────

async function refreshDevices() {
  try {
    const { types } = await window.api.getDevices();
    state.hasData.mac    = types.includes('mac');
    state.hasData.iphone = types.includes('iphone');
    state.hasData.ipad   = types.includes('ipad');
  } catch { /* ignore */ }
  if (!state.hasData.mac) state.hasData.mac = true;
}

// ── Settings modal ────────────────────────────────────────────────────────────

async function openSettings() {
  const modal = document.getElementById('settings-modal');
  modal.style.display = 'flex';

  // Populate target input + ticks toggle
  const ti = document.getElementById('target-input');
  ti.value = settings.dailyTargetHours != null ? settings.dailyTargetHours : '';
  document.getElementById('target-clear').style.display = settings.dailyTargetHours ? '' : 'none';
  document.getElementById('ticks-row').style.display = settings.dailyTargetHours ? '' : 'none';
  document.getElementById('ticks-toggle').checked = settings.showTargetTicks;

  // Load collection history
  document.getElementById('logs-loading').style.display = '';
  document.getElementById('logs-nodata').style.display  = 'none';
  document.getElementById('logs-table').style.display   = 'none';

  try {
    const { runs } = await window.api.getCollectionLog(50);
    document.getElementById('logs-loading').style.display = 'none';

    if (!runs || runs.length === 0) {
      document.getElementById('logs-nodata').style.display = '';
      return;
    }

    const tbody = document.getElementById('logs-tbody');
    tbody.innerHTML = '';
    for (const run of runs) {
      const date = new Date(run.ran_at * 1000);
      const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
                      ' ' + date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

      let badge;
      if (run.error) {
        badge = `<span class="badge badge-err">Error</span>`;
      } else if (run.inserted > 0) {
        badge = `<span class="badge badge-new">+${run.inserted}</span>`;
      } else {
        badge = `<span class="badge badge-zero">No new</span>`;
      }

      const errorNote = run.error
        ? `<br><small style="color:#c0392b;font-size:11px">${run.error}</small>`
        : '';

      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td class="ts">${dateStr}<span class="ts-rel">${fmtRelTime(run.ran_at)}</span></td>` +
        `<td>${run.fetched}</td>` +
        `<td>${run.inserted}</td>` +
        `<td>${badge}${errorNote}</td>`;
      tbody.appendChild(tr);
    }
    document.getElementById('logs-table').style.display = '';
  } catch (err) {
    document.getElementById('logs-loading').style.display = 'none';
    document.getElementById('logs-nodata').style.display  = '';
    console.error('Failed to load logs:', err);
  }
}

function closeSettings() {
  document.getElementById('settings-modal').style.display = 'none';
}

function commitTarget() {
  const raw = parseFloat(document.getElementById('target-input').value);
  const prev = settings.dailyTargetHours;
  settings.dailyTargetHours = (Number.isFinite(raw) && raw > 0 && raw <= 24) ? raw : null;
  document.getElementById('target-clear').style.display = settings.dailyTargetHours ? '' : 'none';
  document.getElementById('ticks-row').style.display    = settings.dailyTargetHours ? '' : 'none';
  document.getElementById('target-input').value = settings.dailyTargetHours != null ? settings.dailyTargetHours : '';
  saveSettings();
  if (prev !== settings.dailyTargetHours) loadCurrentTab();
}

// ── FDA ───────────────────────────────────────────────────────────────────────

async function checkFdaAndInit() {
  try {
    const { granted } = await window.api.checkFda();
    if (!granted) {
      document.getElementById('fda-overlay').style.display = 'flex';
      return false;
    }
  } catch { /* if check throws, assume granted and proceed */ }
  document.getElementById('fda-overlay').style.display = 'none';
  return true;
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  loadSettings();

  window.api.onCollectProgress(async () => {
    await refreshLastRun();
    await refreshDevices();
    loadCurrentTab();
  });

  const fdaOk = await checkFdaAndInit();
  if (!fdaOk) return;

  await refreshDevices();
  await refreshLastRun();
  loadCurrentTab();
}

// ── Event wiring ──────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Mode buttons
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.mode   = btn.dataset.mode;
      state.offset = 0;

      if (state.mode === 'day' && state.activeTab === 'daily') {
        switchTab('overview');
      }

      updateModeButtons();
      updatePeriodUI();
      loadCurrentTab();
    });
  });

  // Period navigation
  document.getElementById('nav-prev').addEventListener('click', () => {
    state.offset--;
    updatePeriodUI();
    loadCurrentTab();
  });

  document.getElementById('nav-next').addEventListener('click', () => {
    if (state.offset < 0) {
      state.offset++;
      updatePeriodUI();
      loadCurrentTab();
    }
  });

  document.getElementById('period-label').addEventListener('click', () => {
    if (state.offset !== 0) {
      state.offset = 0;
      updatePeriodUI();
      loadCurrentTab();
    }
  });

  // Tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Collect now
  document.getElementById('collect-btn').addEventListener('click', triggerCollect);

  // Settings modal
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  document.getElementById('settings-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });

  // Target input
  const ti = document.getElementById('target-input');
  ti.addEventListener('change', commitTarget);
  ti.addEventListener('keydown', (e) => { if (e.key === 'Enter') { ti.blur(); commitTarget(); } });
  document.getElementById('target-clear').addEventListener('click', () => {
    document.getElementById('target-input').value = '';
    commitTarget();
  });

  document.getElementById('ticks-toggle').addEventListener('change', (e) => {
    settings.showTargetTicks = e.target.checked;
    saveSettings();
    loadCurrentTab();
  });

  // Data management
  document.getElementById('export-btn').addEventListener('click', async () => {
    const result = await window.api.exportDb();
    if (result.ok) {
      alert(`Database exported successfully to:\n${result.path}`);
    } else if (result.error) {
      alert(`Export failed: ${result.error}`);
    }
  });

  document.getElementById('import-btn').addEventListener('click', async () => {
    const result = await window.api.importDb();
    if (result && !result.ok && result.error) {
      alert(`Import failed: ${result.error}`);
    }
  });

  // FDA overlay buttons
  document.getElementById('open-settings-btn').addEventListener('click', () => {
    window.api.openPrivacySettings();
  });

  document.getElementById('check-again-btn').addEventListener('click', async () => {
    const ok = await checkFdaAndInit();
    if (ok) {
      await refreshDevices();
      await refreshLastRun();
      loadCurrentTab();
    }
  });

  // Set initial UI state
  updateModeButtons();
  updatePeriodUI();

  init();
});
