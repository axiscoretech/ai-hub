const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_ACCOUNT = "default";
const OPENCLAW_ID = "OpenClaw";
const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HOTKEY_RE = /^(?:(?:CommandOrControl|Command|Control|Alt|Option|Shift|Super)\+)+[A-Za-z0-9]$/;
const LANG_RE = /^[a-z]{2}(?:-[A-Z]{2})?$/;
const DEFAULT_HOTKEY = "CommandOrControl+Shift+Space";

const BUILTINS = [
  { id: "ChatGPT", name: "ChatGPT", url: "https://chat.openai.com/" },
  { id: "Claude", name: "Claude", url: "https://claude.ai/" },
  { id: "Gemini", name: "Gemini", url: "https://gemini.google.com/" },
  { id: "DeepSeek", name: "DeepSeek", url: "https://chat.deepseek.com/" },
  { id: "Qwen", name: "Qwen", url: "https://chat.qwen.ai/" },
  { id: "Perplexity", name: "Perplexity", url: "https://www.perplexity.ai/" },
  { id: "Mistral", name: "Mistral", url: "https://chat.mistral.ai/" },
  { id: "Kimi", name: "Kimi", url: "https://www.kimi.com/" },
  { id: "Grok", name: "Grok", url: "https://grok.com/" },
  { id: OPENCLAW_ID, name: "OpenClaw", url: "http://127.0.0.1:18789/" },
];

function isAccountId(value) {
  return value === DEFAULT_ACCOUNT || (typeof value === "string" && ACCOUNT_RE.test(value));
}

function sanitizeLabel(value, fallback) {
  const cleaned = String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return cleaned || fallback;
}

function sanitizeHttpsUrl(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return "";
  let parsed;
  try { parsed = new URL(trimmed); } catch { return ""; }
  if (parsed.protocol !== "https:") return "";
  if (parsed.username || parsed.password) return "";
  return parsed.href;
}

function freshAccount(label) {
  return { id: DEFAULT_ACCOUNT, label: label || "Default" };
}

function freshService(builtin, order) {
  return {
    id: builtin.id,
    name: builtin.name,
    url: builtin.url,
    builtin: true,
    route: builtin.id === OPENCLAW_ID ? "direct" : "tunnel",
    hidden: false,
    order,
    zoom: 1,
    activeAccountId: DEFAULT_ACCOUNT,
    accounts: [freshAccount("Default")],
  };
}

