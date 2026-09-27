// @ts-check

const MAX_NOTE_LENGTH = 12000;
const MAX_BRIEF = 14000;
const FAST_READS = 2;
const SLOW_READS = 4;

const HOST_SELECTORS = [
  { hosts: ["chatgpt.com", "chat.openai.com"], selectors: ['[data-message-author-role="assistant"]'] },
  { hosts: ["claude.ai"], selectors: ['[data-testid="assistant-message"]'] },
  { hosts: ["gemini.google.com"], selectors: ["model-response", ".model-response-text", "message-content"] },
  { hosts: ["chat.deepseek.com"], selectors: [".ds-markdown"] },
  { hosts: ["chat.qwen.ai"], selectors: [".markdown-body"] },
  { hosts: ["www.perplexity.ai", "perplexity.ai"], selectors: ['[data-testid="answer-content"]', ".prose"] },
  { hosts: ["chat.mistral.ai"], selectors: ['[data-message-author-role="assistant"]'] },
  { hosts: ["www.kimi.com", "kimi.com"], selectors: [".markdown"] },
  { hosts: ["grok.com"], selectors: ['[class*="message-bubble"]'] },
];

const GENERIC_SELECTORS = [
  '[data-message-author-role="assistant"]',
  '[data-testid="assistant-message"]',
  '[data-role="assistant"]',
];

const DEFAULT_PREP = "You are one of several AI models preparing material on the task below. A manager model will check your reply against the others and write one answer for the user. Give reliable, specific information. Mark clearly what you are sure of and what you are not. Do not write the final advice to the user.";

const DEFAULT_LEAD = "You are the manager. Several AI models prepared notes on the task below. Your job is to check those notes and write one final answer for the user. Keep a claim only when the notes support it. Where the notes disagree, choose the better-supported version and say what the disagreement was. Check the result once more before you answer.";

const CONFER_HEAD = "Other models answered the same task you just answered. Their notes are below. Compare them with your own note. Correct what you would not stand behind, add a supported point you missed, and say what you still reject and why. Reply with your revised note only.";

const TAIL = "\n\nWrite the final answer for the user now.";

function cleanText(value) {
  return String(value || "").replace(/\u00a0/g, " ").trim();
}

function isPlaceholder(text) {
  if (!text) return true;
  if (/^[.…]+$/.test(text)) return true;
  return /^(?:thinking|reasoning|loading|searching|загрузка|думаю)(?:\.{1,3}|…)?$/i.test(text);
}

function selectorsForHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  const match = HOST_SELECTORS.find((item) => item.hosts.some((name) => host === name || host.endsWith(`.${name}`)));
  const specific = match ? match.selectors : [];
  return [...specific, ...GENERIC_SELECTORS.filter((sel) => !specific.includes(sel))];
}

const BLOCK_PATTERNS = [
  { pattern: "under heavy usage|high demand|upgrade your plan|priority access", label: "busy" },
  { pattern: "too many requests|rate limit|usage limit|at capacity|over capacity|overloaded", label: "busy" },
  { pattern: "try again later|temporarily unavailable", label: "unavailable" },
];

function serviceBlock(text) {
  const value = cleanText(text).replace(/\s+/g, " ");
  if (value.length < 8 || value.length > 400) return "";
  for (const rule of BLOCK_PATTERNS) {
    if (new RegExp(rule.pattern, "i").test(value)) return rule.label;
  }
  return "";
}

function freshCapture() {
  return {
    baseline: null,
    pending: "",
    hits: 0,
    note: "",
    streamed: false,
    revise: false,
    sawBusy: false,
    blocked: "",
    blockedPending: "",
    blockedHits: 0,
  };
}

function awaitingReply(baseline) {
  return {
    baseline: baseline == null ? "" : String(baseline),
    pending: "",
    hits: 0,
    note: "",
    streamed: false,
    revise: true,
    sawBusy: false,
  };
}

function holdForRevision(state) {
  const current = normalizeCapture(state);
  return awaitingReply(current.note || current.baseline || "");
}

