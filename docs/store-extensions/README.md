# Pilot Store Extensions — RTA / Salik / AI

A set of **"store" extensions** for the [Pilot GPS](https://pilot-gps.com) telematics
platform, plus a small **Python backend**, giving car-rental / fleet operators three
capabilities inside the Pilot web app:

| Capability | Where it lives | What it does |
|---|---|---|
| **RTA traffic fines** | `ai-assistant/server/` (backend) + `rta-salik/extension/` | Anonymous, no-login lookup of UAE traffic fines by plate number. |
| **Salik tolls** | `salik/` (connector + puller) + backend `/salik` | Per-account toll snapshot pulled from the Salik customer portal and pushed to the backend. |
| **AI fleet reporter** | `ai-assistant/extension/` + `ai-assistant/server/` | Natural-language (DeepSeek) questions over a client-gathered fleet snapshot, plus emailed HTML reports. |

There are three ExtJS "store" extensions (`ai-assistant`, `rta-salik`,
`rental-booster`) that run inside the logged-in Pilot session, and one FastAPI
backend (`ai-assistant/server/`) that fronts DeepSeek and the RTA gateway.

> **Repo note:** this work lives on branch
> `PrimeTurkmen/analyze-promatik-extension-crm` of the `pilot-indoor` repository.
> The repository root `README.md` documents a *different* project (indoor
> positioning). These store-extensions docs cover only the
> `ai-assistant/`, `rta-salik/`, `rental-booster/`, and `salik/` directories.

---

## Quick architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Browser — Pilot web app (logged-in user session)                         │
│                                                                          │
│  ExtJS "store" extensions, served via /store/<name>/ proxy:              │
│   ai-assistant   → header button + chat window + "Email report"          │
│   rta-salik      → tab panel: RTA Fines + Salik Tolls + AI               │
│   rental-booster → tab panel: Fleet / Contracts / Fines + AI             │
│     │                                                                     │
│     │  native fetch() — same-origin Pilot API (session cookie)           │
│     │  GET /api/v3/vehicles, /api/v3/rentcar/contracts,                  │
│     │  GET /api/v3/vehicles/trips (monthly km)                           │
│     │                                                                     │
│     └── POST /ask, /rta-fines, /report · GET /salik ──────────┐          │
└────────────────────────────────────────────────────────────────┼──────────┘
                                                                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ FastAPI backend  ai-assistant/server/app.py  (Hostinger VPS, UAE)        │
│   /health · /salik · /ask · /rta-fines · /report                         │
│                                                                          │
│   /ask & /report → DeepSeek (api.deepseek.com)                           │
│   /rta-fines     → RTA gateway (comgw.rta.ae) + 24h disk cache          │
│   /salik         → reads a JSON snapshot pushed from a UAE machine       │
│   /report        → SMTP (smtp.hostinger.com:465, noreply@taqeeq.ae)      │
│                                                                          │
│   Exposed publicly via Cloudflare tunnel at https://pilot-ai.zamtek.ae   │
└──────────────────────────────────────────────────────────────────────────┘
         ▲ Salik snapshot (JSON) pushed via scp/Tailscale
         │
┌────────┴─────────────────────────────────────────────────────────────────┐
│ Salik puller  salik/  (runs on an always-on UAE machine, "Parrot")       │
│   salik.cjs  — zero-dep Node connector to customers.salik.ae             │
│   pull.js    — multi-account toll puller → JSON snapshot                 │
│   pull-and-push.sh — hourly cron: pull + scp snapshot to the VPS         │
└──────────────────────────────────────────────────────────────────────────┘
```

The extension runs inside the user's authenticated Pilot session, so it reads
fleet data with the user's own session cookie (no Pilot credentials ever reach
the AI server). The backend is a strict **read-only** reporter — it only reasons
over the JSON the extension sends it.

---

## Repo layout (store-extensions subset)

```
ai-assistant/
  server/                 FastAPI backend (app.py, rta.py, requirements.txt, .env)
  extension/              "AI Assistant" store extension (Module.js, config.json)
rta-salik/
  extension/              "RTA Salik" store extension (Module.js, config.json, styles.css)
rental-booster/
  extension/              "Rental Booster" store extension (Module.js, config.json, styles.css)
salik/
  salik.cjs               Salik portal connector (Node, zero deps)
  pull.js                 multi-account toll puller → JSON snapshot
  pull-and-push.sh        hourly cron wrapper (pull + scp to VPS)
  server.js               unused Node sidecar (abandoned in favour of the snapshot design)
  *.json                  plate lists + output caches
  cf-config.yml           Cloudflare tunnel config (pilot-ai.zamtek.ae → 127.0.0.1:8790)
  test_*.py / switch_*.py / patch_*.py / reset_*.py   one-off helper scripts
```

---

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — component-by-component detail and data flow.
- **[SETUP.md](SETUP.md)** — local development and production deployment.
- **[API.md](API.md)** — the FastAPI endpoints with request/response shapes.
- **[SHARED-CONTEXT.md](SHARED-CONTEXT.md)** — the gotchas that will bite you (proxy, geo-block, emirate decoding, per-user enablement, …).

Read **SHARED-CONTEXT.md** before you start editing anything — it captures
several non-obvious behaviours that are easy to get wrong.
