// Machine intake, authenticated by HUB_INGEST_KEY (body.key or header x-hub-key). A wrong key gets a plain 404.
//   POST /api/ingest/brief     the morning brief task posts the day's brief (sections + rows)
//   POST /api/ingest/calendar  the Zapier calendar feed posts Ethan's diary + the Fahel Operations calendar
//   POST /api/ingest/signing   the Zapier inbox labeller posts a lease to sign (with its deposit check) or a completion
//   POST /api/ingest/state     read-only: returns open signing rows and marks, for the morning brief task
import { keyOk, NOT_FOUND, store, torontoDate } from "../lib/common.mjs";

const SECTION_KEYS = ["carlton", "clients", "rami", "kailon", "urgent", "laterent", "onoff", "tosign", "waiting"];
const DASHES = new RegExp("[" + String.fromCharCode(8211, 8212) + "]", "g"); // en and em dashes become plain hyphens
const txt = (s, n = 400) => String(s ?? "").replace(DASHES, "-").slice(0, n);

function cleanBrief(b) {
  const sections = (Array.isArray(b.sections) ? b.sections : []).filter(x => SECTION_KEYS.includes(x?.key)).map(sec => ({
    key: sec.key, title: txt(sec.title, 80), summary: txt(sec.summary, 300),
    items: (Array.isArray(sec.items) ? sec.items : []).slice(0, 80).map(it => ({
      id: txt(it.id || `${sec.key}-${it.title}`, 160), title: txt(it.title, 240), detail: txt(it.detail, 900), who: txt(it.who, 80),
      due: /^\d{4}-\d{2}-\d{2}$/.test(it.due || "") ? it.due : null, urgent: !!it.urgent, source: txt(it.source, 80),
      link: /^https:\/\//.test(it.link || "") ? txt(it.link, 600) : null, linkLabel: txt(it.linkLabel || "Open", 40),
      deposit: it.deposit ? txt(it.deposit, 200) : null,
    })),
  }));
  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(b.date || "") ? b.date : torontoDate(), generatedAt: new Date().toISOString(),
    headline: txt(b.headline, 200), today: (Array.isArray(b.today) ? b.today : []).slice(0, 6).map(t => txt(t, 260)),
    sections, health: (Array.isArray(b.health) ? b.health : []).slice(0, 12).map(t => txt(t, 260)),
    emailedTo: txt(b.emailedTo, 120),
  };
}

function cleanEvent(e, cal) {
  return {
    id: txt(`${cal}-${e.id}`, 200), cal, title: txt(e.title || "(no title)", 200), start: txt(e.start, 40), end: txt(e.end, 40),
    allDay: !!e.allDay, location: txt(e.location, 160), link: /^https:\/\//.test(e.link || "") ? txt(e.link, 600) : null,
    needsAction: !!e.needsAction, organizer: txt(e.organizer, 120),
  };
}

