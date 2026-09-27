const test = require("node:test");
const assert = require("node:assert/strict");
const { Script } = require("node:vm");
const {
  MAX_BRIEF,
  FAST_READS,
  SLOW_READS,
  selectorsForHost,
  nextCapture,
  composeBrief,
  composeConferral,
  workerPrompt,
  holdForRevision,
  serviceBlock,
  stallLine,
  gatherSlots,
  planStep,
  describeProgress,
  composerStateScript,
  replyProbeScript,
  selectComposerScript,
  clickSendScript,
} = require("../out/main/gather-notes");

function feed(state, probe, times) {
  let step = { state, commit: null, retract: false };
  for (let i = 0; i < times; i += 1) step = nextCapture(step.state, probe);
  return step;
}

test("a reply already on screen is taken only after it stays still", () => {
  let step = nextCapture(null, { text: "Already here", busy: false });
  assert.equal(step.commit, null);
  assert.equal(step.state.baseline, "Already here");
  step = feed(step.state, { text: "Already here", busy: false }, SLOW_READS - 1);
  assert.equal(step.commit, null);
  step = nextCapture(step.state, { text: "Already here", busy: false });
  assert.equal(step.commit, "Already here");
});

test("a reply that changes is ready after the short wait", () => {
  let step = nextCapture(null, { text: "old", busy: false });
  step = nextCapture(step.state, { text: "new reply", busy: false });
  assert.equal(step.commit, null);
  assert.equal(step.state.hits, 1);
  step = nextCapture(step.state, { text: "new reply", busy: false });
  assert.equal(step.commit, "new reply");
  assert.equal(FAST_READS, 2);
});

test("a finished stream can confirm the text already on screen", () => {
  let step = nextCapture(null, { text: "done", busy: false });
  step = nextCapture({ ...step.state, streamed: true }, { text: "done", busy: false });
  assert.equal(step.commit, null);
  step = nextCapture(step.state, { text: "done", busy: false });
  assert.equal(step.commit, "done");
});

test("placeholders and the task text are not notes", () => {
  const thinking = nextCapture(null, { text: "Thinking...", busy: false });
  assert.equal(thinking.state.baseline, "");
  assert.equal(thinking.commit, null);
  const echo = nextCapture(null, { text: "Hello", busy: false, ignore: "Hello" });
  assert.equal(echo.state.baseline, "");
  const missed = nextCapture(null, null);
  assert.equal(missed.state.baseline, null);
});

test("a busy page drops a note that was not sent yet", () => {
  let step = nextCapture(null, { text: "old", busy: false });
  step = feed(step.state, { text: "answer", busy: false }, FAST_READS);
  assert.equal(step.commit, "answer");
  step = nextCapture(step.state, { text: "answer", busy: true });
  assert.equal(step.retract, true);
  assert.equal(step.state.note, "");
  assert.equal(step.state.baseline, "answer");
});

test("a reply we just asked for is not the text already on screen", () => {
  const held = holdForRevision({ note: "old answer", baseline: "older" });
  assert.equal(held.baseline, "old answer");
  assert.equal(held.revise, true);
  let step = feed(held, { text: "old answer", busy: false }, SLOW_READS + 1);
  assert.equal(step.commit, null);
  step = nextCapture(step.state, { text: "revised note", busy: false });
  assert.equal(step.commit, null);
  step = nextCapture(step.state, { text: "revised note", busy: false });
  assert.equal(step.commit, "revised note");
});

test("the same note counts after a new generation", () => {
  const held = holdForRevision({ note: "same", baseline: "same" });
  let step = nextCapture(held, { text: "same", busy: true });
  assert.equal(step.state.sawBusy, true);
  assert.equal(step.commit, null);
  step = nextCapture({ ...step.state, streamed: true }, { text: "same", busy: false });
  assert.equal(step.commit, null);
  step = nextCapture(step.state, { text: "same", busy: false });
  assert.equal(step.commit, "same");
});

test("a busy service is not treated as an answer", () => {
  const message = "Grok is under heavy usage right now. Please try again later or upgrade your plan to get priority access";
  assert.equal(serviceBlock(message), "busy");
  assert.equal(serviceBlock(`${message} ${"detail ".repeat(80)}`), "");
  let step = nextCapture(null, { text: message, busy: false, blocked: "busy" });
  assert.equal(step.commit, null);
  assert.equal(step.blocked, "");
  step = nextCapture(step.state, { text: message, busy: false, blocked: "busy" });
  assert.equal(step.commit, null);
  assert.equal(step.blocked, "busy");
  assert.equal(step.state.note, "");
  const brief = composeBrief(
    { title: "Plan", prompt: "Draft it" },
    [{ service: "Claude", note: "A path" }],
    [{ service: "Grok", blocked: "busy" }],
  );
  assert.ok(brief.includes("Grok is busy"));
  assert.ok(brief.includes("A path"));
  assert.equal(stallLine([{ service: "Grok", blocked: "busy" }]), "Grok is busy");
});

