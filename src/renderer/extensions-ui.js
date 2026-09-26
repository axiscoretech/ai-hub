/* ─────────────────────────────────────────────────────────── */
/* Extension: manual load                                       */
/* ─────────────────────────────────────────────────────────── */

async function pickExtension() {
  clearMsg();
  const btn = document.getElementById('p-load-ext');
  btn.textContent = '📁 Selecting…';
  btn.disabled = true;
  try {
    const res = await window.electronAPI.pickExtension();
    if (!res || res.canceled) return;
    if (res.success) {
      await refreshExtensions();
      showMsg('Loaded: ' + (res.name || res.path.split('/').pop()) + ' ✓', 'ok');
    } else {
      showMsg('Failed: ' + (res.error || 'Unknown error'), 'err');
    }
  } finally {
    btn.textContent = '📁 Load unpacked extension';
    btn.disabled = false;
    if (panelOpen) requestAnimationFrame(pushBrowserView);
  }
}

/* ─────────────────────────────────────────────────────────── */
/* Extension: auto-install from Chrome Web Store               */
/* ─────────────────────────────────────────────────────────── */

async function installExt(extensionId, btnEl) {
  const installedEntry = extensionRegistry.find(ext => ext.storeId === extensionId || ext.id === extensionId);
  if (installedEntry) {
    await uninstallExt(extensionId, btnEl);
    return;
  }

  clearMsg();
  btnEl.textContent = '⏳';
  btnEl.disabled = true;

  showMsg('Downloading extension…', 'ok');
  if (panelOpen) requestAnimationFrame(pushBrowserView);

  try {
    const res = await window.electronAPI.installExtension(extensionId);
    if (res.success) {
      await refreshExtensions();
      showMsg('Installed! Use Enable/Disable to load it into AI Hub.', 'ok');
    } else {
      btnEl.textContent = 'Install';
      btnEl.disabled = false;
      showMsg('Failed: ' + (res.error || 'Unknown error'), 'err');
    }
  } catch (e) {
    btnEl.textContent = 'Install';
    btnEl.disabled = false;
    showMsg('Error: ' + e.message, 'err');
  } finally {
    if (panelOpen) requestAnimationFrame(pushBrowserView);
  }
}

async function uninstallExt(extensionId, btnEl) {
  clearMsg();
  btnEl.textContent = 'Removing…';
  btnEl.disabled = true;

  try {
    const res = await window.electronAPI.uninstallExtension(extensionId);
    if (res.success) {
      await refreshExtensions();
      showMsg('Extension removed from AI Hub', 'ok');
    } else {
      showMsg('Failed: ' + (res.error || 'Unknown error'), 'err');
    }
  } catch (e) {
    showMsg('Error: ' + e.message, 'err');
  }
}

async function toggleExt(extensionId, btnEl) {
  clearMsg();
  const currentlyEnabled = extensionRegistry.find(ext => ext.storeId === extensionId || ext.id === extensionId)?.enabled;
  btnEl.disabled = true;
  btnEl.textContent = currentlyEnabled ? 'Disabling…' : 'Enabling…';

  try {
    const res = await window.electronAPI.toggleExtension(extensionId, !currentlyEnabled);
    if (res.success) {
      await refreshExtensions();
      showMsg(currentlyEnabled ? 'Extension disabled' : 'Extension enabled for all tabs', 'ok');
    } else {
      showMsg('Failed: ' + (res.error || 'Unknown error'), 'err');
    }
  } catch (e) {
    showMsg('Error: ' + e.message, 'err');
  }
}

async function refreshExtensions() {
  extensionRegistry = await window.electronAPI.listExtensions();
  const byId = new Map();
  extensionRegistry.forEach(ext => {
    if (ext.storeId) byId.set(ext.storeId, ext);
    else if (ext.id) byId.set(ext.id, ext);
  });

  document.querySelectorAll('.p-ext-item[data-ext-id]').forEach(row => {
    const id = row.dataset.extId;
    const entry = byId.get(id);
    const statusEl = row.querySelector('.p-ext-status');
    const installBtn = row.querySelector('.p-ext-install');
    const toggleBtn = row.querySelector('.p-ext-toggle');

    if (!entry) {
      statusEl.textContent = 'Not installed';
      installBtn.textContent = 'Install';
      installBtn.disabled = false;
      installBtn.classList.remove('done', 'remove');
      toggleBtn.textContent = 'Enable';
      toggleBtn.disabled = true;
      toggleBtn.classList.remove('on');
      return;
    }

    statusEl.textContent = entry.enabled ? 'Enabled' : 'Installed';
    installBtn.textContent = 'Uninstall';
    installBtn.disabled = false;
    installBtn.classList.add('done');
    installBtn.classList.add('remove');
    toggleBtn.textContent = entry.enabled ? 'Disable' : 'Enable';
    toggleBtn.disabled = false;
    toggleBtn.classList.toggle('on', entry.enabled);
  });

  renderInstalledExtensions();
}

function renderInstalledExtensions() {
  const container = document.getElementById('installed-ext-list');
  const empty = document.getElementById('installed-ext-empty');
  if (!container || !empty) return;
  container.innerHTML = '';

  if (!extensionRegistry.length) {
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';

  extensionRegistry.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'p-ext-item';

    const name = document.createElement('span');
    name.className = 'p-ext-name';
    name.textContent = entry.name || entry.id || 'Extension';

    const badge = document.createElement('span');
    badge.className = 'p-ext-badge';
    badge.textContent = entry.source === 'store' ? 'Store' : 'Custom';

    const meta = document.createElement('span');
    meta.className = 'p-ext-meta';
    meta.textContent = entry.id || (entry.path ? entry.path.split('/').pop() : 'Unknown');

    const status = document.createElement('span');
    status.className = 'p-ext-status';
    status.textContent = entry.enabled ? 'Enabled' : 'Installed';

    const toggle = document.createElement('button');
    toggle.className = 'p-ext-toggle';
    toggle.textContent = entry.enabled ? 'Disable' : 'Enable';
    toggle.classList.toggle('on', entry.enabled);
    toggle.disabled = !entry.id;
    const lookupKey = entry.storeId || entry.id || entry.path;
    toggle.onclick = () => toggleExt(lookupKey, toggle);

    const remove = document.createElement('button');
    remove.className = 'p-ext-install remove';
    remove.textContent = 'Uninstall';
    remove.onclick = () => uninstallExt(lookupKey, remove);

    row.appendChild(name);
    row.appendChild(badge);
    row.appendChild(meta);
    row.appendChild(status);
    row.appendChild(toggle);
    row.appendChild(remove);
    container.appendChild(row);
  });
}

function openExt(url) { window.electronAPI.openExternal(url); }
