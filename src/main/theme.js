const { BrowserWindow, nativeTheme, ipcMain } = require("electron");

const THEME_COLORS = {
  dark: "#1e1e1e",
  light: "#f3f5f9",
};

function createTheme(options = {}) {
  const getWin = options.window || (() => null);
  const getViews = options.views || (() => ({}));
  const getParked = options.parkedViews || (() => new Map());
  const getCompareSlots = options.compareSlots || (() => []);
  const isViewUsable = options.isViewUsable || (() => false);
  let contentTheme = "dark";

  // Tab pages live outside the shell document. Point Chromium's
  // prefers-color-scheme at the hub theme before any of those pages load.
  nativeTheme.themeSource = contentTheme;

  function normalizeTheme(theme) {
    if (theme === "light" || theme === "dark" || theme === "system") return theme;
    return "dark";
  }

  function resolvedContentTheme() {
    if (contentTheme === "system") return nativeTheme.shouldUseDarkColors ? "dark" : "light";
    return contentTheme === "light" ? "light" : "dark";
  }

  function themeColor() {
    return THEME_COLORS[resolvedContentTheme()];
  }

  function guestThemeScript() {
    const theme = resolvedContentTheme();
    return `(() => {
      const theme = ${JSON.stringify(theme)};
      const dark = theme === "dark";
      const root = document.documentElement;
      if (!root) return;
      root.style.colorScheme = theme;

      const syncEl = (el) => {
        if (!el || !el.classList) return;
        if (el.classList.contains("dark") || el.classList.contains("light")) {
          el.classList.toggle("dark", dark);
          el.classList.toggle("light", !dark);
        }
        if (el.classList.contains("theme-dark") || el.classList.contains("theme-light")) {
          el.classList.toggle("theme-dark", dark);
          el.classList.toggle("theme-light", !dark);
        }
        for (const attr of ["data-theme", "data-bs-theme", "data-color-mode", "data-mode"]) {
          const value = el.getAttribute(attr);
          if (value === "light" || value === "dark") el.setAttribute(attr, theme);
        }
      };

      syncEl(root);
      syncEl(document.body);
    })()`;
  }

  function isHubWebContents(webContents) {
    return !!(getWin() && !getWin().isDestroyed() && webContents && webContents === getWin().webContents);
  }

  const insertedThemeCss = new WeakMap();

  function syncGuestColorScheme(webContents) {
    if (!webContents || webContents.isDestroyed() || isHubWebContents(webContents)) return;
    try {
      const result = webContents.executeJavaScript(guestThemeScript());
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {}
  }

  async function applyGuestColorScheme(webContents) {
    if (!webContents || webContents.isDestroyed() || isHubWebContents(webContents)) return;
    const scheme = resolvedContentTheme();
    try {
      const previous = insertedThemeCss.get(webContents);
      if (previous) await webContents.removeInsertedCSS(previous);
      const key = await webContents.insertCSS(
        `html { color-scheme: ${scheme} !important; }`,
        { cssOrigin: "user" },
      );
      insertedThemeCss.set(webContents, key);
    } catch {}
    try {
      const dbg = webContents.debugger;
      if (!dbg.isAttached()) dbg.attach("1.3");
      await dbg.sendCommand("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: scheme }],
      });
    } catch {}
    syncGuestColorScheme(webContents);
  }

  function eachGuestView(visit) {
    const seen = new Set();
    const take = (view) => {
      if (!isViewUsable(view) || seen.has(view)) return;
      seen.add(view);
      visit(view);
    };
    for (const view of Object.values(getViews())) take(view);
    for (const view of getParked().values()) take(view);
    for (const slot of getCompareSlots()) take(slot.view);
  }

  function paintViewTheme(view) {
    if (!view) return;
    try { view.setBackgroundColor(themeColor()); } catch {}
  }

  function applyContentTheme(theme) {
    contentTheme = normalizeTheme(theme);
    if (nativeTheme.themeSource !== contentTheme) nativeTheme.themeSource = contentTheme;
    const color = themeColor();

    if (getWin() && !getWin().isDestroyed()) {
      try { getWin().setBackgroundColor(color); } catch {}
    }

    eachGuestView((view) => {
      paintViewTheme(view);
      void applyGuestColorScheme(view.webContents);
    });

    for (const window of BrowserWindow.getAllWindows()) {
      if (!window || window.isDestroyed() || window === getWin()) continue;
      try {
        const url = window.webContents.getURL() || "";
        if (url.startsWith("devtools://")) continue;
      } catch {}
      try { window.setBackgroundColor(color); } catch {}
      void applyGuestColorScheme(window.webContents);
    }
  }

  nativeTheme.on("updated", () => {
    if (contentTheme !== "system") return;
    applyContentTheme("system");
  });

  function attachGuestTheme(webContents) {
    if (!webContents) return;
    webContents.on("did-finish-load", () => {
      void applyGuestColorScheme(webContents);
    });
  }

  ipcMain.on("set-content-theme", (_event, theme) => {
    applyContentTheme(theme);
  });

  return {
    themeColor,
    paintViewTheme,
    attachGuestTheme,
    applyContentTheme,
    applyGuestColorScheme,
  };
}

module.exports = { createTheme };
