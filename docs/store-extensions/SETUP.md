# Setup — Pilot Store Extensions

Setup for the FastAPI backend, the Salik puller, and the ExtJS extensions.
Production values are documented where they matter, but everything can be run
locally for development.

---

## 1. Backend (`ai-assistant/server/`)

### Dependencies

`requirements.txt` lists `fastapi`, `uvicorn[standard]`, `httpx`. **It is
incomplete** — `rta.py` also imports PyCryptodome (`Crypto.Cipher`,
`Crypto.Util.Padding`), so install it explicitly:

```bash
cd ai-assistant/server
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt pycryptodome
```

### Environment variables

Create `ai-assistant/server/.env` (gitignored — never commit it). The app reads
`os.environ` directly (no dotenv loader), so either export them or use
`uvicorn` under a process manager that sources the file.

| Variable | Required for | Default |
|---|---|---|
| `DEEPSEEK_API_KEY` | `/ask`, `/report` | *(none — endpoints return an error if unset)* |
| `DEEPSEEK_BASE_URL` | `/ask`, `/report` | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | `/ask`, `/report` | `deepseek-chat` |
| `RTA_API_KEY` | `/rta-fines` (anonymous RTA login) | *(none — raises "not configured")* |
| `RTA_AES_KEY_B64` | `/rta-fines` (AES key, client-side constant) | `WGckN3lQXnEyWiFuUjU+aw==` |
| `RTA_GATEWAY` | `/rta-fines` | `https://comgw.rta.ae` |
| `RTA_CACHE` | fines cache file path | `/home/ceo/pilot-ai/server/rta_cache.json` |
| `SALIK_CACHE` | Salik snapshot file path | `/home/ceo/pilot-ai/salik/cache.json` |
| `SMTP_HOST` / `SMTP_PORT` | `/report` email | `smtp.hostinger.com` / `465` |
| `SMTP_USER` / `SMTP_PASS` | `/report` email | `noreply@taqeeq.ae` / *(none)* |
| `SMTP_FROM_NAME` | `/report` email | `Pilot Fleet Reports` |

> `RTA_AES_KEY_B64` is **not** a secret (it is a public constant from the RTA
> web-app bundle), but `RTA_API_KEY`, `DEEPSEEK_API_KEY`, and `SMTP_PASS` are.
> Keep them in `.env`, out of git.

### Run locally

```bash
cd ai-assistant/server
source .venv/bin/activate
uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```

Verify: `curl http://localhost:8000/health` → `{"ok": true, "model": "...", "key_configured": ...}`.

For a full local `/salik` test, put a Salik snapshot JSON at the `SALIK_CACHE`
path (or set `SALIK_CACHE` to a temp file) and `curl http://localhost:8000/salik`.

---

## 2. Salik puller (`salik/`) — runs on a UAE machine

Requirements: **Node 20+** (uses global `fetch`, `res.headers.getSetCookie()`,
`AbortSignal.any`/`AbortSignal.timeout`). No `npm install` needed — `salik.cjs`
is zero-dependency.

### Manual pull (test)

```bash
cd salik
TAKE_USER=... TAKE_PASS=... KVADRAT_USER=... KVADRAT_PASS=... \
  node pull.js 30 > /tmp/salik_result.json
```

`pull.js` prints the merged snapshot to stdout and progress to stderr. The plate
lists are read from `takeauto_plates.json` (Takeauto account) and
`mihail_plates.json` (KVADRAT account); `plates.json` is a combined copy used by
the cron wrapper.

### Scheduled push (production)

`pull-and-push.sh` is the cron entry point:

```bash
# hourly cron on the UAE machine
0 * * * * /path/to/salik/pull-and-push.sh
```

It runs `node pull.js plates.json 30`, writes the result to
`/tmp/salik_result.json`, and `scp`s it to
`ceo@100.92.174.7:~/pilot-ai/salik/cache.json` (the VPS, over Tailscale). It is
silent on success and non-zero on failure (so cron mail/alert fires).

> ⚠️ `pull.js` and `server.js` currently contain **hardcoded Salik-password
> fallbacks** in their `process.env.X || "…"` defaults. Do **not** commit real
> credentials; supply them via `TAKE_USER`/`TAKE_PASS`/`KVADRAT_USER`/
> `KVADRAT_PASS` and move the fallbacks out of source. See
> [SHARED-CONTEXT.md](SHARED-CONTEXT.md).

---

## 3. ExtJS extensions

The three extensions are plain static assets (`Module.js`, `config.json`,
`styles.css`). To deploy:

1. **Host** the `extension/` folder of the chosen extension on a web server (any
   static host — GitHub Pages, nginx, S3) such that the files are reachable at a
   stable base URL, e.g. `https://yourserver/store/ai_assistant/`.
2. **Register** it in **Pilot Admin → Extensions** with that base URL
   (`/store/ai_assistant/` or the full URL). Pilot proxies `/store/<name>/*` to
   it and calls `initModule()` on the `Store.<name>.Module` class.
3. **Edit `config.json`** to point at the backend:
   - `ai-assistant`: `serverUrl` → `https://pilot-ai.zamtek.ae` (or your local
     backend during dev).
   - `rta-salik`: `aiServerUrl` → same backend URL.
   - `rental-booster`: `aiServerUrl` → backend URL (note: this one defaults to a
     different host, `https://apiport.ae/pilot-ai`).
4. **Enable per user** — extension enablement in Pilot is **per-user**, not
   per-account. Assign the extension to the specific users/roles who should see
   it (`pilotstore cmd=update` per user on the Pilot side).

### Key config knobs (`config.json`)

| Key | Meaning |
|---|---|
| `serverUrl` / `aiServerUrl` | FastAPI backend base URL. |
| `model` | DeepSeek model sent to `/ask` (informational; the server decides). |
| `contextMaxVehicles` | Cap on vehicles sent as AI context (default 300). |
| `mileageLimitKm` | Free-km/month threshold used for the "over limit" flag (4500). |
| `refreshInterval` | Auto-refresh period in ms for the tab extensions. |
| `gatherVehicles/Fines/Contracts/Trips` | Toggle which context the AI Assistant gathers. |

---

## 4. Production deployment topology

| Piece | Where | Notes |
|---|---|---|
| Backend | Hostinger VPS `179.197.240.182`, `uvicorn` on `127.0.0.1:8790` | See `salik/cf-config.yml` for the tunnel target. |
| Public endpoint | Cloudflare tunnel → `https://pilot-ai.zamtek.ae` | Raw VPS IP is blocked by some UAE ISPs. |
| Salik puller | always-on UAE machine ("Parrot") | hourly cron; geo-blocked from the VPS. |
| Extensions | served by pilot-gps.com `/store/<name>/` | per-user enablement. |

To deploy the backend on the VPS: clone the repo, set up the venv and `.env`
(see §1), run `uvicorn app:app --host 127.0.0.1 --port 8790` under a process
manager (systemd/supervisor), and ensure `cloudflared` is running with
`salik/cf-config.yml` (`tunnel: 90ea81c2-…`).
