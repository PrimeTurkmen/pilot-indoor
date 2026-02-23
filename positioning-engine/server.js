/**
 * Positioning Engine — MQTT subscriber, trilateration, Pilot API bridge.
 *
 * Supports multiple data sources:
 *   1. Generic BLE: pilot/indoor/distances/+
 *   2. ELA/Wirepas mesh: wirepas/+/received_data, ela/+/data
 *   3. Channel Sounding (BT 6.0): sub-meter accuracy via ELA Blue ANCHOR
 *
 * Computes positions via weighted trilateration + Kalman smoothing.
 * Posts to Pilot API V3 and serves GET /api/indoor/devices for the extension.
 */

const mqtt = require('mqtt');
const path = require('path');
const fs = require('fs');
const http = require('http');

const { trilaterate } = require('./trilateration');
const { createKalmanFilter } = require('./kalman');
const { buildAffineTransform, pixelToGeo, postPosition } = require('./pilot-bridge');
const { parseMessage, getOrCreateTagState, calcSpeed, shouldReport, MOTION_CONFIG } = require('./ela-wirepas');

// ─── Config ──────────────────────────────────────────────────────────
const configPath = path.join(__dirname, 'config.json');
let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

function persistConfig() {
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed to write config.json:', e.message);
        throw e;
    }
}

// ─── Floor / Anchor Maps ─────────────────────────────────────────────
const anchorMap = new Map();
const transformMap = new Map();

function refreshFloorMaps() {
    anchorMap.clear();
    transformMap.clear();
    for (const floor of config.floors || []) {
        const anchors = {};
        for (const a of floor.anchors || []) {
            anchors[a.id] = { x: a.x, y: a.y, z: a.z || 0 };
        }
        anchorMap.set(floor.id, anchors);
        const cal = floor.calibration;
        if (cal && cal.points && cal.points.length >= 3) {
            const points = cal.points.map(p => ({ pixel: p.pixel, geo: p.geo }));
            transformMap.set(floor.id, buildAffineTransform(points));
        }
    }
}
refreshFloorMaps();

// ─── Runtime Settings ────────────────────────────────────────────────
const MQTT_BROKER = process.env.MQTT_BROKER || config.mqtt.broker;
const PILOT_API_URL = process.env.PILOT_API_URL || config.pilot.api_url;
const PILOT_API_KEY = process.env.PILOT_API_KEY || config.pilot.api_key;
const minAnchors = config.positioning.min_anchors || 3;
const kalmanEnabled = config.positioning.kalman_enabled !== false;

// Per-tag Kalman filters
const kalmanFilters = new Map();

// Tag ID -> Pilot unit ID mapping
const tagToUnitId = new Map();
for (const mapping of config.tag_mappings || []) {
    tagToUnitId.set(mapping.tag_id, mapping.pilot_unit_id);
}

// In-memory device cache for extension GET /api/indoor/devices
const deviceCache = new Map();

// Stats
const stats = { messagesTotal: 0, positionsComputed: 0, csUsed: 0, rssiUsed: 0, lastError: null };

// ─── Positioning Logic ───────────────────────────────────────────────
function getAnchorsForFloor(floorId) {
    return anchorMap.get(floorId) || anchorMap.get(1) || {};
}

function enrichMeasurements(measurements, floorId) {
    const anchors = getAnchorsForFloor(floorId);
    return measurements
        .filter(m => anchors[m.anchor_id])
        .map(m => ({
            ...anchors[m.anchor_id],
            distance_m: m.distance_m,
            quality: m.quality ?? 0.9
        }));
}

