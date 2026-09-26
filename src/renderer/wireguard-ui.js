/* ─────────────────────────────────────────────────────────── */
/* VPN Panel                                                    */
/* ─────────────────────────────────────────────────────────── */

var panelOpen = false;
var proxyMode = 'direct';
var extensionRegistry = [];

function shellInsetHeight() {
  let height = 60;
  ['tunnel-dropped', 'find-bar', 'compare-bar', 'update-bar', 'oc-update-bar'].forEach((id) => {
    const bar = document.getElementById(id);
    if (bar && !bar.hidden) height += bar.offsetHeight || 34;
  });
  if (panelOpen) {
    const panel = document.getElementById('vpn-panel');
    height += (panel ? panel.offsetHeight : 0) + 6;
  }
  return height;
}

function layoutInset() {
  const height = shellInsetHeight();
  document.documentElement.style.setProperty("--shell-inset", height + "px");
  window.electronAPI.setTopBarHeight(height);
}

function pushBrowserView() {
  requestAnimationFrame(layoutInset);
}

function openVpnPanel() {
  panelOpen = true;
  document.getElementById('vpn-panel').classList.add('open');
  document.getElementById('vpn-overlay').style.display = 'block';
  requestAnimationFrame(pushBrowserView);
}

function closeVpnPanel() {
  panelOpen = false;
  document.getElementById('vpn-panel').classList.remove('open');
  document.getElementById('vpn-overlay').style.display = 'none';
  layoutInset();
}

function toggleVpnPanel() { panelOpen ? closeVpnPanel() : openVpnPanel(); }

function selectMode() {
  const wgPanel = document.getElementById('p-wg');
  if (wgPanel) wgPanel.classList.add('on');
  if (panelOpen) requestAnimationFrame(pushBrowserView);
}

/* ─────────────────────────────────────────────────────────── */
/* Proxy apply                                                  */
/* ─────────────────────────────────────────────────────────── */

async function applyProxy() {
  clearMsg();
  const btn = document.getElementById('p-apply');
  btn.textContent = 'Applying…';
  btn.disabled = true;
  try {
    if (proxyMode === 'direct') {
      await window.electronAPI.clearProxy();
      setProxyStatus(false, 'Direct connection');
      showMsg('Proxy disabled', 'ok');
    } else if (proxyMode === 'wireguard') {
      showMsg('Choose a config and press Connect', 'err');
    } else {
      const type = document.getElementById('p-type').value;
      const host = document.getElementById('p-host').value.trim();
      const port = document.getElementById('p-port').value.trim();
      if (!host || !port) { showMsg('Enter host and port', 'err'); return; }
      await window.electronAPI.setProxy({ proxyRules: `${type}://${host}:${port}` });
      setProxyStatus(true, `${type.toUpperCase()} ${host}:${port}`);
      showMsg('Applied to all tabs ✓', 'ok');
    }
  } catch (e) {
    showMsg('Error: ' + e.message, 'err');
  } finally {
    btn.textContent = 'Apply';
    btn.disabled = false;
    if (panelOpen) requestAnimationFrame(pushBrowserView);
  }
}

async function resetClaudeSession() {
  clearMsg();
  const btn = document.getElementById('p-reset-claude');
  btn.textContent = 'Resetting…';
  btn.disabled = true;

  try {
    const res = await window.electronAPI.resetTabSession('Claude');
    if (res.success) {
      activeTabName = 'Claude';
      setActive('Claude');
      showMsg('Claude session cleared. Try signing in again.', 'ok');
    } else {
      showMsg('Failed: ' + (res.error || 'Unknown error'), 'err');
    }
  } catch (e) {
    showMsg('Error: ' + e.message, 'err');
  } finally {
    btn.textContent = 'Reset Claude Session';
    btn.disabled = false;
  }
}

function countryFlag(code) {
  if (!/^[A-Z]{2}$/.test(code || '')) return '';
  return String.fromCodePoint(...code.split('').map(ch => 127397 + ch.charCodeAt(0)));
}

