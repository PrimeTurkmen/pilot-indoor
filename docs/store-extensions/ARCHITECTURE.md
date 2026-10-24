# Architecture — Pilot Store Extensions

This document describes how the store-extensions work fits together. Read
[README.md](README.md) first for the high-level picture.

## The three layers

### 1. ExtJS "store" extensions (run in the browser, inside Pilot)

Each extension is a single `Module.js` defining an `Ext.define(...)` class plus a
`config.json` (and usually a `styles.css`). Pilot loads them via its
`/store/<name>/` proxy and calls `initModule(main, online)`.

| Extension | Class name | Entry point | UI |
|---|---|---|---|
| AI Assistant | `Store.ai_assistant.Module` | header button (`sk.header.insert`) | floating chat window + "Email report" |
| RTA Salik | `Store.rta_salik.Module` | nav tab (`sk.navigation.add`) | tab panel: RTA Fines + Salik Tolls, plus an AI window |
| Rental Booster | `Store.rental_booster.Module` | nav tab | tab panel: Fleet / Contracts / Fines, plus an AI window |

**Pattern (identical across all three):**

1. `initModule()` merges `DEFAULT_CONFIG` with `config.json` (fetched from
   `/store/<name>/config.json` with `credentials:'include'` and `cache:'no-store'`).
2. It injects a `<link>` to `/store/<name>/styles.css`.
3. It builds its UI against Pilot's skeleton: `main.skeleton` (or
   `window.skeleton`) — inserting into `sk.header` (a button) or
   `sk.navigation` (a tab panel).
4. Data is loaded with **native `fetch()`** against same-origin Pilot v3 API
   endpoints using the session cookie (`credentials:'include'`). It is then fed
   into `Ext.data.Store` instances backing grids.

**Client-side context gathering** (`gatherContext()` in the AI Assistant) pulls a
"fleet snapshot" without any server-side Pilot token:

- `GET /api/v3/vehicles` → vehicles (`vehiclenumber`, `agentid`, `model`,
  `current_mileage`, `folder`, `type`, `status`). Plate strings are normalised by
  `extractPlate()` (skips junk/test objects like `FTC…`, `HEAD OFFICE`, `1. …`).
- `POST <backend>/rta-fines` → RTA fines for every plate (calls the backend, not Pilot).
- `GET <backend>/salik` → Salik tolls, matched by `plateRaw`.
- `GET /api/v3/rentcar/contracts?status=open,booked,closed` → rental contracts.
- `GET /api/v3/vehicles/trips?agent_id=…&ts=…&te=…` → one request per vehicle,
  concurrency-capped (5 workers), to sum **current-month km** and flag
  `overLimit` against `mileageLimitKm` (default 4500).

That snapshot (`vehicles`, `fines`, `salik`, `contracts`, `monthlyKm`,
`overLimitVehicles`, …) is sent verbatim as the `context` to `/ask` or `/report`.

### 2. FastAPI backend (`ai-assistant/server/`)

A single-process ASGI app (`app.py`) with no database and no Pilot credentials.
Two kinds of state: an in-memory + on-disk **RTA fines cache** and a **Salik JSON
snapshot file** (written by the UAE-side puller, read-only here).

- **`rta.py`** — RTA gateway connector (see below).
- **`app.py`** — the HTTP surface (see [API.md](API.md) for shapes):
  - `GET /health`, `GET /salik`
  - `POST /ask` (DeepSeek chat, read-only fleet reporter)
  - `POST /rta-fines` (anonymous fines lookup, 24h disk cache)
  - `POST /report` (DeepSeek → HTML → SMTP email)

**RTA fines connector (`rta.py`)** — anonymous, no login:

1. `_guest_auth()` POSTs `{_data: <AES-encrypted {channelCode:"PORTAL", apiKey}>}`
   to `https://comgw.rta.ae/auth/anonymous/login` and gets back a JWT
   (`access_token`) plus a session cookie. The JWT is cached in-process until
   ~60s before its `exp`.
2. `lookup_fines()` POSTs `{_data: <AES-encrypted request body>}` to
   `https://comgw.rta.ae/comgw/cvs/api/public/payable-fines` with
   `Authorization: Bearer <jwt>` and the cookie, trying each emirate
   `sourceCode` in order until one returns results.
