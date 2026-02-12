# PILOT Indoor Positioning — Technical Specification

> Full-stack open source indoor positioning system for PILOT Telematics platform
> using Bluetooth 6.0 Channel Sounding on nRF54L15

## Project Overview

**Repository:** https://github.com/PrimeTurkmen/pilot-indoor
**License:** Apache 2.0
**Author:** TAQEEQ Systems (pilot-gps.com)
**Target:** Indoor worker/asset tracking for construction sites in Turkmenistan & UAE

## Architecture — 3 Layers

```
╔══════════════════════════════════════════════════════╗
║  LAYER 1: FIRMWARE (Zephyr / nRF Connect SDK v3.0.1)║
║  ─────────────────────────────────────────────────── ║
║  nRF54L15 tags: Channel Sounding Reflector           ║
║  nRF54L15 anchors: Channel Sounding Initiator        ║
║  nRF54L15 gateway: collects distances → MQTT         ║
║                                                      ║
║  Reference: sdk-nrf/samples/bluetooth/               ║
║    channel_sounding_ras_initiator/                    ║
║    channel_sounding_ras_reflector/                    ║
╠══════════════════════════════════════════════════════╣
║  LAYER 2: POSITIONING ENGINE (Node.js / Docker)      ║
║  ─────────────────────────────────────────────────── ║
║  MQTT ← distance measurements from gateways          ║
║  Trilateration → computes X, Y, Z                    ║
║  Kalman filter → smoothing                           ║
║  Converts to lat/lon → Pilot API V3                  ║
║                                                      ║
║  Stack: Node.js 20, MQTT.js, mathjs                  ║
╠══════════════════════════════════════════════════════╣
║  LAYER 3: PILOT EXTENSION — "Indoor Positioning"     ║
║  ─────────────────────────────────────────────────── ║
║  Module.js → skeleton.navigation + skeleton.mapframe ║
║  Floor plan overlay on Leaflet map                   ║
║  Real-time tag markers via Pilot API V3 polling      ║
║  Geozones, heatmaps, movement history                ║
║                                                      ║
║  Stack: Ext JS 7.7+, Leaflet, Pilot Extensions API   ║
╚══════════════════════════════════════════════════════╝
```

## Data Flow

```
Tag (Reflector) ──BLE 6.0 CS──→ Anchor (Initiator)
                                      │
                                 distance_m
                                      │
                                      ▼
                              Gateway (nRF54L15)
                                      │
                                 MQTT publish
                              pilot/indoor/distances
                                      │
                                      ▼
                           Positioning Engine (Docker)
                              trilateration(3+ distances)
                              kalman filter smoothing
                                      │
                                 X,Y → lat,lon
                                      │
                              POST Pilot API V3
                              /api/v3/units/{id}/position
                                      │
                                      ▼
                           PILOT Extension (browser)
                              polls Pilot API V3
                              renders on floor plan
```

## Directory Structure

```
pilot-indoor/                    # ← YOUR REPO (write here)
├── extension/                   # Pilot Extension module (Ext JS)
│   ├── Module.js                # Entry point
│   ├── IndoorNavPanel.js        # Navigation tree (left panel)
│   ├── FloorPlanView.js         # Leaflet map + floor plan overlay
│   ├── DeviceGrid.js            # Device table (Ext.grid.Panel)
│   ├── ZoneManager.js           # Geozone CRUD
│   ├── AdminPanel.js            # Settings & calibration
│   ├── styles.css               # Module styles
│   └── doc/
│       └── index.html           # Extension documentation
│
├── positioning-engine/          # Backend (Node.js)
│   ├── server.js                # MQTT → Position → Pilot API
│   ├── trilateration.js         # Weighted trilateration algorithm
│   ├── kalman.js                # Kalman filter for smoothing
│   ├── pilot-bridge.js          # Bridge to Pilot API V3
│   ├── config.json              # Configuration
│   ├── package.json
│   └── Dockerfile
│
├── firmware/                    # nRF54L15 firmware (Zephyr C)
│   ├── initiator/               # Anchor firmware (CS Initiator)
│   ├── reflector/               # Tag firmware (CS Reflector)
│   └── gateway/                 # Gateway: BLE → MQTT
│
├── docs/                        # Project documentation
│   ├── architecture.md
│   ├── api-integration.md
│   └── deployment.md
│
├── TECHNICAL_SPEC.md            # THIS FILE
├── LICENSE
└── README.md
```

