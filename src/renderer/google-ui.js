(function () {
  let state = { signedIn: false, email: "", services: [], overrides: {} };

  function panel() {
    return document.getElementById("google-panel");
  }

  function render() {
    const root = panel();
    const button = document.getElementById("google-btn");
    if (!root) return;
    const email = document.getElementById("google-email");
    const signIn = document.getElementById("google-signin");
    const apply = document.getElementById("google-apply");
    email.textContent = state.signedIn
      ? (state.email || "Google account connected")
      : "No shared Google account yet";
    signIn.textContent = state.signedIn ? "Change shared account" : "Sign in with Google";
    apply.disabled = !state.signedIn;
    if (button) {
      button.classList.toggle("google-on", state.signedIn);
      button.title = state.email ? ("Google · " + state.email) : "Sign in with Google";
    }
    const list = document.getElementById("google-services");
    list.replaceChildren();
    (state.services || []).forEach((service) => {
      if (service === "OpenClaw") return;
      const row = document.createElement("div");
      row.className = "g-row";
      const name = document.createElement("span");
      name.textContent = service;
      const select = document.createElement("select");
      select.setAttribute("aria-label", service + " Google account");
      [["shared", "Shared"], ["other", "Other account"]].forEach(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        if ((value === "other") === Boolean(state.overrides && state.overrides[service])) option.selected = true;
        select.appendChild(option);
      });
      select.addEventListener("change", () => {
        const call = select.value === "other"
          ? window.electronAPI.googleUseOther(service)
          : window.electronAPI.googleUseShared(service);
        call.then(applyStatus).catch(showError);
      });
      row.append(name, select);
      list.appendChild(row);
    });
  }

  function applyStatus(next) {
    if (!next || typeof next !== "object") return;
    state = next;
    render();
  }

  function showError(err) {
    const email = document.getElementById("google-email");
    if (email) email.textContent = (err && err.message) || "Couldn't update Google sign-in";
  }

  function closePanel() {
    const root = panel();
    if (root) {
      root.classList.remove("open");
      root.hidden = true;
    }
    const overlay = document.getElementById("google-overlay");
    if (overlay) {
      overlay.classList.remove("open");
      overlay.hidden = true;
    }
  }

  function openPanel() {
    if (typeof closeVpnPanel === "function") closeVpnPanel();
    const root = panel();
    if (root) {
      root.hidden = false;
      root.classList.add("open");
    }
    const overlay = document.getElementById("google-overlay");
    if (overlay) {
      overlay.hidden = false;
      overlay.classList.add("open");
    }
  }

  function init() {
    const button = document.getElementById("google-btn");
    if (!button || !window.electronAPI.googleStatus) return;
    button.addEventListener("click", () => {
      const root = panel();
      if (root && root.classList.contains("open")) closePanel();
      else openPanel();
    });
    const overlay = document.getElementById("google-overlay");
    if (overlay) overlay.addEventListener("click", closePanel);
    document.getElementById("google-signin").addEventListener("click", () => {
      window.electronAPI.googleSignIn().then(applyStatus).catch(showError);
    });
    document.getElementById("google-apply").addEventListener("click", () => {
      const apply = document.getElementById("google-apply");
      apply.disabled = true;
      apply.textContent = "Signing in…";
      window.electronAPI.googleApplyAll().then((next) => {
        applyStatus(next);
        apply.textContent = "Sign in all tabs";
      }).catch((err) => {
        showError(err);
        apply.disabled = !state.signedIn;
        apply.textContent = "Sign in all tabs";
      });
    });
    window.electronAPI.onGoogle(applyStatus);
    window.electronAPI.googleStatus().then((status) => {
      applyStatus(status);
      const introKey = "aihub-google-intro";
      if (!localStorage.getItem(introKey)) {
        localStorage.setItem(introKey, "1");
        if (!status || !status.signedIn) openPanel();
      }
    }).catch(() => {});
    render();
  }

  init();
})();
