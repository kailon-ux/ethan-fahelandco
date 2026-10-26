// Shared helpers: who may use the hub, the Blobs store, the ingest key, and monday GraphQL.
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";
import { sessionFrom } from "./session.mjs";

export const env = k => (globalThis.Netlify ? Netlify.env.get(k) : process.env[k]);
export const store = () => getStore({ name: "ethan-hub", consistency: "strong" });

// Hub readers and writers. Default: Ethan, finance@, Kailon, Rami. Override with HUB_USERS (comma separated).
const DEFAULT_USERS = ["ethan@fahelandco.com", "finance@fahelandco.com", "kailon@fahelandco.com", "rami@fahelandco.com"];
export function allowedUsers() {
  const raw = env("HUB_USERS");
  return raw ? raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean) : DEFAULT_USERS;
}

// Returns { email } for a signed-in hub user, or a Response to send back.
export function requireUser(req) {
  const s = sessionFrom(req);
  if (!s) return { deny: Response.json({ error: "signin" }, { status: 401 }) };
  if (!allowedUsers().includes(String(s.email).toLowerCase())) {
    return { deny: Response.json({ error: "This hub is limited to Ethan and the operations leads. Ask finance@ to add you." }, { status: 403 }) };
  }
  return { email: s.email };
}

// Machine writers (Zapier workflows, the morning brief task) send HUB_INGEST_KEY as body.key or header x-hub-key.
export function keyOk(req, body) {
  const want = env("HUB_INGEST_KEY");
  if (!want) return false;
  const got = String(req.headers.get("x-hub-key") || body?.key || "");
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const NOT_FOUND = () => Response.json({ error: "not found" }, { status: 404, headers: { "X-Robots-Tag": "noindex" } });

const API = "https://api.monday.com/v2";
export async function gql(query, variables = {}) {
  const token = env("MONDAY_TOKEN");
  if (!token) throw new Error("MONDAY_TOKEN is not set");
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(API, { method: "POST", headers: { Authorization: token, "Content-Type": "application/json", "API-Version": "2024-10" }, body: JSON.stringify({ query, variables }) });
    if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, 1200 * (attempt + 1))); continue; }
    const j = await r.json();
    if (j.errors?.length) throw new Error("monday: " + (j.errors[0].message || "query failed"));
    if (j.error_message) throw new Error("monday: " + j.error_message);
    return j.data;
  }
  throw new Error("monday kept failing after retries");
}

export const torontoDate = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
