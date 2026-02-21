# Detailed Agent Prompt: PILOT Indoor Positioning — Full Stack Deployment

Copy the text below and give it to your agent (e.g. on Ubuntu or in a deployment pipeline).

---

## PROMPT START

You are deploying the **PILOT Indoor Positioning** full-stack system. This is an indoor positioning solution for the PILOT Telematics platform using Bluetooth 6.0 Channel Sounding (nRF54L15). The stack has two deployable parts: (1) **Positioning Engine** (Node.js + MQTT), (2) **PILOT Extension** (frontend that runs inside PILOT).

### Repository and branch

- **Repo:** `https://github.com/PrimeTurkmen/pilot-indoor.git` (or the correct clone URL for this project).
- **Branch:** `main`.
- **Clone (if not already):**
  ```bash
  git clone https://github.com/PrimeTurkmen/pilot-indoor.git pilot-indoor
  cd pilot-indoor
  git pull origin main
  ```

### 1. Positioning Engine (backend)

- **Path in repo:** `positioning-engine/`
- **Stack:** Node.js 20, MQTT client, trilateration, Kalman filter, Pilot API V3 bridge. Reads config from `config.json`; can update floors/calibration/anchors via HTTP API and persists to `config.json`.
- **Run with Docker (recommended):**
  ```bash
  cd positioning-engine
  docker compose up -d
  ```
  This starts the positioning engine and Mosquitto (MQTT broker). Ensure Docker and Docker Compose are installed.
- **Run without Docker (Node only):**
  ```bash
  cd positioning-engine
  npm install
  node server.js
  ```
  An MQTT broker must be running separately (e.g. Mosquitto on port 1883).
- **Engine config file:** `positioning-engine/config.json`
  - `mqtt.broker` — MQTT broker URL (e.g. `mqtt://localhost:1883`).
  - `mqtt.username` / `mqtt.password` — optional broker auth.
  - `pilot.api_url` — PILOT server base URL (e.g. `https://your-server.pilot-gps.com`).
  - `pilot.api_key` — PILOT API key for position updates.
  - `api_port` — HTTP API port (default `3080`).
  - `floors` — array of floors; each has `id`, `name`, `plan_url`, `calibration`, `anchors`. Can be updated via API.
- **Environment variables** (override config): `MQTT_BROKER`, `PILOT_API_URL`, `PILOT_API_KEY`, `API_PORT`.
- **Engine HTTP API (CORS enabled):**
  - `GET /api/indoor/devices` — returns `{ "data": [ { "id", "name", "type", "zone", "battery", "lastUpdate", "status", "x", "y", "floor" }, ... ] }`.
  - `GET /api/indoor/floors` — returns `{ "floors": [ ... ] }` (current floor config from engine).
  - `PUT /api/indoor/floors/:id` — body JSON: `{ "name?", "plan_url?", "bounds?", "calibration?", "anchors?" }`. Updates that floor and persists to `config.json`.

### 2. PILOT Extension (frontend)

- **Path in repo:** `extension/`
- **Stack:** Ext JS 7.7+, Leaflet. Runs inside the PILOT web app; shows floor plans, device markers, device grid, zones, and admin (floor plan load/save, calibration, anchors).
- **Deployment:**
  1. Host the **entire** `extension/` folder on a web server so PILOT can load it. Example base URL: `https://yourserver/store/indoor-positioning/`. All of the following must be reachable under that base:
     - `Module.js`, `IndoorNavPanel.js`, `FloorPlanView.js`, `DeviceGrid.js`, `ZoneManager.js`, `AdminPanel.js`
     - `config.json`, `styles.css`
     - `doc/index.html` (optional)
  2. In **PILOT Admin → Extensions (or Applications)**, register the extension with base URL: `/store/indoor-positioning/` or the full URL used above.
  3. **Load order** (if PILOT allows): `IndoorNavPanel.js` → `FloorPlanView.js` → `DeviceGrid.js` → `ZoneManager.js` → `AdminPanel.js` → `Module.js`, then `styles.css`.
