(function () {
  const STATUSES = [
    ["queued", "Queued"],
    ["doing", "Doing"],
    ["ready", "Ready"],
    ["done", "Done"],
  ];

  let tasksState = { revision: -1, workspace: "chat", tasks: [], services: [], capture: null };
  let appliedRevision = -1;
  let filter = "all";
  let servicesKey = null;

  function activeTask(status) {
    const tasks = status.tasks || [];
    if (status.capture) {
      const captured = tasks.find((task) => task.id === status.capture.taskId);
      if (captured) return captured;
    }
    const doing = tasks.filter((task) => task.assignments.some((item) => item.status === "doing"));
    doing.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return doing[0] || null;
  }

  function attentionCount(status) {
    return (status.tasks || []).reduce((sum, task) => {
      return sum + task.assignments.filter((item) => item.attention).length;
    }, 0);
  }

  function filteredTasks(status) {
    const tasks = status.tasks || [];
    if (filter === "doing") {
      return tasks.filter((task) => task.assignments.some((item) => item.status === "doing"));
    }
    if (filter === "attention") {
      return tasks.filter((task) => task.assignments.some((item) => item.attention));
    }
    return tasks;
  }

  function showError(message) {
    const el = document.getElementById("board-error");
    if (!el) return;
    el.textContent = message || "";
  }

  function applyStatus(status) {
    if (!status || typeof status.revision !== "number") return;
    if (status.revision < appliedRevision) return;
    appliedRevision = status.revision;
    tasksState = status;
    render(status);
  }

  async function run(promise) {
    let result;
    try {
      result = await promise;
    } catch (err) {
      showError(err && err.message ? err.message : "Couldn't update tasks");
      return null;
    }
    if (result && result.status) applyStatus(result.status);
    if (result && result.success === false) showError(result.error || "Couldn't update tasks");
    else if (result && result.success) showError("");
    return result;
  }

  function compareIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");
    const left = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    left.setAttribute("x", "1.5");
    left.setAttribute("y", "2");
    left.setAttribute("width", "5");
    left.setAttribute("height", "12");
    left.setAttribute("rx", "1");
    left.setAttribute("stroke", "currentColor");
    left.setAttribute("stroke-width", "1.5");
    const right = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    right.setAttribute("x", "9.5");
    right.setAttribute("y", "2");
    right.setAttribute("width", "5");
    right.setAttribute("height", "12");
    right.setAttribute("rx", "1");
    right.setAttribute("stroke", "currentColor");
    right.setAttribute("stroke-width", "1.5");
    svg.append(left, right);
    return svg;
  }

  function renderTasksButton(status) {
    const button = document.getElementById("tasks-btn");
    if (!button) return;
    const active = activeTask(status);
    const count = attentionCount(status);
    button.replaceChildren(compareIcon());
    if (count > 0) {
      const badge = document.createElement("span");
      badge.className = "tasks-badge";
      badge.textContent = count > 99 ? "99+" : String(count);
      button.appendChild(badge);
    }
    button.classList.toggle("tasks-on", status.workspace === "board");
    const title = active
      ? "Compare · " + active.title
      : "Compare (Cmd/Ctrl+Shift+B)";
    button.title = title;
    button.setAttribute("aria-label", title);
  }

  function renderServiceChoices(services) {
    const key = (services || []).join("|");
    if (key === servicesKey) return;
    servicesKey = key;
    const box = document.getElementById("board-services");
    if (!box) return;
    box.replaceChildren();
    (services || []).forEach((service) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = service;
      label.append(input, document.createTextNode(" " + service));
      box.appendChild(label);
    });
  }

  function renderFilters() {
    document.querySelectorAll("#board-filters button").forEach((button) => {
      button.classList.toggle("on", button.dataset.filter === filter);
    });
  }

  function renderCards(status) {
    const list = document.getElementById("board-list");
    const empty = document.getElementById("board-empty");
    const scroller = document.getElementById("board");
    if (!list || !empty) return;
    const top = scroller ? scroller.scrollTop : 0;
    const tasks = status.tasks || [];
    const visible = filteredTasks(status);
    if (!tasks.length) {
      empty.hidden = false;
      empty.textContent = "No tasks yet. Add a title, the text to paste, and at least one service.";
    } else if (!visible.length) {
      empty.hidden = false;
      empty.textContent = "No tasks match this filter.";
    } else {
      empty.hidden = true;
      empty.textContent = "";
    }

    list.replaceChildren();
    visible.forEach((task) => list.appendChild(renderCard(task, status.services || [])));
    if (scroller) scroller.scrollTop = top;
  }

  function renderCard(task, services) {
    const card = document.createElement("article");
    card.className = "board-card";

    const top = document.createElement("div");
    top.className = "board-card-top";
    const title = document.createElement("h2");
    title.className = "board-title";
    title.textContent = task.title;
    const actions = document.createElement("div");
    actions.className = "board-card-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => copyTask(task, copy));
    const removeTask = document.createElement("button");
    removeTask.type = "button";
    removeTask.textContent = "Delete";
    removeTask.addEventListener("click", () => {
      void run(window.electronAPI.tasksDelete(task.id));
    });
    const side = document.createElement("button");
    side.type = "button";
    side.textContent = task.assignments.length > 3 ? "Side by side (3)" : "Side by side";
    side.disabled = task.assignments.length < 2;
    side.addEventListener("click", () => {
      if (window.electronAPI.compareStart) void run(window.electronAPI.compareStart(task.id));
    });
    actions.append(side, copy, removeTask);
    top.append(title, actions);
    card.appendChild(top);

    if (task.prompt) {
      const prompt = document.createElement("p");
      prompt.className = "board-prompt";
      prompt.textContent = task.prompt;
      card.appendChild(prompt);
    }

    task.assignments.forEach((assignment) => {
      card.appendChild(renderAssignment(task, assignment));
    });

    const assigned = new Set(task.assignments.map((item) => item.service));
    const remaining = services.filter((service) => !assigned.has(service));
    if (remaining.length) {
      const row = document.createElement("div");
      row.className = "board-add-row";
      const select = document.createElement("select");
      select.setAttribute("aria-label", "Add a service");
      remaining.forEach((service) => {
        const option = document.createElement("option");
        option.value = service;
        option.textContent = service;
        select.appendChild(option);
      });
      const add = document.createElement("button");
      add.type = "button";
      add.className = "board-add";
      add.textContent = "Add service";
      add.addEventListener("click", () => {
        void run(window.electronAPI.tasksAddAssignment({ taskId: task.id, service: select.value }));
      });
      row.append(select, add);
      card.appendChild(row);
    }

    return card;
  }

  function renderAssignment(task, assignment) {
    const row = document.createElement("div");
    row.className = "board-row";

    const dot = document.createElement("span");
    dot.className = assignment.attention ? "board-dot" : "board-dot idle";
    dot.title = assignment.attention ? "Needs a look" : "";
    const name = document.createElement("span");
    name.className = "board-service";
    name.textContent = assignment.service;

    const select = document.createElement("select");
    select.setAttribute("aria-label", assignment.service + " status");
    STATUSES.forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      if (value === assignment.status) option.selected = true;
      select.appendChild(option);
    });
    select.addEventListener("change", () => {
      void run(window.electronAPI.tasksSetStatus({
        taskId: task.id,
        service: assignment.service,
        status: select.value,
      }));
    });

    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "Open";
    open.addEventListener("click", () => {
      void run(window.electronAPI.tasksOpen({ taskId: task.id, service: assignment.service }));
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      void run(window.electronAPI.tasksRemoveAssignment({ taskId: task.id, service: assignment.service }));
    });

    row.append(dot, name, select, open, remove);
    return row;
  }

  async function copyTask(task, button) {
    const text = task.prompt || task.title;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }
    setTimeout(() => { button.textContent = "Copy"; }, 1200);
  }

  function render(status) {
    const board = document.getElementById("board");
    if (!board) return;
    const wasOpen = board.classList.contains("visible");
    const open = status.workspace === "board";
    board.classList.toggle("visible", open);
    board.setAttribute("aria-hidden", open ? "false" : "true");
    if (open && typeof hideOpenClawPanel === "function") hideOpenClawPanel();
    if (!open && wasOpen && typeof syncOpenClawShell === "function") {
      const active = document.querySelector(".tab.active");
      if (active) syncOpenClawShell(active.dataset.name);
    }
    renderTasksButton(status);
    renderServiceChoices(status.services || []);
    renderFilters();
    renderCards(status);
    if (open && typeof layoutInset === "function") layoutInset();
  }

  function selectedServices() {
    return [...document.querySelectorAll("#board-services input:checked")].map((input) => input.value);
  }

  function bind() {
    const button = document.getElementById("tasks-btn");
    if (button) {
      button.addEventListener("click", () => {
        void run(window.electronAPI.tasksToggleWorkspace());
      });
    }

    document.getElementById("board-filters").addEventListener("click", (event) => {
      const target = event.target.closest("button[data-filter]");
      if (!target) return;
      filter = target.dataset.filter;
      render(tasksState);
    });

    document.getElementById("board-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const title = document.getElementById("board-title").value;
      const prompt = document.getElementById("board-prompt").value;
      const services = selectedServices();
      if (!String(title || "").trim()) {
        showError("Title is required");
        return;
      }
      if (!services.length) {
        showError("Choose at least one service");
        return;
      }
      void run(window.electronAPI.tasksCreate({ title, prompt, services })).then((result) => {
        if (!result || !result.success) return;
        document.getElementById("board-title").value = "";
        document.getElementById("board-prompt").value = "";
        document.querySelectorAll("#board-services input").forEach((input) => { input.checked = false; });
      });
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.repeat || tasksState.workspace !== "board") return;
      event.preventDefault();
      void run(window.electronAPI.tasksSetWorkspace("chat"));
    });
  }

  function build(root) {
    root.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "board-wrap";

    const head = document.createElement("div");
    head.className = "board-head";
    const heading = document.createElement("h1");
    heading.textContent = "Compare";
    const filters = document.createElement("div");
    filters.id = "board-filters";
    filters.className = "board-filters";
    [
      ["all", "All"],
      ["doing", "Doing"],
      ["attention", "Needs a look"],
    ].forEach(([value, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.filter = value;
      button.textContent = label;
      filters.appendChild(button);
    });
    head.append(heading, filters);

    const empty = document.createElement("p");
    empty.id = "board-empty";
    empty.className = "board-empty";
    empty.hidden = true;

    const list = document.createElement("div");
    list.id = "board-list";
    list.className = "board-list";

    const form = document.createElement("form");
    form.id = "board-form";
    form.className = "board-form";
    const formTitle = document.createElement("h2");
    formTitle.textContent = "New task";
    const title = document.createElement("input");
    title.id = "board-title";
    title.type = "text";
    title.maxLength = 120;
    title.placeholder = "Title";
    title.setAttribute("aria-label", "Title");
    const prompt = document.createElement("textarea");
    prompt.id = "board-prompt";
    prompt.maxLength = 8000;
    prompt.placeholder = "Text to copy and paste into the chat";
    prompt.setAttribute("aria-label", "Task text");
    const services = document.createElement("div");
    services.id = "board-services";
    services.className = "board-services";
    const error = document.createElement("p");
    error.id = "board-error";
    error.className = "board-error";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "board-add";
    submit.textContent = "Add task";
    form.append(formTitle, title, prompt, services, error, submit);

    wrap.append(head, form, empty, list);
    root.appendChild(wrap);
  }

  function initBoard() {
    const root = document.getElementById("board");
    if (!root || !window.electronAPI || !window.electronAPI.tasksList || !window.electronAPI.onTasks) return;
    build(root);
    bind();
    window.electronAPI.onTasks(applyStatus);
    window.electronAPI.tasksList().then(applyStatus).catch(() => {});
  }

  initBoard();
})();