test("prep text is added only when the task asks for it", () => {
  assert.equal(workerPrompt({ title: "T", prompt: "Do it", prep: false }), "Do it");
  const prepared = workerPrompt({ title: "T", prompt: "Do it", prep: true, prepText: "" });
  assert.ok(prepared.startsWith("You are one of several AI models"));
  assert.ok(prepared.endsWith("# Task\n\nDo it"));
  assert.equal(workerPrompt({ title: "T", prompt: "Do it", prep: true, prepText: "Custom line" }), "Custom line\n\n# Task\n\nDo it");
});

test("the manager is told its role before the task", () => {
  const brief = composeBrief({ title: "Plan", prompt: "Draft it" }, [{ service: "Claude", note: "A path" }]);
  assert.ok(brief.startsWith("You are the manager."));
  assert.ok(brief.indexOf("You are the manager.") < brief.indexOf("# Task: Plan"));
  assert.ok(brief.indexOf("# Task: Plan") < brief.indexOf("# Notes from the other models"));
  const custom = composeBrief({ title: "Plan", prompt: "Draft it", leadText: "Be brief." }, [{ service: "Claude", note: "A path" }]);
  assert.ok(custom.startsWith("Be brief.\n\n# Task: Plan"));
});

test("conferral leaves out the model reading it", () => {
  const text = composeConferral("Claude", [
    { service: "Claude", note: "mine" },
    { service: "Gemini", note: "theirs" },
  ]);
  assert.equal(text.includes("mine"), false);
  assert.ok(text.includes("## Gemini"));
  assert.ok(text.includes("theirs"));
  assert.ok(text.startsWith("Other models answered the same task"));
});

test("the brief names each chat and stays within the limit", () => {
  const brief = composeBrief(
    { title: "Plan", prompt: "Draft it" },
    [
      { service: "Claude", note: "A".repeat(20000) },
      { service: "Gemini", note: "Use the short path" },
    ],
  );
  assert.ok(brief.includes("Task: Plan"));
  assert.ok(brief.includes("Draft it"));
  assert.ok(brief.includes("## Claude"));
  assert.ok(brief.includes("## Gemini"));
  assert.ok(brief.includes("Use the short path"));
  assert.ok(brief.length <= MAX_BRIEF);
});

test("gather keeps the main chat first and needs two services", () => {
  const task = {
    lead: { service: "ChatGPT", accountId: "default" },
    assignments: [
      { service: "Claude", accountId: "default" },
      { service: "ChatGPT", accountId: "default" },
      { service: "Gemini", accountId: "default" },
      { service: "Grok", accountId: "default" },
    ],
  };
  const picked = gatherSlots(task);
  assert.equal(picked.ok, true);
  assert.deepEqual(picked.slots.map((item) => item.service), ["ChatGPT", "Claude", "Gemini"]);
  assert.equal(gatherSlots({ lead: null, assignments: task.assignments }).error, "Choose the main chat");
  assert.equal(gatherSlots({ lead: task.lead, assignments: [task.assignments[1]] }).error, "Choose at least two services");
});

test("notes are sent on the poll after they are all ready", () => {
  assert.equal(planStep("watch", 1), "watch");
  assert.equal(planStep("watch", 0), "arm");
  assert.equal(planStep("arm", 0), "send");
  assert.equal(planStep("arm", 1), "watch");
  assert.equal(planStep("focus", 0), "focus");
  assert.equal(planStep("sent", 0), "sent");
});

test("the bar shows what each chat is doing", () => {
  assert.equal(
    describeProgress("ChatGPT", [{ service: "Claude", state: "writing" }, { service: "Grok", state: "busy" }], ""),
    "Claude: writing · Grok: busy · ChatGPT (manager): waits for notes",
  );
  assert.equal(
    describeProgress("ChatGPT", [{ service: "Claude", state: "manual" }], "writing your answer"),
    "Claude: send it yourself · ChatGPT (manager): writing your answer",
  );
  assert.equal(stallLine([{ service: "Grok", blocked: "silent" }]), "Grok did not reply");
});

test("host selectors stay on that host", () => {
  assert.equal(selectorsForHost("chatgpt.com")[0], '[data-message-author-role="assistant"]');
  assert.equal(selectorsForHost("sub.chatgpt.com")[0], '[data-message-author-role="assistant"]');
  assert.equal(selectorsForHost("chat.deepseek.com")[0], ".ds-markdown");
  assert.equal(selectorsForHost("evilchatgpt.com").includes(".ds-markdown"), false);
  assert.equal(selectorsForHost("evilchatgpt.com")[0], '[data-message-author-role="assistant"]');
});

test("page scripts parse", () => {
  new Script(replyProbeScript());
  new Script(selectComposerScript("textarea, [contenteditable]"));
  new Script(clickSendScript());
  new Script(composerStateScript("textarea, [contenteditable]"));
});
