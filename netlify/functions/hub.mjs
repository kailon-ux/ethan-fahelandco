// GET /api/hub: everything the page shows, in one call.
// ?refresh=1 re-reads the monday boards now instead of using the 10 minute cache.
import { requireUser, store } from "../lib/common.mjs";
import { buildAgenda } from "../lib/agenda.mjs";

const AGENDA_TTL_MS = 10 * 60 * 1000;

export default async (req) => {
  const u = requireUser(req);
  if (u.deny) return u.deny;
  const s = store();
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";

  let agenda = await s.get("agenda/cache", { type: "json" });
  if (refresh || !agenda || Date.now() - Date.parse(agenda.at) > AGENDA_TTL_MS) {
    try {
      agenda = await buildAgenda();
      await s.setJSON("agenda/cache", agenda);
    } catch (e) {
      agenda = { ...(agenda || { master: [], projects: [], cycle: { steps: [] } }), errors: [`monday: ${e.message}`], stale: true };
    }
  }

  const [brief, calendar, signing, marks, diary] = await Promise.all([
    s.get("brief/latest", { type: "json" }),
    s.get("calendar/latest", { type: "json" }),
    s.get("inbox/signing", { type: "json" }),
    s.get("state/marks", { type: "json" }),
    s.get("diary/items", { type: "json" }),
  ]);

  return Response.json({
    me: u.email,
    now: new Date().toISOString(),
    brief: brief || null,
    calendar: calendar || null,
    signing: signing || { items: {} },
    marks: marks || {},
    diary: diary || [],
    agenda,
  }, { headers: { "Cache-Control": "no-store" } });
};

export const config = { path: "/api/hub", method: ["GET"] };
