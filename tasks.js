const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_TASKS = 50;
const MAX_TITLE_LENGTH = 120;
const MAX_PROMPT_LENGTH = 8000;
const MAX_URL_LENGTH = 4096;
const TASK_STATUSES = ["queued", "doing", "ready", "done"];
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_QUERY_RE = /^(?:token|password|secret|bootstrapToken|access_token|refresh_token|id_token|code|session|auth|key)$/i;

const TRANSITIONS = {
  queued: new Set(["doing"]),
  doing: new Set(["ready", "done", "queued"]),
  ready: new Set(["doing", "done"]),
  done: new Set(["doing"]),
};

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from] && TRANSITIONS[from].has(to));
}

function isId(value) {
  return typeof value === "string" && ID_RE.test(value);
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeTitle(value) {
  if (typeof value !== "string") return { ok: false, error: "Title is required" };
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return { ok: false, error: "Title is required" };
  if (cleaned.length > MAX_TITLE_LENGTH) return { ok: false, error: "Title is too long" };
  return { ok: true, value: cleaned };
}

function sanitizePrompt(value) {
  if (value == null) return { ok: true, value: "" };
  if (typeof value !== "string") return { ok: false, error: "Prompt must be text" };
  const cleaned = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n/g, "\n");
  if (cleaned.length > MAX_PROMPT_LENGTH) return { ok: false, error: "Prompt is too long" };
  return { ok: true, value: cleaned };
}

function sanitizeStoredUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const trimmed = value.trim();
  if (trimmed.length > MAX_URL_LENGTH) return "";
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (SECRET_QUERY_RE.test(key)) parsed.searchParams.delete(key);
  }
  return parsed.href;
}

