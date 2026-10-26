import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";
import { z } from "zod";

// Ethan's inbox labeller. Fires on every new email in ethan@fahelandco.com's inbox (going forward only).
//  1. DocuSign or Buildium "please sign" mail: label "To Sign" and mark it read (it stays in the inbox).
//     For a lease, check the E-Transfer Log for a deposit at that property/unit and post the result to Ethan's hub.
//  2. DocuSign "Completed:" / Buildium "fully signed": take "To Sign" off the earlier emails and close the hub row.
//  3. Ethan only in Cc (not To), and his name is not used in the new part of the message: label "To Review"
//     (left unread and in the inbox).
// Nothing is deleted, archived or sent.

const sdk = createZapierSdk();
const GMAIL = "gmail_ethan";
const SHEETS = "sheets_kailon";
const ME = "ethan@fahelandco.com";
const HUB = "https://ethan-fahelandco.netlify.app";
const HUB_KEY = "<HUB_INGEST_KEY>"; // write-only key for the hub's intake (HUB_INGEST_KEY on Netlify)
const ET_LOG = "1sUwN8niHnfVyyxuIVpe-o3DUNiivoZtWrbMTSNLUHtI";
const ET_TABS = ["etransfer@fahel", "info@fahel", "remit@fahel", "canvaslofts@fahel", "rankin@fahel", "stirlingplace@fahel", "hinton@fahel", "250hinchey@fahel", "77flo@fahel", "312daly@fahel", "94russell@fahel", "2123ridge@fahel", "payments@fahel"];
const LOOKBACK_DAYS = 30;
const GM = "https://gmail.googleapis.com/gmail/v1/users/me";

const Addr = z.object({ emails: z.unknown(), names: z.unknown() }).loose().nullable().optional();
const InputSchema = z.object({
  message_id: z.string().nullable().optional(),
  thread_id: z.string().nullable().optional(),
  message_url: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  body_plain: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  from: z.object({ email: z.unknown(), name: z.unknown() }).loose().nullable().optional(),
  to: Addr,
  cc: Addr,
  raw: z.object({ id: z.string().nullable().optional(), labelIds: z.unknown(), internalDate: z.unknown() }).loose().nullable().optional(),
  test: z.boolean().nullable().optional(), // test runs: classify and check deposits, never touch the mailbox
}).loose();
type Input = z.infer<typeof InputSchema>;

function normalizeInput(raw: unknown): unknown { return typeof raw === "string" ? JSON.parse(raw) : raw; }
const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

function stripQuoted(body: string): string {
  const cut = body.search(/\n\s*On .{5,200}wrote:\s*\n|\n-{2,}\s*(Original|Forwarded) Message|\nFrom:\s.+\n(Sent|Date):\s|\n>/i);
  return (cut > 0 ? body.slice(0, cut) : body).trim();
}

type Sign = { kind: "docusign" | "buildium"; doc: string; property: string; unit: string; isLease: boolean };

// What kind of signing mail this is, if any.
function classifySigning(from: string, subject: string, body: string): { sign?: Sign; completedKey?: string; completedDoc?: string } {
  const s = subject.trim();
  const domain = ((from.split(/\s+/)[0] || "").split("@")[1] || "").toLowerCase();
  if (/docusign\.net$/.test(domain) || /via docusign/i.test(from)) {
    const doc = s.replace(/^(Reminder|Completed|Voided|Declined):\s*/i, "").replace(/^[A-Z0-9-]+\s+Complete with Docusign:\s*/i, "").replace(/^Complete with Docusign:\s*/i, "").trim();
    if (/^Completed:/i.test(s)) return { completedKey: "ds-" + doc, completedDoc: doc };
    if (!/(sent you a new docusign document to view and sign|review document|please docusign|complete with docusign)/i.test(body + " " + s)) return {};
    if (/^(Voided|Declined):/i.test(s)) return {};
    let property = "", unit = "";
    const cw = /^([A-Z]\d{2,4})\s*[-_ ]+\s*Carlton[ _]West/i.exec(doc);
    const pu = /(\d{1,4}(?:-\d{1,4})?\s+[A-Za-z'][A-Za-z' ]+?)\s*-\s*([A-Za-z0-9]{1,6})\.pdf/i.exec(doc);
    if (cw) { property = "Carlton West (1655 Carling)"; unit = cw[1].toUpperCase(); }
    else if (pu) { property = pu[1].trim(); unit = pu[2].toUpperCase(); }
    const notLease = /\b(N11|N1|N4|N9|N12|L1|parking|addendum|amendment|insurance|invoice)\b/i.test(doc);
    const isLease = !notLease && (/lease/i.test(doc) || !!property);
    return { sign: { kind: "docusign", doc, property, unit, isLease } };
  }
  if (/managebuilding\.com$|buildium\.com$/.test(domain)) {
    const ready = /^An? (lease|addendum|document|renewal)[a-z ]* for (.+?) is ready for your signature/i.exec(s);
    if (ready) return { sign: { kind: "buildium", doc: s, property: ready[2].trim(), unit: "", isLease: /lease|renewal/i.test(ready[1]) } };
    const done = /^An? (lease|addendum|renewal)[a-z ]* for (.+?) is fully signed/i.exec(s);
    if (done) return { completedKey: "prop:" + done[2].trim(), completedDoc: s };
  }
  return {};
}

