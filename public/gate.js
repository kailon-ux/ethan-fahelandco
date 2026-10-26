/* Staff sign-in (Google, fahelandco.com accounts only). Same flow as staff.fahelandco.com/gate.js.
   FCGate.start(after): if a session exists, calls after(info) right away; otherwise turns the
   #gate-form card into a Google sign-in button and calls after(info) once signed in. */
window.FCGate = (() => {
  let SESSION = ""; try { SESSION = localStorage.getItem("fc_session") || ""; } catch (_) {}
  const _fetch = window.fetch.bind(window);
  window.fetch = (url, init = {}) => { if (typeof url === "string" && url.startsWith("/api/")) init = { ...init, headers: { ...(init.headers || {}), "x-session": SESSION } }; return _fetch(url, init); };
  function button(form, clientId, after) {
    const div = document.createElement("div"); div.id = "gsi"; div.style.cssText = "display:flex;justify-content:center;margin:6px 0 4px";
    form.insertBefore(div, form.querySelector("#gate-err"));
    form.addEventListener("submit", e => e.preventDefault());
    if (!clientId) { const el = form.querySelector("#gate-err"); if (el) el.textContent = "Sign-in is not configured yet."; return; }
    const s = document.createElement("script"); s.src = "https://accounts.google.com/gsi/client"; s.async = true; document.head.appendChild(s);
    const mount = () => {
      if (!window.google?.accounts?.id) { setTimeout(mount, 150); return; }
      google.accounts.id.initialize({ client_id: clientId, hd: "fahelandco.com", auto_select: true, ux_mode: "popup", callback: async ({ credential }) => {
        const err = form.querySelector("#gate-err"); if (err) err.textContent = "";
        try {
          const r = await fetch("/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential }) }).then(x => x.json());
          if (r.error) throw new Error(r.error);
          SESSION = r.session; try { localStorage.setItem("fc_session", SESSION); } catch (_) {}
          setCookie(); after(r);
        } catch (e) { if (err) err.textContent = e.message; }
      } });
      google.accounts.id.renderButton(div, { theme: "outline", size: "large", width: 300, text: "signin_with", shape: "pill" });
    };
    mount();
  }
  async function start(after) {
    let j = null;
    try { j = await fetch("/api/auth").then(r => r.json()); } catch (_) { j = { error: "network" }; }
    if (j && !j.error) { setCookie(); after(j); return; }
    SESSION = "";
    const form = document.getElementById("gate-form");
    if (form) button(form, j?.clientId || "", after);
  }
  function setCookie() { try { document.cookie = `fc_session=${SESSION}; path=/; max-age=1209600; SameSite=Lax; Secure`; } catch (_) {} }
  function signOut() { try { localStorage.removeItem("fc_session"); document.cookie = "fc_session=; path=/; max-age=0"; google?.accounts?.id?.disableAutoSelect?.(); } catch (_) {} location.reload(); }
  return { start, signOut };
})();