function createTasks(options = {}) {
  const getUserDataPath = options.getUserDataPath;
  const isKnownService = options.isKnownService || (() => false);
  const isServiceUrl = options.isServiceUrl || (() => false);
  const listServices = options.listServices || (() => []);
  const broadcast = options.broadcast || (() => {});

  let tasks = [];
  let workspace = "chat";
  let lastService = null;
  let capture = null;
  let revision = 0;
  let loaded = false;
  let chain = Promise.resolve();

  function known(service) {
    try {
      return typeof service === "string" && Boolean(isKnownService(service));
    } catch {
      return false;
    }
  }

  function urlAllowed(service, url) {
    try {
      return Boolean(isServiceUrl(service, url));
    } catch {
      return false;
    }
  }

  function knownServices() {
    let list = [];
    try {
      list = listServices() || [];
    } catch {
      return [];
    }
    if (!Array.isArray(list)) return [];
    const names = [];
    for (const name of list) {
      if (known(name) && !names.includes(name)) names.push(name);
    }
    return names;
  }

  function tasksFile() {
    return path.join(getUserDataPath(), "tasks.json");
  }

  function cloneAssignment(entry) {
    return {
      service: entry.service,
      status: entry.status,
      url: entry.url || null,
      attention: Boolean(entry.attention),
      updatedAt: entry.updatedAt,
    };
  }

  function cloneTask(entry) {
    return {
      id: entry.id,
      title: entry.title,
      prompt: entry.prompt,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      assignments: entry.assignments.map(cloneAssignment),
    };
  }

  function snapshot() {
    return {
      revision,
      workspace,
      lastService,
      capture: capture ? { taskId: capture.taskId, service: capture.service } : null,
      services: knownServices(),
      tasks: tasks.map(cloneTask),
    };
  }

  function publish() {
    revision += 1;
    const status = snapshot();
    try { broadcast(status); } catch {}
    return status;
  }

  function fail(error) {
    return { success: false, error, status: snapshot() };
  }

  function ok() {
    save();
    return { success: true, error: null, status: publish() };
  }

  function unchanged() {
    return { success: true, error: null, status: snapshot() };
  }

  function enqueue(task) {
    const run = chain.then(async () => {
      try {
        return await task();
      } catch (err) {
        return fail(err && err.message ? err.message : "Couldn't update tasks");
      }
    });
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  function writeAtomic(dest, body) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    if (process.platform !== "win32") {
      try { fs.chmodSync(tmp, 0o600); } catch {}
    }
    try {
      fs.renameSync(tmp, dest);
    } catch (err) {
      if (process.platform !== "win32") {
        try { fs.unlinkSync(tmp); } catch {}
        throw err;
      }
      try { fs.unlinkSync(dest); } catch {}
      try {
        fs.renameSync(tmp, dest);
      } catch (renameErr) {
        try { fs.unlinkSync(tmp); } catch {}
        throw renameErr;
      }
    }
    if (process.platform !== "win32") {
      try { fs.chmodSync(dest, 0o600); } catch {}
    }
  }

  function save() {
    const body = JSON.stringify({
      workspace,
      lastService,
      capture,
      tasks: tasks.map(cloneTask),
    }, null, 2);
    writeAtomic(tasksFile(), body);
  }

  function normalizeAssignment(entry, seen) {
    if (!entry || typeof entry !== "object") return null;
    const service = entry.service;
    if (!known(service) || seen.has(service)) return null;
    seen.add(service);
    const status = TASK_STATUSES.includes(entry.status) ? entry.status : "queued";
    const storedUrl = sanitizeStoredUrl(entry.url);
    const url = storedUrl && urlAllowed(service, storedUrl) ? storedUrl : null;
    const titleStamp = typeof entry.updatedAt === "string" && entry.updatedAt ? entry.updatedAt : nowIso();
    return {
      service,
      status,
      url,
      attention: entry.attention === true,
      updatedAt: titleStamp,
    };
  }

  function normalizeTask(entry) {
    if (!entry || !isId(entry.id)) return null;
    const title = sanitizeTitle(entry.title);
    const prompt = sanitizePrompt(entry.prompt);
    if (!title.ok || !prompt.ok) return null;
    const seen = new Set();
    const assignments = Array.isArray(entry.assignments)
      ? entry.assignments.map((item) => normalizeAssignment(item, seen)).filter(Boolean)
      : [];
    if (!assignments.length) return null;
    const createdAt = typeof entry.createdAt === "string" && entry.createdAt ? entry.createdAt : nowIso();
    const updatedAt = typeof entry.updatedAt === "string" && entry.updatedAt ? entry.updatedAt : createdAt;
    return {
      id: entry.id,
      title: title.value,
      prompt: prompt.value,
      createdAt,
      updatedAt,
      assignments,
    };
  }

  function applyRaw(raw) {
    workspace = raw && raw.workspace === "board" ? "board" : "chat";
    lastService = raw && known(raw.lastService) ? raw.lastService : null;
    tasks = Array.isArray(raw && raw.tasks) ? raw.tasks.map(normalizeTask).filter(Boolean).slice(0, MAX_TASKS) : [];
    // Don't resume a capture session from disk. The next tab load is the
    // service home page, and it would replace the saved chat URL.
    capture = null;
  }

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      applyRaw(JSON.parse(fs.readFileSync(tasksFile(), "utf8")));
    } catch {
      tasks = [];
      workspace = "chat";
      lastService = null;
      capture = null;
    }
  }

  function findTask(id) {
    if (!isId(id)) return null;
    return tasks.find((item) => item.id === id) || null;
  }

  function findAssignment(task, service) {
    if (!task || !known(service)) return null;
    return task.assignments.find((item) => item.service === service) || null;
  }

  function normalizeServiceList(services) {
    if (!Array.isArray(services) || services.length === 0) {
      return { ok: false, error: "Choose at least one service" };
    }
    const unique = [];
    for (const service of services) {
      if (!known(service)) return { ok: false, error: "Unknown service" };
      if (!unique.includes(service)) unique.push(service);
    }
    if (!unique.length) return { ok: false, error: "Choose at least one service" };
    return { ok: true, services: unique };
  }

  function create(payload) {
    return enqueue(() => {
      load();
      const body = payload && typeof payload === "object" ? payload : {};
      const title = sanitizeTitle(body.title);
      if (!title.ok) return fail(title.error);
      const prompt = sanitizePrompt(body.prompt);
      if (!prompt.ok) return fail(prompt.error);
      const services = normalizeServiceList(body.services);
      if (!services.ok) return fail(services.error);
      if (tasks.length >= MAX_TASKS) return fail("You can keep up to 50 tasks");
      const stamp = nowIso();
      tasks.push({
        id: crypto.randomUUID(),
        title: title.value,
        prompt: prompt.value,
        createdAt: stamp,
        updatedAt: stamp,
        assignments: services.services.map((service) => ({
          service,
          status: "queued",
          url: null,
          attention: false,
          updatedAt: stamp,
        })),
      });
      return ok();
    });
  }

  function update(payload) {
    return enqueue(() => {
      load();
      const body = payload && typeof payload === "object" ? payload : {};
      const task = findTask(body.id);
      if (!task) return fail("Unknown task");
      if (body.title === undefined && body.prompt === undefined) return fail("Nothing to update");
      if (body.title !== undefined) {
        const title = sanitizeTitle(body.title);
        if (!title.ok) return fail(title.error);
        task.title = title.value;
      }
      if (body.prompt !== undefined) {
        const prompt = sanitizePrompt(body.prompt);
        if (!prompt.ok) return fail(prompt.error);
        task.prompt = prompt.value;
      }
      task.updatedAt = nowIso();
      return ok();
    });
  }

  function remove(id) {
    return enqueue(() => {
      load();
      const task = findTask(id);
      if (!task) return fail("Unknown task");
      tasks = tasks.filter((item) => item.id !== task.id);
      if (capture && capture.taskId === task.id) capture = null;
      return ok();
    });
  }

  function setStatus(payload) {
    return enqueue(() => {
      load();
      const body = payload && typeof payload === "object" ? payload : {};
      const task = findTask(body.taskId);
      if (!task) return fail("Unknown task");
      const assignment = findAssignment(task, body.service);
      if (!assignment) return fail("Unknown service");
      if (!TASK_STATUSES.includes(body.status)) return fail("Unknown status");
      if (!canTransition(assignment.status, body.status)) {
        return fail(`Cannot change status from ${assignment.status} to ${body.status}`);
      }
      const stamp = nowIso();
      assignment.status = body.status;
      assignment.attention = false;
      assignment.updatedAt = stamp;
      task.updatedAt = stamp;
      return ok();
    });
  }

  function addAssignment(payload) {
    return enqueue(() => {
      load();
      const body = payload && typeof payload === "object" ? payload : {};
      const task = findTask(body.taskId);
      if (!task) return fail("Unknown task");
      if (!known(body.service)) return fail("Unknown service");
      if (task.assignments.some((item) => item.service === body.service)) {
        return fail("Service is already on this task");
      }
      const stamp = nowIso();
      task.assignments.push({
        service: body.service,
        status: "queued",
        url: null,
        attention: false,
        updatedAt: stamp,
      });
      task.updatedAt = stamp;
      return ok();
    });
  }

  function removeAssignment(payload) {
    return enqueue(() => {
      load();
      const body = payload && typeof payload === "object" ? payload : {};
      const task = findTask(body.taskId);
      if (!task) return fail("Unknown task");
      if (!task.assignments.some((item) => item.service === body.service)) {
        return fail("Unknown service");
      }
      if (task.assignments.length <= 1) return fail("A task needs at least one service");
      task.assignments = task.assignments.filter((item) => item.service !== body.service);
      if (capture && capture.taskId === task.id && capture.service === body.service) capture = null;
      task.updatedAt = nowIso();
      return ok();
    });
  }

  function open(payload) {
    return enqueue(() => {
      load();
      const body = payload && typeof payload === "object" ? payload : {};
      const task = findTask(body.taskId);
      if (!task) return fail("Unknown task");
      const assignment = findAssignment(task, body.service);
      if (!assignment) return fail("Unknown service");
      const stamp = nowIso();
      if (assignment.status === "queued") assignment.status = "doing";
      assignment.attention = false;
      assignment.updatedAt = stamp;
      task.updatedAt = stamp;
      capture = { taskId: task.id, service: assignment.service };
      workspace = "chat";
      lastService = assignment.service;
      return ok();
    });
  }

  function setWorkspace(next) {
    return enqueue(() => {
      load();
      if (next !== "chat" && next !== "board") return fail("Unknown workspace");
      if (workspace === next) return unchanged();
      workspace = next;
      return ok();
    });
  }

  function clearCapture() {
    return enqueue(() => {
      load();
      if (!capture) return unchanged();
      capture = null;
      return ok();
    });
  }

  function noteActivity(service) {
    return enqueue(() => {
      load();
      if (!known(service)) return unchanged();
      const stamp = nowIso();
      let changed = false;
      for (const task of tasks) {
        for (const assignment of task.assignments) {
          if (assignment.service !== service || assignment.status !== "doing" || assignment.attention) continue;
          assignment.attention = true;
          assignment.updatedAt = stamp;
          task.updatedAt = stamp;
          changed = true;
        }
      }
      if (!changed) return unchanged();
      return ok();
    });
  }

  function noteUrl(service, url) {
    return enqueue(() => {
      load();
      if (!known(service)) return fail("Unknown service");
      if (typeof url === "string" && url.trim().length > MAX_URL_LENGTH) {
        return fail("URL is too long");
      }
      const stored = sanitizeStoredUrl(url);
      if (!stored || !urlAllowed(service, url) || !urlAllowed(service, stored)) {
        return fail("URL does not belong to this service");
      }
      if (!capture || capture.service !== service) return unchanged();
      const task = findTask(capture.taskId);
      const assignment = findAssignment(task, service);
      if (!assignment) {
        capture = null;
        return ok();
      }
      if (assignment.url === stored) return unchanged();
      const stamp = nowIso();
      assignment.url = stored;
      assignment.updatedAt = stamp;
      task.updatedAt = stamp;
      return ok();
    });
  }

  function clearUrlsForService(service) {
    return enqueue(() => {
      load();
      if (!known(service)) return fail("Unknown service");
      let changed = false;
      const stamp = nowIso();
      for (const task of tasks) {
        for (const assignment of task.assignments) {
          if (assignment.service !== service || !assignment.url) continue;
          assignment.url = null;
          assignment.updatedAt = stamp;
          task.updatedAt = stamp;
          changed = true;
        }
      }
      if (capture && capture.service === service) {
        capture = null;
        changed = true;
      }
      if (!changed) return unchanged();
      return ok();
    });
  }

  return {
    list() {
      load();
      return snapshot();
    },
    status() {
      load();
      return snapshot();
    },
    create,
    update,
    delete: remove,
    setStatus,
    addAssignment,
    removeAssignment,
    open,
    setWorkspace,
    clearCapture,
    noteActivity,
    noteUrl,
    clearUrlsForService,
  };
}

module.exports = {
  createTasks,
  canTransition,
  sanitizeTitle,
  sanitizePrompt,
  sanitizeStoredUrl,
  TASK_STATUSES,
  MAX_TASKS,
  MAX_TITLE_LENGTH,
  MAX_PROMPT_LENGTH,
  MAX_URL_LENGTH,
};