## LAYER 3: PILOT Extension — Detailed Requirements

### Reference Files (in workspace)
- `pilot_extensions/AI_SPECS.md` — full Pilot Extensions specification
- `pilot_extensions/AI_SPECS_SHORT.md` — short version
- `pilot_extensions/examples/template-app/` — module template
- `pilot_extensions/examples/airports/` — example with Leaflet map & markers

### Module.js (Entry Point)

```javascript
Ext.define('Store.indoor-positioning.Module', {
    extend: 'Ext.Component',

    initModule: function () {
        // 1. Navigation tab — building/floor/zone tree
        var navTab = Ext.create('IndoorPositioning.NavPanel');

        // 2. Main panel — floor plan with Leaflet map
        var mainPanel = Ext.create('IndoorPositioning.FloorPlanView');

        // 3. Link navigation to map
        navTab.map_frame = mainPanel;

        // 4. Register in PILOT interface
        skeleton.navigation.add(navTab);
        skeleton.mapframe.add(mainPanel);

        // 5. Optional: header button for quick access
        skeleton.header.insert(3, Ext.create('Ext.Button', {
            iconCls: 'fa fa-map-marker-alt',
            tooltip: 'Indoor Positioning',
            handler: function () {
                skeleton.navigation.setActiveItem(navTab);
                skeleton.mapframe.setActiveItem(mainPanel);
            }
        }));
    }
});
```

### Component: IndoorNavPanel.js (Left Panel)

**Purpose:** Tree list of Buildings → Floors → Zones + tag search

**Requirements:**
- Ext.tree.Panel with hierarchical data: Building → Floor → Zone
- Tag/person list with search field (Ext.form.field.Text + filter)
- Status indicators: online (green), offline (gray), low battery (yellow)
- Filters by type: people, assets, vehicles
- Click on item → centers floor plan map on that entity
- Collapsible sections for buildings

### Component: FloorPlanView.js (Main Map Panel)

**Purpose:** Floor plan with real-time tag positions

**Requirements:**
- Leaflet map using **CRS.Simple** (pixel coordinates, not geo)
- Floor plan as `L.imageOverlay(url, bounds)` — PNG/SVG uploaded by admin
- Tag markers as `L.circleMarker` with color by type:
  - Blue: people
  - Orange: assets/equipment
  - Green: online, Gray: offline
- Marker popup: name, zone, battery, last update time
- Real-time updates via polling Pilot API V3 every 3-5 seconds
- Movement trail: `L.polyline` for selected tag (date range filter)
- Floor switcher: dropdown/buttons to switch between floors
- Geozones: `L.polygon` overlays with semi-transparent fill
- Anchor positions shown as small triangles (fixed)
- Scale bar showing meters
- Coordinate grid overlay (optional, toggleable)

**Map initialization pattern (from airports example):**
```javascript
var map = new MapContainer('indoor-map');
map.init(0, 0, 2, this.body.dom.id, {
    crs: L.CRS.Simple,
    minZoom: -2,
    maxZoom: 4
});
```

### Component: DeviceGrid.js (Device Table)

**Purpose:** Tabular view of all indoor-tracked devices

**Requirements:**
- Ext.grid.Panel with columns: Name, Type, Zone, Battery%, Last Update, Status
- Sortable and filterable columns
- Row click → centers map on device and opens popup
- Export to CSV button
- Auto-refresh every 5 seconds
- Color-coded status column

### Component: ZoneManager.js (Zone CRUD)

**Purpose:** Create/edit/delete geozones on floor plan

