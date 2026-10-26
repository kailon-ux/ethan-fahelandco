# Operations Hub for Ethan (ethan-fahelandco)

Staff module for Fahel & Co, same sign-in and design as staff.fahelandco.com (Google sign-in, fahelandco.com accounts, and only the people in HUB_USERS).
Built 2026-10-26. Netlify project: ethan-fahelandco (team "Fahel and Co"), https://ethan-fahelandco.netlify.app

## What it shows
- Today: the brief's 3 to 5 "if nothing else" items, today and tomorrow from every calendar source, and count tiles.
- Calendar, one merged agenda, colour coded, each stream can be switched off:
  - My calendar (Ethan's Google Calendar) and the Fahel Operations calendar, synced hourly by the Zapier workflow ethan-hub-calendar-feed.
  - Late Rent Cycle Tracker (board 18423960533, current month group): steps with a day in their Timing ("1st of month", "Month end", "5 days before the 1st") are placed on that day; the rest are listed under "Show the Late Rent cycle".
  - Master Operations Calendar (18421422068) items with a Due Date, status from that month's column.
  - Projects: MASTER Project Tracker (18403725633) items assigned to Ethan, on their timeline end date.
  - Deadlines from the brief: any brief row with a due date (red when overdue).
  - My items: added with "+" on any day, shared between hub users, ticked off into "Completed items".
  - Week view by default (Mon to Sun, previous/next), the month folded underneath. Click any entry for details, its link, Mark done or Hide.
- Morning brief: nine cards (Carlton West, Clients, Assigned by Rami, Assigned by Kailon, Urgent from the dashboard, Late Rent, Onboarding and offboarding, Leases to sign, Waiting on you). One line each, rows folded, every row with Open, Done and Hide.
- Leases to sign: live from the inbox labeller, with the E-Transfer Log deposit check per lease.
- Links to the boards, dashboard, meeting notes, E-Transfer Log, the old Fahel Ops Hub guides, and Gmail's To Sign / To Review labels.

## How data arrives
| Source | Writer | Endpoint / store key |
|---|---|---|
| Morning brief | Claude scheduled task "Ethan's morning brief (weekdays)", 08:00 ET | POST /api/ingest/brief -> brief/latest, brief/YYYY-MM-DD |
| Google Calendar | Zapier workflow ethan-hub-calendar-feed, hourly at :15 | POST /api/ingest/calendar -> calendar/latest |
| To Sign rows + deposit check | Zapier workflow ethan-inbox-labeller, on every new ethan@ inbox email | POST /api/ingest/signing -> inbox/signing |
| monday boards | the hub itself (MONDAY_TOKEN), cached 10 minutes, Refresh forces a re-read | agenda/cache |
| Done / Hide / my items | the page | POST /api/items -> state/marks, diary/items |

All ingest calls carry HUB_INGEST_KEY (body.key or header x-hub-key); a wrong key gets a plain 404. POST /api/ingest/state returns the open To Sign rows for the brief task.

## The inbox labeller (Zapier, private, finance@ account)
https://zapier.com/workflow/01a17921-a8b6-790b-9aa9-6722c3d2fb6c
- Trigger: Gmail new email in INBOX on ethan@ (connection 025952e5...). New mail only; nothing already in the inbox is touched.
- DocuSign "view and sign" (and reminders) and Buildium "... is ready for your signature": label To Sign, mark read. Leases (not N11/N4/parking/addenda) get a deposit check across the E-Transfer Log mailbox tabs for the last 30 days: same property and unit = Deposit in; property only (Buildium mail never names the unit) = Possible deposit; nothing = No deposit found.
- DocuSign "Completed:" removes To Sign from that document's emails and closes the hub row; Buildium "fully signed" closes the oldest open row for that property.
- Ethan in Cc only, not in To, and "Ethan" not written in the new part of the message: label To Review (left unread, in the inbox).
- Source copy: zapier/ethan-inbox-labeller.workflow.ts

## Environment variables (Functions scope)
| Name | What |
|---|---|
| GSI_CLIENT_ID | Google sign-in client ID (same client as the staff site). https://ethan-fahelandco.netlify.app must be added to its Authorized JavaScript origins in Google Cloud. |
| SESSION_SECRET | random, unique to this site |
| HUB_INGEST_KEY | random, shared with the two Zapier workflows and the brief task |
| MONDAY_TOKEN | monday API token (same service token as the staff site) |
| HUB_USERS | optional, comma separated; default ethan@, finance@, kailon@, rami@ |

## Deploy
Push to main on the GitHub repo (once linked); Netlify builds automatically. Until then, a manual `netlify deploy --prod --dir public --functions netlify/functions` from this folder.

## Rooming house licences
The hub carries a general guide only (who applies, the yearly renewal steps, sales and ownership changes, deadlines, where to send it, the City's insurance wording, forms). It does not track individual buildings.
