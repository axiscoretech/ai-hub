(function () {
  let state = { signedIn: false, email: "", profiles: [] };

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
    (state.profiles || []).forEach((profile) => {
      const row = document.createElement("div");
      row.className = "g-row";
      const name = document.createElement("span");
      const several = (state.profiles || []).filter((item) => item.serviceId === profile.serviceId).length > 1;
      name.textContent = several
        ? (profile.serviceName + " · " + (profile.label || "Account"))
        : profile.serviceName;
      const select = document.createElement("select");
      select.setAttribute("aria-label", name.textContent + " Google account");
      [["shared", "Shared"], ["own", "Own account"]].forEach(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.selected = profile.shared ? value === "shared" : value === "own";
        select.appendChild(option);
      });
      select.addEventListener("change", () => {
        const payload = { serviceId: profile.serviceId, accountId: profile.accountId };
        const call = select.value === "own"
          ? window.electronAPI.googleUseOther(payload)
          : window.electronAPI.googleUseShared(payload);
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
        apply.textContent = "Sign in shared profiles";
      }).catch((err) => {
        showError(err);
        apply.disabled = !state.signedIn;
        apply.textContent = "Sign in shared profiles";
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
