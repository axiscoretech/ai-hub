const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createTasks } = require("../tasks");

const KNOWN = new Set(["ChatGPT", "Claude", "OpenClaw"]);
const HOSTS = {
  ChatGPT: new Set(["chatgpt.com", "chat.openai.com"]),
  Claude: new Set(["claude.ai"]),
  OpenClaw: new Set(["127.0.0.1", "localhost"]),
};

function makeApi() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-hub-tasks-"));
  const api = createTasks({
    getUserDataPath: () => dir,
    isKnownService: (name) => KNOWN.has(name),
    isServiceUrl: (service, url) => {
      try {
        return Boolean(HOSTS[service] && HOSTS[service].has(new URL(url).hostname));
      } catch {
        return false;
      }
    },
    listServices: () => ["ChatGPT", "Claude", "OpenClaw"],
    broadcast: () => {},
  });
  return {
    dir,
    api,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function assignment(status, id, service) {
  const task = status.tasks.find((item) => item.id === id);
  assert.ok(task, "task missing");
  const found = task.assignments.find((item) => item.service === service);
  assert.ok(found, "assignment missing");
  return found;
}

test("create task", async (t) => {
  const ctx = makeApi();
  t.after(() => ctx.cleanup());
  const created = await ctx.api.create({
    title: "Hello\u0000 world",
    prompt: "Line one\nLine\u0000two",
    services: ["ChatGPT", "Claude"],
  });
  assert.equal(created.success, true);
  assert.equal(created.error, null);
  assert.equal(created.status.tasks.length, 1);
  assert.equal(created.status.workspace, "chat");
  assert.equal(created.status.capture, null);
  assert.deepEqual(created.status.services, ["ChatGPT", "Claude", "OpenClaw"]);
  const task = created.status.tasks[0];
  assert.match(task.id, /^[0-9a-f-]{36}$/i);
  assert.equal(task.title, "Hello world");
  assert.equal(task.prompt, "Line one\nLinetwo");
  assert.equal(task.assignments.length, 2);
  assert.deepEqual(task.assignments.map((item) => item.service), ["ChatGPT", "Claude"]);
  assert.equal(task.assignments[0].status, "queued");
  assert.equal(task.assignments[0].url, null);
  assert.equal(task.assignments[0].attention, false);
  assert.ok(task.createdAt);
  assert.ok(task.updatedAt);
});

test("unknown service is rejected", async (t) => {
  const ctx = makeApi();
  t.after(() => ctx.cleanup());
  const created = await ctx.api.create({
    title: "Nope",
    prompt: "text",
    services: ["ChatGPT", "Bing"],
  });
  assert.equal(created.success, false);
  assert.equal(created.error, "Unknown service");
  assert.equal(created.status.tasks.length, 0);
  assert.equal(ctx.api.list().revision, created.status.revision);
});

test("empty assignments are rejected", async (t) => {
  const ctx = makeApi();
  t.after(() => ctx.cleanup());
  const created = await ctx.api.create({ title: "Empty", prompt: "text", services: [] });
  assert.equal(created.success, false);
  assert.equal(created.error, "Choose at least one service");
  assert.equal(ctx.api.list().tasks.length, 0);

  const made = await ctx.api.create({ title: "One", prompt: "text", services: ["ChatGPT"] });
  const id = made.status.tasks[0].id;
  const removed = await ctx.api.removeAssignment({ taskId: id, service: "ChatGPT" });
  assert.equal(removed.success, false);
  assert.equal(removed.error, "A task needs at least one service");
  assert.equal(ctx.api.list().tasks[0].assignments.length, 1);
});

test("title, prompt, and task count limits", async (t) => {
  const ctx = makeApi();
  t.after(() => ctx.cleanup());
  const ok = await ctx.api.create({
    title: "t".repeat(120),
    prompt: "p".repeat(8000),
    services: ["ChatGPT"],
  });
  assert.equal(ok.success, true);
  assert.equal(ok.status.tasks[0].title.length, 120);
  assert.equal(ok.status.tasks[0].prompt.length, 8000);

  const longTitle = await ctx.api.create({
    title: "t".repeat(121),
    prompt: "short",
    services: ["ChatGPT"],
  });
  assert.equal(longTitle.success, false);
  assert.equal(longTitle.error, "Title is too long");

  const longPrompt = await ctx.api.create({
    title: "Short",
    prompt: "p".repeat(8001),
    services: ["ChatGPT"],
  });
  assert.equal(longPrompt.success, false);
  assert.equal(longPrompt.error, "Prompt is too long");

  while (ctx.api.list().tasks.length < 50) {
    const next = await ctx.api.create({
      title: `Task ${ctx.api.list().tasks.length}`,
      prompt: "body",
      services: ["Claude"],
    });
    assert.equal(next.success, true);
  }
  const before = ctx.api.list().revision;
  const overflow = await ctx.api.create({ title: "One more", prompt: "no", services: ["Claude"] });
  assert.equal(overflow.success, false);
  assert.equal(overflow.error, "You can keep up to 50 tasks");
  assert.equal(overflow.status.tasks.length, 50);
  assert.equal(overflow.status.revision, before);
});

test("status transitions are accepted or rejected", async (t) => {
  const ctx = makeApi();
  t.after(() => ctx.cleanup());
  const created = await ctx.api.create({ title: "Status", prompt: "p", services: ["ChatGPT"] });
  const id = created.status.tasks[0].id;
  const accepted = [
    ["queued", "doing"],
    ["doing", "ready"],
    ["ready", "doing"],
    ["doing", "done"],
    ["done", "doing"],
    ["doing", "queued"],
  ];
  for (const [from, to] of accepted) {
    assert.equal(assignment(ctx.api.list(), id, "ChatGPT").status, from);
    const res = await ctx.api.setStatus({ taskId: id, service: "ChatGPT", status: to });
    assert.equal(res.success, true, `${from} -> ${to}`);
    assert.equal(assignment(res.status, id, "ChatGPT").status, to);
  }

  assert.equal(assignment(ctx.api.list(), id, "ChatGPT").status, "queued");
  for (const bad of ["ready", "done", "queued"]) {
    const before = ctx.api.list().revision;
    const res = await ctx.api.setStatus({ taskId: id, service: "ChatGPT", status: bad });
    assert.equal(res.success, false, `queued -> ${bad}`);
    assert.equal(assignment(res.status, id, "ChatGPT").status, "queued");
    assert.equal(res.status.revision, before);
  }

  assert.equal((await ctx.api.setStatus({ taskId: id, service: "ChatGPT", status: "doing" })).success, true);
  const unknown = await ctx.api.setStatus({ taskId: id, service: "ChatGPT", status: "shipped" });
  assert.equal(unknown.success, false);
  assert.equal(unknown.error, "Unknown status");
  assert.equal(assignment(ctx.api.list(), id, "ChatGPT").status, "doing");

  assert.equal((await ctx.api.setStatus({ taskId: id, service: "ChatGPT", status: "ready" })).success, true);
  const readyQueued = await ctx.api.setStatus({ taskId: id, service: "ChatGPT", status: "queued" });
  assert.equal(readyQueued.success, false);
  assert.equal(assignment(ctx.api.list(), id, "ChatGPT").status, "ready");

  assert.equal((await ctx.api.setStatus({ taskId: id, service: "ChatGPT", status: "done" })).success, true);
  const doneReady = await ctx.api.setStatus({ taskId: id, service: "ChatGPT", status: "ready" });
  assert.equal(doneReady.success, false);
  assert.equal(assignment(ctx.api.list(), id, "ChatGPT").status, "done");
  const doneDoing = await ctx.api.setStatus({ taskId: id, service: "ChatGPT", status: "doing" });
  assert.equal(doneDoing.success, true);
  assert.equal(assignment(doneDoing.status, id, "ChatGPT").status, "doing");
});

test("foreign URL is rejected", async (t) => {
  const ctx = makeApi();
  t.after(() => ctx.cleanup());
  const created = await ctx.api.create({ title: "Link", prompt: "p", services: ["ChatGPT"] });
  const id = created.status.tasks[0].id;
  await ctx.api.open({ taskId: id, service: "ChatGPT" });
  const before = ctx.api.list().revision;
  const rejected = await ctx.api.noteUrl("ChatGPT", "https://claude.ai/chat/foreign");
  assert.equal(rejected.success, false);
  assert.equal(rejected.error, "URL does not belong to this service");
  assert.equal(assignment(rejected.status, id, "ChatGPT").url, null);
  assert.equal(rejected.status.revision, before);
});

test("own URL is stored only when capture matches", async (t) => {
  const ctx = makeApi();
  t.after(() => ctx.cleanup());
  const created = await ctx.api.create({
    title: "Compare",
    prompt: "Look at this",
    services: ["ChatGPT", "Claude"],
  });
  const id = created.status.tasks[0].id;
  const chatUrl = "https://chatgpt.com/c/own";
  const missed = await ctx.api.noteUrl("ChatGPT", chatUrl);
  assert.equal(missed.success, true);
  assert.equal(assignment(missed.status, id, "ChatGPT").url, null);
  assert.equal(missed.status.revision, created.status.revision);

  const opened = await ctx.api.open({ taskId: id, service: "Claude" });
  assert.equal(opened.status.capture.service, "Claude");
  const wrongCapture = await ctx.api.noteUrl("ChatGPT", chatUrl);
  assert.equal(wrongCapture.success, true);
  assert.equal(assignment(wrongCapture.status, id, "ChatGPT").url, null);

  const claudeUrl = "https://claude.ai/chat/abc";
  const stored = await ctx.api.noteUrl("Claude", claudeUrl);
  assert.equal(stored.success, true);
  assert.equal(assignment(stored.status, id, "Claude").url, claudeUrl);
  assert.equal(assignment(stored.status, id, "ChatGPT").url, null);

  const secret = await ctx.api.noteUrl("Claude", "https://claude.ai/chat/abc?token=sekret#hash");
  assert.equal(secret.success, true);
  assert.equal(assignment(secret.status, id, "Claude").url, "https://claude.ai/chat/abc");
  assert.equal(JSON.stringify(secret.status).includes("sekret"), false);
});

test("clear urls for a service", async (t) => {
  const ctx = makeApi();
  t.after(() => ctx.cleanup());
  const created = await ctx.api.create({
    title: "Reset",
    prompt: "p",
    services: ["ChatGPT", "Claude"],
  });
  const id = created.status.tasks[0].id;
  await ctx.api.open({ taskId: id, service: "ChatGPT" });
  await ctx.api.noteUrl("ChatGPT", "https://chatgpt.com/c/saved");
  const cleared = await ctx.api.clearUrlsForService("ChatGPT");
  assert.equal(cleared.success, true);
  assert.equal(assignment(cleared.status, id, "ChatGPT").url, null);
  assert.equal(cleared.status.capture, null);
  assert.equal(cleared.status.tasks[0].assignments.find((item) => item.service === "Claude").url, null);
});

test("activity marks doing assignments without changing status", async (t) => {
  const ctx = makeApi();
  t.after(() => ctx.cleanup());
  const created = await ctx.api.create({
    title: "Watch",
    prompt: "p",
    services: ["ChatGPT", "Claude"],
  });
  const id = created.status.tasks[0].id;
  await ctx.api.setStatus({ taskId: id, service: "ChatGPT", status: "doing" });
  const noted = await ctx.api.noteActivity("ChatGPT");
  assert.equal(noted.success, true);
  assert.equal(assignment(noted.status, id, "ChatGPT").attention, true);
  assert.equal(assignment(noted.status, id, "ChatGPT").status, "doing");
  assert.equal(assignment(noted.status, id, "Claude").attention, false);
  const cleared = await ctx.api.setStatus({ taskId: id, service: "ChatGPT", status: "ready" });
  assert.equal(cleared.success, true);
  assert.equal(assignment(cleared.status, id, "ChatGPT").status, "ready");
  assert.equal(assignment(cleared.status, id, "ChatGPT").attention, false);
  const again = await ctx.api.noteActivity("ChatGPT");
  assert.equal(again.status.revision, cleared.status.revision);
  assert.equal(assignment(again.status, id, "ChatGPT").attention, false);
  assert.equal(assignment(again.status, id, "ChatGPT").status, "ready");
  assert.equal(JSON.stringify(again.status).includes("page title"), false);
});

test("revision increases monotonically", async (t) => {
  const ctx = makeApi();
  t.after(() => ctx.cleanup());
  const seen = [ctx.api.list().revision];
  const created = await ctx.api.create({ title: "Rev", prompt: "p", services: ["ChatGPT"] });
  seen.push(created.status.revision);
  const id = created.status.tasks[0].id;
  const updated = await ctx.api.setStatus({ taskId: id, service: "ChatGPT", status: "doing" });
  seen.push(updated.status.revision);
  const opened = await ctx.api.open({ taskId: id, service: "ChatGPT" });
  seen.push(opened.status.revision);
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(seen[i] > seen[i - 1], `revision ${seen[i - 1]} then ${seen[i]}`);
  }
});

