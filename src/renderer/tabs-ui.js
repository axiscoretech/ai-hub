/* ─────────────────────────────────────────────────────────── */
/* Tab state                                                    */
/* ─────────────────────────────────────────────────────────── */

var activeTabName = null;
var openclawGatewayUp = false;
var openclawSeq = 0;
var openclawBusy = false;
var tabLoadState = {}; // name → 'start' | 'finish' | 'fail' | 'idle'
var tabLoadTimers = {};
var TAB_LOAD_SAFETY_MS = 25000;
var THEME_ORDER = ['dark', 'light', 'system'];
var themePreference = localStorage.getItem('aihub-theme') || 'dark';
if (!THEME_ORDER.includes(themePreference)) themePreference = 'dark';

function resolvedTheme() {
  if (themePreference !== 'system') return themePreference;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function themeLabel(preference) {
  if (preference === 'light') return 'Theme: light';
  if (preference === 'system') return 'Theme: system';
  return 'Theme: dark';
}

function applyTheme(preference) {
  themePreference = THEME_ORDER.includes(preference) ? preference : 'dark';
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.body.dataset.theme = theme;
  localStorage.setItem('aihub-theme', themePreference);
  const themeBtn = document.getElementById('theme-btn');
  if (themeBtn) {
    themeBtn.dataset.preference = themePreference;
    themeBtn.title = themeLabel(themePreference);
    themeBtn.setAttribute('aria-label', themeBtn.title);
  }
  if (window.electronAPI && window.electronAPI.setContentTheme) {
    window.electronAPI.setContentTheme(themePreference);
  }
}

function toggleTheme() {
  const index = THEME_ORDER.indexOf(themePreference);
  applyTheme(THEME_ORDER[(index + 1) % THEME_ORDER.length]);
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (themePreference === 'system') applyTheme('system');
});

function reloadPage(ignoreCache) {
  window.electronAPI.reloadActiveTab(Boolean(ignoreCache));
}

function setActive(name) {
  document.querySelectorAll('.tab').forEach(el => {
    el.classList.toggle('active', el.dataset.name === name);
  });
}

function switchTab(name) {
  activeTabName = name;
  setActive(name);
  window.electronAPI.switchTab(name);

  // Bar only while this tab is still loading. Finished, failed, and idle stay hidden.
  const state = tabLoadState[name];
  if (state === 'start') {
    resetProgress();
    startProgress();
  } else {
    setTabSpinner(name, false);
    hideProgress();
  }
}

window.electronAPI.onTabActive(name => {
  activeTabName = name;
  setActive(name);
  renderAccountSwitch();
  syncOpenClawShell(name);
});

/* ─────────────────────────────────────────────────────────── */
/* Progress bar                                                 */
/* ─────────────────────────────────────────────────────────── */

var progressPct = 0;
var progressCrawlTimer = null;
var progressHungTimer  = null;
var progressToken = 0;

var bar = () => document.getElementById('progress-bar');

function setProgressWidth(pct) {
  progressPct = pct;
  bar().style.width = pct + '%';
}

function resetProgress() {
  clearInterval(progressCrawlTimer);
  clearTimeout(progressHungTimer);
  const b = bar();
  b.style.transition = 'none';
  b.style.animation  = '';
  b.style.opacity    = '0';
  b.style.background = 'linear-gradient(90deg, #7c6aff, #b0a6ff)';
  setProgressWidth(0);
}

function startProgress() {
  const token = ++progressToken;
  const b = bar();
  b.style.opacity = '1';

  // Quick jump to 15%
  requestAnimationFrame(() => {
    if (token !== progressToken) return;
    b.style.transition = 'width 0.2s ease';
    setProgressWidth(15);

    // Crawl slowly toward 75%
    progressCrawlTimer = setInterval(() => {
      if (token !== progressToken) return;
      if (progressPct < 75) {
        setProgressWidth(progressPct + (75 - progressPct) * 0.055);
      }
    }, 350);
  });

  // Hung detection: >10s still loading → turn orange + pulse
  progressHungTimer = setTimeout(() => {
    if (token !== progressToken) return;
    b.style.background = 'linear-gradient(90deg, #e09a3a, #f0bc6a)';
    b.style.animation  = 'pulse-bar 1.4s ease-in-out infinite';
  }, 10000);
}

function finishProgress(failed) {
  const token = progressToken;
  clearInterval(progressCrawlTimer);
  clearTimeout(progressHungTimer);
  const b = bar();
  b.style.animation  = '';
  if (failed) b.style.background = 'rgba(210,70,70,0.75)';
  b.style.transition = 'width 0.12s ease';
  setProgressWidth(100);
  setTimeout(() => {
    if (token !== progressToken) return;
    b.style.transition = 'opacity 0.28s';
    b.style.opacity    = '0';
    setTimeout(() => {
      if (token !== progressToken) return;
      resetProgress();
    }, 300);
  }, 180);
}

function hideProgress() {
  const token = progressToken;
  clearInterval(progressCrawlTimer);
  clearTimeout(progressHungTimer);
  const b = bar();
  b.style.animation  = '';
  b.style.transition = 'opacity 0.15s';
  b.style.opacity    = '0';
  setTimeout(() => {
    if (token !== progressToken) return;
    resetProgress();
  }, 200);
}

/* ─────────────────────────────────────────────────────────── */
/* Tab progress events from main process                        */
/* ─────────────────────────────────────────────────────────── */

function clearTabLoadTimer(name) {
  if (!tabLoadTimers[name]) return;
  clearTimeout(tabLoadTimers[name]);
  delete tabLoadTimers[name];
}

function setTabSpinner(name, loading) {
  const tabEl = document.querySelector(`.tab[data-name="${name}"]`);
  if (tabEl) tabEl.classList.toggle('loading', Boolean(loading));
}

function beginTabLoad(name) {
  clearTabLoadTimer(name);
  tabLoadState[name] = 'start';
  setTabSpinner(name, true);
  tabLoadTimers[name] = setTimeout(() => {
    delete tabLoadTimers[name];
    settleTabLoad(name, 'idle');
  }, TAB_LOAD_SAFETY_MS);

  if (name === activeTabName) {
    resetProgress();
    startProgress();
  }
}

function settleTabLoad(name, event) {
  clearTabLoadTimer(name);
  const wasLoading = tabLoadState[name] === 'start';
  tabLoadState[name] = event === 'fail' ? 'fail' : (event === 'finish' ? 'finish' : 'idle');
  setTabSpinner(name, false);

  if (name !== activeTabName) return;
  if (event === 'fail') {
    finishProgress(true);
    return;
  }
  if (wasLoading) finishProgress(false);
  else hideProgress();
}

window.electronAPI.onTabProgress((name, event) => {
  if (event === 'start') {
    beginTabLoad(name);
    return;
  }
  // "dom" is ignored so it cannot pin the spinner after the document is ready.
  if (event === 'finish' || event === 'fail') settleTabLoad(name, event);
});
