// @ts-check
const { session, webContents } = require("electron");
const { buildBlackholeProxyConfig, webrtcIpHandlingPolicy } = require("./wireguard");

function createProxyRouting(options = {}) {
  const accounts = options.accounts || (() => []);

  let proxyConfig = null;

  let tunnelProxy = null;
  let hubProxyPhase = "direct";

  function proxyForRoute(route) {
    if (route === "direct") return { mode: "direct" };
    if (hubProxyPhase === "dropped") return buildBlackholeProxyConfig();
    if (hubProxyPhase === "tunnel" && tunnelProxy) return tunnelProxy;
    return { mode: "direct" };
  }

  function applyWebRTCPolicyToContents(contents, route) {
    if (!contents || contents.isDestroyed()) return;
    if (typeof contents.setWebRTCIPHandlingPolicy !== "function") return;
    contents.setWebRTCIPHandlingPolicy(webrtcIpHandlingPolicy(route, hubProxyPhase));
  }

  function applyWebRTCPolicy(targetSession, route) {
    for (const contents of webContents.getAllWebContents()) {
      try {
        if (contents.isDestroyed() || contents.session !== targetSession) continue;
        applyWebRTCPolicyToContents(contents, route);
      } catch {}
    }
  }

  async function configureAccountProxy(account) {
    const target = session.fromPartition(account.partition);
    applyWebRTCPolicy(target, account.route);
    await target.setProxy(proxyForRoute(account.route));
    return target;
  }

  function shouldKeepConnections(partition) {
    return partition === "persist:OpenClaw" || partition.startsWith("persist:OpenClaw:");
  }

  async function applyRoutedProxy() {
    const routed = accounts();
    const targets = await Promise.all(routed.map((account) => configureAccountProxy(account)));
    await Promise.all(routed.map((account, index) => {
      if (shouldKeepConnections(account.partition)) return undefined;
      return targets[index].closeAllConnections().catch(() => {});
    }));
  }

  async function applyHubProxy(config) {
    tunnelProxy = config;
    hubProxyPhase = "tunnel";
    proxyConfig = config;
    await applyRoutedProxy();
  }

  async function clearHubProxy() {
    tunnelProxy = null;
    hubProxyPhase = "direct";
    proxyConfig = null;
    await applyRoutedProxy();
  }

  async function applyDroppedHubProxy() {
    hubProxyPhase = "dropped";
    proxyConfig = buildBlackholeProxyConfig();
    await applyRoutedProxy();
  }

  return {
    current: () => proxyConfig,
    applyHubProxy,
    clearHubProxy,
    applyDroppedHubProxy,
    configureAccountProxy,
    shouldKeepConnections,
    applyWebRTCPolicy,
    applyWebRTCPolicyToContents,
    proxyForRoute,
  };
}

module.exports = { createProxyRouting };
