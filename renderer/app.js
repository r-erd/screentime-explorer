'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  mode:          'week',  // day | week | month | year
  offset:        0,       // 0 = current period, -1 = previous, etc.
  activeTab:     'overview',
  devices:       [],      // [{device_id, device_type, display_name}], set by refreshDevices()
  hiddenDevices: new Set(), // device_ids currently hidden by the user
};

const settings = {
  dailyTargetHours:       null,
  showTargetTicks:        true,
  appearance:             'system',  // 'system' | 'light' | 'dark'
  notificationsEnabled:   false,
  deduplicateDeviceTime:  false,
  chartStyle:             'bar',     // 'bar' | 'line'  — Daily & Hourly
  chartStyleOverview:     'bar',     // 'bar' | 'doughnut' | 'treemap'
  chartStyleDrilldown:    'bar',     // 'bar' | 'line'  — App drilldown
  appMerges:              [],        // [{primary, primaryName, secondary, secondaryName}]
};

// Categorical palette for donut/treemap — Apple system colours, all dark enough for white text
const OV_PALETTE = [
  '#007AFF', '#FF9500', '#FF2D55', '#AF52DE', '#00C7BE',
  '#34C759', '#5856D6', '#FF6B35', '#FFCC00', '#32ADE6',
  '#30D158', '#FF3B30', '#BF5AF2', '#FF9F0A', '#0A84FF',
];

const charts = {};

// Raw apps from the last overview fetch — used by the merge picker in drilldown.
let cachedAllApps = [];

// Drilldown state — stored so chart type toggle can re-render without re-fetching.
let ddChartRows   = [];
let ddLabelFn     = null;

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

// ── Theme ─────────────────────────────────────────────────────────────────────

function getEffectiveTheme() {
  if (settings.appearance === 'dark')  return 'dark';
  if (settings.appearance === 'light') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(reloadCharts = false) {
  const theme = getEffectiveTheme();
  document.documentElement.setAttribute('data-theme', theme);
  Chart.defaults.color = theme === 'dark' ? '#8e8e93' : '#888888';
  if (reloadCharts) loadCurrentTab();
}

// ── Device colors (theme-aware) ───────────────────────────────────────────────

// Returns a color for the Nth device of a given type (0-indexed within that type).
function getDeviceColor(deviceType, typeIndex) {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (deviceType === 'mac') return dark ? '#e5e5e5' : '#1d1d1f';
  const palettes = {
    iphone: ['#007AFF', '#5AC8FA', '#32ADE6', '#0A84FF'],
    ipad:   ['#34C759', '#30D158', '#32D74B', '#4CD964'],
  };
  const p = palettes[deviceType] ?? palettes.iphone;
  return p[typeIndex % p.length];
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Chart grid helper ─────────────────────────────────────────────────────────

function getChartGrid() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  return dark ? '#3a3a3c' : '#f0f0f0';
}

// ── Utilities ─────────────────────────────────────────────────────────────────

// Pick a y-axis step size (in minutes) from allowed values so the result
// is always a round interval — never 20 min or 1h 20min.
function niceStepMin(maxValueMin) {
  for (const s of [30, 60, 120, 240]) {
    if (maxValueMin / s <= 6) return s;
  }
  return 240;
}

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

function fmtMonth(yearMonth) {
  // yearMonth = 'YYYY-MM'
  const [y, m] = yearMonth.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short' });
}

// Like fmtDate but includes the year when the date is not in the current year.
function fmtDateWithYear(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const opts = { month: 'short', day: 'numeric' };
  if (y !== new Date().getFullYear()) opts.year = 'numeric';
  return new Date(y, m - 1, d).toLocaleDateString('en-US', opts);
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

// Returns devices that are currently visible (not hidden by the filter pills).
function visibleDevices() {
  return state.devices.filter(d => !state.hiddenDevices.has(d.device_id));
}

// Build typed datasets array from state.devices for Chart.js, skipping hidden devices.
function deviceDatasets(dataFn) {
  return state.devices.map((dev, i) => {
    const typeIdx = state.devices.slice(0, i).filter(d => d.device_type === dev.device_type).length;
    return {
      label:           dev.display_name,
      data:            dataFn(dev),
      backgroundColor: getDeviceColor(dev.device_type, typeIdx),
      hidden:          state.hiddenDevices.has(dev.device_id),
    };
  });
}

function rowTotal(row) {
  return Object.entries(row.by_device || {})
    .filter(([id]) => !state.hiddenDevices.has(id))
    .reduce((s, [, v]) => s + v, 0);
}

// Render per-device totals (as colored items) into a .stat-device-breakdown element.
// byDeviceTotals: { device_id -> seconds }
// Only shown when dedup is off and there are 2+ devices with data.
function renderDeviceBreakdown(elId, byDeviceTotals) {
  const el = document.getElementById(elId);
  if (!el) return;
  const dedup = settings.deduplicateDeviceTime;
  const devicesWithData = state.devices.filter(d => (byDeviceTotals[d.device_id] || 0) > 0);

  if (dedup || devicesWithData.length < 2) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }

  const parts = [];
  state.devices.forEach((dev, i) => {
    const secs = byDeviceTotals[dev.device_id] || 0;
    if (secs === 0) return;
    const typeIdx = state.devices.slice(0, i).filter(d => d.device_type === dev.device_type).length;
    const color   = getDeviceColor(dev.device_type, typeIdx);
    parts.push(
      `<span class="stat-device-item" style="color:${color}">${escHtml(dev.display_name)}: ${fmtHours(secs)}</span>`
    );
  });

  el.innerHTML = parts.join('');
  el.style.display = '';
}

// Reflect settings.chartStyle into the Daily / Hourly / Monthly toggle groups.
function syncChartTypeToggles() {
  ['dy-chart-type', 'hr-chart-type', 'mo-chart-type'].forEach(id => {
    document.getElementById(id)?.querySelectorAll('.chart-type-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.type === settings.chartStyle);
    });
  });
}

// Reflect settings.chartStyleOverview into the Overview toggle.
function syncOverviewToggle() {
  document.getElementById('ov-chart-type')?.querySelectorAll('.chart-type-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === settings.chartStyleOverview);
  });
}

// ── App merges ────────────────────────────────────────────────────────────────

// Apply just-in-time app merges to a raw apps array.
// Returns a new array where secondaries are absorbed into their primary;
// the primary gains `mergedFrom: [secondary_app_id, ...]` for multi-fetch in drilldown.
function applyMerges(apps) {
  if (!settings.appMerges || settings.appMerges.length === 0) return apps;
  const result    = apps.map(a => ({ ...a, by_device: { ...a.by_device } }));
  const toRemove  = new Set();
  for (const merge of settings.appMerges) {
    const pIdx = result.findIndex(a => a.app === merge.primary);
    const sIdx = result.findIndex(a => a.app === merge.secondary);
    if (pIdx === -1 || sIdx === -1) continue;
    const p = result[pIdx];
    const s = result[sIdx];
    for (const [devId, secs] of Object.entries(s.by_device || {})) {
      p.by_device[devId] = (p.by_device[devId] || 0) + secs;
    }
    if (!p.mergedFrom) p.mergedFrom = [];
    if (!p.mergedFrom.includes(merge.secondary)) p.mergedFrom.push(merge.secondary);
    toRemove.add(sIdx);
  }
  return result.filter((_, i) => !toRemove.has(i));
}

// Build a Chart.js line-chart dataset. fillArea=true adds a translucent area fill.
function lineDs(label, data, color, fillArea) {
  return {
    label,
    data,
    borderColor:     color,
    backgroundColor: fillArea ? hexToRgba(color, 0.12) : 'transparent',
    fill:            fillArea ? 'origin' : false,
    tension:         0.4,
    borderWidth:     2,
    pointRadius:     3,
    pointHoverRadius: 5,
    pointBackgroundColor: color,
  };
}

