# API — FastAPI Backend (`ai-assistant/server/app.py`)

Base URL: `https://pilot-ai.zamtek.ae` (production) or `http://localhost:8000`
(local). All responses are JSON. CORS is wide open (`allow_origins=["*"]`).

---

## `GET /health`

Liveness + config probe.

**Response**

```json
{ "ok": true, "model": "deepseek-chat", "key_configured": true }
```

- `model` — the configured `DEEPSEEK_MODEL`.
- `key_configured` — `true` when `DEEPSEEK_API_KEY` is set (i.e. `/ask` and
  `/report` can run).

---

## `GET /salik`

Returns the cached Salik toll snapshot. The file is written by the UAE-side
puller (`salik/pull-and-push.sh` → `SALIK_CACHE`), not by this process.

**Response** (the puller's snapshot verbatim, or an empty shape if the file is
missing/unreadable):

```json
{
  "matched": 12,
  "notFound": 3,
  "totalTolls": 214.5,
  "days": 30,
  "data": {
    "AA-28501 Mustang": {
      "salikPlate": "28501:AA",
      "tripCount": 9,
      "totalTolls": 42.0,
      "tolls": [
        { "date": "2026-10-01T10:21:03.000Z", "amount": 4.0, "gate": "Al Barsha (Dubai → Sharjah)" }
      ]
    },
    "SOME_PLATE": { "error": "not in salik" }
  }
}
```

Empty fallback (file absent): `{"matched":0,"notFound":0,"totalTolls":0,"days":0,"data":{}}`.

The extension matches `data` keys against its `plateRaw` vehicle strings. A plate
may map to an entry with `error` when it isn't registered in any Salik account.

---

## `POST /ask`

DeepSeek chat — a strict **read-only** fleet reporter. The server never fetches
Pilot data itself; it only reasons over the `context` you send.

**Request**

```json
{
  "question": "who exceeded the 4500 km limit?",
  "context": {
    "mileageLimitKm": 4500,
    "gatheredAt": "2026-10-24T08:00:00.000Z",
    "vehicleCount": 42,
    "vehicles": [
      { "agentid": "...", "plate": "AA 28501", "plateRaw": "AA-28501 Mustang",
        "folder": "...", "model": "...", "odometerKm": 12345, "type": "...",
        "monthlyKm": 5100, "overLimit": true }
    ],
    "fines": [ { "plate": "AA 28501", "type": "...", "amount": 400, "paid": false, "date": "..." } ],
    "salik": [ { "plate": "AA 28501", "date": "...", "amount": 4.0, "gate": "..." } ],
    "contracts": [ { "..." : "..." } ],
    "overLimitVehicles": ["AA 28501"],
    "overLimitCount": 1
  }
}
```

`context` is arbitrary JSON — the extension builds it; the server passes it
through. The system prompt forces factual, English-by-default (echoes the user's
language), table-like answers and forbids inventing capabilities.

**Response**

```json
{ "answer": "1 vehicle is over the limit: AA 28501 (5100 km)." }
```

or, on error:

```json
{ "error": "AI server not configured (missing API key)." }
// or  { "error": "AI error: <exception text>" }
```

---

## `POST /rta-fines`

Anonymous UAE traffic-fines lookup for a list of plate strings. Results are
cached per plate (`plateCode:plateNo`) for 24 hours (TTL `86400s`), persisted to
`RTA_CACHE` on disk.

**Request**

```json
{ "plates": ["AA-28501 Mustang", "SHJ3 18894", "78739 W"] }
```

**Response** — an object keyed by the **original input string**:

```json
{
  "AA-28501 Mustang": {
    "fines": [
      {
        "referenceNo": "123456789",
        "amount": 400,
        "blackPoints": 4,
        "description": "Exceeding speed limit",
        "ticketDate": "2026-09-15",
        "source": "Dubai Police",
        "car": "Toyota"
      }
    ],
    "totalAmount": 400,
    "totalBlackPoints": 4,
    "plate": "AA-28501 Mustang",
    "cached": true
  },
  "SHJ3 18894": {
    "fines": [],
    "totalAmount": 0,
    "totalBlackPoints": 0,
    "plate": "SHJ3 18894"
  },
  "not a plate": {
    "fines": [],
    "totalAmount": 0,
    "totalBlackPoints": 0,
    "error": "invalid plate",
    "plate": "not a plate"
  }
}
```

Fields per plate:

| Field | Meaning |
|---|---|
| `fines` | Array of `{referenceNo, amount, blackPoints, description, ticketDate, source, car}`. |
| `totalAmount` | Sum of `amount` (AED). |
| `totalBlackPoints` | Sum of `blackPoints`. |
| `cached` | `true` when served from the 24h cache (only on cache hits). |
| `error` | Present on invalid plates or upstream failures (`"invalid plate"` or the exception message). |
| `plate` | Echo of the input string. |

The lookup is performed with a thread pool (max 6 workers). Plate strings are
decoded to `{sourceCode, plateCode, plateNo}` via `rta.decode_plate()` (see
[ARCHITECTURE.md](ARCHITECTURE.md)); an invalid/unparseable string yields
`"error": "invalid plate"` with no network call.

---

## `POST /report`

Generates a fleet report (DeepSeek → clean HTML) and emails it over SMTP. The
server-side applies two filters before calling the LLM: a plate allow-list and a
date range.

**Request**

```json
{
  "context": { "vehicles": [ "…" ], "fines": [ "…" ], "salik": [ "…" ], "vehicleCount": 42 },
  "email": "owner@example.com",
  "subject": "Pilot Fleet Report",
  "from_date": "2026-10-01",
  "to_date": "2026-10-24",
  "plates": ["AA-28501 Mustang"]
}
```

| Field | Type | Notes |
|---|---|---|
| `context` | object | Same fleet snapshot as `/ask`. |
| `email` | string | **Required.** Recipient. |
| `subject` | string | Default `"Отчёт по автопарку Pilot"`. |
| `from_date` / `to_date` | string | Optional `YYYY-MM-DD`. Filters `context.fines[].date`/`ticketDate` and `context.salik[].date`. |
| `plates` | string[] | Optional. If non-empty, only vehicles whose `plate`/`plateRaw` match are kept (and `vehicleCount` recomputed). |

**Response**

```json
{ "status": "sent", "email": "owner@example.com", "preview": "<html>… first 300 chars …" }
```

`status` values:

- `"sent"` — emailed successfully.
- `"SMTP not configured (SMTP_PASS empty)"` — SMTP password missing.
- `"AI error: …"` (returned as `{"error": …}` shape) — DeepSeek call failed.

SMTP uses SSL on `smtp.hostinger.com:465`, authenticating as `SMTP_USER`
(`noreply@taqeeq.ae`) and sending `From: Pilot Fleet Reports <noreply@taqeeq.ae>`.

---

## Error conventions

- `/ask` and `/report` return `{"error": "..."}` (HTTP 200) when the key is
  missing or the upstream call fails — they do **not** raise HTTP errors.
- `/rta-fines` returns per-plate `error` strings; invalid plates are handled
  before any network I/O.
- `/salik` and `/health` never fail.