function paintLocationFlag(active, label, countryCode) {
  const btn = document.getElementById('vpn-btn');
  const icon = document.getElementById('vpn-flag-icon');
  const emoji = document.getElementById('vpn-flag-emoji');
  if (!btn || !icon || !emoji) return;
  btn.classList.toggle('proxy-on', active);
  const title = label || 'WireGuard';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  const flag = active ? countryFlag(countryCode) : '';
  if (flag) {
    emoji.hidden = false;
    emoji.textContent = flag;
    icon.hidden = true;
  } else {
    emoji.hidden = true;
    emoji.textContent = '';
    icon.hidden = false;
  }
}

function setProxyStatus(active, label, countryCode) {
  document.getElementById('p-dot').classList.toggle('on', active);
  const t = document.getElementById('p-status-text');
  t.classList.toggle('on', active);
  t.textContent = label;
  paintLocationFlag(active, label, countryCode);
}

/* ─────────────────────────────────────────────────────────── */
/* WireGuard (hub tabs only)                                    */
/* ─────────────────────────────────────────────────────────── */

var wgState = { revision: -1, connectedId: null, pendingId: null, error: null, configs: [] };

function onWireguardStatus(status) {
  if (!status || !Array.isArray(status.configs)) return;
  if (typeof status.revision === 'number' && status.revision < wgState.revision) return;
  const previousError = wgState.error;
  const previousConnected = wgState.connectedId;
  wgState = status;
  renderWireguard(status);
  renderTunnelDropped(status);

  if (status.phase === 'dropped') {
    setProxyStatus(false, 'Tunnel dropped', '');
    selectMode();
  } else if (status.connectedId) {
    const cfg = status.configs.find(item => item.id === status.connectedId);
    const place = status.location || (cfg && cfg.location) || (cfg && cfg.name) || 'WireGuard';
    const code = status.countryCode || (cfg && cfg.countryCode) || '';
    setProxyStatus(true, place, code);
    if (previousConnected !== status.connectedId) selectMode();
  } else if (status.phase === 'connecting') {
    const cfg = status.configs.find(item => item.id === status.pendingId);
    setProxyStatus(true, cfg ? ('Connecting ' + cfg.name) : 'Connecting…', '');
    selectMode();
  } else if (status.error || previousConnected) {
    setProxyStatus(false, status.error ? 'WireGuard failed' : 'Direct connection', '');
    if (status.error && status.error !== previousError) selectMode();
  }

  if (status.error && status.error !== previousError) showMsg(status.error, 'err');
}

