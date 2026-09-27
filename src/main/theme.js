// @ts-check
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
  /** @type {"dark" | "light" | "system"} */
  let contentTheme = "dark";

  // Tab pages live outside the shell document. Point Chromium's
  // prefers-color-scheme at the hub theme before any of those pages load.
  nativeTheme.themeSource = contentTheme;

  /** @returns {"dark" | "light" | "system"} */
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
      // A drag region in a guest page (ChatGPT's header is .draggable) swallows
      // every click over it inside a WebContentsView, no-drag buttons included.
      const key = await webContents.insertCSS(
        `html { color-scheme: ${scheme} !important; }
         *, *::before, *::after {
           app-region: no-drag !important;
           -webkit-app-region: no-drag !important;
         }`,
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
    installHideScrollbars(webContents);
  }

  // scrollbar-width only. width:0 / display:none on ::-webkit-scrollbar makes a
  // flex chat column grow to the full transcript, so the composer leaves the
  // screen and scrolling the page carries the header with it.
  const hideScrollbarsScript = `(() => {
    const css = "* { scrollbar-width: none !important; }";
    const stamp = (root) => {
      if (!root || !root.appendChild) return;
      try {
        if (root.querySelector && root.querySelector("style[data-aihub-scrollbars]")) return;
        const style = document.createElement("style");
        style.setAttribute("data-aihub-scrollbars", "");
        style.textContent = css;
        if (root.head) root.head.appendChild(style);
        else root.appendChild(style);
      } catch {}
    };
    const walk = (root) => {
      stamp(root);
      let nodes = [];
      try { nodes = root.querySelectorAll ? root.querySelectorAll("*") : []; } catch { return; }
      for (const el of nodes) {
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    const paint = () => {
      try { walk(document); } catch {}
      let frames = [];
      try { frames = document.querySelectorAll("iframe"); } catch { frames = []; }
      for (const frame of frames) {
        try { if (frame.contentDocument) walk(frame.contentDocument); } catch {}
      }
    };
    try {
      const orig = Element.prototype.attachShadow;
      if (orig && !orig.__aiHubScrollbars) {
        const wrapped = function (init) {
          const shadow = orig.call(this, init);
          try { stamp(shadow); } catch {}
          return shadow;
        };
        wrapped.__aiHubScrollbars = true;
        Element.prototype.attachShadow = wrapped;
      }
    } catch {}
    if (!window.__aiHubHideBars) {
      window.__aiHubHideBars = true;
      setInterval(() => { try { paint(); } catch {} }, 2000);
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", paint, { once: true });
    }
    paint();
  })()`;

  const scrollbarHooks = new WeakSet();

  function ensureDebugger(webContents) {
    if (!webContents || webContents.isDestroyed()) return Promise.resolve(null);
    const dbg = webContents.debugger;
    try {
      if (!dbg.isAttached()) dbg.attach("1.3");
    } catch {
      return Promise.resolve(null);
    }
    return Promise.resolve(dbg);
  }

  function installScrollbarHook(webContents) {
    if (!webContents || webContents.isDestroyed() || isHubWebContents(webContents)) return Promise.resolve();
    if (scrollbarHooks.has(webContents)) return Promise.resolve();
    scrollbarHooks.add(webContents);
    const attempt = ensureDebugger(webContents).then((dbg) => {
      if (!dbg) return;
      return dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: hideScrollbarsScript });
    }).catch(() => {});
    return Promise.race([
      attempt,
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  }

  function installHideScrollbars(webContents) {
    if (!webContents || webContents.isDestroyed() || isHubWebContents(webContents)) return;
    const run = (frame) => {
      if (!frame || (typeof frame.isDestroyed === "function" && frame.isDestroyed())) return;
      frame.executeJavaScript(hideScrollbarsScript).catch(() => {});
      const children = frame.frames || [];
      for (const child of children) run(child);
    };
    try { run(webContents.mainFrame); } catch {
      webContents.executeJavaScript(hideScrollbarsScript).catch(() => {});
    }
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
    if (!webContents) return Promise.resolve();
    const ready = installScrollbarHook(webContents);
    webContents.on("did-finish-load", () => {
      void applyGuestColorScheme(webContents);
    });
    webContents.on("did-frame-finish-load", () => {
      installHideScrollbars(webContents);
    });
    return ready;
  }

  const scrollWatchScript = `(() => {
    if (window.__aiHubScrollWatch) return;
    window.__aiHubScrollWatch = true;
    let target = null;
    const pageBox = (el) => el === document.documentElement || el === document.body || el === document.scrollingElement;
    const pick = () => {
      let best = null;
      let score = 0;
      const visit = (root) => {
        if (!root || !root.querySelectorAll) return;
        for (const el of root.querySelectorAll("*")) {
          if (pageBox(el)) continue;
          let style;
          try { style = getComputedStyle(el); } catch { continue; }
          const oy = style.overflowY;
          if (oy === "auto" || oy === "scroll" || oy === "overlay") {
            const delta = el.scrollHeight - el.clientHeight;
            const rect = el.getBoundingClientRect();
            const weight = delta * rect.height;
            if (delta > 24 && rect.height > 160 && rect.width > 160 && weight > score) {
              best = el;
              score = weight;
            }
          }
          if (el.shadowRoot) visit(el.shadowRoot);
        }
      };
      visit(document);
      return best;
    };
    const reversed = (el) => {
      if (el.scrollTop < 0) return true;
      let node = el;
      for (let i = 0; node && i < 4; i += 1) {
        const style = getComputedStyle(node);
        if (style.flexDirection === "column-reverse" || style.flexDirection === "row-reverse") return true;
        node = node.parentElement;
      }
      return false;
    };
    const metrics = (el) => {
      const height = el.scrollHeight || 0;
      const client = el.clientHeight || 0;
      const max = Math.max(0, height - client);
      const raw = el.scrollTop || 0;
      const fromTop = reversed(el) ? max + Math.min(0, raw) : Math.max(0, raw);
      return { hidden: max <= 8, fromTop, max, height, client };
    };
    const publish = () => {
      const el = target && target.isConnected !== false ? target : (target = pick());
      if (!el) {
        console.log("__AIHUB_SCROLL__" + JSON.stringify({ hidden: true }));
        return;
      }
      console.log("__AIHUB_SCROLL__" + JSON.stringify(metrics(el)));
    };
    window.__aiHubScrollTo = (ratio) => {
      const el = target && target.isConnected !== false ? target : (target = pick());
      if (!el) return;
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      const fromTop = Math.min(1, Math.max(0, Number(ratio) || 0)) * max;
      el.scrollTop = reversed(el) ? fromTop - max : fromTop;
      publish();
    };
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; publish(); });
    };
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("wheel", () => { target = pick(); schedule(); }, { capture: true, passive: true });
    setInterval(() => { target = pick(); publish(); }, 1200);
    publish();
  })()`;

  const scrollAttached = new WeakSet();

  function attachPageScroll(webContents) {
    if (!webContents || scrollAttached.has(webContents)) return;
    scrollAttached.add(webContents);
    const onScroll = options.onScroll || (() => {});
    webContents.on("console-message", (event, _level, message) => {
      const text = event && typeof event.message === "string" ? event.message : message;
      if (typeof text !== "string" || !text.startsWith("__AIHUB_SCROLL__")) return;
      try { onScroll(webContents, JSON.parse(text.slice("__AIHUB_SCROLL__".length))); } catch {}
    });
    const install = () => {
      if (!webContents.isDestroyed()) webContents.executeJavaScript(scrollWatchScript).catch(() => {});
    };
    webContents.on("dom-ready", install);
    install();
  }

  ipcMain.on("set-content-theme", (_event, theme) => {
    applyContentTheme(theme);
  });

  return {
    themeColor,
    paintViewTheme,
    attachGuestTheme,
    attachPageScroll,
    applyContentTheme,
    applyGuestColorScheme,
  };
}

module.exports = { createTheme };