function normalizeCapture(state) {
  if (!state || typeof state !== "object") return freshCapture();
  return {
    baseline: state.baseline == null ? null : String(state.baseline),
    pending: typeof state.pending === "string" ? state.pending : "",
    hits: Number.isFinite(state.hits) ? state.hits : 0,
    note: typeof state.note === "string" ? state.note : "",
    streamed: state.streamed === true,
    revise: state.revise === true,
    sawBusy: state.sawBusy === true,
    blocked: typeof state.blocked === "string" ? state.blocked : "",
    blockedPending: typeof state.blockedPending === "string" ? state.blockedPending : "",
    blockedHits: Number.isFinite(state.blockedHits) ? state.blockedHits : 0,
  };
}

function nextCapture(state, probe) {
  let current = normalizeCapture(state);
  if (!probe || typeof probe.text !== "string") {
    return { state: current, commit: null, retract: false, blocked: "" };
  }
  const text = cleanText(probe.text);
  const marked = probe.blocked === "busy" || probe.blocked === "unavailable" ? probe.blocked : "";
  const reason = marked || serviceBlock(probe.blocked || "") || serviceBlock(text);
  if (reason) {
    const blockedHits = reason === current.blockedPending ? current.blockedHits + 1 : 1;
    if (blockedHits >= FAST_READS) {
      return {
        state: {
          ...current,
          blocked: reason,
          blockedPending: reason,
          blockedHits,
          note: "",
          pending: "",
          hits: 0,
        },
        commit: null,
        retract: Boolean(current.note),
        blocked: reason,
      };
    }
    return {
      state: { ...current, blocked: "", blockedPending: reason, blockedHits },
      commit: null,
      retract: false,
      blocked: "",
    };
  }
  if (current.blocked || current.blockedPending) {
    current = { ...current, blocked: "", blockedPending: "", blockedHits: 0 };
  }
  const ignore = cleanText(probe.ignore || "");
  const unusable = Boolean(probe.busy) || !text || isPlaceholder(text) || (ignore && text === ignore);

  if (current.baseline == null) {
    return {
      state: {
        ...current,
        baseline: unusable ? "" : text,
        pending: "",
        hits: 0,
        sawBusy: current.sawBusy || Boolean(probe.busy),
      },
      commit: null,
      retract: false,
    };
  }

  if (unusable) {
    const sawBusy = current.sawBusy || Boolean(probe.busy);
    if (current.note && probe.busy) {
      return {
        state: { ...current, sawBusy, note: "", pending: "", hits: 0 },
        commit: null,
        retract: true,
      };
    }
    if (!current.hits && !current.pending && sawBusy === current.sawBusy) {
      return { state: current, commit: null, retract: false };
    }
    return { state: { ...current, sawBusy, pending: "", hits: 0 }, commit: null, retract: false };
  }

  if (current.revise && !current.sawBusy && text === current.baseline) {
    return { state: current, commit: null, retract: false };
  }

  if (current.note) {
    if (text === current.note) return { state: current, commit: null, retract: false };
    return {
      state: { ...current, note: "", pending: text, hits: 1 },
      commit: null,
      retract: true,
    };
  }

  const hits = text === current.pending ? current.hits + 1 : 1;
  const needed = text !== current.baseline || current.streamed ? FAST_READS : SLOW_READS;
  if (hits >= needed) {
    return {
      state: { ...current, baseline: text, pending: text, hits, note: text, streamed: false, revise: false, sawBusy: false },
      commit: text,
      retract: false,
    };
  }
  return { state: { ...current, pending: text, hits }, commit: null, retract: false };
}