function createServices(options = {}) {
  const getUserDataPath = options.getUserDataPath;
  const broadcast = options.broadcast || (() => {});
  const openclawUrl = sanitizeHttpsUrl(options.openclawUrl) || options.openclawUrl || BUILTINS.find((item) => item.id === OPENCLAW_ID).url;

  let services = [];
  let hotkey = DEFAULT_HOTKEY;
  let spellcheckLanguages = [];
  let revision = 0;
  let loaded = false;
  let chain = Promise.resolve();

  function catalog() {
    return BUILTINS.map((item) => (
      item.id === OPENCLAW_ID ? { ...item, url: openclawUrl || item.url } : { ...item }
    ));
  }

  function file() {
    return path.join(getUserDataPath(), "services.json");
  }

  function knownId(id) {
    return services.some((item) => item.id === id);
  }

  function findService(id) {
    return services.find((item) => item.id === id) || null;
  }

  function partitionFor(serviceId, accountId) {
    const service = findService(serviceId);
    if (!service) return "";
    const account = accountId || service.activeAccountId || DEFAULT_ACCOUNT;
    if (!service.accounts.some((item) => item.id === account)) return "";
    if (account === DEFAULT_ACCOUNT) return `persist:${service.id}`;
    return `persist:${service.id}:${account}`;
  }

  function publicAccount(service, account) {
    return {
      id: account.id,
      label: account.label,
      partition: partitionFor(service.id, account.id),
    };
  }

  function publicService(service) {
    return {
      id: service.id,
      name: service.name,
      url: service.url,
      builtin: service.builtin === true,
      route: service.route === "direct" ? "direct" : "tunnel",
      hidden: service.hidden === true,
      order: service.order,
      zoom: service.zoom,
      activeAccountId: service.activeAccountId,
      accounts: service.accounts.map((account) => publicAccount(service, account)),
    };
  }

  function snapshot() {
    const ordered = [...services].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    return {
      revision,
      hotkey,
      spellcheckLanguages: [...spellcheckLanguages],
      services: ordered.map(publicService),
    };
  }

  function publish() {
    revision += 1;
    const status = snapshot();
    try { broadcast(status); } catch {}
    return status;
  }

  function save() {
    const dest = file();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const body = JSON.stringify({
      hotkey,
      spellcheckLanguages,
      rememberTabVisibility: true,
      services: services.map((service) => ({
        id: service.id,
        name: service.name,
        url: service.url,
        builtin: service.builtin === true,
        route: service.route,
        hidden: service.hidden === true,
        order: service.order,
        zoom: service.zoom,
        activeAccountId: service.activeAccountId,
        accounts: service.accounts.map((account) => ({ id: account.id, label: account.label })),
      })),
    }, null, 2);
    const tmp = `${dest}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, dest);
  }

  function normalizeAccount(entry, seen) {
    if (!entry || !isAccountId(entry.id) || seen.has(entry.id)) return null;
    seen.add(entry.id);
    return { id: entry.id, label: sanitizeLabel(entry.label, entry.id === DEFAULT_ACCOUNT ? "Default" : "Account") };
  }

  function normalizeStored(entry, order) {
    if (!entry || typeof entry.id !== "string") return null;
    const builtin = catalog().find((item) => item.id === entry.id);
    const customUrl = sanitizeHttpsUrl(entry.url);
    if (!builtin && !customUrl) return null;
    if (!builtin && !/^[0-9a-f-]{36}$/i.test(entry.id)) return null;
    const seen = new Set();
    let accounts = Array.isArray(entry.accounts)
      ? entry.accounts.map((item) => normalizeAccount(item, seen)).filter(Boolean)
      : [];
    if (!accounts.some((item) => item.id === DEFAULT_ACCOUNT)) {
      accounts = [freshAccount("Default"), ...accounts];
    }
    const active = accounts.some((item) => item.id === entry.activeAccountId)
      ? entry.activeAccountId
      : DEFAULT_ACCOUNT;
    const zoom = Number(entry.zoom);
    return {
      id: builtin ? builtin.id : entry.id,
      name: builtin ? builtin.name : sanitizeLabel(entry.name, "Service"),
      url: builtin ? builtin.url : customUrl,
      builtin: Boolean(builtin),
      route: entry.id === OPENCLAW_ID ? "direct" : (entry.route === "direct" ? "direct" : "tunnel"),
      hidden: entry.hidden === true,
      order: Number.isInteger(entry.order) ? entry.order : order,
      zoom: Number.isFinite(zoom) ? Math.min(3, Math.max(0.5, zoom)) : 1,
      activeAccountId: active,
      accounts,
    };
  }

  function seed() {
    services = catalog().map((item, index) => freshService(item, index));
    hotkey = DEFAULT_HOTKEY;
    spellcheckLanguages = [];
  }

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
      const stored = Array.isArray(raw.services) ? raw.services : [];
      services = stored.map((item, index) => normalizeStored(item, index)).filter(Boolean);
      const have = new Set(services.map((item) => item.id));
      catalog().forEach((builtin, index) => {
        if (!have.has(builtin.id)) services.push(freshService(builtin, services.length + index));
      });
      hotkey = typeof raw.hotkey === "string" && HOTKEY_RE.test(raw.hotkey) ? raw.hotkey : DEFAULT_HOTKEY;
      spellcheckLanguages = Array.isArray(raw.spellcheckLanguages)
        ? raw.spellcheckLanguages.filter((item) => typeof item === "string" && LANG_RE.test(item)).slice(0, 4)
        : [];
      if (raw.rememberTabVisibility !== true) {
        const openclaw = services.find((item) => item.id === OPENCLAW_ID);
        if (openclaw && openclaw.hidden) {
          openclaw.hidden = false;
          save();
        }
      }
    } catch {
      seed();
    }
  }

  function enqueue(task) {
    const run = chain.then(task, task);
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  function accountsFlat() {
    load();
    const rows = [];
    for (const service of services) {
      for (const account of service.accounts) {
        rows.push({
          serviceId: service.id,
          accountId: account.id,
          label: account.label,
          route: service.route === "direct" ? "direct" : "tunnel",
          partition: partitionFor(service.id, account.id),
          hidden: service.hidden === true,
          url: service.url,
        });
      }
    }
    return rows;
  }

  function useAccount(serviceId, accountId) {
    load();
    const service = findService(serviceId);
    if (!service || !service.accounts.some((item) => item.id === accountId)) return false;
    if (service.activeAccountId !== accountId) {
      service.activeAccountId = accountId;
      save();
      publish();
    }
    return true;
  }

  return {
    list() {
      load();
      return snapshot();
    },
    known(id) {
      load();
      return knownId(id);
    },
    ids() {
      load();
      return services.map((item) => item.id);
    },
    url(id) {
      load();
      const service = findService(id);
      return service ? service.url : "";
    },
    hidden(id) {
      load();
      const service = findService(id);
      return Boolean(service && service.hidden);
    },
    route(id) {
      load();
      const service = findService(id);
      return service && service.route === "direct" ? "direct" : "tunnel";
    },
    zoom(id) {
      load();
      const service = findService(id);
      return service ? service.zoom : 1;
    },
    activeAccountId(id) {
      load();
      const service = findService(id);
      return service ? service.activeAccountId : DEFAULT_ACCOUNT;
    },
    useAccount,
    partitionFor(serviceId, accountId) {
      load();
      return partitionFor(serviceId, accountId);
    },
    accounts: accountsFlat,
    hotkey() {
      load();
      return hotkey;
    },
    spellcheckLanguages() {
      load();
      return [...spellcheckLanguages];
    },
    setRoute(id, route) {
      return enqueue(async () => {
        load();
        const service = findService(id);
        if (!service) throw new Error("Unknown service");
        if (service.id === OPENCLAW_ID) return snapshot();
        const next = route === "direct" ? "direct" : "tunnel";
        if (service.route === next) return snapshot();
        service.route = next;
        save();
        return publish();
      });
    },
    setHidden(id, hidden) {
      return enqueue(async () => {
        load();
        const service = findService(id);
        if (!service) throw new Error("Unknown service");
        service.hidden = hidden === true;
        save();
        return publish();
      });
    },
    reorder(ids) {
      return enqueue(async () => {
        load();
        if (!Array.isArray(ids)) throw new Error("Unknown service order");
        const known = new Set(services.map((item) => item.id));
        const next = [];
        for (const id of ids) {
          if (!known.has(id) || next.includes(id)) continue;
          next.push(id);
        }
        for (const service of services) {
          if (!next.includes(service.id)) next.push(service.id);
        }
        next.forEach((id, index) => {
          const service = findService(id);
          if (service) service.order = index;
        });
        save();
        return publish();
      });
    },
    addAccount(serviceId, label) {
      return enqueue(async () => {
        load();
        const service = findService(serviceId);
        if (!service) throw new Error("Unknown service");
        if (service.accounts.length >= 8) throw new Error("This service already has 8 accounts");
        const account = {
          id: crypto.randomUUID(),
          label: sanitizeLabel(label, `Account ${service.accounts.length + 1}`),
        };
        service.accounts.push(account);
        service.activeAccountId = account.id;
        save();
        return publish();
      });
    },
    setActiveAccount(serviceId, accountId) {
      return enqueue(async () => {
        if (!useAccount(serviceId, accountId)) throw new Error("Unknown account");
        return snapshot();
      });
    },
    setAccountLabel(serviceId, accountId, label) {
      return enqueue(async () => {
        load();
        const service = findService(serviceId);
        if (!service) throw new Error("Unknown service");
        const account = service.accounts.find((item) => item.id === accountId);
        if (!account) throw new Error("Unknown account");
        account.label = sanitizeLabel(label, account.label);
        save();
        return publish();
      });
    },
    removeAccount(serviceId, accountId) {
      return enqueue(async () => {
        load();
        const service = findService(serviceId);
        if (!service) throw new Error("Unknown service");
        if (accountId === DEFAULT_ACCOUNT) throw new Error("The first account stays on this service");
        if (service.accounts.length <= 1) throw new Error("A service needs an account");
        if (!service.accounts.some((item) => item.id === accountId)) throw new Error("Unknown account");
        service.accounts = service.accounts.filter((item) => item.id !== accountId);
        if (service.activeAccountId === accountId) service.activeAccountId = DEFAULT_ACCOUNT;
        save();
        return publish();
      });
    },
    addCustom(name, url) {
      return enqueue(async () => {
        load();
        const href = sanitizeHttpsUrl(url);
        if (!href) throw new Error("Enter an https address");
        if (services.length >= 30) throw new Error("Too many services");
        const service = {
          id: crypto.randomUUID(),
          name: sanitizeLabel(name, "Service"),
          url: href,
          builtin: false,
          route: "tunnel",
          hidden: false,
          order: services.length,
          zoom: 1,
          activeAccountId: DEFAULT_ACCOUNT,
          accounts: [freshAccount("Default")],
        };
        services.push(service);
        save();
        return publish();
      });
    },
    removeCustom(id) {
      return enqueue(async () => {
        load();
        const service = findService(id);
        if (!service) throw new Error("Unknown service");
        if (service.builtin) throw new Error("Built-in services stay in the list");
        services = services.filter((item) => item.id !== id);
        save();
        return publish();
      });
    },
    setZoom(id, zoom) {
      return enqueue(async () => {
        load();
        const service = findService(id);
        if (!service) throw new Error("Unknown service");
        const value = Number(zoom);
        if (!Number.isFinite(value)) throw new Error("Invalid zoom");
        service.zoom = Math.min(3, Math.max(0.5, Math.round(value * 100) / 100));
        save();
        return publish();
      });
    },
    setHotkey(value) {
      return enqueue(async () => {
        load();
        const next = String(value || "").trim();
        if (next && !HOTKEY_RE.test(next)) throw new Error("That shortcut is not supported");
        hotkey = next || DEFAULT_HOTKEY;
        save();
        return publish();
      });
    },
    setSpellcheckLanguages(languages) {
      return enqueue(async () => {
        load();
        const next = Array.isArray(languages)
          ? languages.filter((item) => typeof item === "string" && LANG_RE.test(item)).slice(0, 4)
          : [];
        spellcheckLanguages = next;
        save();
        return publish();
      });
    },
  };
}

module.exports = {
  createServices,
  DEFAULT_ACCOUNT,
  DEFAULT_HOTKEY,
  OPENCLAW_ID,
};
