// GET  /api/auth  -> { ok, email } for a valid session, else { error, clientId } so the page can show Google sign-in.
// POST /api/auth  { credential } -> { session, email }
import { issueSession, sessionFrom, verifyGoogle } from "../lib/session.mjs";

export default async (req) => {
  if (req.method === "POST") {
    try {
      const { credential } = await req.json();
      if (!credential) return Response.json({ error: "Missing Google credential." }, { status: 400 });
      const email = await verifyGoogle(credential);
      return Response.json({ session: issueSession(email), email });
    } catch (e) {
      return Response.json({ error: e.message || "Sign-in failed." }, { status: 401 });
    }
  }
  const s = sessionFrom(req);
  if (s) return Response.json({ ok: true, email: s.email });
  return Response.json({ error: "signin", clientId: Netlify.env.get("GSI_CLIENT_ID") || "" }, { status: 401 });
};

export const config = { path: "/api/auth", method: ["GET", "POST"] };
