function syncOpenClawShell(name) {
  if (name !== 'OpenClaw') {
    openclawSeq += 1;
    hideOpenClawPanel();
    return;
  }
  refreshOpenClaw();
}

function hideOpenClawPanel() {
  const panel = document.getElementById('openclaw-panel');
  if (panel) panel.classList.remove('visible');
  layoutInset();
}

function setOpenClawBusy(busy) {
  openclawBusy = busy;
  ['oc-refresh', 'oc-start', 'oc-install'].forEach(id => {
    const button = document.getElementById(id);
    if (button) button.disabled = busy;
  });
}

function renderOpenClaw(status, logText) {
  const panel = document.getElementById('openclaw-panel');
  if (!panel || !status) return;
  const board = document.getElementById('board');
  if (board && board.classList.contains('visible')) {
    hideOpenClawPanel();
    return;
  }
  openclawGatewayUp = Boolean(status.gatewayUp);
  if (status.pageReady) {
    hideOpenClawPanel();
    return;
  }
  panel.classList.add('visible');
  const title = document.getElementById('oc-title');
  const explain = document.getElementById('oc-explain');
  const install = document.getElementById('oc-install');
  const start = document.getElementById('oc-start');
  if (status.gatewayUp) {
    title.textContent = 'Opening OpenClaw';
    explain.textContent = status.error || 'Opening its page on this Mac.';
    install.hidden = true;
    start.hidden = true;
  } else if (status.phase === 'checking') {
    title.textContent = 'OpenClaw';
    explain.textContent = 'Looking for OpenClaw on this Mac.';
    install.hidden = true;
    start.hidden = true;
  } else if (status.stopped) {
    title.textContent = 'OpenClaw stopped';
    explain.textContent = 'Its page lost the connection because OpenClaw is not running. Open it again.';
    install.hidden = true;
    start.hidden = false;
  } else if (!status.installed) {
    title.textContent = 'Install OpenClaw';
    explain.textContent = 'Install downloads https://openclaw.ai/install.sh and asks before running it.';
    install.hidden = false;
    start.hidden = true;
  } else {
    title.textContent = 'Open OpenClaw';
    explain.textContent = 'OpenClaw is installed. Open it to show its web page in this tab.';
    install.hidden = true;
    start.hidden = false;
  }
  const log = document.getElementById('oc-log');
  const detail = String(status.error || logText || "");
  log.textContent = /\$ |openclaw |LaunchAgent/i.test(detail) ? "" : detail;
  layoutInset();
}

async function refreshOpenClaw() {
  if (!window.electronAPI.openclawStatus) return;
  const seq = ++openclawSeq;
  if (activeTabName !== 'OpenClaw') {
    hideOpenClawPanel();
    return;
  }
  if (!openclawGatewayUp) {
    renderOpenClaw({ gatewayUp: false, phase: 'checking' });
  }
  setOpenClawBusy(true);
  try {
    const status = await window.electronAPI.openclawStatus();
    if (seq !== openclawSeq || activeTabName !== 'OpenClaw') return;
    if (status && status.installed && !status.gatewayUp && !status.pageReady) {
      renderOpenClaw({ ...status, stopped: true });
      setOpenClawBusy(false);
      await startOpenClaw();
      return;
    }
    renderOpenClaw(status);
    if (status && status.pageReady) void checkOpenClawUpdate();
  } catch (err) {
    if (seq !== openclawSeq || activeTabName !== 'OpenClaw') return;
    renderOpenClaw({
      installed: true,
      gatewayUp: false,
      phase: 'stopped',
      error: err.message || 'Could not check OpenClaw',
    });
  } finally {
    if (seq === openclawSeq) setOpenClawBusy(false);
  }
}