function processTagData(tagData) {
    const { tagId, measurements, sensors, floor: floorId, name, type, timestamp } = tagData;
    if (!tagId || !measurements.length) return;

    stats.messagesTotal++;

    // Enrich with anchor positions
    const enriched = enrichMeasurements(measurements, floorId);
    if (enriched.length < minAnchors) return;

    // Track CS vs RSSI usage
    for (const m of measurements) {
        if (m.method === 'cs') stats.csUsed++;
        else stats.rssiUsed++;
    }

    // Trilaterate
    const result = trilaterate(enriched);
    if (!result) return;

    let { x, y } = result;
    const confidence = result.confidence;

    // Outlier check
    const maxDist = Math.max(...enriched.map(m => m.distance_m));
    if (maxDist > (config.positioning.max_distance_m || 30)) return;

    // Kalman smoothing
    if (kalmanEnabled) {
        let kf = kalmanFilters.get(tagId);
        if (!kf) {
            kf = createKalmanFilter({ processNoise: 0.5, measurementNoise: 1.0 });
            kalmanFilters.set(tagId, kf);
        }
        const smoothed = kf.update(x, y);
        x = smoothed.x;
        y = smoothed.y;
    }

    // Adaptive reporting: check motion state
    const state = getOrCreateTagState(tagId);
    const ts = Date.now();
    state.positions.push({ x, y, ts });
    if (state.positions.length > MOTION_CONFIG.historySize) state.positions.shift();

    const speed = calcSpeed(state.positions);
    state.isMoving = speed >= MOTION_CONFIG.speedThreshold;

    // Update sensor data from ELA
    if (sensors.battery != null) state.sensors.battery = sensors.battery;
    if (sensors.temperature != null) state.sensors.temperature = sensors.temperature;
    if (sensors.humidity != null) state.sensors.humidity = sensors.humidity;
    if (sensors.motion != null) state.sensors.motion = sensors.motion;

    // Adaptive rate: skip if parked and reported recently
    if (!shouldReport(state)) return;
    state.lastReportTs = ts;

    stats.positionsComputed++;

    // Pixel → Geo conversion
    const transform = transformMap.get(floorId);
    let geo = null;
    if (transform) {
        geo = pixelToGeo(transform, x, y);
    }

    // Post to Pilot API
    const unitId = tagToUnitId.get(tagId) || tagId;
    if (PILOT_API_URL && PILOT_API_KEY && geo) {
        postPosition({
            apiUrl: PILOT_API_URL,
            apiKey: PILOT_API_KEY,
            unitId,
            lat: geo.lat,
            lon: geo.lon,
            speed: state.isMoving ? speed : 0,
            timestamp: timestamp || Math.floor(Date.now() / 1000)
        }).catch(err => {
            stats.lastError = err.message;
            console.error(`Pilot API error for ${tagId}:`, err.message);
        });
    }

    // Update device cache for extension
    deviceCache.set(tagId, {
        id: tagId,
        name: name || tagId,
        type: type || 'person',
        zone: '',
        battery: state.sensors.battery ?? null,
        temperature: state.sensors.temperature ?? null,
        humidity: state.sensors.humidity ?? null,
        lastUpdate: timestamp || Math.floor(Date.now() / 1000),
        status: 'online',
        isMoving: state.isMoving,
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100,
        floor: floorId,
        confidence: Math.round(confidence * 100) / 100,
        geo: geo || null
    });

    console.log(`[${measurements[0]?.method || '?'}] ${tagId}: (${x.toFixed(2)}, ${y.toFixed(2)}) conf=${confidence.toFixed(2)} ${state.isMoving ? 'MOVING' : 'parked'}`);
}

// ─── MQTT Message Router ─────────────────────────────────────────────
function handleMqttMessage(topic, payload) {
    try {
        const tags = parseMessage(topic, payload);
        for (const tag of tags) {
            processTagData(tag);
        }
    } catch (e) {
        stats.lastError = e.message;
        console.error('[Engine] Error processing', topic, ':', e.message);
    }
}

// ─── Mark stale devices offline ──────────────────────────────────────
setInterval(() => {
    const staleThreshold = Date.now() / 1000 - 120; // 2 minutes
    for (const [id, dev] of deviceCache) {
        if (dev.lastUpdate < staleThreshold && dev.status === 'online') {
            dev.status = 'offline';
        }
    }
}, 30000);

// ─── HTTP API ────────────────────────────────────────────────────────
const API_PORT = parseInt(process.env.API_PORT || config.api_port || '3080', 10);

function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch (e) { reject(e); }
        });
        req.on('error', reject);
    });
}

const apiServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = req.url.split('?')[0];

    // GET /api/indoor/devices — device list for extension
    if (req.method === 'GET' && (url === '/api/indoor/devices' || url === '/api/indoor/devices/')) {
        const data = Array.from(deviceCache.values());
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ data }));
        return;
    }

    // GET /api/indoor/floors — floor list
    if (req.method === 'GET' && (url === '/api/indoor/floors' || url === '/api/indoor/floors/')) {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ floors: config.floors || [] }));
        return;
    }

    // GET /api/indoor/stats — engine stats
    if (req.method === 'GET' && (url === '/api/indoor/stats' || url === '/api/indoor/stats/')) {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({
            ...stats,
            devicesOnline: Array.from(deviceCache.values()).filter(d => d.status === 'online').length,
            devicesTotal: deviceCache.size,
            uptime: process.uptime()
        }));
        return;
    }

    // PUT /api/indoor/floors/:id — update floor
    const putFloorMatch = url.match(/^\/api\/indoor\/floors\/(\d+)\/?$/);
    if (req.method === 'PUT' && putFloorMatch) {
        const floorId = parseInt(putFloorMatch[1], 10);
        let body;
        try { body = await parseJsonBody(req); }
        catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

        const floors = config.floors || [];
        const idx = floors.findIndex(f => f.id === floorId);
        if (idx === -1) { res.writeHead(404); res.end(JSON.stringify({ error: 'Floor not found' })); return; }

        const floor = floors[idx];
        if (body.name !== undefined) floor.name = body.name;
        if (body.plan_url !== undefined) floor.plan_url = body.plan_url;
        if (body.calibration !== undefined) floor.calibration = body.calibration;
        if (body.anchors !== undefined) floor.anchors = body.anchors;
        if (body.bounds !== undefined) floor.bounds = body.bounds;

        try { refreshFloorMaps(); persistConfig(); }
        catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); return; }

        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ floor }));
        return;
    }

    // POST /api/indoor/floors/:id/plan — upload floor plan image
    const postPlanMatch = url.match(/^\/api\/indoor\/floors\/(\d+)\/plan\/?$/);
    if (req.method === 'POST' && postPlanMatch) {
        const floorId = parseInt(postPlanMatch[1], 10);
        let body;
        try { body = await parseJsonBody(req); }
        catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

        const base64 = body.plan;
        const filename = (body.filename || 'floor-plan.png').replace(/[^a-zA-Z0-9._-]/g, '_');
        if (!base64) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing plan (base64)' })); return; }

        const floors = config.floors || [];
        const idx = floors.findIndex(f => f.id === floorId);
        if (idx === -1) { res.writeHead(404); res.end(JSON.stringify({ error: 'Floor not found' })); return; }

        const plansDir = path.join(__dirname, 'plans');
        if (!fs.existsSync(plansDir)) fs.mkdirSync(plansDir, { recursive: true });
        const ext = path.extname(filename) || '.png';
        const safeName = path.basename(filename, ext) + ext;
        const filePath = path.join(plansDir, safeName);
        try { fs.writeFileSync(filePath, Buffer.from(base64, 'base64')); }
        catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'Failed to save: ' + e.message })); return; }

        const planUrl = '/plans/' + safeName;
        floors[idx].plan_url = planUrl;
        if (body.bounds) floors[idx].bounds = body.bounds;
        try { persistConfig(); }
        catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); return; }

        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ plan_url: planUrl, floor: floors[idx] }));
        return;
    }

    // Serve /plans/ for floor plan images
    if (req.method === 'GET' && url.startsWith('/plans/')) {
        const plansDir = path.join(__dirname, 'plans');
        const filePath = path.join(plansDir, url.slice('/plans/'.length));
        const safePath = path.resolve(filePath);
        if (safePath.startsWith(plansDir) && fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
            const ext = path.extname(safePath).toLowerCase();
            const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
            res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
            res.writeHead(200);
            res.end(fs.readFileSync(safePath));
            return;
        }
    }

    // Standalone demo
    const standaloneDir = path.join(__dirname, 'standalone');
    if (req.method === 'GET' && (url === '/' || url === '/standalone' || url === '/standalone/' || url === '/standalone/index.html')) {
        const filePath = path.join(standaloneDir, 'index.html');
        if (fs.existsSync(filePath)) {
            res.setHeader('Content-Type', 'text/html');
            res.writeHead(200);
            res.end(fs.readFileSync(filePath, 'utf8'));
            return;
        }
    }
    if (req.method === 'GET' && url.startsWith('/standalone/')) {
        const filePath = path.join(standaloneDir, url.slice('/standalone/'.length));
        const safePath = path.resolve(filePath);
        if (safePath.startsWith(standaloneDir) && fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
            const ext = path.extname(safePath);
            const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
            res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
            res.writeHead(200);
            res.end(fs.readFileSync(safePath));
            return;
        }
    }

    res.writeHead(404);
    res.end();
});