// ── Device filter pills ───────────────────────────────────────────────────────

function renderDevicePills() {
  const bar = document.getElementById('device-filters');
  if (!bar) return;

  // Hide when there is only one device, or when dedup is on (per-device view not meaningful then)
  if (state.devices.length < 2 || settings.deduplicateDeviceTime) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = '';
  bar.innerHTML = '';

  state.devices.forEach((dev, i) => {
    const typeIdx = state.devices.slice(0, i).filter(d => d.device_type === dev.device_type).length;
    const color   = getDeviceColor(dev.device_type, typeIdx);
    const hidden  = state.hiddenDevices.has(dev.device_id);

    const pill = document.createElement('button');
    pill.className = 'device-pill' + (hidden ? ' device-pill-off' : '');
    pill.title     = hidden ? `Show ${dev.display_name}` : `Hide ${dev.display_name}`;
    pill.innerHTML =
      `<span class="device-pill-dot" style="background:${color}"></span>` +
      `<span class="device-pill-label">${escHtml(dev.display_name)}</span>`;

    pill.addEventListener('click', () => {
      if (state.hiddenDevices.has(dev.device_id)) {
        state.hiddenDevices.delete(dev.device_id);
      } else {
        // Don't allow hiding all devices
        const wouldRemain = state.devices.filter(d => !state.hiddenDevices.has(d.device_id) && d.device_id !== dev.device_id);
        if (wouldRemain.length === 0) return;
        state.hiddenDevices.add(dev.device_id);
      }
      renderDevicePills();
      loadCurrentTab();
    });

    bar.appendChild(pill);
  });
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

  // Hide "Daily" tab in Day mode; show "Monthly" tab only in Year mode
  const dailyTabBtn   = document.querySelector('.tab-btn[data-tab="daily"]');
  const monthlyTabBtn = document.querySelector('.tab-btn[data-tab="monthly"]');
  if (dailyTabBtn)   dailyTabBtn.style.display   = (state.mode === 'day')  ? 'none' : '';
  if (monthlyTabBtn) monthlyTabBtn.style.display  = (state.mode === 'year') ? ''     : 'none';
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
  else if (state.activeTab === 'monthly')  loadMonthly();
  else if (state.activeTab === 'hourly')   loadHourly();
}

function showTabState(prefix, tabState) {
  document.getElementById(`${prefix}-loading`).style.display = tabState === 'loading' ? '' : 'none';
  document.getElementById(`${prefix}-nodata`).style.display  = tabState === 'nodata'  ? '' : 'none';
  document.getElementById(`${prefix}-wrap`).style.display    = tabState === 'data'    ? '' : 'none';
}

// ── Overview ──────────────────────────────────────────────────────────────────

let drilldownClickTimer = null;

async function loadOverview() {
  showTabState('ov', 'loading');
  const [from, to] = getApiRange();

  // Fetch app breakdown + daily totals in parallel (daily needed for KPIs)
  const [{ apps, dedup_total: periodDedupSec }, { days }] = await Promise.all([
    window.api.getScreentime(from, to),
    window.api.getDaily(from, to),
  ]);

  // Cache raw apps for the drilldown merge picker, then apply just-in-time merges.
  cachedAllApps = apps;
  const mergedApps = applyMerges(apps);
  const filtered = mergedApps.filter(a => rowTotal(a) > 0).slice(0, 15);

  if (filtered.length === 0) {
    showTabState('ov', 'nodata');
    document.getElementById('ov-total').textContent  = '—';
    document.getElementById('ov-apps').textContent   = '—';
    document.getElementById('ov-avg').textContent    = '—';
    document.getElementById('ov-kpi').style.display  = 'none';
    const ovBd = document.getElementById('ov-total-devices');
    if (ovBd) { ovBd.innerHTML = ''; ovBd.style.display = 'none'; }
    return;
  }

  // KPIs (uses daily totals; when dedup is on, use per-day dedup_total)
  const kpiTotals = settings.deduplicateDeviceTime
    ? days.map(d => d.dedup_total)
    : days.map(d => rowTotal(d));
  try { renderKpis(days, kpiTotals, 'ov'); } catch (e) { console.error('KPI render error:', e); }

  const numDays = Math.max(1, Math.round((to - from) / 86400));
  const total   = settings.deduplicateDeviceTime
    ? periodDedupSec
    : filtered.reduce((s, a) => s + rowTotal(a), 0);
  document.getElementById('ov-total').textContent = fmtHours(total);
  document.getElementById('ov-apps').textContent  = String(filtered.length);
  document.getElementById('ov-avg').textContent   = fmtHours(total / numDays);

  // Per-device breakdown under "Total Screen Time"
  const ovDevTotals = {};
  for (const app of filtered) {
    for (const [devId, secs] of Object.entries(app.by_device || {})) {
      ovDevTotals[devId] = (ovDevTotals[devId] || 0) + secs;
    }
  }
  renderDeviceBreakdown('ov-total-devices', ovDevTotals);

  showTabState('ov', 'data');
  destroyChart('ov');

  const dedup   = settings.deduplicateDeviceTime;
  const dark    = document.documentElement.getAttribute('data-theme') === 'dark';
  const ovStyle = settings.chartStyleOverview;   // 'bar' | 'doughnut' | 'treemap'
  const canvas  = document.getElementById('ov-chart');
  canvas.ondblclick = null;

  // ── Bar chart ─────────────────────────────────────────────────────────────────
  if (ovStyle === 'bar') {
    const ovDatasets = dedup
      ? [{ label: 'Screen time', data: filtered.map(a => Math.round(Object.values(a.by_device).reduce((s, v) => s + v, 0) / 60)), backgroundColor: dark ? '#e5e5e5' : '#1d1d1f' }]
      : deviceDatasets(dev => filtered.map(a => Math.round((a.by_device[dev.device_id] || 0) / 60)));

    canvas.style.height = `${Math.max(280, filtered.length * 28)}px`;
    canvas.title = 'Click any row to see history; double-click to rename';

    charts['ov'] = new Chart(canvas, {
      type: 'bar',
      data: { labels: filtered.map(a => a.display_name), datasets: ovDatasets },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: !dedup && state.devices.length > 1, position: 'top', labels: { boxWidth: 10, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              title: items => { const a = filtered[items[0].dataIndex]; return a.display_name === a.app ? a.app : `${a.display_name} (${a.app})`; },
              label: ctx => ` ${ctx.dataset.label}: ${fmtHours(ctx.raw * 60)}`,
            },
          },
        },
        scales: {
          x: { stacked: !dedup, ticks: { callback: v => fmtHours(v * 60) }, grid: { color: getChartGrid() } },
          y: { stacked: !dedup, ticks: { font: { size: 12 } } },
        },
      },
    });

    charts['ov'].options.onClick = (event, elements) => {
      if (!elements.length) return;
      clearTimeout(drilldownClickTimer);
      const idx = elements[0].index;
      drilldownClickTimer = setTimeout(() => showAppDrilldown(filtered[idx], from, to), 220);
    };

    canvas.ondblclick = (e) => {
      clearTimeout(drilldownClickTimer);
      const chart = charts['ov'];
      if (!chart) return;
      const index = Math.round(chart.scales.y.getValueForPixel(e.offsetY));
      if (index < 0 || index >= filtered.length) return;
      showRenamePopover(filtered[index], e.clientX, e.clientY);
    };

  // ── Donut chart ───────────────────────────────────────────────────────────────
  } else if (ovStyle === 'doughnut') {
    canvas.style.height = '360px';
    canvas.title = 'Click any slice to see history';

    charts['ov'] = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: filtered.map(a => a.display_name),
        datasets: [{
          data: filtered.map(a => Math.round(rowTotal(a) / 60)),
          backgroundColor: filtered.map((_, i) => OV_PALETTE[i % OV_PALETTE.length]),
          borderWidth: 2,
          borderColor: dark ? '#2c2c2e' : '#ffffff',
          hoverOffset: 8,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: {
            position: 'right',
            labels: { boxWidth: 10, font: { size: 11 }, padding: 10 },
          },
          tooltip: {
            callbacks: {
              title: items => { const a = filtered[items[0].dataIndex]; return a.display_name === a.app ? a.app : `${a.display_name} (${a.app})`; },
              label: ctx => ` ${fmtHours(ctx.raw * 60)} — ${Math.round(ctx.raw / filtered.reduce((s, a) => s + rowTotal(a) / 60, 0) * 100)}%`,
            },
          },
        },
      },
    });

    charts['ov'].options.onClick = (event, elements) => {
      if (!elements.length) return;
      clearTimeout(drilldownClickTimer);
      const idx = elements[0].index;
      drilldownClickTimer = setTimeout(() => showAppDrilldown(filtered[idx], from, to), 220);
    };

  // ── Treemap ───────────────────────────────────────────────────────────────────
  } else if (ovStyle === 'treemap') {
    canvas.style.height = '380px';
    canvas.title = 'Click any cell to see history';

    const treeData = filtered.map((a, i) => ({
      v:     Math.round(rowTotal(a) / 60),
      label: a.display_name,
      app:   a.app,
      idx:   i,
    }));

    charts['ov'] = new Chart(canvas, {
      type: 'treemap',
      data: {
        datasets: [{
          tree:  treeData,
          key:   'v',
          backgroundColor: ctx => {
            if (!ctx.raw?._data) return OV_PALETTE[0];
            return OV_PALETTE[ctx.raw._data.idx % OV_PALETTE.length];
          },
          borderWidth: 2,
          borderColor: dark ? '#1c1c1e' : '#f5f5f7',
          spacing: 1,
          labels: {
            display: true,
            overflow: 'cut',
            padding: 5,
            color: '#ffffff',
            font: [{ size: 12, weight: '600' }, { size: 11, weight: '400' }],
            formatter: ctx => {
              if (!ctx.raw?._data) return '';
              return [ctx.raw._data.label, fmtHours(ctx.raw.v * 60)];
            },
          },
          captions: { display: false },
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: items => { const d = items[0].raw._data; return d.display_name === d.app ? d.app : `${d.label}${d.label !== d.app ? ` (${d.app})` : ''}`; },
              label: ctx => ` ${fmtHours(ctx.raw.v * 60)}`,
            },
          },
        },
      },
    });

    charts['ov'].options.onClick = (event, elements) => {
      if (!elements.length) return;
      clearTimeout(drilldownClickTimer);
      const d = elements[0].element.$context.raw._data;
      if (d?.idx == null) return;
      drilldownClickTimer = setTimeout(() => showAppDrilldown(filtered[d.idx], from, to), 220);
    };
  }
}