export default async (req) => {
  let body;
  try { body = await req.json(); } catch { return NOT_FOUND(); }
  if (!keyOk(req, body)) return NOT_FOUND();
  const kind = new URL(req.url).pathname.split("/").pop();
  const s = store();

  if (kind === "brief") {
    const brief = cleanBrief(body.brief || {});
    if (!brief.sections.length) return Response.json({ error: "brief has no sections" }, { status: 422 });
    await s.setJSON("brief/latest", brief);
    await s.setJSON(`brief/${brief.date}`, brief);
    return Response.json({ ok: true, date: brief.date, sections: brief.sections.length, rows: brief.sections.reduce((n, x) => n + x.items.length, 0) });
  }

  if (kind === "calendar") {
    const events = [
      ...(body.diary || []).map(e => cleanEvent(e, "diary")),
      ...(body.ops || []).map(e => cleanEvent(e, "ops")),
    ];
    // An empty feed with errors means the read failed: keep yesterday's events and record the error instead.
    const prev = await s.get("calendar/latest", { type: "json" });
    const errors = (body.errors || []).map(x => txt(x, 300));
    if (!events.length && errors.length && prev) {
      await s.setJSON("calendar/latest", { ...prev, errors, failedAt: new Date().toISOString() });
      return Response.json({ ok: false, kept: prev.events.length, errors });
    }
    await s.setJSON("calendar/latest", { at: new Date().toISOString(), from: txt(body.from, 40), to: txt(body.to, 40), events, errors });
    return Response.json({ ok: true, events: events.length });
  }

  if (kind === "signing") {
    const reg = (await s.get("inbox/signing", { type: "json" })) || { items: {} };
    let added = 0, updated = 0, cleared = 0;
    for (const it of body.items || []) {
      const key = txt(it.key, 200);
      if (!key) continue;
      const old = reg.items[key];
      const row = {
        key, kind: txt(it.kind, 20), doc: txt(it.doc, 200), property: txt(it.property, 120), unit: txt(it.unit, 40),
        subject: txt(it.subject, 240), from: txt(it.from, 120), firstSeen: old?.firstSeen || txt(it.date, 40), lastSeen: txt(it.date, 40),
        reminders: (old?.reminders || 0) + (old ? 1 : 0), url: /^https:\/\//.test(it.url || "") ? txt(it.url, 400) : old?.url || null,
        deposit: it.deposit ? {
          status: ["found", "possible", "none", "unknown"].includes(it.deposit.status) ? it.deposit.status : "unknown",
          note: txt(it.deposit.note, 300), checkedAt: new Date().toISOString(),
          matches: (it.deposit.matches || []).slice(0, 8).map(m => ({ date: txt(m.date, 20), name: txt(m.name, 80), amount: Number(m.amount) || 0, property: txt(m.property, 80), unit: txt(m.unit, 30), tab: txt(m.tab, 40) })),
        } : old?.deposit || null,
        status: old?.status === "signed" ? "signed" : "open",
      };
      if (old) updated++; else added++;
      reg.items[key] = row;
    }
    for (const c of body.completed || []) {
      let key = txt(c, 200);
      // "prop:<property>" (Buildium "fully signed" mail names only the property): close the oldest open Buildium row there.
      if (key.startsWith("prop:")) {
        const p = key.slice(5).toLowerCase();
        const cand = Object.values(reg.items).filter(x => x.status === "open" && x.kind === "buildium" && x.property.toLowerCase() === p).sort((a, b) => String(a.firstSeen).localeCompare(String(b.firstSeen)))[0];
        key = cand?.key || "";
      }
      if (reg.items[key] && reg.items[key].status !== "signed") { reg.items[key].status = "signed"; reg.items[key].signedAt = new Date().toISOString(); cleared++; }
    }
    // Keep 60 days of history.
    const cutoff = Date.now() - 60 * 864e5;
    for (const [k, v] of Object.entries(reg.items)) if (Date.parse(v.lastSeen || v.firstSeen || 0) < cutoff) delete reg.items[k];
    reg.at = new Date().toISOString();
    await s.setJSON("inbox/signing", reg);
    return Response.json({ ok: true, added, updated, cleared });
  }

  if (kind === "state") {
    const [signing, marks, brief] = await Promise.all([s.get("inbox/signing", { type: "json" }), s.get("state/marks", { type: "json" }), s.get("brief/latest", { type: "json" })]);
    const closed = (k) => ["done", "dismissed"].includes((marks || {})[k]?.status);
    const open = Object.values(signing?.items || {}).filter(x => x.status === "open" && !closed(`sign-${x.key}`));
    return Response.json({ signing: open, marks: marks || {}, lastBrief: brief ? { date: brief.date, generatedAt: brief.generatedAt } : null });
  }

  return NOT_FOUND();
};

export const config = { path: ["/api/ingest/brief", "/api/ingest/calendar", "/api/ingest/signing", "/api/ingest/state"], method: ["POST"] };