apiServer.listen(API_PORT, () => {
    console.log(`\n╔══════════════════════════════════════════════════╗`);
    console.log(`║   PILOT Indoor Positioning Engine v2.0           ║`);
    console.log(`║   ELA / Wirepas / Channel Sounding               ║`);
    console.log(`╠══════════════════════════════════════════════════╣`);
    console.log(`║   API:    http://0.0.0.0:${API_PORT}/api/indoor/devices  ║`);
    console.log(`║   Stats:  http://0.0.0.0:${API_PORT}/api/indoor/stats    ║`);
    console.log(`║   MQTT:   ${MQTT_BROKER.substring(0, 38).padEnd(38)} ║`);
    console.log(`╚══════════════════════════════════════════════════╝\n`);
});

// ─── MQTT ────────────────────────────────────────────────────────────
const mqttTopics = config.mqtt.topics;
const allTopics = [
    mqttTopics.distances,           // pilot/indoor/distances/+
    mqttTopics.wirepas || null,     // wirepas/+/received_data
    mqttTopics.ela || null          // ela/+/data
].filter(Boolean);

const client = mqtt.connect(MQTT_BROKER, {
    username: config.mqtt.username || undefined,
    password: config.mqtt.password || undefined,
    reconnectPeriod: 5000
});

client.on('connect', () => {
    console.log('[MQTT] Connected to', MQTT_BROKER);
    for (const topic of allTopics) {
        client.subscribe(topic, err => {
            if (err) console.error('[MQTT] Subscribe error:', topic, err);
            else console.log('[MQTT] Subscribed:', topic);
        });
    }
});

client.on('message', (topic, payload) => {
    handleMqttMessage(topic, payload);
});

client.on('error', err => {
    console.error('[MQTT] Error:', err.message);
});

client.on('reconnect', () => {
    console.log('[MQTT] Reconnecting...');
});

// ─── Mock Data (dev) ─────────────────────────────────────────────────
if (process.env.MOCK_DATA === 'true' || process.env.MOCK_DATA === '1') {
    const mockDevices = [
        { id: 'ela_puck_001', name: 'Worker Ahmed',    type: 'person', zone: 'Zone A', battery: 87, x: 5.2,  y: 3.1,  floor: 1 },
        { id: 'ela_puck_002', name: 'Forklift #3',     type: 'asset',  zone: 'Zone B', battery: 64, x: 12.0, y: 8.5,  floor: 1 },
        { id: 'ela_coin_003', name: 'Pallet Jack B',   type: 'asset',  zone: 'Loading', battery: 92, x: 18.3, y: 1.7,  floor: 1 },
        { id: 'ela_puck_004', name: 'Worker Sarah',    type: 'person', zone: 'Zone A', battery: 45, x: 8.8,  y: 11.2, floor: 1 },
        { id: 'ela_coin_005', name: 'Crane Sensor C',  type: 'asset',  zone: 'Staging', battery: 78, x: 15.0, y: 6.0,  floor: 1 },
    ];
    const now = Math.floor(Date.now() / 1000);
    for (const d of mockDevices) {
        deviceCache.set(d.id, {
            id: d.id, name: d.name, type: d.type, zone: d.zone,
            battery: d.battery, temperature: null, humidity: null,
            lastUpdate: now, status: 'online', isMoving: true,
            x: d.x, y: d.y, floor: d.floor, confidence: 0.85, geo: null
        });
    }
    console.log('[Mock] Loaded', mockDevices.length, 'ELA devices');
}
