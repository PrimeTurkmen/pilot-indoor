# Pilot Fleet Intelligence — Store Extensions (RTA / Salik / AI)

A set of **store extensions** for the [Pilot GPS](https://pilot-gps.com) telematics
platform, plus a small **Python backend**, giving car-rental and fleet operators
three capabilities inside the Pilot web app.

> **Two projects live in this repo.**
> This README covers the **store extensions** (`ai-assistant/`, `rta-salik/`,
> `rental-booster/`, `salik/`). The older **PILOT Indoor Positioning** extension
> (BLE 6.0 / Channel Sounding) is documented in
> [README-indoor-positioning.md](README-indoor-positioning.md).

## What it does

| Capability | What it adds |
|---|---|
| **RTA traffic fines** | Anonymous, no-login lookup of UAE traffic fines by plate number. |
| **Salik tolls** | Per-account toll transactions (date, gate, amount) from the Salik customer portal. |
| **AI fleet reporter** | Natural-language (DeepSeek) questions over the fleet, plus emailed HTML reports. |

Two ExtJS **store extensions** run inside the logged-in Pilot session:

- **`rta-salik`** → a tab panel with **RTA Fines** + **Salik Tolls**.
- **`ai-assistant`** → a header button + chat window + **"Email report"**.

A single **FastAPI backend** (`ai-assistant/server/`) fronts DeepSeek, the RTA
gateway, and the Salik snapshot, exposed publicly over HTTPS.

## Highlights

- **RTA fines** — anonymous, no-login, cached daily, shows issuing authority
  (Dubai Police, RTA, Salik, Sharjah, Abu Dhabi, …).
- **Salik tolls** — per-client Salik account, pulled from an always-on UAE machine
  and pushed to the backend (the Salik portal is geo-blocked outside the UAE).
- **AI reporter** — strictly **read-only**; it only reports numbers from the fleet
  data it is given, never changes anything.
- **"Email report"** — generates a full HTML fleet report (summary + per-vehicle
  table) and emails it from a dedicated noreply mailbox.

## Documentation

| Doc | Audience |
|---|---|
| [docs/PILOT-TELEMATICS-OVERVIEW.md](docs/PILOT-TELEMATICS-OVERVIEW.md) | Platform operator — what the extensions do, plain language. |
| [docs/store-extensions/README.md](docs/store-extensions/README.md) | Developers — repo layout and quick architecture. |
| [docs/store-extensions/ARCHITECTURE.md](docs/store-extensions/ARCHITECTURE.md) | Developers — component-by-component detail. |
| [docs/store-extensions/SETUP.md](docs/store-extensions/SETUP.md) | Developers — local dev + deployment. |
| [docs/store-extensions/API.md](docs/store-extensions/API.md) | Developers — backend endpoints. |
| [docs/store-extensions/SHARED-CONTEXT.md](docs/store-extensions/SHARED-CONTEXT.md) | Developers — gotchas that will bite you. |

## Quick architecture

```
Browser (Pilot session)
  └─ ExtJS store extensions (served via /store/<name>/)
       ├─ rta-salik    → RTA Fines + Salik Tolls tabs
       └─ ai-assistant → chat + "Email report"
            │  native fetch() to Pilot API (session-scoped) + backend
            ▼
FastAPI backend (ai-assistant/server/, Cloudflare-tunnelled)
  ├─ /rta-fines → RTA gateway (anonymous, 24h cache)
  ├─ /salik     → Salik snapshot (pushed from a UAE machine)
  ├─ /ask       → DeepSeek (read-only fleet reporter)
  └─ /report    → DeepSeek HTML report + SMTP email
```

*Everything is read-only and account-scoped: no Pilot credentials leave the
browser, and the extensions never write to or modify Pilot data.*