test("round-trip through a new store on the same directory", async (t) => {
  const ctx = makeApi();
  t.after(() => ctx.cleanup());
  const created = await ctx.api.create({
    title: "Plan",
    prompt: "Draft the plan",
    services: ["OpenClaw"],
  });
  const id = created.status.tasks[0].id;
  const board = await ctx.api.setWorkspace("board");
  assert.equal(board.success, true);
  assert.equal(board.status.workspace, "board");

  const again = createTasks({
    getUserDataPath: () => ctx.dir,
    isKnownService: (name) => KNOWN.has(name),
    isServiceUrl: () => false,
    listServices: () => ["ChatGPT", "Claude", "OpenClaw"],
  });
  const status = again.list();
  assert.equal(status.workspace, "board");
  assert.equal(status.tasks.length, 1);
  assert.equal(status.tasks[0].id, id);
  assert.equal(status.tasks[0].title, "Plan");
  assert.equal(status.tasks[0].prompt, "Draft the plan");
  assert.equal(status.tasks[0].assignments[0].service, "OpenClaw");
  assert.equal(status.tasks[0].assignments[0].status, "queued");
  assert.equal(fs.existsSync(path.join(ctx.dir, "tasks.json")), true);
});

test("delete task clears capture", async (t) => {
  const ctx = makeApi();
  t.after(() => ctx.cleanup());
  const first = await ctx.api.create({ title: "Keep", prompt: "a", services: ["Claude"] });
  const second = await ctx.api.create({ title: "Drop", prompt: "b", services: ["ChatGPT"] });
  const keepId = first.status.tasks[0].id;
  const dropId = second.status.tasks.find((item) => item.title === "Drop").id;
  const opened = await ctx.api.open({ taskId: dropId, service: "ChatGPT" });
  assert.deepEqual(opened.status.capture, { taskId: dropId, service: "ChatGPT" });
  assert.equal(opened.status.workspace, "chat");
  assert.equal(opened.status.lastService, "ChatGPT");
  assert.equal(assignment(opened.status, dropId, "ChatGPT").status, "doing");
  assert.equal(assignment(opened.status, dropId, "ChatGPT").attention, false);

  const removed = await ctx.api.delete(dropId);
  assert.equal(removed.success, true);
  assert.equal(removed.status.capture, null);
  assert.equal(removed.status.tasks.length, 1);
  assert.equal(removed.status.tasks[0].id, keepId);

  const reopened = await ctx.api.open({ taskId: keepId, service: "Claude" });
  assert.equal(reopened.status.capture.taskId, keepId);
  const other = await ctx.api.delete(dropId);
  assert.equal(other.success, false);
  assert.deepEqual(ctx.api.list().capture, { taskId: keepId, service: "Claude" });
  const cleared = await ctx.api.clearCapture();
  assert.equal(cleared.success, true);
  assert.equal(cleared.status.capture, null);
});