function renderWireguard(status) {
  const list = document.getElementById('p-wg-list');
  const empty = document.getElementById('p-wg-empty');
  const errorEl = document.getElementById('p-wg-error');
  const disconnect = document.getElementById('p-wg-disconnect');
  if (!list || !empty) return;
  list.textContent = '';
  empty.hidden = status.configs.length > 0;
  if (errorEl) errorEl.textContent = status.error || '';
  if (disconnect) disconnect.disabled = !status.connectedId && status.phase !== 'dropped';

  const busy = status.phase === 'connecting';
  status.configs.forEach(cfg => {
    const row = document.createElement('div');
    row.className = 'p-wg-item';
    if (cfg.id === status.connectedId) row.classList.add('on');

    const name = document.createElement('div');
    name.className = 'p-wg-name';
    name.textContent = cfg.name || 'WireGuard';

    const meta = document.createElement('div');
    meta.className = 'p-wg-meta';
    const place = cfg.id === status.connectedId ? (status.location || cfg.location || '') : (cfg.location || '');
    meta.textContent = [place, cfg.endpointHost].filter(Boolean).join(' · ');

    const actions = document.createElement('div');
    actions.className = 'p-wg-actions';

    const connect = document.createElement('button');
    connect.type = 'button';
    connect.className = 'p-wg-btn';
    if (cfg.id === status.connectedId) {
      connect.textContent = 'Connected';
      connect.disabled = true;
    } else {
      connect.textContent = status.connectedId ? 'Switch location' : 'Connect';
      connect.disabled = busy;
      connect.onclick = () => connectWireguard(cfg.id);
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'p-wg-btn danger';
    remove.textContent = 'Remove';
    remove.disabled = busy;
    remove.onclick = () => removeWireguard(cfg.id);

    actions.appendChild(connect);
    actions.appendChild(remove);
    row.appendChild(name);
    row.appendChild(meta);
    row.appendChild(actions);
    list.appendChild(row);
  });
  if (panelOpen) requestAnimationFrame(pushBrowserView);
}

async function connectWireguard(id) {
  clearMsg();
  try {
    const res = await window.electronAPI.connectWireguard(id);
    if (res && res.status) onWireguardStatus(res.status);
    if (res && res.success) showMsg('WireGuard connected', 'ok');
    else if (!res || !res.status) showMsg((res && res.error) || 'Could not connect', 'err');
  } catch (e) {
    showMsg('Error: ' + e.message, 'err');
  }
}

async function disconnectWireguard() {
  clearMsg();
  try {
    const res = await window.electronAPI.disconnectWireguard();
    if (res && res.status) onWireguardStatus(res.status);
    if (res && res.success) showMsg('WireGuard disconnected', 'ok');
    else if (!res || !res.status) showMsg((res && res.error) || 'Could not disconnect', 'err');
  } catch (e) {
    showMsg('Error: ' + e.message, 'err');
  }
}

async function importWireguard() {
  clearMsg();
  const btn = document.getElementById('p-wg-import');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Importing…';
  }
  try {
    const res = await window.electronAPI.importWireguardConfigs();
    if (!res || res.canceled) return;
    if (res.status) onWireguardStatus(res.status);
    if (res.error) showMsg(res.error, 'err');
    else if (res.imported) {
      showMsg('Imported ' + res.imported + (res.imported === 1 ? ' config' : ' configs'), 'ok');
    }
  } catch (e) {
    showMsg('Error: ' + e.message, 'err');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Import .conf';
    }
    if (panelOpen) requestAnimationFrame(pushBrowserView);
  }
}

async function removeWireguard(id) {
  clearMsg();
  try {
    const res = await window.electronAPI.removeWireguardConfig(id);
    if (res && res.status) onWireguardStatus(res.status);
    if (!res || !res.success) showMsg((res && res.error) || 'Could not remove config', 'err');
  } catch (e) {
    showMsg('Error: ' + e.message, 'err');
  }
}

function showTunnelGate(info) {
  const gate = document.getElementById('tunnel-gate');
  if (!gate) return;
  const active = Boolean(info && info.active);
  gate.hidden = !active;
  const name = document.getElementById('tunnel-name');
  if (name && active) name.textContent = (info && info.name) || 'WireGuard';
  const cancel = document.getElementById('tunnel-cancel');
  if (cancel && active) {
    cancel.disabled = false;
    cancel.textContent = 'Cancel';
  }
}

function renderTunnelDropped(status) {
  const bar = document.getElementById('tunnel-dropped');
  if (!bar) return;
  const show = Boolean(status && status.phase === 'dropped' && status.savedId);
  if (bar.hidden === !show) {
    layoutInset();
    return;
  }
  bar.hidden = !show;
  const button = document.getElementById('tunnel-reconnect');
  if (button) button.disabled = false;
  layoutInset();
}

function initWireguard() {
  if (!window.electronAPI || !window.electronAPI.onWireguardStatus) return;
  window.electronAPI.onWireguardStatus(onWireguardStatus);
  window.electronAPI.listWireguardConfigs().then(onWireguardStatus).catch(() => {});
  if (window.electronAPI.onTunnelGate) window.electronAPI.onTunnelGate(showTunnelGate);
  const cancel = document.getElementById('tunnel-cancel');
  if (cancel && window.electronAPI.tunnelCancel) {
    cancel.addEventListener('click', () => {
      cancel.disabled = true;
      cancel.textContent = 'Cancelling…';
      window.electronAPI.tunnelCancel().catch(() => {
        cancel.disabled = false;
        cancel.textContent = 'Cancel';
      });
    });
  }
  const reconnect = document.getElementById('tunnel-reconnect');
  if (reconnect) {
    reconnect.addEventListener('click', () => {
      const id = wgState && wgState.savedId;
      if (!id) return;
      reconnect.disabled = true;
      connectWireguard(id).finally(() => { reconnect.disabled = false; });
    });
  }
}