3. Bodies are **AES-128-CBC** encrypted and wrapped as `{"_data":"<b64>"}`. The
   16-byte key is a client-side constant (base64-decoded from `RTA_AES_KEY_B64`);
   the IV is the same 16 bytes. This is *not* a secret — it ships in the public
   RTA web app bundle — but `RTA_API_KEY` **is** required and comes from env.

`decode_plate()` turns free-text plate strings (e.g. `78739 W`, `AA-22695 GLE`,
`SHJ3 18894`) into `{plateCategory, plateCode, plateNo, sourceCodes}`. Emirate
inference: an explicit emirate prefix (`SHJ/AUH/AJM/RAK/FUJ/UAQ/DXB`) wins;
otherwise a **letter-first** plate is treated as **Dubai (DXB)**; otherwise it is
**number-first** and the non-Dubai emirates are tried in order
(`SHJ, AUH, AJM, RAK, FUJ, UAQ`). See [SHARED-CONTEXT.md](SHARED-CONTEXT.md) for
the subtle consequences.

### 3. Salik connector + puller (`salik/`)

- **`salik.cjs`** — a zero-dependency Node connector to the Salik **customer
  portal** (`customers.salik.ae`), implementing the ASP.NET login flow by hand
  (no browser): bounce off `/` → `id.salik.ae` login → POST credentials → follow
  `/core/connect/authorize` → scrape the `form_post` hidden tokens → POST them to
  `/Connect/SalikIdCallback` to obtain the `.ASPXAUTH` cookie. It then reads the
  portal's own JSON "surface" endpoints (vehicles, toll trips, parking trips).
  Exports `login`, `getVehicles`, `getTollTrips`, `getParkingTrips`.
- **`pull.js`** — pulls tolls for **multiple** Salik accounts (Takeauto and
  KVADRAT), matching against plate-list files, and prints a merged JSON snapshot
  to stdout: `{matched, notFound, totalTolls, days, data:{<plateRaw>: {salikPlate,
  tripCount, totalTolls, tolls:[{date,amount,gate}]}}}`.
- **`pull-and-push.sh`** — the cron entry point: `node pull.js plates.json 30 >
  /tmp/salik_result.json`, then `scp` to the VPS over Tailscale
  (`ceo@100.92.174.7:~/pilot-ai/salik/cache.json`), which is exactly the file
  `app.py` reads in `GET /salik`. Silent on success; `set -e` makes failures
  trigger the cron alert.
- **`server.js`** — an abandoned Node HTTP sidecar that would have served Salik
  on demand (session cached ~20 min). Not used; the snapshot design replaced it
  because the VPS is geo-blocked from `customers.salik.ae`.

## Deployment topology

```
UAE machine "Parrot" (always-on, not geo-blocked)
  └─ cron hourly → pull-and-push.sh
        ├─ node pull.js → Salik snapshot
        └─ scp (Tailscale 100.92.174.7) → VPS:~/pilot-ai/salik/cache.json

Hostinger VPS 179.197.240.182 (Malaysia datacenter — geo-blocked from Salik)
  ├─ uvicorn app:app  (127.0.0.1:8790)
  └─ cloudflared tunnel (cf-config.yml) → https://pilot-ai.zamtek.ae

Pilot platform (pilot-gps.com)
  └─ serves extensions via /store/<name>/ proxy; enablement is per-user
```

The raw VPS IP is blocked by some UAE ISPs (e.g. Etisalat), which is why the
Cloudflare tunnel (public hostname `pilot-ai.zamtek.ae`) exists. Extensions point
`serverUrl`/`aiServerUrl` at `https://pilot-ai.zamtek.ae`.

## Why the split design

- **RTA fines** live in the Python backend because the RTA gateway requires an
  AES-encrypted request/response handshake and an API key that must not ship to
  the browser; the browser only ever sees a clean JSON result.
- **Salik tolls** live in a snapshot file because the portal is geo-blocked from
  the VPS and requires per-account login; a UAE-resident machine does the pull
  and pushes a plain JSON snapshot the backend can serve without any credentials.
- **Fleet data** stays in the browser (session cookie) so the AI server never
  stores or needs Pilot credentials — it is a stateless, read-only reporter.