// ── Daily ─────────────────────────────────────────────────────────────────────

async function loadDaily() {
  showTabState('dy', 'loading');
  const [from, to] = getApiRange();
  const { days } = await window.api.getDaily(from, to);

  const dedup = settings.deduplicateDeviceTime;
  const totals = dedup
    ? days.map(d => d.dedup_total)
    : days.map(d => rowTotal(d));
  const grandTotal = totals.reduce((s, v) => s + v, 0);

  if (grandTotal === 0) {
    showTabState('dy', 'nodata');
    document.getElementById('dy-total').textContent = '—';
    document.getElementById('dy-avg').textContent   = '—';
    document.getElementById('dy-peak').textContent  = '—';
    document.getElementById('dy-kpi').style.display  = 'none';
    const dyBd = document.getElementById('dy-total-devices');
    if (dyBd) { dyBd.innerHTML = ''; dyBd.style.display = 'none'; }
    return;
  }

  const nonZero = totals.filter(v => v > 0);
  const avg     = grandTotal / Math.max(1, nonZero.length);
  const peakIdx = totals.indexOf(Math.max(...totals));

  document.getElementById('dy-total').textContent = fmtHours(grandTotal);
  document.getElementById('dy-avg').textContent   = fmtHours(avg);
  document.getElementById('dy-peak').textContent  = fmtDateWithYear(days[peakIdx].date);

  // Per-device breakdown under "Total Screen Time"
  const dyDevTotals = {};
  for (const day of days) {
    for (const [devId, secs] of Object.entries(day.by_device || {})) {
      dyDevTotals[devId] = (dyDevTotals[devId] || 0) + secs;
    }
  }
  renderDeviceBreakdown('dy-total-devices', dyDevTotals);

  showTabState('dy', 'data');
  destroyChart('dy');

  try { renderKpis(days, totals, 'dy'); } catch (e) { console.error('KPI render error:', e); }

  const targetSec = settings.dailyTargetHours ? settings.dailyTargetHours * 3600 : null;
  const targetMin = settings.dailyTargetHours ? settings.dailyTargetHours * 60   : null;

  const dark    = document.documentElement.getAttribute('data-theme') === 'dark';
  const isLine  = settings.chartStyle === 'line';
  const singleColor = dark ? '#e5e5e5' : '#1d1d1f';

  let datasets;
  if (isLine) {
    if (dedup) {
      datasets = [lineDs('Deduplicated', days.map(d => Math.round(d.dedup_total / 60)), singleColor, true)];
    } else {
      const visDevs = visibleDevices();
      datasets = state.devices.map((dev, i) => {
        const typeIdx = state.devices.slice(0, i).filter(d => d.device_type === dev.device_type).length;
        const color   = getDeviceColor(dev.device_type, typeIdx);
        const data    = days.map(d => Math.round((d.by_device[dev.device_id] || 0) / 60));
        // Fill area only when there's a single visible device — looks clean; skip for multi-line
        return { ...lineDs(dev.display_name, data, color, visDevs.length === 1), hidden: state.hiddenDevices.has(dev.device_id) };
      });
    }
  } else {
    // Bar chart (original behaviour)
    datasets = dedup
      ? [{ label: 'Deduplicated', data: days.map(d => Math.round(d.dedup_total / 60)), backgroundColor: singleColor }]
      : deviceDatasets(dev => days.map(d => Math.round((d.by_device[dev.device_id] || 0) / 60)));
  }

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
          // Dashed line
          ctx.strokeStyle = '#FF3B30';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(chartArea.left, yPx);
          ctx.lineTo(chartArea.right, yPx);
          ctx.stroke();
          ctx.setLineDash([]);

          // Pill label
          const labelText = `Goal: ${fmtHours(targetSec)}`;
          ctx.font = '600 10px -apple-system, BlinkMacSystemFont, sans-serif';
          const tw   = ctx.measureText(labelText).width;
          const px   = 6, py = 3;
          const ph   = 10 + py * 2;          // pill height
          const pw   = tw + px * 2;           // pill width
          const pr   = ph / 2;                // border-radius → full pill
          const pilX = chartArea.right - pw - 4;
          const pilY = yPx - ph - 3;          // 3px gap above the line

          // Background: semi-transparent white (light) / dark-red (dark)
          const dark = document.documentElement.getAttribute('data-theme') === 'dark';
          ctx.fillStyle = dark ? 'rgba(255,59,48,0.22)' : 'rgba(255,255,255,0.88)';
          ctx.beginPath();
          ctx.moveTo(pilX + pr, pilY);
          ctx.lineTo(pilX + pw - pr, pilY);
          ctx.arcTo(pilX + pw, pilY,      pilX + pw, pilY + ph,      pr);
          ctx.lineTo(pilX + pw, pilY + ph - pr);
          ctx.arcTo(pilX + pw, pilY + ph, pilX + pw - pr, pilY + ph, pr);
          ctx.lineTo(pilX + pr, pilY + ph);
          ctx.arcTo(pilX,      pilY + ph, pilX, pilY + ph - pr,      pr);
          ctx.lineTo(pilX,     pilY + pr);
          ctx.arcTo(pilX,      pilY,      pilX + pr, pilY,            pr);
          ctx.closePath();
          ctx.fill();

          // Subtle border
          ctx.strokeStyle = 'rgba(255,59,48,0.45)';
          ctx.lineWidth = 0.75;
          ctx.stroke();

          // Text
          ctx.fillStyle = '#FF3B30';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText(labelText, chartArea.right - 4 - px, pilY + ph / 2);
          ctx.textBaseline = 'alphabetic';
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

  const stackBars = !dedup && !isLine;
  charts['dy'] = new Chart(document.getElementById('dy-chart'), {
    type: isLine ? 'line' : 'bar',
    data: { labels: days.map(d => fmtDate(d.date)), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: !dedup && state.devices.length > 1,
          position: 'top',
          labels: { boxWidth: 10, font: { size: 11 }, ...(isLine ? { usePointStyle: true, pointStyle: 'line' } : {}) },
        },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${fmtHours(ctx.raw * 60)}`,
            footer: (!isLine && !dedup) ? items => {
              if (items.length < 2) return [];
              const total = items.reduce((s, i) => s + i.raw, 0);
              return [`Total: ${fmtHours(total * 60)}`];
            } : undefined,
          },
        },
      },
      scales: {
        x: { stacked: stackBars, grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { stacked: stackBars, suggestedMax: targetMin ?? undefined, ticks: { stepSize: niceStepMin(Math.max(targetMin ?? 0, Math.max(...totals.map(t => t / 60)))), callback: v => fmtHours(v * 60) }, grid: { color: getChartGrid() } },
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

  const dedup = settings.deduplicateDeviceTime;

  // Average per-day so the unit is "avg hours per day"
  const avgd = hours.map(h => ({
    ...h,
    by_device: Object.fromEntries(
      Object.entries(h.by_device || {}).map(([id, v]) => [id, v / num_days])
    ),
    // dedup_secs already averaged per day by the backend
  }));

  const totals = dedup
    ? hours.map(h => h.dedup_secs)   // already averaged per day
    : avgd.map(h => rowTotal(h));
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

  const dark    = document.documentElement.getAttribute('data-theme') === 'dark';
  const isLine  = settings.chartStyle === 'line';
  const hrSingleColor = dark ? '#e5e5e5' : '#1d1d1f';

  let hrDatasets;
  if (isLine) {
    if (dedup) {
      hrDatasets = [lineDs('Deduplicated', hours.map(h => Math.round(h.dedup_secs / 60)), hrSingleColor, true)];
    } else {
      const visDevs = visibleDevices();
      hrDatasets = state.devices.map((dev, i) => {
        const typeIdx = state.devices.slice(0, i).filter(d => d.device_type === dev.device_type).length;
        const color   = getDeviceColor(dev.device_type, typeIdx);
        const data    = avgd.map(h => Math.round((h.by_device[dev.device_id] || 0) / 60));
        return { ...lineDs(dev.display_name, data, color, visDevs.length === 1), hidden: state.hiddenDevices.has(dev.device_id) };
      });
    }
  } else {
    hrDatasets = dedup
      ? [{ label: 'Deduplicated', data: hours.map(h => Math.round(h.dedup_secs / 60)), backgroundColor: hrSingleColor }]
      : deviceDatasets(dev => avgd.map(h => Math.round((h.by_device[dev.device_id] || 0) / 60)));
  }

  const stackBars = !dedup && !isLine;
  charts['hr'] = new Chart(document.getElementById('hr-chart'), {
    type: isLine ? 'line' : 'bar',
    data: { labels: hours.map(h => fmtHour(h.hour)), datasets: hrDatasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: !dedup && state.devices.length > 1,
          position: 'top',
          labels: { boxWidth: 10, font: { size: 11 }, ...(isLine ? { usePointStyle: true, pointStyle: 'line' } : {}) },
        },
        tooltip: {
          callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmtHours(ctx.raw * 60)} avg` },
        },
      },
      scales: {
        x: { stacked: stackBars, grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { stacked: stackBars, ticks: { stepSize: niceStepMin(Math.max(...totals.map(t => t / 60))), callback: v => fmtHours(v * 60) }, grid: { color: getChartGrid() } },
      },
    },
  });
}

