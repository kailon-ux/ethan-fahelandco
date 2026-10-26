// Google sign-in for fahelandco.com accounts, and a signed session token (HMAC, 14 days).
import crypto from "node:crypto";

const DOMAIN = "fahelandco.com";
const TTL_MS = 14 * 24 * 3600 * 1000;
const env = k => (globalThis.Netlify ? Netlify.env.get(k) : process.env[k]);
const b64u = buf => Buffer.from(buf).toString("base64url");

function sign(payload) {
  const secret = env("SESSION_SECRET");
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export function issueSession(email) {
  const payload = b64u(JSON.stringify({ e: email, x: Date.now() + TTL_MS }));
  return `${payload}.${sign(payload)}`;
}

export function readSession(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  let expected;
  try { expected = sign(payload); } catch { return null; }
  const a = Buffer.from(sig || ""), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { e, x } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!e || !x || Date.now() > x) return null;
    if (!String(e).toLowerCase().endsWith("@" + DOMAIN)) return null;
    return { email: e, expires: x };
  } catch { return null; }
}

export function sessionFrom(req) {
  const h = req.headers.get("x-session");
  if (h) return readSession(h);
  const m = /(?:^|;\s*)fc_session=([^;]+)/.exec(req.headers.get("cookie") || "");
  return m ? readSession(decodeURIComponent(m[1])) : null;
}

// Verifies a Google Identity Services ID token with Google, then checks audience and domain.
export async function verifyGoogle(credential) {
  const clientId = env("GSI_CLIENT_ID");
  const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential));
  if (!r.ok) throw new Error("Google could not verify that sign-in. Try again.");
  const t = await r.json();
  if (t.aud !== clientId) throw new Error("This sign-in was issued for a different app.");
  if (String(t.email_verified) !== "true") throw new Error("Your Google email is not verified.");
  const email = String(t.email || "").toLowerCase();
  if (t.hd !== DOMAIN || !email.endsWith("@" + DOMAIN)) throw new Error("Use your fahelandco.com Google account.");
  return email;
}

export function runKey() {
  return sign("ethan-hub");
}
