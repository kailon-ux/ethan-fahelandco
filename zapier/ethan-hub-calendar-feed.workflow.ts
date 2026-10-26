import { defineDurable } from "@zapier/zapier-durable";
import { createZapierSdk } from "@zapier/zapier-sdk";

// Ethan's hub calendar feed. Every hour it reads Ethan's own Google Calendar and the shared
// "Fahel Operations" calendar (7 days back, 6 weeks ahead) through the ethan@ Google Calendar
// connection and posts the events to the hub, which merges them with the monday dates.
// Read only on the calendars. Writes nothing anywhere except the hub's intake.

const sdk = createZapierSdk();
const GCAL = "gcal_ethan";
const HUB = "https://ethan-fahelandco.netlify.app";
const HUB_KEY = "<HUB_INGEST_KEY>"; // write-only key for the hub's intake (HUB_INGEST_KEY on Netlify)
const CALENDARS = [
  { as: "diary", id: "ethan@fahelandco.com" },
  { as: "ops", id: "c_78dd4f1e75b85e7c05542412d4ec329b000c549385dae0d057e8bddc075a2fcc@group.calendar.google.com" },
];
const ME = "ethan@fahelandco.com";

type GEvent = {
  id: string; status?: string; summary?: string; location?: string; htmlLink?: string;
  start?: { date?: string; dateTime?: string }; end?: { date?: string; dateTime?: string };
  attendees?: { email?: string; self?: boolean; responseStatus?: string }[]; organizer?: { email?: string; displayName?: string };
  eventType?: string;
};

export default defineDurable<unknown, unknown>("ethan-hub-calendar-feed", async (ctx) => {
  const window = await ctx.step("capture-window", async () => {
    const now = Date.now();
    return { from: new Date(now - 7 * 864e5).toISOString(), to: new Date(now + 42 * 864e5).toISOString() };
  });

  const results = await Promise.all(CALENDARS.map((cal) => ctx.step({
    name: `read-${cal.as}`, maxAttempts: 2, retryDelaySeconds: 10,
    run: async () => {
      const events: Record<string, unknown>[] = [];
      let pageToken = "";
      for (let page = 0; page < 10; page++) {
        const qs = new URLSearchParams({ timeMin: window.from, timeMax: window.to, singleEvents: "true", orderBy: "startTime", maxResults: "250", timeZone: "America/Toronto" });
        if (pageToken) qs.set("pageToken", pageToken);
        const r = await sdk.fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${qs}`, { connection: GCAL, method: "GET" });
        if (!r.ok) return { ok: false, error: `${cal.as}: Google Calendar ${r.status} ${(await r.text()).slice(0, 160)}`, events: [] };
        const j = (await r.json()) as { items?: GEvent[]; nextPageToken?: string };
        for (const e of j.items || []) {
          if (e.status === "cancelled" || e.eventType === "workingLocation") continue;
          const me = (e.attendees || []).find((a) => a.self || (a.email || "").toLowerCase() === ME);
          if (me?.responseStatus === "declined") continue;
          events.push({
            id: e.id, title: e.summary || "(no title)", location: e.location || "", link: e.htmlLink || "",
            start: e.start?.dateTime || e.start?.date || "", end: e.end?.dateTime || e.end?.date || "", allDay: !!e.start?.date,
            needsAction: cal.as === "diary" && me?.responseStatus === "needsAction" && (e.organizer?.email || "").toLowerCase() !== ME,
            organizer: e.organizer?.displayName || e.organizer?.email || "",
          });
        }
        if (!j.nextPageToken) break;
        pageToken = j.nextPageToken;
      }
      return { ok: true, error: null as string | null, events };
    },
  })));

  const byCal = Object.fromEntries(CALENDARS.map((c, i) => [c.as, results[i]]));
  const posted = await ctx.step("post-calendar-to-hub", async () => {
    const r = await sdk.fetch(`${HUB}/api/ingest/calendar`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: HUB_KEY, from: window.from, to: window.to, diary: byCal.diary.events, ops: byCal.ops.events, errors: results.filter((x) => !x.ok).map((x) => x.error) }),
    });
    return { status: r.status, body: (await r.text()).slice(0, 200) };
  });

  return { diary: byCal.diary.events.length, ops: byCal.ops.events.length, errors: results.filter((x) => !x.ok).map((x) => x.error), posted };
});
