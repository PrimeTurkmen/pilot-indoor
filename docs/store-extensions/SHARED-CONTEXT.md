# Shared Context & Gotchas

Non-obvious facts and traps, accumulated while building these extensions. Read
this **before** editing anything — most of these have already caused real bugs.

## ExtJS extensions inside Pilot

### `Ext.Ajax` is broken under the `/store/` proxy — use native `fetch()`
Inside a `/store/<name>/` extension, `Ext.Ajax.request()` rewrites relative
paths through the `/store/<ext>/` proxy and **404s**. Always use native
`fetch()` with **absolute same-origin paths** (`/api/v3/vehicles`,
`/api/v3/rentcar/contracts`, …) and `credentials:'include'`.

- Session auth: v3 Pilot endpoints accept the browser session cookie (no Bearer
  token) when called same-origin from the logged-in session. That's how the
  extensions read fleet data without any API key.
- Backend calls (`serverUrl`/`aiServerUrl`) are cross-origin and go over the
  Cloudflare tunnel — use the **absolute** `https://…` URL (a relative path would
  be rewritten through the Pilot proxy and break).

### Extension enablement is per-user, not per-account
Pilot enables a store extension **per user** (`pilotstore cmd=update` per user),
not per account/tenant. A "deployed" extension does nothing until you assign it
to the specific users who should see it. When someone reports "the extension
doesn't appear", check per-user enablement first.

### Extension skeleton hooks
Modules mount via `main.skeleton` (or `window.skeleton`): a button is inserted
with `sk.header.insert(index, btn)`; a tab with `sk.navigation.add(tab)`. The
`initModule(main, online)` signature is the Pilot entry point. Config is fetched
from `/store/<name>/config.json` (with `cache:'no-store'`) and merged over
`DEFAULT_CONFIG`.

## RTA fines

### Anonymous, no login — but there's still an API key and an AES handshake
The lookup is anonymous (no user account), but the gateway still requires a
client-side `apiKey` (`RTA_API_KEY` env) and **AES-128-CBC**-encrypted
request/response bodies wrapped as `{"_data":"<base64>"}`. The AES key
(`RTA_AES_KEY_B64`) is a public constant from the RTA web-app bundle — **not** a
secret — and the IV equals the key (both 16 bytes). `RTA_API_KEY` is the real
secret; it is not embedded in source and must come from `.env`.

### Plate → emirate decoding is heuristic (`decode_plate`)
Free-text plates are split into `sourceCode` (emirate) + `plateCode` + `plateNo`:

- An **explicit emirate prefix** (`SHJ/AUH/AJM/RAK/FUJ/UAQ/DXB`) wins, e.g.
  `SHJ3 18894` → `SHJ`.
- Otherwise a **letter-first** plate (e.g. `AA 28501`) is assumed **Dubai
  (`DXB`)**.
- Otherwise a **number-first** plate (e.g. `78739 W`) is treated as non-Dubai and
  the emirates `SHJ, AUH, AJM, RAK, FUJ, UAQ` are tried **in order** until one
  returns fines (the first non-empty result wins — `lookup_fines` breaks on the
  first `source` with rows).

Consequences:

- A letter-first plate that is actually from Sharjah/Abu Dhabi/etc. will be
  misrouted to `DXB` (and may silently miss fines). If you need correctness for
  mixed fleets, add the emirate prefix to the stored plate string.
- `decode_plate` does **not** parse an emirate *category* digit (the `3` in
  `SHJ3 18894`) into `plateCode` — it only detects the emirate. `plateCode` is
  derived from the letters found; category handling is not implemented here.
- `EMIRATE_CODES` order in `rta.py` is `SHJ, AUH, AJM, RAK, FUJ, UAQ, DXB` — but
  the "number-first" fallback source list is `SHJ, AUH, AJM, RAK, FUJ, UAQ`
  (Dubai is intentionally absent, since number-first is never Dubai).

### Fines cache
`/rta-fines` caches per `plateCode:plateNo` for **24h** on disk (`RTA_CACHE`).
A plate can't be force-refreshed through the API; to invalidate, delete the cache
file or restart (it's loaded once at import time and only written after fresh
lookups).

## Salik

