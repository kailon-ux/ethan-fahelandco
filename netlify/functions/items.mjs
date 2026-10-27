// POST /api/items: the page's own writes, all keyed and shared between hub users.
//   { op:"mark", id, status:"done"|"dismissed"|"open" }        tick or hide a brief row / agenda entry / signing row
//   { op:"update", id, status?, due?, note?, deleteNote? }      to-do state on any row: status open|inprogress|deferred|done|dismissed,
//                                                               due YYYY-MM-DD (moves it on the calendar; "" clears), note appends to its notes log.
//                                                               Notes and a moved date survive a reopen; history keeps the last 30 changes.
//   { op:"add", date, title, note }                             add a diary item on a day
//   { op:"move", id, date }                                     move a diary item to another day (calendar drag and drop)
//   { op:"toggle", id }                                         complete or reopen a diary item
//   { op:"delete", id }                                         remove a diary item
import crypto from "node:crypto";
import { requireUser, store } from "../lib/common.mjs";

const DASHES = new RegExp("[" + String.fromCharCode(8211, 8212) + "]", "g"); // en and em dashes become plain hyphens
const STATUSES = ["open", "inprogress", "deferred", "done", "dismissed"];
const LABEL = { inprogress: "Marked in progress", deferred: "Deferred", done: "Marked done", dismissed: "Hidden" };
const clean = (s, n) => String(s ?? "").replace(DASHES, "-").trim().slice(0, n);

export default async (req) => {
  const u = requireUser(req);
  if (u.deny) return u.deny;
  let b;
  try { b = await req.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
  const s = store();
  const at = new Date().toISOString();

  if (b.op === "mark" || b.op === "update") {
    const id = clean(b.id, 200);
    if (!id) return Response.json({ error: "id required" }, { status: 400 });
    const marks = (await s.get("state/marks", { type: "json" })) || {};
    const m = { ...(marks[id] || {}) };
    const log = (what) => { m.history = [...(m.history || []), { what, by: u.email, at }].slice(-30); };
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) return Response.json({ error: "status must be one of " + STATUSES.join(", ") }, { status: 400 });
      if (b.status === "open") { if (m.status) log("Reopened"); delete m.status; }
      else if (m.status !== b.status) { m.status = b.status; log(LABEL[b.status]); }
      m.by = u.email; m.at = at;
    }
    if (b.due !== undefined) {
      const due = b.due === null || b.due === "" ? null : /^\d{4}-\d{2}-\d{2}$/.test(b.due) ? b.due : undefined;
      if (due === undefined) return Response.json({ error: "due must be YYYY-MM-DD or empty" }, { status: 400 });
      if (due !== (m.due || null)) { if (due) m.due = due; else delete m.due; log(due ? "Date set to " + due : "Date cleared"); }
    }
    const note = clean(b.note, 1000);
    if (note) { m.notes = [...(m.notes || []), { text: note, by: u.email, at }].slice(-50); }
    if (b.deleteNote !== undefined && m.notes) { m.notes = m.notes.filter(n => n.at !== b.deleteNote || n.by !== u.email); }
    if (!m.status && !m.due && !(m.notes || []).length) delete marks[id];
    else marks[id] = m;
    await s.setJSON("state/marks", marks);
    return Response.json({ ok: true, marks });
  }

  const items = (await s.get("diary/items", { type: "json" })) || [];
  if (b.op === "add") {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || "") ? b.date : null;
    const title = clean(b.title, 200);
    if (!date || !title) return Response.json({ error: "date and title required" }, { status: 400 });
    items.push({ id: "d" + crypto.randomBytes(6).toString("hex"), date, title, note: clean(b.note, 1000), done: false, by: u.email, at });
  } else if (b.op === "move") {
    const i = items.findIndex(x => x.id === b.id);
    if (i < 0) return Response.json({ error: "not found" }, { status: 404 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || "")) return Response.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
    items[i].date = b.date; items[i].movedBy = u.email; items[i].movedAt = at;
  } else if (b.op === "toggle" || b.op === "delete") {
    const i = items.findIndex(x => x.id === b.id);
    if (i < 0) return Response.json({ error: "not found" }, { status: 404 });
    if (b.op === "delete") items.splice(i, 1);
    else { items[i].done = !items[i].done; items[i].doneAt = items[i].done ? at : null; items[i].doneBy = items[i].done ? u.email : null; }
  } else {
    return Response.json({ error: "unknown op" }, { status: 400 });
  }
  await s.setJSON("diary/items", items);
  return Response.json({ ok: true, diary: items });
};

export const config = { path: "/api/items", method: ["POST"] };