- **Access control (auth):** PILOT controls who sees the extension. In PILOT Admin → Extensions, assign the extension to the desired users or roles. Only users granted access will see it; no separate auth needed.
- **Extension config:** `extension/config.json`
  - `settings.devicesApiUrl` — **Must point to the positioning engine devices API** for full-stack use, e.g. `http://ENGINE_HOST:3080/api/indoor/devices`. Replace `ENGINE_HOST` with the hostname or IP the browser can reach (e.g. the same server or a reachable internal host). If this is set, the extension also uses the same engine for **GET/PUT /api/indoor/floors** (load/save floor plan, calibration, anchors).
  - `settings.deviceRefreshInterval` — milliseconds (e.g. `5000`).
  - `settings.defaultFloorPlanBounds` — optional default pixel bounds.
- **Nginx example** (if extension is on same server):
  ```nginx
  location /store/indoor-positioning/ {
      alias /var/www/store/indoor-positioning/;
      add_header Cache-Control "public, max-age=300";
      add_header Access-Control-Allow-Origin "*";
  }
  ```
  Then ensure the extension files are copied to `/var/www/store/indoor-positioning/` (or adjust path).

### 3. Full-stack connectivity

- The **browser** (PILOT user) must be able to call the positioning engine at `settings.devicesApiUrl` (e.g. `http://engine-host:3080/api/indoor/devices`). If the engine is on another host, that host/port must be reachable from the user’s network and CORS is already allowed by the engine.
- For **load/save floor plan, calibration, and anchors**, the extension derives the engine base URL from `devicesApiUrl` (e.g. `http://engine-host:3080`) and calls `GET/PUT /api/indoor/floors`. So the same engine host/port must be used.

### 4. Verification

- **Engine:** After starting, check:
  ```bash
  curl -s http://localhost:3080/api/indoor/devices
  curl -s http://localhost:3080/api/indoor/floors
  ```
  Both should return JSON (devices may be empty; floors should list at least one floor if config has it).
- **Extension:** In PILOT, open the Indoor Positioning tab; the map and device grid should load. Open **Indoor Settings** (gear); if `devicesApiUrl` is set, the Floor/Floor plan/Calibration/Anchors tabs should load data from the engine and allow Save to engine.

### 5. Summary of what you must do

1. Clone repo, `git pull origin main`.
2. Configure `positioning-engine/config.json` (MQTT, Pilot API URL/key, api_port, floors if needed).
3. Run engine: `cd positioning-engine && docker compose up -d` (or `npm install && node server.js` with MQTT broker running).
4. Copy `extension/` to the web server and set the extension base URL in PILOT Admin.
5. Set `extension/config.json` → `settings.devicesApiUrl` to the engine’s devices API URL (e.g. `http://ENGINE_HOST:3080/api/indoor/devices`).
6. Verify with `curl` and in PILOT (Indoor tab + Indoor Settings).

If anything fails, check: Docker/Node and MQTT broker for the engine; nginx/paths and PILOT load order for the extension; and that `devicesApiUrl` is reachable from the browser and points to the correct engine host/port.

### 6. Testing on PILOT Telematics

1. Deploy engine on AWS (or same network as PILOT users).
2. Host extension at `https://your-aws/store/indoor-positioning/` (or use PILOT server).
3. In PILOT Admin → Extensions: add extension, set base URL, assign to test user/role.
4. Set `extension/config.json` → `devicesApiUrl` to engine URL (e.g. `https://engine-host:3080/api/indoor/devices`). Use HTTPS if engine is behind TLS.
5. Log in as a user with access; verify Indoor Positioning tab appears and loads devices/map.

## PROMPT END

---

*Generated for pilot-indoor full-stack deployment. Repo: PrimeTurkmen/pilot-indoor (main).*