### Geo-block: `customers.salik.ae` ≠ `www.salik.ae`
Use **`customers.salik.ae`** for the customer-portal "surface" endpoints. The
marketing site `www.salik.ae` is Cloudflare-fenced (bot protection) — do not
target it.

### The portal is geo-blocked from the Hostinger VPS
The VPS (Malaysia datacenter) cannot reach `customers.salik.ae`. The puller
therefore runs on an **always-on UAE machine ("Parrot")**, on an hourly cron,
and `scp`s the JSON snapshot to the VPS (Tailscale `100.92.174.7` →
`~/pilot-ai/salik/cache.json`). The backend only reads that file. If Salik data
goes stale, check the UAE machine's cron first — the backend has no way to pull
it itself.

### Login is a hand-rolled ASP.NET flow (no browser)
`salik.cjs` follows the redirect chain (`/` → `id.salik.ae` → `/core/connect/
authorize` → `/Connect/SalikIdCallback`) and scrapes the `form_post` hidden
tokens to set `.ASPXAUTH`. Two traps handled in code:

- The portal sets **empty placeholder cookies** (`.ASPXAUTH=`, …) before login;
  replaying them makes ASP.NET throw a 500. Empty cookie values are treated as
  deletions.
- `getJson()` retries because the portal returns an **empty body** for
  zero-result sets and for windows it considers too large (parking is chunked
  into ≤30-day windows; toll trips are paginated because `pageSize` is
  hard-capped at **10**).

### Multi-account matching by plate number
`pull.js` pulls from **two** Salik accounts (Takeauto, KVADRAT), each with its own
plate-list file. It matches by the **plate number** extracted from each free-text
plate string; `PlateColorId` (numeric) comes from the vehicles endpoint and is
required by the trips endpoint (letters don't work there). A plate not found in
any account is emitted as `{ "error": "not in salik" }`.

### `server.js` is dead code
`salik/server.js` was an on-demand HTTP sidecar (session cached ~20 min). It was
abandoned in favour of the snapshot design because it would still have run on a
geo-blocked host. Do not build on it.

## Backend / deployment

### Public access goes through Cloudflare, not the raw IP
The VPS IP `179.197.240.182` is blocked by some UAE ISPs (e.g. Etisalat). The
public endpoint is `https://pilot-ai.zamtek.ae` via a Cloudflare tunnel
(`salik/cf-config.yml` maps it to `http://127.0.0.1:8790`). The backend listens
on `127.0.0.1:8790` in production.

### `requirements.txt` is missing `pycryptodome`
`rta.py` imports `Crypto` (PyCryptodome) but `requirements.txt` only lists
`fastapi`, `uvicorn[standard]`, `httpx`. A fresh `pip install -r requirements.txt`
will fail at import time when `/rta-fines` is hit. Install `pycryptodome`
explicitly (see [SETUP.md](SETUP.md)).

### The AI server is read-only by design — don't "add abilities"
`app.py`'s system prompt hard-forbids the model from claiming admin
access/permissions. The backend holds **no Pilot credentials**; all fleet data is
sent by the client as `context`. Keep it that way — do not add a Pilot service
token or write-path to the backend without revisiting this model.

### Report email is rebranded "Pilot Fleet Reports"
SMTP is `smtp.hostinger.com:465` (SSL), sender `noreply@taqeeq.ae`, `From` name
`Pilot Fleet Reports`. `SMTP_PASS` is required for `/report` to send; without it
the endpoint still generates the HTML but returns `"SMTP not configured …"`.

## Security gotchas

- **Hardcoded Salik passwords**: `salik/pull.js` and `salik/server.js` contain
  literal password fallbacks in `process.env.X || "…"` defaults. Treat env as the
  only real source and remove the literals. **Never commit credentials.**
- `.env` is gitignored (`ai-assistant/server/.gitignore`) — do not add it.
- The RTA AES key is **public** (client constant); only `RTA_API_KEY`,
  `DEEPSEEK_API_KEY`, and `SMTP_PASS` are secrets.
- `reset_mail_pw.py` and `switch_deepseek.py` are one-off helper scripts that
  hardcode/rewrite credentials on remote boxes — leave them out of automated
  workflows and don't rely on them.