// Property matching between a lease email and an E-Transfer Log row.
function propParts(p: string) {
  const low = p.toLowerCase().replace(/\(.*?\)/g, " ");
  const nums = (low.match(/\d+/g) || []).map(Number);
  const words = (low.match(/[a-z']{3,}/g) || []).filter((w) => !["street", "avenue", "ave", "road", "crescent", "drive", "unit", "the", "and", "private", "boulevard", "place"].includes(w));
  return { nums, words };
}
function sameProperty(lease: string, logProp: string, extra = ""): boolean {
  if (/carlton west|1655 carling/i.test(lease)) return /carlton|1655 carling/i.test(logProp + " " + extra);
  const a = propParts(lease), b = propParts(logProp || extra);
  if (!a.words.length || !b.words.some((w) => a.words.includes(w))) return false;
  if (!a.nums.length || !b.nums.length) return true;
  const lo = Math.min(...a.nums.slice(0, 2)), hi = Math.max(...a.nums.slice(0, 2));
  return b.nums.slice(0, 2).some((n) => n >= lo && n <= hi);
}
const normUnit = (u: string) => u.toLowerCase().replace(/\.0+$/, "").replace(/[^a-z0-9]/g, "").replace(/^0+/, "");

export default defineDurable<Input, unknown>("ethan-inbox-labeller", async (ctx, rawInput) => {
  const input = InputSchema.parse(normalizeInput(rawInput)) as Input;
  const id = input.message_id ?? input.raw?.id ?? "";
  if (!id) return { skipped: true, reason: "no-message-id" };
  const from = (str(input.from?.email) + " " + str(input.from?.name)).toLowerCase();
  const fromEmail = str(input.from?.email).toLowerCase();
  const subject = input.subject ?? "";
  const body = input.body_plain ?? "";
  const to = list(input.to?.emails), cc = list(input.cc?.emails);
  if (fromEmail === ME) return { skipped: true, reason: "sent-by-ethan" };

  const sig = classifySigning(fromEmail + " " + from, subject, body);
  const isReview = !sig.sign && !sig.completedKey && cc.includes(ME) && !to.includes(ME) && !/\bethan\b/i.test(stripQuoted(body) + " " + subject);
  if (!sig.sign && !sig.completedKey && !isReview) return { skipped: true, reason: "no-rule-matched" };

  // Label ids, creating "To Sign" / "To Review" the first time.
  if (input.test && isReview) return { test: true, wouldLabel: "To Review", subject };
  const labels = await ctx.step("ensure-labels", async () => {
    const r = await sdk.fetch(`${GM}/labels`, { connection: GMAIL, method: "GET" });
    if (!r.ok) throw new Error(`Gmail labels ${r.status}`);
    const j = (await r.json()) as { labels?: { id: string; name: string }[] };
    const out: Record<string, string> = {};
    for (const name of ["To Sign", "To Review"]) {
      const hit = (j.labels || []).find((l) => l.name.toLowerCase() === name.toLowerCase());
      if (hit) { out[name] = hit.id; continue; }
      const c = await sdk.fetch(`${GM}/labels`, { connection: GMAIL, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }) });
      if (!c.ok) throw new Error(`Gmail create label ${name} ${c.status}`);
      out[name] = ((await c.json()) as { id: string }).id;
    }
    return out;
  });

  if (isReview) {
    await ctx.step("label-to-review", async () => {
      const r = await sdk.fetch(`${GM}/messages/${id}/modify`, { connection: GMAIL, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ addLabelIds: [labels["To Review"]] }) });
      if (!r.ok) throw new Error(`Gmail modify ${r.status}`);
      return { ok: true };
    });
    return { labelled: "To Review", subject };
  }

  if (sig.completedKey) {
    // Take "To Sign" off the earlier emails for this document, then close the hub row.
    const removed = await ctx.step("clear-to-sign", async () => {
      const q = sig.completedKey!.startsWith("ds-") ? `label:to-sign subject:"${sig.completedDoc!.replace(/"/g, "").slice(0, 120)}"` : "";
      if (!q) return 0;
      const r = await sdk.fetch(`${GM}/messages?maxResults=50&q=${encodeURIComponent(q)}`, { connection: GMAIL, method: "GET" });
      if (!r.ok) throw new Error(`Gmail search ${r.status}`);
      const ids = (((await r.json()) as { messages?: { id: string }[] }).messages || []).map((m) => m.id);
      if (!ids.length) return 0;
      const m = await sdk.fetch(`${GM}/messages/batchModify`, { connection: GMAIL, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids, removeLabelIds: [labels["To Sign"]] }) });
      if (!m.ok) throw new Error(`Gmail batchModify ${m.status}`);
      return ids.length;
    });
    const posted = await ctx.step("post-completed-to-hub", async () => {
      const r = await sdk.fetch(`${HUB}/api/ingest/signing`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: HUB_KEY, completed: [sig.completedKey] }) });
      return { status: r.status, body: (await r.text()).slice(0, 200) };
    });
    return { completed: sig.completedKey, unlabelled: removed, posted };
  }

  const sign = sig.sign!;
  if (!input.test) await ctx.step("label-to-sign-and-mark-read", async () => {
    const r = await sdk.fetch(`${GM}/messages/${id}/modify`, { connection: GMAIL, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ addLabelIds: [labels["To Sign"]], removeLabelIds: ["UNREAD"] }) });
    if (!r.ok) throw new Error(`Gmail modify ${r.status}`);
    return { ok: true };
  });

  const receivedAt = await ctx.step("capture-received-at", async () => {
    const ms = Number(str(input.raw?.internalDate)) || Date.parse(input.date ?? "") || Date.now();
    return new Date(ms).toISOString();
  });

  // Deposit check against the E-Transfer Log, for leases with a known property.
  let deposit: { status: string; note: string; matches: unknown[] } = { status: "unknown", note: "Not a lease, no deposit check", matches: [] };
  if (sign.isLease && sign.property) {
    deposit = await ctx.step({
      name: "check-etransfer-log", maxAttempts: 2, retryDelaySeconds: 10,
      run: async () => {
        const ranges = ET_TABS.map((t) => `ranges=${encodeURIComponent(`'${t}'!A:K`)}`).join("&");
        const r = await sdk.fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ET_LOG}/values:batchGet?${ranges}&valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`, { connection: SHEETS, method: "GET" });
        if (!r.ok) return { status: "unknown", note: `E-Transfer Log could not be read (${r.status})`, matches: [] };
        const j = (await r.json()) as { valueRanges?: { range: string; values?: string[][] }[] };
        const since = Date.parse(receivedAt) - LOOKBACK_DAYS * 864e5;
        const exact: Record<string, unknown>[] = [], near: Record<string, unknown>[] = [];
        for (const vr of j.valueRanges || []) {
          const tab = vr.range.split("!")[0].replace(/'/g, "");
          const rows = vr.values || [];
          const head = (rows[0] || []).map((h) => String(h).trim().toLowerCase());
          const col = (n: string) => head.indexOf(n);
          const cDate = col("date"), cName = col("name"), cAmt = col("amount"), cDesc = col("description"), cBn = col("buildium name"), cProp = col("property"), cUnit = col("unit");
          for (const row of rows.slice(1)) {
            const d = Date.parse(String(row[cDate] || ""));
            if (!d || d < since) continue;
            const prop = String(row[cProp] || ""), desc = String(row[cDesc] || "");
            if (!sameProperty(sign.property, prop, desc)) continue;
            const m = { date: String(row[cDate]).slice(0, 10), name: String(row[cBn] || row[cName] || ""), amount: Number(String(row[cAmt] || "0").replace(/[$,]/g, "")) || 0, property: prop || desc.slice(0, 60), unit: String(row[cUnit] || ""), tab };
            if (sign.unit && normUnit(m.unit) && normUnit(m.unit) === normUnit(sign.unit)) exact.push(m); else near.push(m);
          }
        }
        if (exact.length) return { status: "found", note: `${exact.length} e-transfer${exact.length > 1 ? "s" : ""} for ${sign.property} ${sign.unit} in the last ${LOOKBACK_DAYS} days`, matches: exact };
        if (near.length && !sign.unit) return { status: "possible", note: `Unit not named in the email: ${near.length} e-transfer${near.length > 1 ? "s" : ""} at ${sign.property} in the last ${LOOKBACK_DAYS} days`, matches: near.slice(-8) };
        if (near.length) return { status: "none", note: `No e-transfer for unit ${sign.unit}; ${near.length} other${near.length > 1 ? "s" : ""} at ${sign.property}`, matches: near.slice(-5) };
        return { status: "none", note: `No e-transfer at ${sign.property} in the E-Transfer Log in the last ${LOOKBACK_DAYS} days`, matches: [] };
      },
    });
  } else if (sign.isLease) {
    deposit = { status: "unknown", note: "The email does not name the property, check the lease", matches: [] };
  }

  const key = sign.kind === "docusign" ? "ds-" + sign.doc : `bd-${sign.property}-${input.thread_id ?? id}`;
  const posted = await ctx.step("post-signing-to-hub", async () => {
    const r = await sdk.fetch(`${HUB}/api/ingest/signing`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: HUB_KEY, items: [{ key, kind: sign.kind, doc: sign.doc, property: sign.property, unit: sign.unit, subject, from: str(input.from?.name), date: receivedAt, url: `https://mail.google.com/mail/u/?authuser=${ME}#all/${input.thread_id ?? id}`, deposit }], completed: input.test ? [key] : [] }), // a test run closes its own row straight away
    });
    return { status: r.status, body: (await r.text()).slice(0, 200) };
  });

  return { labelled: "To Sign", markedRead: true, key, deposit: { status: deposit.status, note: deposit.note }, posted };
});
