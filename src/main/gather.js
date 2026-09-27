// @ts-check
const { clipboard } = require("electron");
const { handle } = require("./ipc-bind");
const { COMPOSER_SELECTOR } = require("./compare");
const {
  awaitingReply,
  composeBrief,
  composeConferral,
  composerStateScript,
  describeProgress,
  freshCapture,
  gatherSlots,
  holdForRevision,
  nextCapture,
  planStep,
  stallLine,
  workerPrompt,
  clickSendScript,
  replyProbeScript,
  selectComposerScript,
} = require("./gather-notes");

const POLL_MS = 1500;
const COMPOSER_WAIT_MS = 45000;
const REPLY_WAIT_MS = 5 * 60 * 1000;
const FINAL_PHASES = new Set(["sending", "sent", "typed", "stopped"]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createGather(options = {}) {
  const state = {
    get win() { return options.window(); },
    get views() { return options.views(); },
    get tabs() { return options.tabs(); },
    get topBarHeight() { return options.getTopBarHeight(); },
    get compareOpen() { return options.getCompareOpen(); },
    set compareOpen(value) { options.setCompareOpen(value); },
    get compareSlots() { return options.getCompareSlots(); },
    set compareSlots(value) { options.setCompareSlots(value); },
    set compareFocus(value) { options.setCompareFocus(value); },
    set compareTaskId(value) { options.setCompareTaskId(value); },
  };
  const tasks = options.tasks;
  const services = options.services;
  const isViewUsable = options.isViewUsable || (() => false);
  const isBoardWorkspace = options.isBoardWorkspace || (() => false);
  const takeAccountView = options.takeAccountView;
  const createTab = options.createTab;
  const showPageView = options.showPageView || (() => {});
  const hideOtherPageViews = options.hideOtherPageViews || (() => {});
  const detachPageView = options.detachPageView || (() => {});
  const acceptedServiceUrl = options.acceptedServiceUrl || (() => null);
  const closePanes = options.closePanes || (() => {});
  const setPaneKind = options.setPaneKind || (() => {});

  let runId = 0;
  let running = false;
  let timer = null;
  let busy = false;
  let again = false;
  let phase = "ask";
  let round = "ask";
  let armed = false;
  let leadStage = "waits for notes";
  let titleText = "";
  let lastDetail = "";
  let taskId = "";
  /** @type {any[]} */
  let openSlots = [];
  /** @type {Map<string, any>} */
  let captures = new Map();
  /** @type {Map<string, { state: string, since: number }>} */
  let progress = new Map();

  function keyOf(slot) {
    return `${slot.service}\n${slot.accountId || "default"}`;
  }

  function progressOf(slot) {
    return progress.get(keyOf(slot)) || { state: "opening", since: Date.now() };
  }

  function setProgress(slot, next) {
    const current = progress.get(keyOf(slot));
    if (current && current.state === next) return;
    progress.set(keyOf(slot), { state: next, since: Date.now() });
  }

  function stop() {
    runId += 1;
    running = false;
    busy = false;
    again = false;
    phase = "ask";
    round = "ask";
    armed = false;
    leadStage = "waits for notes";
    titleText = "";
    lastDetail = "";
    taskId = "";
    openSlots = [];
    captures = new Map();
    progress = new Map();
    if (timer) clearInterval(timer);
    timer = null;
  }

  function publish(detail) {
    if (!detail || detail === lastDetail) return;
    lastDetail = detail;
    if (!state.win || state.win.isDestroyed()) return;
    state.win.webContents.send("compare-status", {
      open: true,
      mode: "gather",
      title: titleText,
      taskId,
      detail,
    });
  }

  function report(prefix) {
    const lead = openSlots[0];
    if (!lead) return;
    const rows = openSlots.slice(1).map((slot) => ({ service: slot.service, state: progressOf(slot).state }));
    const line = describeProgress(lead.service, rows, leadStage);
    publish(prefix ? `${prefix} · ${line}` : line);
  }

  function place(view, bounds) {
    if (!isViewUsable(view)) return;
    try { showPageView(view, { keepOthers: true }); } catch {}
    try {
      view.setBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.max(0, Math.round(bounds.width)),
        height: Math.max(0, Math.round(bounds.height)),
      });
    } catch {}
  }

  function layout() {
    if (!state.compareOpen || !state.win || state.win.isDestroyed()) return;
    const slots = state.compareSlots || [];
    if (!slots.length) return;
    const [width, height] = state.win.getContentSize();
    const top = state.topBarHeight;
    const tall = Math.max(0, height - top);
    if (slots.length === 1) {
      place(slots[0].view, { x: 0, y: top, width, height: tall });
      return;
    }
    if (FINAL_PHASES.has(phase)) {
      const leadWidth = Math.round(width * 0.66);
      place(slots[0].view, { x: 0, y: top, width: leadWidth, height: tall });
      const rest = slots.slice(1);
      const each = tall / rest.length;
      rest.forEach((slot, index) => {
        place(slot.view, { x: leadWidth, y: top + each * index, width: width - leadWidth, height: each });
      });
      return;
    }
    const col = width / slots.length;
    slots.forEach((slot, index) => {
      place(slot.view, { x: col * index, y: top, width: index === slots.length - 1 ? width - col * index : col, height: tall });
    });
  }

  async function readReply(contents) {
    if (!contents || contents.isDestroyed()) return null;
    try {
      const value = await contents.executeJavaScript(replyProbeScript(), true);
      if (!value || typeof value.text !== "string") return null;
      return {
        text: value.text,
        busy: value.busy === true,
        blocked: value.blocked === "busy" || value.blocked === "unavailable" ? value.blocked : "",
      };
    } catch {
      return null;
    }
  }

  async function composerState(contents) {
    if (!contents || contents.isDestroyed()) return null;
    try {
      const value = await contents.executeJavaScript(composerStateScript(COMPOSER_SELECTOR), true);
      return value && typeof value === "object" ? value : null;
    } catch {
      return null;
    }
  }

  async function waitForComposer(id, contents) {
    const deadline = Date.now() + COMPOSER_WAIT_MS;
    while (Date.now() < deadline) {
      if (id !== runId || !contents || contents.isDestroyed()) return false;
      let loading = false;
      try { loading = contents.isLoading(); } catch {}
      if (!loading) {
        const composer = await composerState(contents);
        if (composer && composer.ready) return true;
      }
      await wait(700);
    }
    return false;
  }

  function pressEnter(contents) {
    try {
      contents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      contents.sendInputEvent({ type: "char", keyCode: "\r" });
      contents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      return true;
    } catch {
      return false;
    }
  }

  async function leftInComposer(contents) {
    const composer = await composerState(contents);
    if (!composer || !composer.ready) return 0;
    return Number(composer.length) || 0;
  }

  /** @returns {Promise<"sent" | "typed" | "failed" | "cancelled">} */
  async function sendText(id, contents, text) {
    if (!text) return "failed";
    const ready = await waitForComposer(id, contents);
    if (id !== runId) return "cancelled";
    if (!ready) return "failed";
    try { contents.focus(); } catch { return "failed"; }
    let selected = false;
    try { selected = await contents.executeJavaScript(selectComposerScript(COMPOSER_SELECTOR), true); } catch { selected = false; }
    if (id !== runId) return "cancelled";
    if (!selected) return "failed";
    try { contents.insertText(text); } catch { return "failed"; }
    await wait(400);
    if (id !== runId) return "cancelled";
    let clicked = false;
    try { clicked = await contents.executeJavaScript(clickSendScript(), true); } catch { clicked = false; }
    if (!clicked) pressEnter(contents);
    await wait(1200);
    if (id !== runId) return "cancelled";
    if (await leftInComposer(contents) === 0) return "sent";
    try { contents.focus(); } catch {}
    pressEnter(contents);
    await wait(1200);
    if (id !== runId) return "cancelled";
    return await leftInComposer(contents) === 0 ? "sent" : "typed";
  }

  function finish(id, next, detail) {
    if (id !== runId) return;
    phase = next;
    if (timer) clearInterval(timer);
    timer = null;
    layout();
    report(detail);
  }

  async function askAll(id, task) {
    const text = workerPrompt(task);
    for (const slot of openSlots.slice(1)) {
      if (id !== runId) return;
      setProgress(slot, "opening");
      report();
      const contents = slot.view && slot.view.webContents;
      const ready = await waitForComposer(id, contents);
      if (id !== runId) return;
      const probe = ready ? await readReply(contents) : null;
      if (id !== runId) return;
      captures.set(keyOf(slot), awaitingReply(probe && !probe.busy ? probe.text : ""));
      if (!ready) {
        setProgress(slot, "manual");
        report();
        continue;
      }
      setProgress(slot, "sending");
      report();
      const result = await sendText(id, contents, text);
      if (id !== runId) return;
      setProgress(slot, result === "sent" ? "writing" : "manual");
      report();
    }
  }

  async function confer(id, ready) {
    const notes = ready.map((slot) => ({
      service: slot.service,
      note: (captures.get(keyOf(slot)) || {}).note || "",
    }));
    for (const slot of ready) {
      captures.set(keyOf(slot), holdForRevision(captures.get(keyOf(slot))));
      setProgress(slot, "sending");
      await tasks.setNote({ taskId, service: slot.service, accountId: slot.accountId, note: "" });
      if (id !== runId) return;
    }
    report();
    for (const slot of ready) {
      if (id !== runId) return;
      const result = await sendText(id, slot.view && slot.view.webContents, composeConferral(slot.service, notes));
      if (id !== runId) return;
      setProgress(slot, result === "sent" ? "revising" : "manual");
      report();
    }
  }

  async function deliver(id, lead, ready, task, stalled) {
    const notes = ready.map((slot) => ({
      service: slot.service,
      note: (captures.get(keyOf(slot)) || {}).note || "",
    })).filter((item) => item.note);
    const text = composeBrief(task, notes, stalled);
    phase = "sending";
    leadStage = "getting the notes";
    layout();
    report();
    const result = await sendText(id, lead.view && lead.view.webContents, text);
    if (id !== runId || result === "cancelled") return;
    if (result === "sent") {
      leadStage = "writing your answer";
      finish(id, "sent", "");
      return;
    }
    if (result === "typed") {
      leadStage = "notes typed, press Send";
      finish(id, "typed", "");
      return;
    }
    try { clipboard.writeText(text); } catch {}
    leadStage = "couldn't type. Notes are on the clipboard, paste them";
    finish(id, "typed", "");
  }

  async function poll(id) {
    if (!running || id !== runId) return;
    if (FINAL_PHASES.has(phase)) return;
    const status = tasks.list();
    const task = (status.tasks || []).find((item) => item.id === taskId);
    if (!task) {
      closePanes();
      return;
    }
    const lead = openSlots[0];
    const sources = openSlots.slice(1);
    if (!lead || !sources.length) {
      closePanes();
      return;
    }
    const now = Date.now();
    for (const slot of sources) {
      if (id !== runId) return;
      const current = progressOf(slot);
      if (current.state === "opening" || current.state === "sending" || current.state === "silent") continue;
      if (!isViewUsable(slot.view)) continue;
      const probe = await readReply(slot.view.webContents);
      if (id !== runId || !probe) continue;
      const result = nextCapture(captures.get(keyOf(slot)) || freshCapture(), {
        text: probe.text,
        busy: probe.busy,
        blocked: probe.blocked,
        ignore: workerPrompt(task),
      });
      captures.set(keyOf(slot), result.state);
      if (result.retract) {
        await tasks.setNote({ taskId, service: slot.service, accountId: slot.accountId, note: "" });
      }
      if (result.commit) {
        await tasks.setNote({ taskId, service: slot.service, accountId: slot.accountId, note: result.commit });
      }
      if (id !== runId) return;
      const capture = result.state;
      if (capture.blocked) setProgress(slot, "busy");
      else if (capture.note) setProgress(slot, "ready");
      else if (current.state === "busy" || current.state === "ready") setProgress(slot, round === "confer" ? "revising" : "writing");
      else if (current.state === "manual" && probe.busy) setProgress(slot, "writing");
      const after = progressOf(slot);
      if (!capture.note && !capture.blocked && now - after.since > REPLY_WAIT_MS) setProgress(slot, "silent");
    }

    const waiting = [];
    const ready = [];
    const stalled = [];
    for (const slot of sources) {
      const current = progressOf(slot).state;
      const capture = captures.get(keyOf(slot)) || freshCapture();
      if (current === "busy") stalled.push({ service: slot.service, blocked: capture.blocked || "busy" });
      else if (current === "silent") stalled.push({ service: slot.service, blocked: "silent" });
      else if (current === "ready" && capture.note) ready.push(slot);
      else waiting.push(slot);
    }

    if (!waiting.length && !ready.length) {
      const line = stallLine(stalled);
      leadStage = "nothing to send";
      finish(id, "stopped", line ? `${line}` : "");
      return;
    }

    const next = planStep(armed ? "arm" : "watch", waiting.length);
    if (next === "watch") {
      armed = false;
      report();
      return;
    }
    if (round === "ask" && ready.length > 1) {
      round = "confer";
      armed = false;
      await confer(id, ready);
      return;
    }
    if (next === "arm") {
      armed = true;
      leadStage = "notes go in a moment";
      report();
      return;
    }
    await deliver(id, lead, ready, task, stalled);
  }

  function wake(id) {
    if (id !== runId) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    Promise.resolve(poll(id)).catch(() => {}).finally(() => {
      busy = false;
      if (!again) return;
      again = false;
      wake(id);
    });
  }

  function noteStream(service) {
    if (!running || typeof service !== "string") return;
    let hit = false;
    for (const slot of openSlots.slice(1)) {
      if (slot.service !== service) continue;
      const key = keyOf(slot);
      const current = captures.get(key) || freshCapture();
      captures.set(key, { ...current, streamed: true });
      hit = true;
    }
    if (hit) wake(runId);
  }

  function openSlot(assignment) {
    services.useAccount(assignment.service, assignment.accountId || "default");
    takeAccountView(assignment.service);
    if (!isViewUsable(state.views[assignment.service])) {
      const saved = acceptedServiceUrl(assignment.service, assignment.url);
      createTab(assignment.service, saved || state.tabs[assignment.service], { background: true });
    }
    const view = state.views[assignment.service];
    if (!isViewUsable(view)) return null;
    if (!view.compareFocusHooked) {
      view.compareFocusHooked = true;
      view.webContents.on("focus", () => { state.compareFocus = view.webContents; });
    }
    return {
      service: assignment.service,
      accountId: assignment.accountId || "default",
      view,
    };
  }

  async function start(requestedId) {
    const status = tasks.list();
    const task = (status.tasks || []).find((item) => item.id === requestedId);
    if (!task) return { success: false, error: "Unknown task" };
    const picked = gatherSlots(task);
    if (!picked.ok || !picked.slots) return { success: false, error: picked.error || "Choose at least two services" };
    let leftBoard = false;
    if (isBoardWorkspace()) {
      try {
        await tasks.setWorkspace("chat");
        leftBoard = true;
      } catch {}
    }
    closePanes();
    const id = runId;
    const slots = [];
    for (const assignment of picked.slots) {
      const slot = openSlot(assignment);
      if (slot) slots.push(slot);
    }
    if (slots.length !== picked.slots.length) {
      for (const slot of slots) {
        try { detachPageView(slot.view); } catch {}
      }
      state.compareSlots = [];
      if (leftBoard) {
        try { await tasks.setWorkspace("board"); } catch {}
      }
      return { success: false, error: "Couldn't open those services" };
    }
    if (state.win && !state.win.isDestroyed()) {
      try { hideOtherPageViews(null); } catch {}
    }
    state.compareSlots = slots.map((slot) => ({ service: slot.service, view: slot.view }));
    state.compareOpen = true;
    state.compareTaskId = task.id;
    setPaneKind("gather");
    openSlots = slots;
    taskId = task.id;
    titleText = task.title;
    phase = "ask";
    round = "ask";
    armed = false;
    leadStage = "waits for notes";
    captures = new Map();
    progress = new Map();
    slots.slice(1).forEach((slot) => setProgress(slot, "opening"));
    layout();
    report();
    try {
      await tasks.clearNotes({
        taskId: task.id,
        services: slots.slice(1).map((slot) => ({ service: slot.service, accountId: slot.accountId })),
      });
    } catch {}
    if (id !== runId) return { success: false, error: "Couldn't open those services" };
    running = true;
    timer = setInterval(() => wake(id), POLL_MS);
    void askAll(id, task).catch(() => {});
    return { success: true };
  }

  handle("gather-start", async (_event, requestedId) => {
    try { return await start(requestedId); }
    catch (err) { return { success: false, error: err.message }; }
  });

  return { layout, stop, noteStream, start };
}

module.exports = { createGather, POLL_MS, REPLY_WAIT_MS };
