// The monday side of Ethan's merged agenda: Master Operations Calendar, Late Rent Cycle Tracker, MASTER Project Tracker.
// Every entry: { id, stream, date (YYYY-MM-DD or null), title, who, status, timing, link, done }
import { gql, torontoDate } from "./common.mjs";

export const BOARDS = {
  master: 18421422068,   // Master Operations Calendar
  cycle: 18423960533,    // Late Rent Cycle Tracker (one group per month)
  projects: 18403725633, // MASTER Project Tracker
};
const ETHAN_MONDAY_ID = "64815041";
const MONTH_COLS = { 7: "color_mm4m9q8q", 8: "color_mm4m52w8", 9: "color_mm4m70bn", 10: "color_mm54xmjb", 11: "color_mm546fer", 12: "color_mm545tnz" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const link = (b, id) => `https://fahel.monday.com/boards/${b}/pulses/${id}`;
const short = s => String(s || "").replace(/ @ Fahel & Co/g, "").replace(/Ethan Grant/g, "Ethan").replace(/Management/g, "Mgmt");
const isDone = s => /^(done|complete|completed|not needed|cancelled|canceled)$/i.test(String(s || "").trim());

function ymd(y, m, d) { return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }
function lastBusinessDay(y, m) {
  const d = new Date(Date.UTC(y, m, 0));
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() - 1);
  return ymd(y, m, d.getUTCDate());
}

// Late Rent Cycle "Timing" text -> a date in the month, or null when it is ongoing work.
export function timingToDate(timing, y, m) {
  const t = String(timing || "").toLowerCase();
  if (!t) return null;
  if (/month end|end of month|last week/.test(t)) return lastBusinessDay(y, m);
  const before = /(\d+)\s*days? before the 1st/.exec(t);
  if (before) { const d = new Date(Date.UTC(y, m, 1)); d.setUTCDate(d.getUTCDate() - Number(before[1])); return d.toISOString().slice(0, 10); }
  if (/^(daily|weekly|ongoing|as |on |when |per |same day|within|after|before|\d+\+? days)/.test(t)) return null;
  const nth = /\b(\d{1,2})(st|nd|rd|th)\b/.exec(t);
  if (nth && !/business/.test(t)) return ymd(y, m, Math.min(28, Number(nth[1])));
  return null;
}

async function masterCalendar() {
  const cols = ["text_mm4m70pz", "multiple_person_mm5qrkxr", "date_mm54809p", ...Object.values(MONTH_COLS)];
  const d = await gql(`query($b:[ID!]){boards(ids:$b){items_page(limit:200){items{id name column_values(ids:${JSON.stringify(cols)}){id text}}}}}`, { b: [BOARDS.master] });
  return (d.boards[0]?.items_page?.items || []).map(it => {
    const v = Object.fromEntries(it.column_values.map(c => [c.id, c.text || ""]));
    const date = v.date_mm54809p || null;
    const mon = date ? Number(date.slice(5, 7)) : null;
    const status = mon && MONTH_COLS[mon] ? v[MONTH_COLS[mon]] : "";
    return {
      id: "m" + it.id, stream: "master", date, title: it.name, who: short(v.multiple_person_mm5qrkxr), timing: v.text_mm4m70pz,
      status, done: isDone(status), mine: /Ethan/.test(v.multiple_person_mm5qrkxr), link: link(BOARDS.master, it.id),
    };
  });
}

async function lateRentCycle(now) {
  const y = Number(now.slice(0, 4)), m = Number(now.slice(5, 7));
  const title = `${MONTHS[m - 1]} ${y}`;
  const g = await gql(`query($b:[ID!]){boards(ids:$b){groups{id title}}}`, { b: [BOARDS.cycle] });
  const group = (g.boards[0]?.groups || []).find(x => x.title.trim() === title);
  if (!group) return { month: title, missing: true, steps: [] };
  const cols = ["color_mm5nh9kk", "multiple_person_mm5nxd4m", "text_mm5nbr7j", "color_mm5naa6a"];
  const d = await gql(`query($b:[ID!],$g:[String]){boards(ids:$b){groups(ids:$g){items_page(limit:100){items{id name column_values(ids:${JSON.stringify(cols)}){id text}}}}}}`, { b: [BOARDS.cycle], g: [group.id] });
  const items = d.boards[0]?.groups?.[0]?.items_page?.items || [];
  const steps = items.map(it => {
    const v = Object.fromEntries(it.column_values.map(c => [c.id, c.text || ""]));
    const n = Number((/^(\d+)\./.exec(it.name) || [])[1] || 0);
    return {
      id: "c" + it.id, stream: "cycle", n, title: it.name.replace(/^\d+\.\s*/, ""), type: v.color_mm5nh9kk, who: short(v.multiple_person_mm5nxd4m),
      timing: v.text_mm5nbr7j, status: v.color_mm5naa6a, done: isDone(v.color_mm5naa6a), mine: /Ethan/.test(v.multiple_person_mm5nxd4m),
      date: timingToDate(v.text_mm5nbr7j, y, m), link: link(BOARDS.cycle, it.id),
    };
  }).sort((a, b) => a.n - b.n);
  return { month: title, missing: false, steps, done: steps.filter(s => s.done).length, total: steps.length };
}

async function projects() {
  const cols = ["multiple_person_mm41sreh", "timerange_mm1cmnyj", "color_mm1ceqts", "color_mm1ctyxz"];
  const out = [];
  let d = await gql(`query($b:[ID!]){boards(ids:$b){items_page(limit:200, query_params:{rules:[{column_id:"multiple_person_mm41sreh", compare_value:["person-${ETHAN_MONDAY_ID}"], operator:any_of}]}){cursor items{id name group{title} column_values(ids:${JSON.stringify(cols)}){id text value}}}}}`, { b: [BOARDS.projects] });
  let page = d.boards[0]?.items_page;
  const take = p => (p?.items || []).forEach(it => {
    const v = Object.fromEntries(it.column_values.map(c => [c.id, c]));
    let from = null, to = null;
    try { const tr = JSON.parse(v.timerange_mm1cmnyj?.value || "null"); from = tr?.from || null; to = tr?.to || null; } catch { /* no timeline */ }
    const status = v.color_mm1ceqts?.text || "";
    out.push({ id: "p" + it.id, stream: "projects", date: to, from, title: it.name, group: it.group?.title || "", status, priority: v.color_mm1ctyxz?.text || "", done: isDone(status), mine: true, link: link(BOARDS.projects, it.id) });
  });
  take(page);
  while (page?.cursor) {
    d = await gql(`query($c:String!){next_items_page(limit:200, cursor:$c){cursor items{id name group{title} column_values(ids:${JSON.stringify(cols)}){id text value}}}}`, { c: page.cursor });
    page = d.next_items_page; take(page);
  }
  return out;
}

// Each source fails on its own, so one broken board never blanks the calendar.
export async function buildAgenda() {
  const now = torontoDate();
  const [m, c, p] = await Promise.allSettled([masterCalendar(), lateRentCycle(now), projects()]);
  return {
    at: new Date().toISOString(),
    master: m.status === "fulfilled" ? m.value : [],
    cycle: c.status === "fulfilled" ? c.value : { month: "", missing: true, steps: [] },
    projects: p.status === "fulfilled" ? p.value : [],
    errors: [m, c, p].map((r, i) => r.status === "rejected" ? `${["Master Operations Calendar", "Late Rent Cycle Tracker", "Project Tracker"][i]}: ${r.reason?.message || r.reason}` : null).filter(Boolean),
  };
}
