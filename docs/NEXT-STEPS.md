# Next steps — CEO vision (Pilot Telematics extension)

Status of the RTA/Salik/AI extension work, and what's left. The AI should become
an **SLA level-1 worker** for the operator-client, plus the CEO's "time-log" map
view.

## Done

- RTA fines — Dubai (letter codes) + Sharjah/Abu Dhabi (UTS plate codes, resolved
  from `comgw.rta.ae/comgw/mastersetup/api/msd/get-plate-search`, cached 1 day).
  `rta.py` `decode_plate()` detects the emirate prefix (`SHJ`/`AUH`/`AJM`/`UMQ`/
  `RAK`/`FUJ`/`DXB`) and maps the display code → UTS code (Sharjah "3" → 692).
- Salik tolls — multi-account puller (`salik/pull.js`) on Parrot, hourly cron
  pushes a JSON snapshot to the VPS; `/salik` serves it.
- AI chat (read-only) + `/report` (DeepSeek → HTML → SMTP email). Report has
  `from_date` / `to_date` / `plates` filters.
- **Click → map (CEO's core ask).** Click a fine → car GPS position at event
  time on the Pilot Leaflet map (`/backend/ax/tracks_get_history.php` ±30 min,
  nearest segment → `skeleton.mapframe` pan/marker). Ministry fine timestamps
  lag the real event — shows "best case / nearby".
- **Sort + filter.** Sort by column + flexible date range + "rental duration
  only" filter (contracts data), in the extension UI (sortable ExtJS grids).
- **Vehicle name + Agent ID from Pilot** — `name` + `agentid` columns in Fines,
  Salik and Fleet grids.
- **Trips breakdown tab** — per-vehicle trip/parking segments for a chosen
  period (toolbar From/To, default last 7 days); click a trip → map at trip
  start.
- **Salik trip window** — clicking a Salik plate opens its per-trip breakdown
  (date, gate, amount); clicking a trip → map at that timestamp.
- **Linking form** — link a Pilot agent to its RTA plate (format `DXB K 62968`
  / `SHJ 3 18894`) and Salik plate, or enter a manual plate with no Pilot
  agent. Persisted in localStorage per user; linked plates feed the RTA fines
  query and Salik matching.
- Deployed live: `/var/www/pilot-store-rtasalik/` on the VPS (Caddy), verified
  md5 through the pilot-gps.com `/store/rta_salik/` proxy; enabled for all 4
  RMA account (19336) users.
- Docs: root README (store extensions), `docs/PILOT-TELEMATICS-OVERVIEW.md`,
  `docs/store-extensions/` (dev docs), `README-indoor-positioning.md`.

## Remaining (in priority order)

1. **AI worker (SLA level 1).** Give the AI write operations in Pilot (via admin
   API): `block_unblock.php?cmd=block/unblock`, `debits.php` (balance), delete
   endpoints (eco/files/drivers/…), plus comms (email/telegram/whatsapp/notify).
   Autonomous for low-risk (comms, balance), **confirmation-required for
   destructive (delete/block)**, every write audited, and auto-create a ticket +
   escalate to TSC when stuck.

2. **Security.** `salik/pull.js` still has hardcoded Salik fallback passwords
   (Takeauto, KVADRAT). Move to env before making the repo fully public. Same for
   the one-off scripts (already gitignored).

## Key gotchas (see docs/store-extensions/SHARED-CONTEXT.md)

- `Ext.Ajax.request` is broken under `/store/` — use native `fetch()`.
- Extension enablement is **per-user**, not per-account.
- Salik is geo-blocked from the VPS (Malaysia) — pull from a UAE machine.
- RTA non-Dubai plates need the **UTS plate code**, not the display digit.
- Live extension state + deploy one-liner: see the
  `fleet-gps-ingestion` skill → `references/pilot-rta-salik-state.md`.