**Requirements:**
- Leaflet.draw plugin for polygon creation on map
- Zone properties: name, floor, color, alert rules
- Alert rules: "Tag entered zone", "Tag left zone", "Tag in zone > X minutes"
- Zone list panel with edit/delete actions
- Save zones to Pilot API V3 or local config

### Component: AdminPanel.js (Settings)

**Purpose:** System configuration

**Requirements:**
- Floor plan upload (PNG/SVG) with drag-and-drop
- Calibration: 3-point alignment of floor plan to coordinate system
- Anchor management: place anchors on floor plan, set their positions
- Positioning Engine connection: MQTT broker URL, credentials
- Pilot API settings: API URL, API key
- System status: connected anchors, active tags, engine status

## LAYER 2: Positioning Engine — Detailed Requirements

### MQTT Topics

```
# Gateway publishes distance measurements
pilot/indoor/distances/{gateway_id}

# Positioning engine publishes computed positions
pilot/indoor/positions/{tag_id}

# System status
pilot/indoor/status/{device_id}
```

### Input Format (from gateway)

```json
{
    "gateway_id": "gw_01",
    "tag_id": "AA:BB:CC:DD:EE:FF",
    "tag_name": "Worker_Ahmed",
    "measurements": [
        {"anchor_id": "anchor_01", "distance_m": 3.45, "rssi": -65, "quality": 0.92},
        {"anchor_id": "anchor_02", "distance_m": 5.12, "rssi": -72, "quality": 0.85},
        {"anchor_id": "anchor_03", "distance_m": 2.89, "rssi": -58, "quality": 0.95}
    ],
    "timestamp": 1707830400,
    "floor": 1
}
```

### Output Format (computed position)

```json
{
    "tag_id": "AA:BB:CC:DD:EE:FF",
    "position": {
        "x": 15.3,
        "y": 8.7,
        "z": 0.0,
        "floor": 1,
        "confidence": 0.89
    },
    "geo": {
        "lat": 25.2048,
        "lon": 55.2708
    },
    "zone": "Zone A - Excavation",
    "timestamp": 1707830401
}
```

### trilateration.js

- Weighted Least Squares trilateration from 3+ distance measurements
- Weight = measurement quality (0-1) from Channel Sounding confidence
- Uses mathjs for linear algebra (matrix operations)
- Returns {x, y, confidence} in local coordinate system
- Handles edge cases: <3 measurements, outlier distances

### kalman.js

- 2D Kalman filter for position smoothing
- State: [x, y, vx, vy] (position + velocity)
- Process noise tuned for walking speed (~1.5 m/s)
- Measurement noise from Channel Sounding accuracy (~1m)
- Per-tag filter instances (maintained in Map)

### pilot-bridge.js

- Converts local X,Y coordinates to lat/lon using floor plan calibration
- Calibration: 3 reference points mapping pixel→geo coordinates
- Affine transformation matrix
- Posts position updates to Pilot API V3
- Endpoint: POST /api/v3/units/{unit_id}/position (or similar)
- Alternative: Wialon IPS protocol emulation over TCP for direct tracker emulation
- Handles API rate limiting and batching

### config.json

```json
{
    "mqtt": {
        "broker": "mqtt://localhost:1883",
        "username": "",
        "password": "",
        "topics": {
            "distances": "pilot/indoor/distances/+",
            "positions": "pilot/indoor/positions/"
        }
    },
    "pilot": {
        "api_url": "https://your-server.pilot-gps.com",
        "api_key": "",
        "update_interval_ms": 3000
    },
    "positioning": {
        "min_anchors": 3,
        "max_distance_m": 30,
        "kalman_enabled": true,
        "outlier_threshold_m": 10
    },
    "floors": [
        {
            "id": 1,
            "name": "Ground Floor",
            "plan_url": "/plans/floor1.png",
            "calibration": {
                "points": [
                    {"pixel": [0, 0], "geo": [25.2048, 55.2708]},
                    {"pixel": [1000, 0], "geo": [25.2048, 55.2718]},
                    {"pixel": [0, 800], "geo": [25.2055, 55.2708]}
                ]
            },
            "anchors": [
                {"id": "anchor_01", "x": 0, "y": 0, "z": 2.5},
                {"id": "anchor_02", "x": 20, "y": 0, "z": 2.5},
                {"id": "anchor_03", "x": 10, "y": 15, "z": 2.5}
            ]
        }
    ]
}
```

### Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY . .
ENV MQTT_BROKER=mqtt://localhost:1883
ENV PILOT_API_URL=https://your-server.pilot-gps.com
ENV PILOT_API_KEY=
EXPOSE 3000
CMD ["node", "server.js"]
```

## LAYER 1: Firmware — Reference Only

Firmware is based on Nordic SDK samples. For initial development, use the SDK samples as-is on nRF54L15 DK boards.

### Reference samples (in workspace):
- `sdk-nrf/samples/bluetooth/channel_sounding_ras_initiator/` — anchor firmware
- `sdk-nrf/samples/bluetooth/channel_sounding_ras_reflector/` — tag firmware

### Target hardware:
- **Tags:** MOKOSMART L03 (nRF54L15, BLE 6.0, 10+ year battery)
- **Anchors:** MOKOSMART L03 or nRF54L15 DK
- **Gateway:** nRF54L15 DK + Ethernet/WiFi bridge → MQTT

### Firmware customization (Phase 2):
1. Multi-reflector scanning: initiator measures distances to multiple reflectors
2. UART output: structured JSON distances to gateway MCU
3. BLE Mesh forwarding: distances relayed through mesh to gateway
4. Power optimization: configurable scan intervals

## Technology Stack

| Component | Technology | License |
|-----------|-----------|---------|
| Tag/Anchor firmware | Zephyr RTOS + nRF Connect SDK v3.0.1 | Open source |
| Channel Sounding | BLE 6.0 on nRF54L15 | Open source |
| Positioning Engine | Node.js 20 + mathjs | MIT |
| MQTT Broker | Mosquitto | EPL/EDL |
| UI Module | Pilot Extensions (Ext JS 7.7+) | Apache 2.0 |
| Maps | Leaflet | BSD-2 |
| API | Pilot API V3 | Platform |
| Hardware | MOKOSMART L03 (nRF54L15) | Commercial |

**Zero proprietary software licenses. Zero Wirepas dependency.**

## API References

| Resource | URL |
|----------|-----|
| Pilot Extensions Repo | https://github.com/pilot-telematics/pilot_extensions |
| Pilot API V3 Swagger | https://pilot-swagger.pilot-gps.com |
| Pilot API V3 YAML | https://dev.pilot-gps.com/doc/api/v3.yaml |
| Pilot Documentation | https://doc.pilot-gps.com |
| Ext JS 7.7 Docs | https://docs.sencha.com/extjs/7.7.0/ |
| Leaflet Docs | https://leafletjs.com/reference.html |
| nRF Connect SDK Docs | https://docs.nordicsemi.com/bundle/ncs-latest/page/nrf/index.html |
| Channel Sounding Samples | https://docs.nordicsemi.com/bundle/ncs-latest/page/nrf/samples/bluetooth/channel_sounding/ |
| OpenHPS Framework | https://openhps.org |
| MOKOSMART L03 | https://www.mokosmart.com/l03-bluetooth-6-0-beacon/ |
| Nordic Developer Academy | https://academy.nordicsemi.com |

## Development Order

1. **Read** AI_SPECS.md and template-app from pilot_extensions
2. **Create** Module.js following template-app pattern
3. **Create** FloorPlanView.js with Leaflet CRS.Simple + imageOverlay
4. **Create** IndoorNavPanel.js with building tree
5. **Create** DeviceGrid.js
6. **Create** positioning-engine/server.js + trilateration.js
7. **Create** Dockerfile + docker-compose.yml
8. **Create** README.md (English + Russian)

**Start with Module.js + FloorPlanView.js — these are the core.**
