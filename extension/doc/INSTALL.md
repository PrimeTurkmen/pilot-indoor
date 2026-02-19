# Indoor Positioning — Installation in PILOT

## Fixing "404 Not Found" (nginx) in Extensions

If the Extensions panel shows **404 Not Found** from nginx when you open "Indoor Positioning", the server at the extension’s base URL is not serving the extension files. Do the following:

1. **Copy the extension files to the server**  
   Upload or clone the **entire** `extension/` folder to your server (e.g. AWS). For example put it at `/var/www/store/indoor-positioning/` so that these files exist:
   - `/var/www/store/indoor-positioning/Module.js`
   - `/var/www/store/indoor-positioning/config.json`
   - …and all other JS/CSS files listed below.

2. **Configure nginx to serve that path**  
   Add a `location` that serves the directory (and allows PILOT to load JS/CSS). Example:

```nginx
location /store/indoor-positioning/ {
    alias /var/www/store/indoor-positioning/;
    add_header Cache-Control "public, max-age=300";
    # Allow PILOT (possibly different origin) to load scripts
    add_header Access-Control-Allow-Origin "*";
}
```

   Reload nginx (`nginx -s reload` or restart the service). Then in PILOT, the extension base URL should be **`/store/indoor-positioning/`** (or the full URL, e.g. `https://your-aws-host/store/indoor-positioning/`).

3. **Confirm in the browser**  
   Open `https://your-aws-host/store/indoor-positioning/Module.js` in a tab. You should see JavaScript content, not 404.

---

## 1. Host the extension files

Serve the contents of the `extension/` folder at a URL reachable by PILOT, for example:

- `https://your-pilot-server.com/store/indoor-positioning/`

Ensure these files are available:

- `config.json`
- `IndoorNavPanel.js`
- `FloorPlanView.js`
- `DeviceGrid.js`
- `ZoneManager.js`
- `AdminPanel.js`
- `Module.js`
- `styles.css`
- `doc/index.html` (optional, for documentation)

## 2. Load order in PILOT Admin

In **PILOT Admin → Extensions**, register the extension with:

- **Base URL:** `/store/indoor-positioning/` (or the full URL you use in step 1)
- **Load order** (if your PILOT version allows specifying script order), load in this order:
  1. `IndoorNavPanel.js`
  2. `FloorPlanView.js`
  3. `DeviceGrid.js`
  4. `ZoneManager.js`
  5. `AdminPanel.js`
  6. `Module.js`

PILOT will load the extension and call `initModule()` on the Module class.

## 3. Devices API (backend)

The Devices grid and map markers need a JSON API that returns indoor devices.

**Option A — Positioning Engine (recommended)**  
Run the positioning engine (see repo root `positioning-engine/`). It exposes:

- **GET** `http://engine-host:3080/api/indoor/devices`  
  Returns `{ "data": [ { "id", "name", "type", "zone", "battery", "lastUpdate", "status", "x", "y", "floor" }, ... ] }`

Configure the extension to use this URL by editing `extension/config.json`:

```json
"settings": {
  "devicesApiUrl": "http://your-engine-host:3080/api/indoor/devices",
  "deviceRefreshInterval": 5000
}
```

If the extension is served from a different origin than the engine, the engine enables CORS for this endpoint.

**Option B — PILOT server**  
Implement or proxy on your PILOT server, e.g. `/ax/indoor/devices.php`, returning the same JSON shape. Leave `devicesApiUrl` empty in config to use that path by default.

## 4. Verify

1. Open PILOT in the browser.
2. Use the **Indoor Positioning** tab in the left navigation (or the map-marker header button).
3. The floor plan and Devices grid should load. If the devices API is not configured or unreachable, the grid will be empty and the map will have no markers.

## 5. Base URL override (optional)

If your extension is not at `/store/indoor-positioning/`, set the base URL before the extension loads so that `config.json` and `styles.css` are loaded from the correct path:

```js
Store.indoorPositioningBaseUrl = 'https://your-cdn.com/indoor-positioning/';
```

(Set this in PILOT’s global script or in an extension that loads before Indoor Positioning.)