async function startOpenClaw() {
  if (openclawBusy || !window.electronAPI.openclawStart) return;
  const seq = ++openclawSeq;
  setOpenClawBusy(true);
  const button = document.getElementById('oc-start');
  button.textContent = 'Opening…';
  try {
    const result = await window.electronAPI.openclawStart();
    if (seq !== openclawSeq || activeTabName !== 'OpenClaw') return;
    if (result && result.status) renderOpenClaw(result.status);
    else renderOpenClaw({
      installed: true,
      gatewayUp: false,
      phase: 'stopped',
      error: (result && result.error) || 'Could not open OpenClaw',
    });
  } catch (err) {
    if (seq !== openclawSeq || activeTabName !== 'OpenClaw') return;
    renderOpenClaw({
      installed: true,
      gatewayUp: false,
      phase: 'stopped',
      error: err.message || 'Could not open OpenClaw',
    });
  } finally {
    button.textContent = 'Open OpenClaw';
    if (seq === openclawSeq) setOpenClawBusy(false);
  }
}

async function openOpenClawDashboard() {
  if (openclawBusy || !window.electronAPI.openclawDashboard) return;
  const seq = ++openclawSeq;
  setOpenClawBusy(true);
  try {
    const result = await window.electronAPI.openclawDashboard();
    if (seq !== openclawSeq || activeTabName !== 'OpenClaw') return;
    if (!result || !result.success) {
      renderOpenClaw({
        installed: true,
        gatewayUp: false,
        phase: 'stopped',
        error: (result && result.error) || 'Could not open the page',
      });
      return;
    }
    renderOpenClaw({
      installed: true,
      gatewayUp: true,
      phase: 'running',
      error: null,
    }, result.error || '');
  } catch (err) {
    if (seq !== openclawSeq || activeTabName !== 'OpenClaw') return;
    renderOpenClaw({
      installed: true,
      gatewayUp: openclawGatewayUp,
      phase: openclawGatewayUp ? 'running' : 'stopped',
      error: err.message || 'Could not open the page',
    });
  } finally {
    if (seq === openclawSeq) setOpenClawBusy(false);
  }
}

async function installOpenClaw() {
  if (openclawBusy || !window.electronAPI.openclawInstall) return;
  const proceed = window.confirm("AI Hub will download https://openclaw.ai/install.sh and run it with /bin/bash.");
  if (!proceed) return;
  const seq = ++openclawSeq;
  setOpenClawBusy(true);
  const button = document.getElementById('oc-install');
  if (button) button.textContent = 'Installing…';
  try {
    const result = await window.electronAPI.openclawInstall();
    if (seq !== openclawSeq || activeTabName !== 'OpenClaw') return;
    if (result && result.status) renderOpenClaw(result.status);
    else renderOpenClaw({
      installed: false,
      gatewayUp: false,
      phase: 'missing',
      error: (result && result.error) || 'OpenClaw could not be installed.',
    });
  } catch (err) {
    if (seq !== openclawSeq || activeTabName !== 'OpenClaw') return;
    renderOpenClaw({
      installed: false,
      gatewayUp: false,
      phase: 'missing',
      error: 'OpenClaw could not be installed.',
    });
  } finally {
    if (button) button.textContent = 'Install OpenClaw';
    if (seq === openclawSeq) setOpenClawBusy(false);
  }
}

if (window.electronAPI.onOpenClawPage) {
  window.electronAPI.onOpenClawPage((info) => {
    if (activeTabName !== 'OpenClaw') return;
    if (info && info.ready) {
      openclawGatewayUp = true;
      hideOpenClawPanel();
      void checkOpenClawUpdate();
    }
  });
}

if (window.electronAPI.onOpenClawDown) {
  window.electronAPI.onOpenClawDown((info) => {
    if (activeTabName !== 'OpenClaw') return;
    openclawSeq += 1;
    renderOpenClaw({
      installed: true,
      serviceInstalled: true,
      gatewayUp: false,
      phase: 'stopped',
      url: (info && info.url) || 'http://127.0.0.1:18789/',
      error: (info && info.error) || 'Gateway is not reachable',
    });
    setOpenClawBusy(false);
  });
}