// ── Monthly (Year mode only) ──────────────────────────────────────────────────

async function loadMonthly() {
  showTabState('mo', 'loading');
  const [from, to] = getApiRange();
  const { days } = await window.api.getDaily(from, to);

  // Aggregate daily rows into month buckets
  const monthMap = new Map(); // 'YYYY-MM' -> bucket
  for (const day of days) {
    const key = day.date.slice(0, 7);
    if (!monthMap.has(key)) monthMap.set(key, { key, by_device: {}, dedup_total: 0 });
    const b = monthMap.get(key);
    b.dedup_total += day.dedup_total || 0;
    for (const [id, secs] of Object.entries(day.by_device || {})) {
      b.by_device[id] = (b.by_device[id] || 0) + secs;
    }
  }
  const months = [...monthMap.values()];

  const dedup  = settings.deduplicateDeviceTime;
  const totals = months.map(m => dedup ? m.dedup_total : rowTotal(m));
  const grandTotal = totals.reduce((s, v) => s + v, 0);

  if (grandTotal === 0) {
    showTabState('mo', 'nodata');
    document.getElementById('mo-total').textContent = '—';
    document.getElementById('mo-avg').textContent   = '—';
    document.getElementById('mo-peak').textContent  = '—';
    return;
  }

  const nonZero  = totals.filter(v => v > 0);
  const avg      = grandTotal / Math.max(1, nonZero.length);
  const peakIdx  = totals.indexOf(Math.max(...totals));
  const peakKey  = months[peakIdx].key; // 'YYYY-MM'
  const peakYear = Number(peakKey.split('-')[0]);
  const peakLabel = fmtMonth(peakKey) + (peakYear !== new Date().getFullYear() ? ` ${peakYear}` : '');

  document.getElementById('mo-total').textContent = fmtHours(grandTotal);
  document.getElementById('mo-avg').textContent   = fmtHours(avg);
  document.getElementById('mo-peak').textContent  = peakLabel;

  showTabState('mo', 'data');
  destroyChart('mo');

  const dark   = document.documentElement.getAttribute('data-theme') === 'dark';
  const isLine = settings.chartStyle === 'line';
  const singleColor = dark ? '#e5e5e5' : '#1d1d1f';

  let datasets;
  if (isLine) {
    if (dedup) {
      datasets = [lineDs('Deduplicated', months.map(m => Math.round(m.dedup_total / 60)), singleColor, true)];
    } else {
      const visDevs = visibleDevices();
      datasets = state.devices.map((dev, i) => {
        const typeIdx = state.devices.slice(0, i).filter(d => d.device_type === dev.device_type).length;
        const color   = getDeviceColor(dev.device_type, typeIdx);
        const data    = months.map(m => Math.round((m.by_device[dev.device_id] || 0) / 60));
        return { ...lineDs(dev.display_name, data, color, visDevs.length === 1), hidden: state.hiddenDevices.has(dev.device_id) };
      });
    }
  } else {
    datasets = dedup
      ? [{ label: 'Deduplicated', data: months.map(m => Math.round(m.dedup_total / 60)), backgroundColor: singleColor }]
      : deviceDatasets(dev => months.map(m => Math.round((m.by_device[dev.device_id] || 0) / 60)));
  }

  const stackBars = !dedup && !isLine;
  charts['mo'] = new Chart(document.getElementById('mo-chart'), {
    type: isLine ? 'line' : 'bar',
    data: { labels: months.map(m => fmtMonth(m.key)), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: !dedup && state.devices.length > 1,
          position: 'top',
          labels: { boxWidth: 10, font: { size: 11 }, ...(isLine ? { usePointStyle: true, pointStyle: 'line' } : {}) },
        },
        tooltip: {
          callbacks: {
            title: items => {
              const m = months[items[0].dataIndex];
              const [y] = m.key.split('-');
              return `${fmtMonth(m.key)} ${y}`;
            },
            label: ctx => ` ${ctx.dataset.label}: ${fmtHours(ctx.raw * 60)}`,
            footer: (!isLine && !dedup) ? items => {
              if (items.length < 2) return [];
              return [`Total: ${fmtHours(items.reduce((s, i) => s + i.raw, 0) * 60)}`];
            } : undefined,
          },
        },
      },
      scales: {
        x: { stacked: stackBars, grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { stacked: stackBars, ticks: { stepSize: niceStepMin(Math.max(...totals.map(t => t / 60))), callback: v => fmtHours(v * 60) }, grid: { color: getChartGrid() } },
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

// ── Device rename popover ─────────────────────────────────────────────────────

function showRenameDevicePopover(deviceId, currentName, clientX, clientY) {
  const popover = document.getElementById('rename-popover');
  const input   = document.getElementById('rename-input');
  const title   = popover.querySelector('.rename-popover-title');

  if (title) title.textContent = 'Rename device';
  input.value = currentName;

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
    if (title) title.textContent = 'Rename app';
    if (name === currentName) return;
    await window.api.updateDeviceName(deviceId, name);
    await refreshDevices();
    renderDeviceSettingsList();
    loadCurrentTab();
  }

  function cancel() {
    popover.style.display = 'none';
    if (title) title.textContent = 'Rename app';
  }

  document.getElementById('rename-ok').onclick     = commit;
  document.getElementById('rename-cancel').onclick = cancel;
  input.onkeydown = (e) => {
    if (e.key === 'Enter')  commit();
    if (e.key === 'Escape') cancel();
  };
}

// ── Device settings list ──────────────────────────────────────────────────────

async function renderDeviceSettingsList() {
  const container = document.getElementById('devices-list');
  if (!container) return;
  container.innerHTML = '<div class="loading" style="padding:10px 0">Loading…</div>';
  try {
    const { devices } = await window.api.getDevices();
    if (!devices || devices.length === 0) {
      container.innerHTML = '<div style="color:var(--text4);font-size:13px;padding:4px 0">No devices found. Run a collection first.</div>';
      return;
    }
    const typeCount = {};
    container.innerHTML = '';
    for (const dev of devices) {
      const tc = typeCount[dev.device_type] || 0;
      typeCount[dev.device_type] = tc + 1;
      const color    = getDeviceColor(dev.device_type, tc);
      const subtitle = dev.device_type === 'mac' ? 'Mac' : dev.device_type === 'iphone' ? 'iPhone' : 'iPad';
      const row = document.createElement('div');
      row.className = 'settings-row';
      row.style.marginTop = '10px';
      row.innerHTML =
        `<div class="settings-row-main" style="display:flex;align-items:center;gap:8px">` +
          `<span style="width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0;display:inline-block"></span>` +
          `<div>` +
            `<div class="settings-label">${escHtml(dev.display_name)}</div>` +
            `<div class="settings-sub">${escHtml(subtitle)}</div>` +
          `</div>` +
        `</div>` +
        `<div class="settings-row-control">` +
          `<button class="target-clear-btn" style="white-space:nowrap">Rename…</button>` +
        `</div>`;
      const btn = row.querySelector('button');
      const devSnapshot = { ...dev };
      btn.addEventListener('click', (e) => {
        showRenameDevicePopover(devSnapshot.device_id, devSnapshot.display_name, e.clientX, e.clientY);
      });
      container.appendChild(row);
    }
  } catch {
    container.innerHTML = '<div style="color:var(--text4);font-size:13px;padding:4px 0">Failed to load devices.</div>';
  }
}

// ── Merge settings list ───────────────────────────────────────────────────────

function renderMergeSettingsList() {
  const container = document.getElementById('merges-list');
  const emptyEl   = document.getElementById('merges-empty');
  if (!container || !emptyEl) return;

  const merges = settings.appMerges || [];
  if (merges.length === 0) {
    container.innerHTML = '';
    emptyEl.style.display = '';
    return;
  }
  emptyEl.style.display = 'none';
  container.innerHTML = '';

  for (const merge of merges) {
    const row = document.createElement('div');
    row.className = 'merge-list-row';
    row.innerHTML =
      `<div class="merge-list-names">` +
        `<strong>${escHtml(merge.primaryName || merge.primary)}</strong>` +
        `<span class="mlr-arrow"> ← </span>` +
        `${escHtml(merge.secondaryName || merge.secondary)}` +
      `</div>` +
      `<button class="target-clear-btn">Remove</button>`;
    const btn      = row.querySelector('button');
    const snapshot = { ...merge };
    btn.addEventListener('click', () => {
      settings.appMerges = (settings.appMerges || []).filter(m =>
        !(m.primary === snapshot.primary && m.secondary === snapshot.secondary)
      );
      saveSettings();
      renderMergeSettingsList();
      loadCurrentTab();
    });
    container.appendChild(row);
  }
}

// Populate the drilldown merge picker list based on a search query.
function renderMergePickerList(currentApp, query) {
  const listEl = document.getElementById('dd-merge-list');
  if (!listEl) return;

  const q = query.toLowerCase().trim();
  // IDs already secondary to this primary
  const existingSecondaries = new Set(
    (settings.appMerges || [])
      .filter(m => m.primary === currentApp.app)
      .map(m => m.secondary)
  );

  const candidates = cachedAllApps.filter(a => {
    if (a.app === currentApp.app) return false;
    if (existingSecondaries.has(a.app)) return false;
    if (!q) return true;
    return a.display_name.toLowerCase().includes(q) || a.app.toLowerCase().includes(q);
  });

  listEl.innerHTML = '';
  if (candidates.length === 0) {
    listEl.innerHTML =
      '<div class="merge-picker-item" style="color:var(--text4);cursor:default">No apps found</div>';
    return;
  }

  for (const candidate of candidates.slice(0, 20)) {
    const item = document.createElement('div');
    item.className = 'merge-picker-item';
    const sub = candidate.display_name !== candidate.app ? candidate.app : '';
    item.innerHTML =
      `<div>${escHtml(candidate.display_name)}</div>` +
      (sub ? `<div class="mpi-sub">${escHtml(sub)}</div>` : '');

    item.addEventListener('click', () => {
      const pickerInner = document.querySelector('#dd-merge-picker .merge-picker');
      const confirmEl   = document.getElementById('dd-merge-confirm');
      const confirmText = document.getElementById('dd-merge-confirm-text');

      if (pickerInner) pickerInner.style.display = 'none';
      confirmText.innerHTML =
        `Merge <strong>${escHtml(candidate.display_name)}</strong> ` +
        `into <strong>${escHtml(currentApp.display_name)}</strong>?`;
      if (confirmEl) confirmEl.style.display = '';

      document.getElementById('dd-merge-yes').onclick = () => {
        if (!settings.appMerges) settings.appMerges = [];
        settings.appMerges.push({
          primary:       currentApp.app,
          primaryName:   currentApp.display_name,
          secondary:     candidate.app,
          secondaryName: candidate.display_name,
        });
        saveSettings();
        // Reset picker state for next open
        document.getElementById('dd-merge-picker').style.display = 'none';
        if (confirmEl) confirmEl.style.display = 'none';
        if (pickerInner) pickerInner.style.display = '';
        closeDrilldown();
        loadCurrentTab();
      };
    });
    listEl.appendChild(item);
  }
}

// ── App drill-down modal ──────────────────────────────────────────────────────

function closeDrilldown() {
  document.getElementById('drilldown-modal').style.display = 'none';
  destroyChart('dd');
}

// Render (or re-render) the drilldown chart using the module-level ddChartRows / ddLabelFn.
// Called both on initial load and when the chart type toggle changes.
function renderDrilldownChart() {
  if (!ddChartRows.length || !ddLabelFn) return;
  destroyChart('dd');

  const wrapEl  = document.getElementById('drilldown-wrap');
  wrapEl.style.display = '';

  const isLine      = settings.chartStyleDrilldown === 'line';
  const dark        = document.documentElement.getAttribute('data-theme') === 'dark';
  const singleColor = dark ? '#e5e5e5' : '#1d1d1f';
  const stackBars   = !isLine;
  const maxVal      = Math.max(...ddChartRows.map(d => d.total / 60), 1);

  let datasets;
  if (isLine) {
    const visDevs = visibleDevices();
    datasets = state.devices.map((dev, i) => {
      const typeIdx = state.devices.slice(0, i).filter(d => d.device_type === dev.device_type).length;
      const color   = getDeviceColor(dev.device_type, typeIdx);
      const data    = ddChartRows.map(d => Math.round((d.by_device[dev.device_id] || 0) / 60));
      return { ...lineDs(dev.display_name, data, color, visDevs.length === 1), hidden: state.hiddenDevices.has(dev.device_id) };
    });
  } else {
    datasets = deviceDatasets(dev =>
      ddChartRows.map(d => Math.round((d.by_device[dev.device_id] || 0) / 60))
    );
  }

  charts['dd'] = new Chart(document.getElementById('drilldown-chart'), {
    type: isLine ? 'line' : 'bar',
    data: { labels: ddChartRows.map(ddLabelFn), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: {
          display: state.devices.length > 1, position: 'top',
          labels: { boxWidth: 10, font: { size: 11 }, ...(isLine ? { usePointStyle: true, pointStyle: 'line' } : {}) },
        },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${fmtHours(ctx.raw * 60)}`,
            footer: !isLine ? items => items.length > 1
              ? [`Total: ${fmtHours(items.reduce((s, i) => s + i.raw, 0) * 60)}`]
              : [] : undefined,
          },
        },
      },
      scales: {
        x: { stacked: stackBars, grid: { display: false }, ticks: { font: { size: 11 } } },
        y: {
          stacked: stackBars,
          ticks: { stepSize: niceStepMin(maxVal), callback: v => fmtHours(v * 60) },
          grid: { color: getChartGrid() },
        },
      },
    },
  });
}

async function showAppDrilldown(app, from, to) {
  const modal      = document.getElementById('drilldown-modal');
  const titleEl    = document.getElementById('drilldown-title');
  const subEl      = document.getElementById('drilldown-subtitle');
  const loadEl     = document.getElementById('drilldown-loading');
  const nodataEl   = document.getElementById('drilldown-nodata');
  const wrapEl     = document.getElementById('drilldown-wrap');
  const pickerEl   = document.getElementById('dd-merge-picker');
  const confirmEl  = document.getElementById('dd-merge-confirm');
  const pickerInner = pickerEl ? pickerEl.querySelector('.merge-picker') : null;

  // Reset drilldown state
  ddChartRows = [];
  ddLabelFn   = null;

  // Title and subtitle
  titleEl.textContent = app.display_name;
  let subText = app.app !== app.display_name ? app.app : '';
  if (app.mergedFrom && app.mergedFrom.length > 0) {
    const mergedNames = app.mergedFrom.map(id => {
      const found = cachedAllApps.find(a => a.app === id);
      return escHtml(found ? found.display_name : id);
    }).join(', ');
    subText = (subText ? subText + ' · ' : '') + `Merged with: ${mergedNames}`;
  }
  subEl.textContent = subText;

  // Reset UI
  loadEl.style.display    = '';
  nodataEl.style.display  = 'none';
  wrapEl.style.display    = 'none';
  if (pickerEl)    pickerEl.style.display    = 'none';
  if (confirmEl)   confirmEl.style.display   = 'none';
  if (pickerInner) pickerInner.style.display = '';
  modal.style.display = 'flex';
  destroyChart('dd');

  // ── Chart type toggle (Bar / Line) ─────────────────────────────────────────
  const ddTypeGroup = document.getElementById('dd-chart-type');
  ddTypeGroup.querySelectorAll('.chart-type-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === settings.chartStyleDrilldown);
  });
  ddTypeGroup.onclick = (e) => {
    const btn = e.target.closest('.chart-type-btn');
    if (!btn) return;
    const type = btn.dataset.type;
    if (type === settings.chartStyleDrilldown) return;
    settings.chartStyleDrilldown = type;
    saveSettings();
    ddTypeGroup.querySelectorAll('.chart-type-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.type === type)
    );
    renderDrilldownChart();
  };

  // ── Rename button ──────────────────────────────────────────────────────────
  document.getElementById('dd-rename-btn').onclick = (e) => {
    showRenamePopover(app, e.clientX, e.clientY);
  };

  // ── Merge with… button ────────────────────────────────────────────────────
  document.getElementById('dd-merge-btn').onclick = () => {
    if (!pickerEl) return;
    const isVisible = pickerEl.style.display !== 'none';
    pickerEl.style.display = isVisible ? 'none' : '';
    if (confirmEl)   confirmEl.style.display   = 'none';
    if (pickerInner) pickerInner.style.display = '';
    if (!isVisible) {
      document.getElementById('dd-merge-search').value = '';
      renderMergePickerList(app, '');
      document.getElementById('dd-merge-search').focus();
    }
  };

  // ── Merge search field ─────────────────────────────────────────────────────
  document.getElementById('dd-merge-search').oninput = (e) => {
    renderMergePickerList(app, e.target.value);
  };

  // ── Merge confirm — Cancel button ─────────────────────────────────────────
  document.getElementById('dd-merge-no').onclick = () => {
    if (confirmEl)   confirmEl.style.display   = 'none';
    if (pickerInner) pickerInner.style.display = '';
  };

  // ── Fetch data ─────────────────────────────────────────────────────────────
  try {
    const appIds = [app.app, ...(app.mergedFrom || [])];
    let allDays;

    if (appIds.length === 1) {
      const { days } = await window.api.getAppDaily(appIds[0], from, to);
      allDays = days || [];
    } else {
      // Fetch multiple app IDs and combine by date
      const results = await Promise.all(appIds.map(id => window.api.getAppDaily(id, from, to)));
      const dayMap  = {};
      for (const { days } of results) {
        for (const d of days || []) {
          if (!dayMap[d.date]) dayMap[d.date] = { date: d.date, total: 0, by_device: {} };
          dayMap[d.date].total += d.total;
          for (const [devId, secs] of Object.entries(d.by_device || {})) {
            dayMap[d.date].by_device[devId] = (dayMap[d.date].by_device[devId] || 0) + secs;
          }
        }
      }
      allDays = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));
    }

    loadEl.style.display = 'none';

    if (!allDays.length || allDays.every(d => d.total === 0)) {
      nodataEl.style.display = '';
      return;
    }

    // In year view, aggregate days into months for readability
    let chartRows = allDays;
    let labelFn   = d => fmtDate(d.date);
    if (state.mode === 'year') {
      const byMonth = {};
      for (const d of allDays) {
        const key = d.date.slice(0, 7); // 'YYYY-MM'
        if (!byMonth[key]) byMonth[key] = { date: key, total: 0, by_device: {} };
        byMonth[key].total += d.total;
        for (const [id, secs] of Object.entries(d.by_device || {})) {
          byMonth[key].by_device[id] = (byMonth[key].by_device[id] || 0) + secs;
        }
      }
      chartRows = Object.values(byMonth).sort((a, b) => a.date.localeCompare(b.date));
      labelFn   = d => {
        const [y, m] = d.date.split('-').map(Number);
        return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short' });
      };
    }

    // Store for re-rendering on chart type toggle
    ddChartRows = chartRows;
    ddLabelFn   = labelFn;

    renderDrilldownChart();
  } catch (e) {
    loadEl.style.display    = 'none';
    nodataEl.style.display  = '';
    console.error('Drilldown error:', e);
  }
}

// ── CSV export ────────────────────────────────────────────────────────────────

async function exportCsv() {
  const [from, to] = getApiRange();
  let csv, filename;
  const ts = new Date().toISOString().slice(0, 10);

  if (state.activeTab === 'overview') {
    const { apps } = await window.api.getScreentime(from, to);
    const rows = apps.filter(a => rowTotal(a) > 0);
    const devCols = state.devices.map(d => `"${d.display_name} (min)"`).join(',');
    csv = `App ID,Display Name,Total Minutes,${devCols}\n` +
      rows.map(a =>
        `"${a.app}","${a.display_name}",${Math.round(rowTotal(a)/60)},` +
        state.devices.map(d => Math.round((a.by_device[d.device_id] || 0) / 60)).join(',')
      ).join('\n');
    filename = `screenlog_overview_${ts}.csv`;
  } else if (state.activeTab === 'daily') {
    const { days } = await window.api.getDaily(from, to);
    const devCols = state.devices.map(d => `"${d.display_name} (min)"`).join(',');
    csv = `Date,Total Minutes,${devCols}\n` +
      days.map(d =>
        `${d.date},${Math.round(rowTotal(d)/60)},` +
        state.devices.map(dev => Math.round((d.by_device[dev.device_id] || 0) / 60)).join(',')
      ).join('\n');
    filename = `screenlog_daily_${ts}.csv`;
  } else {
    const { hours, num_days } = await window.api.getHourly(from, to);
    csv = 'Hour,Avg Minutes\n' +
      hours.map(h => `${fmtHour(h.hour)},${Math.round(rowTotal(h)/60/num_days)}`).join('\n');
    filename = `screenlog_hourly_${ts}.csv`;
  }
  await window.api.saveCsv(filename, csv);
}

// ── Notification check ────────────────────────────────────────────────────────

async function checkGoalNotifications() {
  if (!settings.notificationsEnabled || !settings.dailyTargetHours) return;

  const today = new Date().toISOString().slice(0, 10);
  let ns = {};
  try { ns = JSON.parse(localStorage.getItem('notifState') || '{}'); } catch {}
  if (ns.date !== today) ns = { date: today, halfFired: false, fullFired: false };
  if (ns.halfFired && ns.fullFired) return;

  const targetSec = settings.dailyTargetHours * 3600;
  const todayStart = Math.floor(new Date(today + 'T00:00:00').getTime() / 1000);
  const todayEnd   = todayStart + 86399;

  try {
    const { days } = await window.api.getDaily(todayStart, todayEnd);
    if (!days || !days.length) return;
    const d = days[days.length - 1];
    const total = settings.deduplicateDeviceTime ? d.dedup_total : rowTotal(d);

    if (!ns.fullFired && total >= targetSec) {
      await window.api.showNotification(
        'Screen Time Limit Reached',
        `You've used ${fmtHours(total)} today — your ${settings.dailyTargetHours}h limit has been exceeded.`
      );
      ns.halfFired = true;
      ns.fullFired = true;
    } else if (!ns.halfFired && total >= targetSec * 0.5) {
      await window.api.showNotification(
        'Screen Time Warning — 50%',
        `You've used ${fmtHours(total)} today, halfway to your ${settings.dailyTargetHours}h daily limit.`
      );
      ns.halfFired = true;
    }
    localStorage.setItem('notifState', JSON.stringify(ns));
  } catch { /* ignore */ }
}

// ── Grafana push ──────────────────────────────────────────────────────────────

const PG_KEYS = ['host', 'port', 'database', 'user', 'password'];

function loadPgConfig() {
  try {
    return JSON.parse(localStorage.getItem('screenlog_pg') || '{}');
  } catch { return {}; }
}

function savePgConfig(cfg) {
  try { localStorage.setItem('screenlog_pg', JSON.stringify(cfg)); } catch { /* ignore */ }
}

function getPgFields() {
  return {
    host:     document.getElementById('pg-host').value.trim(),
    port:     parseInt(document.getElementById('pg-port').value, 10) || 5432,
    database: document.getElementById('pg-database').value.trim(),
    user:     document.getElementById('pg-user').value.trim(),
    password: document.getElementById('pg-password').value,
  };
}

function setPgStatus(msg, isError = false) {
  const el = document.getElementById('pg-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#FF3B30' : 'var(--text3)';
}

async function grafanaPushIfEnabled() {
  const cfg = loadPgConfig();
  if (!cfg.autopush || !cfg.host) return;
  try {
    const { host, port = 5432, database, user, password } = cfg;
    const result = await window.api.pushToGrafana(host, port, database, user, password);
    if (result && result.ok) {
      console.log(`Grafana push: ${result.rows} rows upserted`);
    } else if (result && result.error) {
      console.warn('Grafana push error:', result.error);
    }
  } catch (e) {
    console.warn('Grafana push failed:', e);
  }
}

function populatePgSettings() {
  const cfg = loadPgConfig();
  document.getElementById('pg-host').value     = cfg.host     || '';
  document.getElementById('pg-port').value     = cfg.port     || '';
  document.getElementById('pg-database').value = cfg.database || '';
  document.getElementById('pg-user').value     = cfg.user     || '';
  document.getElementById('pg-password').value = cfg.password || '';
  document.getElementById('pg-autopush').checked = !!cfg.autopush;
  setPgStatus('');
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
    const { devices } = await window.api.getDevices();
    state.devices = devices;
  } catch {
    // Fallback: assume at least a Mac
    state.devices = [{ device_id: '', device_type: 'mac', display_name: 'Mac' }];
  }
  // Remove stale hidden entries (device no longer present)
  const knownIds = new Set(state.devices.map(d => d.device_id));
  for (const id of [...state.hiddenDevices]) {
    if (!knownIds.has(id)) state.hiddenDevices.delete(id);
  }
  renderDevicePills();
}

// ── Settings modal ────────────────────────────────────────────────────────────

async function openSettings() {
  const modal = document.getElementById('settings-modal');
  modal.style.display = 'flex';
  populatePgSettings();

  // Populate target input + ticks toggle
  const ti = document.getElementById('target-input');
  ti.value = settings.dailyTargetHours != null ? settings.dailyTargetHours : '';
  document.getElementById('target-clear').style.display = settings.dailyTargetHours ? '' : 'none';
  document.getElementById('ticks-row').style.display = settings.dailyTargetHours ? '' : 'none';
  document.getElementById('ticks-toggle').checked = settings.showTargetTicks;

  // Appearance
  document.querySelectorAll('#appearance-ctrl .seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.val === settings.appearance);
  });

  // Launch at login
  try {
    const enabled = await window.api.getAutostart();
    document.getElementById('login-toggle').checked = enabled;
  } catch { document.getElementById('login-toggle').checked = false; }

  // Notifications
  document.getElementById('notif-toggle').checked = settings.notificationsEnabled;
  document.getElementById('notif-no-goal').style.display = settings.dailyTargetHours ? 'none' : '';

  // (dedup-toggle lives in the header, not the settings modal)

  // Load device list
  renderDeviceSettingsList();

  // Load app merges list
  renderMergeSettingsList();

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

      // Source breakdown: show "Mac X | iPhone/iPad Y" when either source has data
      // Fall back gracefully for old log rows that have no per-source columns (all zeros).
      const hasSources = run.mac_fetched > 0 || run.biome_fetched > 0;
      let sourceHtml = '';
      if (hasSources) {
        const parts = [];
        if (run.mac_fetched > 0)   parts.push(`Mac ${run.mac_fetched}→${run.mac_inserted}`);
        if (run.biome_fetched > 0) parts.push(`iPhone/iPad ${run.biome_fetched}→${run.biome_inserted}`);
        sourceHtml = `<br><small style="color:var(--text4);font-size:11px">${parts.join(' &nbsp;·&nbsp; ')}</small>`;
      }

      const errorNote = run.error
        ? `<br><small style="color:#c0392b;font-size:11px">${escHtml(run.error)}</small>`
        : '';

      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td class="ts">${dateStr}<span class="ts-rel">${fmtRelTime(run.ran_at)}</span></td>` +
        `<td>${run.fetched}${sourceHtml}</td>` +
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
  // Update notif-no-goal hint visibility
  document.getElementById('notif-no-goal').style.display = settings.dailyTargetHours ? 'none' : '';
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
  applyTheme(); // apply before any rendering

  // Sync header toggle now that settings are loaded (the DOMContentLoaded wiring
  // runs before loadSettings(), so the checkbox needs a second sync here).
  const dedupToggleEl = document.getElementById('dedup-toggle');
  if (dedupToggleEl) dedupToggleEl.checked = settings.deduplicateDeviceTime;
  syncChartTypeToggles();
  syncOverviewToggle();

  window.api.onCollectProgress(async () => {
    await refreshLastRun();
    await refreshDevices();
    loadCurrentTab();
    checkGoalNotifications();
    grafanaPushIfEnabled();
  });

  const fdaOk = await checkFdaAndInit();
  if (!fdaOk) return;

  await refreshDevices();
  await refreshLastRun();
  loadCurrentTab();
}

// ── Event wiring ──────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // System theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.appearance === 'system') applyTheme(true);
  });

  // Mode buttons
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.mode   = btn.dataset.mode;
      state.offset = 0;

      const needsRedirect =
        (state.mode === 'day'  && state.activeTab === 'daily')   ||
        (state.mode !== 'year' && state.activeTab === 'monthly');

      updateModeButtons();
      updatePeriodUI();

      if (needsRedirect) {
        switchTab('overview'); // calls loadCurrentTab internally
      } else {
        loadCurrentTab();
      }
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

  // Appearance segmented control
  document.querySelectorAll('#appearance-ctrl .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.appearance = btn.dataset.val;
      saveSettings();
      document.querySelectorAll('#appearance-ctrl .seg-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.val === settings.appearance));
      applyTheme(true);
    });
  });

  // Launch at login toggle
  document.getElementById('login-toggle').addEventListener('change', async (e) => {
    try { await window.api.setAutostart(e.target.checked); }
    catch (err) { console.error('Autostart error:', err); e.target.checked = !e.target.checked; }
  });

  // Notifications toggle
  document.getElementById('notif-toggle').addEventListener('change', (e) => {
    settings.notificationsEnabled = e.target.checked;
    saveSettings();
  });

  const dedupToggle = document.getElementById('dedup-toggle');
  dedupToggle.checked = settings.deduplicateDeviceTime;
  dedupToggle.addEventListener('change', (e) => {
    settings.deduplicateDeviceTime = e.target.checked;
    saveSettings();
    renderDevicePills();
    loadCurrentTab();
  });

  // Chart type toggles (Bar / Line) — Daily, Monthly + Hourly
  ['dy-chart-type', 'mo-chart-type', 'hr-chart-type'].forEach(groupId => {
    document.getElementById(groupId).addEventListener('click', (e) => {
      const btn = e.target.closest('.chart-type-btn');
      if (!btn) return;
      const type = btn.dataset.type;
      if (type === settings.chartStyle) return;
      settings.chartStyle = type;
      saveSettings();
      syncChartTypeToggles();
      loadCurrentTab();
    });
  });

  // Chart type toggle — Overview (Bar / Donut / Treemap)
  document.getElementById('ov-chart-type').addEventListener('click', (e) => {
    const btn = e.target.closest('.chart-type-btn');
    if (!btn) return;
    const type = btn.dataset.type;
    if (type === settings.chartStyleOverview) return;
    settings.chartStyleOverview = type;
    saveSettings();
    syncOverviewToggle();
    loadCurrentTab();
  });

  // CSV export
  document.getElementById('csv-btn').addEventListener('click', exportCsv);

  // Drill-down close
  document.getElementById('drilldown-close').addEventListener('click', closeDrilldown);
  document.getElementById('drilldown-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeDrilldown();
  });

  // Set initial UI state
  updateModeButtons();
  updatePeriodUI();

  // ── Grafana push settings ─────────────────────────────────────────────────
  // Save config on any field change
  ['pg-host', 'pg-port', 'pg-database', 'pg-user', 'pg-password'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      savePgConfig({ ...loadPgConfig(), ...getPgFields() });
    });
  });
  document.getElementById('pg-autopush').addEventListener('change', (e) => {
    savePgConfig({ ...loadPgConfig(), autopush: e.target.checked });
  });

  document.getElementById('pg-test-btn').addEventListener('click', async () => {
    const btn = document.getElementById('pg-test-btn');
    btn.disabled = true;
    setPgStatus('Connecting…');
    savePgConfig({ ...loadPgConfig(), ...getPgFields() });
    const { host, port, database, user, password } = getPgFields();
    try {
      const result = await window.api.testGrafanaPush(host, port, database, user, password);
      setPgStatus(result.ok ? '✓ Connected successfully' : `✗ ${result.error}`, !result.ok);
    } catch (e) {
      setPgStatus(`✗ ${e}`, true);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('pg-push-btn').addEventListener('click', async () => {
    const btn = document.getElementById('pg-push-btn');
    btn.disabled = true;
    setPgStatus('Pushing…');
    savePgConfig({ ...loadPgConfig(), ...getPgFields() });
    const { host, port, database, user, password } = getPgFields();
    try {
      const result = await window.api.pushToGrafana(host, port, database, user, password);
      if (result.ok) {
        setPgStatus(`✓ Pushed ${result.rows.toLocaleString()} rows`);
      } else {
        setPgStatus(`✗ ${result.error}`, true);
      }
    } catch (e) {
      setPgStatus(`✗ ${e}`, true);
    } finally {
      btn.disabled = false;
    }
  });

  // ── Window drag ───────────────────────────────────────────────────────────
  // Call the Rust start_drag command directly — more reliable than CSS-only
  // drag regions when controls fill most of the header.
  document.querySelector('header').addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, select, textarea, a, .mode-group, .period-nav, .collect-wrap')) return;
    window.api.startDrag().catch(() => {});
  });

  init();
});