test("reloading the store drops capture and keeps the saved url", async (t) => {
  const ctx = makeApi();
  t.after(() => ctx.cleanup());
  const created = await ctx.api.create({
    title: "Keep url",
    prompt: "p",
    services: ["ChatGPT"],
  });
  const id = created.status.tasks[0].id;
  await ctx.api.open({ taskId: id, service: "ChatGPT" });
  const chatUrl = "https://chatgpt.com/c/saved-chat";
  await ctx.api.noteUrl("ChatGPT", chatUrl);

  const again = createTasks({
    getUserDataPath: () => ctx.dir,
    isKnownService: (name) => KNOWN.has(name),
    isServiceUrl: (service, url) => {
      try {
        return Boolean(HOSTS[service] && HOSTS[service].has(new URL(url).hostname));
      } catch {
        return false;
      }
    },
    listServices: () => ["ChatGPT", "Claude", "OpenClaw"],
  });
  const status = again.list();
  assert.equal(status.capture, null);
  assert.equal(assignment(status, id, "ChatGPT").url, chatUrl);
  const noted = await again.noteUrl("ChatGPT", "https://chatgpt.com/");
  assert.equal(noted.success, true);
  assert.equal(assignment(noted.status, id, "ChatGPT").url, chatUrl);
  assert.equal(noted.status.revision, status.revision);
});

test("very long urls are rejected", async (t) => {
  const ctx = makeApi();
  t.after(() => ctx.cleanup());
  const created = await ctx.api.create({ title: "Long", prompt: "p", services: ["ChatGPT"] });
  const id = created.status.tasks[0].id;
  await ctx.api.open({ taskId: id, service: "ChatGPT" });
  const before = ctx.api.list().revision;
  const huge = `https://chatgpt.com/c/${"a".repeat(5000)}`;
  const rejected = await ctx.api.noteUrl("ChatGPT", huge);
  assert.equal(rejected.success, false);
  assert.equal(rejected.error, "URL is too long");
  assert.equal(assignment(rejected.status, id, "ChatGPT").url, null);
  assert.equal(rejected.status.revision, before);
});
