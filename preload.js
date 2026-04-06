const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  switchTab:        (tabName) => ipcRenderer.send("switch-tab", tabName),
  onTabActive:      (cb)      => ipcRenderer.on("tab-active", (_e, name) => cb(name)),
  onTabProgress:    (cb)      => ipcRenderer.on("tab-progress", (_e, name, event) => cb(name, event)),
  setTopBarHeight:  (h)       => ipcRenderer.send("set-topbar-height", h),
  reloadActiveTab:  (ignoreCache) => ipcRenderer.send("reload-active-tab", ignoreCache),
  resetTabSession:  (tabName)  => ipcRenderer.invoke("reset-tab-session", tabName),
  setProxy:         (config)  => ipcRenderer.invoke("set-proxy", config),
  clearProxy:       ()        => ipcRenderer.invoke("clear-proxy"),
  pickExtension:    ()        => ipcRenderer.invoke("pick-extension"),
  installExtension: (id)      => ipcRenderer.invoke("install-extension", id),
  listExtensions:   ()        => ipcRenderer.invoke("list-extensions"),
  toggleExtension:  (id, enabled) => ipcRenderer.invoke("toggle-extension", id, enabled),
  uninstallExtension: (id)    => ipcRenderer.invoke("uninstall-extension", id),
  openExternal:     (url)     => ipcRenderer.send("open-external", url),
});
