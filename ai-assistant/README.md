# Pilot AI Assistant extension

Natural-language button for PILOT, powered by Hermes/DeepSeek. Ask the fleet a
question in plain Russian/English ("сколько машин", "топливо", "кто превысил
лимит 4500 км") and get a natural answer.

## Architecture (context-injection — no Pilot creds on the AI server)

```
extension/Module.js --fetch /api/v3/vehicles (session)--> fleet snapshot
extension/Module.js --POST {question, context}---------> server/app.py (FastAPI)
server/app.py      --POST /chat/completions-----------> DeepSeek --> answer
```

The extension runs inside the logged-in Pilot session, so it fetches the fleet
snapshot with the user's own session (same-origin). The AI server only reasons
over the JSON it's given — it holds no Pilot credentials.

## Files

- `extension/Module.js` — `Store.ai_assistant.Module` (header button + chat window).
- `extension/config.json` — `serverUrl` (point at your VDS), `model`, caps.
- `extension/styles.css` — chat bubbles.
- `server/app.py` — FastAPI `/ask` + `/health`, DeepSeek proxy.

## Deploy the extension into PILOT

1. Host `extension/` anywhere (GitHub Pages, nginx, S3) and register it in
   **PILOT Admin → Extensions** with base URL = that folder, publisher, and
   assign to users. PILOT proxies `/store/ai_assistant/*` to it and calls
   `initModule()`.
2. Edit `extension/config.json` → `serverUrl` = `https://<your-vds>`.

## Run the AI server (on your VDS)

```bash
cd server
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cat > .env <<'EOF'
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com
EOF
uvicorn app:app --host 0.0.0.0 --port 8787
```

`.env` is gitignored — never commit the key.

## Notes / pitfalls (learned from the Promatic extension)

- Inside a `/store/` extension you MUST use native `fetch()` with absolute
  same-origin paths (`/api/v3/vehicles`, `/backend/ax/...`). `Ext.Ajax.request`
  rewrites relative paths through the `/store/<ext>/` proxy → 404.
- The DeepSeek key "RMA Agent" resolves to the `deepseek-flash` model (a
  reasoning model); it also accepts `deepseek-chat` (aliased). Bump `max_tokens`
  so reasoning doesn't eat the answer.
- v3 endpoints accept the session cookie (`credentials:'include'`) with NO
  Bearer token when called from the browser — that's how the extension reads
  the fleet without any key.

## Upgrade path (function-calling "skills")

v1 sends a static snapshot. To answer open-ended questions on demand, give the
AI server a Pilot service token and let DeepSeek call tools
(`get_fuel()`, `get_mileage(period)`, `check_limit(vehicle, km)`). Same
`/ask` contract, server-side only.
