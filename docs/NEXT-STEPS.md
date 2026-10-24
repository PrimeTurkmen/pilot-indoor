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
- Docs: root README (store extensions), `docs/PILOT-TELEMATICS-OVERVIEW.md`,
  `docs/store-extensions/` (dev docs), `README-indoor-positioning.md`.

## Remaining (in priority order)

1. **Click → map (CEO's core ask).** Click a fine (or Salik trip) → show the car's
   GPS position at that timestamp on the Pilot Leaflet map. Needs the GPS track
   via `/api/v3/vehicles/trips?agent_id=X&from=ts&to=te` (returned HTTP 400 on an
   early probe — confirm the exact param format) + `skeleton.mapframe` pan/marker.
   Note: ministry fine timestamps lag the actual event — show "best case / nearby".

2. **Sort + filter.** Flexible date range (already in `/report`) + sort by column
   + "rental duration only" (filter fines/trips within the car's rental window,
   from the contracts data). Email clients can't sort — do this in the extension
   UI (sortable ExtJS grid) or a web report view.

3. **Linking form.** A form to link a Pilot agent/vehicle to its Salik/RTA plate,
   or manually enter the plate in the RTA/Salik format. Data is account-scoped by
   Pilot ID; client inputs their creds → sees their data.

4. **AI worker (SLA level 1).** Give the AI write operations in Pilot (via admin
   API): `block_unblock.php?cmd=block/unblock`, `debits.php` (balance), delete
   endpoints (eco/files/drivers/…), plus comms (email/telegram/whatsapp/notify).
   Autonomous for low-risk (comms, balance), **confirmation-required for
   destructive (delete/block)**, every write audited, and auto-create a ticket +
   escalate to TSC when stuck.

5. **Security.** `salik/pull.js` still has hardcoded Salik fallback passwords
   (Takeauto, KVADRAT). Move to env before making the repo fully public. Same for
   the one-off scripts (already gitignored).

## Key gotchas (see docs/store-extensions/SHARED-CONTEXT.md)

- `Ext.Ajax.request` is broken under `/store/` — use native `fetch()`.
- Extension enablement is **per-user**, not per-account.
- Salik is geo-blocked from the VPS (Malaysia) — pull from a UAE machine.
- RTA non-Dubai plates need the **UTS plate code**, not the display digit.