function clip(text, max) {
  const value = cleanText(text);
  if (value.length <= max) return value;
  if (max < 2) return "";
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

function workerPrompt(task) {
  const body = cleanText(task && task.prompt) || cleanText(task && task.title);
  if (!task || task.prep !== true) return body;
  const intro = cleanText(task.prepText) || DEFAULT_PREP;
  if (!body) return intro;
  return `${intro}\n\n# Task\n\n${body}`;
}

function composeConferral(service, sources) {
  const list = (Array.isArray(sources) ? sources : []).filter((item) => item && item.service !== service && cleanText(item.note));
  const head = `${CONFER_HEAD}\n\n# Notes from the other models\n\n`;
  const room = MAX_BRIEF - head.length;
  const per = Math.max(80, Math.floor(room / Math.max(1, list.length)) - 16);
  const body = list.map((item) => `## ${item.service}\n${clip(item.note, per)}`).join("\n\n");
  const text = `${head}${body}`;
  return text.length > MAX_BRIEF ? text.slice(0, MAX_BRIEF) : text;
}

function stallLine(stalled) {
  const list = Array.isArray(stalled) ? stalled : [];
  if (!list.length) return "";
  return list.map((item) => {
    if (item.blocked === "silent") return `${item.service} did not reply`;
    return `${item.service} is ${item.blocked === "unavailable" ? "unavailable" : "busy"}`;
  }).join(". ");
}

function composeBrief(task, sources, stalled) {
  const title = clip(task && task.title ? task.title : "Task", 200);
  const prompt = task && task.prompt ? cleanText(task.prompt) : "";
  const list = (Array.isArray(sources) ? sources : []).filter((item) => item && cleanText(item.note));
  const intro = cleanText(task && task.leadText) || DEFAULT_LEAD;
  const headParts = [intro, "", `# Task: ${title}`];
  if (prompt) headParts.push("", prompt);
  const absent = stallLine(stalled);
  if (absent) headParts.push("", `${absent}.`);
  headParts.push("", "# Notes from the other models", "");
  const head = headParts.join("\n");
  const room = MAX_BRIEF - head.length - TAIL.length;
  const per = Math.max(80, Math.floor(room / Math.max(1, list.length)) - 16);
  const body = list.map((item) => `## ${item.service}\n${clip(item.note, per)}`).join("\n\n");
  const text = `${head}${body}${TAIL}`;
  return text.length > MAX_BRIEF ? text.slice(0, MAX_BRIEF) : text;
}

function gatherSlots(task) {
  const assignments = task && Array.isArray(task.assignments) ? task.assignments : [];
  if (assignments.length < 2) return { ok: false, error: "Choose at least two services" };
  if (!task.lead || !task.lead.service) return { ok: false, error: "Choose the main chat" };
  const leadId = task.lead.accountId || "default";
  const lead = assignments.find((item) => item.service === task.lead.service && (item.accountId || "default") === leadId);
  if (!lead) return { ok: false, error: "Choose the main chat" };
  const others = assignments.filter((item) => item !== lead);
  if (!others.length) return { ok: false, error: "Choose at least two services" };
  return { ok: true, slots: [lead, ...others.slice(0, 2)] };
}

function planStep(phase, waitingCount) {
  if (phase === "sent" || phase === "typed" || phase === "stopped") return phase;
  if (waitingCount > 0) return "watch";
  if (phase === "focus") return "focus";
  if (phase === "arm") return "send";
  return "arm";
}

const PROGRESS_LABELS = {
  opening: "opening",
  sending: "getting the task",
  manual: "send it yourself",
  writing: "writing",
  revising: "revising its note",
  ready: "note ready",
  busy: "busy",
  silent: "no reply",
};

function describeProgress(lead, rows, leadStage) {
  const parts = (Array.isArray(rows) ? rows : []).map((row) => `${row.service}: ${PROGRESS_LABELS[row.state] || row.state}`);
  if (lead) parts.push(`${lead} (manager): ${leadStage || "waits for notes"}`);
  return parts.join(" · ");
}

function composerStateScript(selector) {
  return `(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const visible = nodes.filter((el) => {
      if (el.getAttribute("contenteditable") === "false") return false;
      if (el.disabled || el.readOnly) return false;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 40 && rect.height > 16 && rect.bottom > 0 && rect.top < window.innerHeight;
    });
    if (!visible.length) return { ready: false, length: 0 };
    visible.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    const el = visible[0];
    const editable = el.isContentEditable || el.getAttribute("contenteditable") != null;
    const value = editable ? String(el.innerText || "") : String(el.value || "");
    return { ready: true, length: value.trim().length };
  })()`;
}

function replyProbeScript() {
  return `(() => {
    const table = ${JSON.stringify(HOST_SELECTORS)};
    const generic = ${JSON.stringify(GENERIC_SELECTORS)};
    const host = String(location.hostname || "").toLowerCase();
    const match = table.find((item) => item.hosts.some((name) => host === name || host.endsWith("." + name)));
    const selectors = (match && match.selectors ? match.selectors : []).concat(generic);
    const seen = new Set();
    const found = [];
    function textOf(el) {
      if (!el) return "";
      try {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return "";
      } catch (err) {}
      return String(el.innerText || "").replace(/\\u00a0/g, " ").trim();
    }
    for (const sel of selectors) {
      let nodes = [];
      try { nodes = document.querySelectorAll(sel); } catch (err) { nodes = []; }
      for (const el of nodes) {
        if (seen.has(el)) continue;
        if (!textOf(el)) continue;
        seen.add(el);
        found.push(el);
      }
    }
    const inner = found.filter((el) => !found.some((other) => other !== el && el.contains(other)));
    inner.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    let last = inner.length ? inner[inner.length - 1] : null;
    if (last && textOf(last).length < 40) {
      const bigger = found.filter((el) => el !== last && el.contains(last) && textOf(el).length > textOf(last).length);
      bigger.sort((a, b) => textOf(a).length - textOf(b).length);
      if (bigger.length) last = bigger[0];
    }
    const text = textOf(last).slice(0, ${MAX_NOTE_LENGTH});
    const blockRules = ${JSON.stringify(BLOCK_PATTERNS)};
    function blockLabel(value) {
      const raw = String(value || "").replace(/\\s+/g, " ").trim();
      if (raw.length < 8 || raw.length > 400) return "";
      for (const rule of blockRules) {
        if (new RegExp(rule.pattern, "i").test(raw)) return rule.label;
      }
      return "";
    }
    let blocked = "";
    for (const el of document.querySelectorAll("div, p, span, section, [role='alert'], [role='status']")) {
      if (blocked) break;
      if (el.children && el.children.length > 8) continue;
      try {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
      } catch (err) { continue; }
      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8 || rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
      blocked = blockLabel(el.innerText || "");
    }
    if (!blocked) blocked = blockLabel(text);
    let busy = false;
    for (const el of document.querySelectorAll("button, [role='button']")) {
      const label = ((el.getAttribute("aria-label") || "") + " " + (el.getAttribute("data-testid") || "")).toLowerCase();
      if (!label.includes("stop") && !label.includes("останов")) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 8 && rect.height > 8) { busy = true; break; }
    }
    return { text, busy, blocked };
  })()`;
}

function selectComposerScript(selector) {
  return `(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const visible = nodes.filter((el) => {
      if (el.getAttribute("contenteditable") === "false") return false;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 40 && rect.height > 16 && rect.bottom > 0 && rect.top < window.innerHeight;
    });
    if (!visible.length) return false;
    visible.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    const el = visible[0];
    try { el.focus(); } catch (err) { return false; }
    try {
      const editable = el.isContentEditable || el.getAttribute("contenteditable") != null;
      if (editable && el.getAttribute("contenteditable") !== "false") {
        const sel = window.getSelection();
        if (!sel) return false;
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        return true;
      }
      if (typeof el.select === "function") el.select();
    } catch (err) {}
    return true;
  })()`;
}

function clickSendScript() {
  return `(() => {
    const nodes = [...document.querySelectorAll("button, [role='button']")];
    const candidates = [];
    for (const el of nodes) {
      const label = [el.getAttribute("aria-label"), el.getAttribute("data-testid"), el.getAttribute("title")].filter(Boolean).join(" ").toLowerCase();
      if (!/\\bsend\\b|send-button|отправить/.test(label)) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8 || rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
      candidates.push(el);
    }
    if (!candidates.length) return false;
    candidates.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    const lower = candidates.filter((el) => el.getBoundingClientRect().bottom > window.innerHeight * 0.5);
    const pick = lower[0] || candidates[0];
    pick.click();
    return true;
  })()`;
}

module.exports = {
  MAX_NOTE_LENGTH,
  MAX_BRIEF,
  FAST_READS,
  SLOW_READS,
  DEFAULT_PREP,
  DEFAULT_LEAD,
  workerPrompt,
  composeConferral,
  serviceBlock,
  stallLine,
  awaitingReply,
  holdForRevision,
  selectorsForHost,
  freshCapture,
  nextCapture,
  composeBrief,
  gatherSlots,
  planStep,
  describeProgress,
  composerStateScript,
  replyProbeScript,
  selectComposerScript,
  clickSendScript,
};
