/**
 * PILOT Indoor Positioning Engine v3.0 — Modular Orchestrator
 * Ported from SiteTrack pipeline architecture.
 *
 * Pipeline: MQTT → Parse → Enrich → Trilaterate → Kalman → Affine → Zone → Alert → Cache → Broadcast → Pilot API
 *
 * Features:
 *   - Zero-dependency trilateration (130x faster than mathjs)
 *   - Zone checker with point-in-polygon enter/exit detection
 *   - Alert evaluator with 6 types + cooldown
 *   - WebSocket real-time broadcast (positions, zones, alerts, stats)
 *   - Binary protobuf decode from SolidSense N6 gateways
 *   - Gateway registry with health monitoring
 *   - Distance-based adaptive update rate
 *   - Proper device cache with merge semantics + stale sweep
 */

const mqtt = require('mqtt');
const path = require('path');
const fs = require('fs');
const http = require('http');

const { trilaterate } = require('./trilateration');
const { createKalmanFilter } = require('./kalman');
const { buildAffineTransform, pixelToGeo, postPosition } = require('./pilot-bridge');
const { parseMessage, getMqttTopics, shouldProcessUpdate, getTagMotionState, registerAnchor, getStats: getElaStats, getGatewayStats, getAnchors: getElaAnchors, getELADeviceList, sweepGateways } = require('./ela-wirepas');
const { DeviceCache } = require('./device-cache');
const { ZoneChecker } = require('./zone-checker');
const { AlertEvaluator } = require('./alert-evaluator');
const { WebSocketBroadcaster } = require('./websocket');
const velavuAdapter = require('./velavu-adapter');

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

// ─── Module Initialization ──────────────────────────────────────────

// 1. Device Cache
const deviceCache = new DeviceCache({
    offlineTimeout: (config.alerts && config.alerts.offline_timeout_seconds || 600) * 1000
});

// 2. Zone Checker
const zoneChecker = new ZoneChecker();
zoneChecker.setZones(config.zones || []);

// 3. Alert Evaluator
const alertConfig = config.alerts || {};
const alertEvaluator = new AlertEvaluator({
    cooldownMs: (alertConfig.cooldown_seconds || 300) * 1000,
    batteryWarning: alertConfig.battery_warning || 15,
    batteryCritical: alertConfig.battery_critical || 5,
    offlineTimeoutMs: (alertConfig.offline_timeout_seconds || 600) * 1000,
    speedLimitKmh: alertConfig.speed_limit_kmh || 40
});

// 4. WebSocket Broadcaster (attached to HTTP server later)
const wsBroadcaster = new WebSocketBroadcaster();

// Wire alert callback to WebSocket broadcast
alertEvaluator.setOnAlert((alert) => {
    wsBroadcaster.broadcastAlert(alert);
});

// 5. Floor / Anchor Maps
const anchorMap = new Map();
const transformMap = new Map();

function refreshFloorMaps() {
    anchorMap.clear();
    transformMap.clear();
    for (const floor of config.floors || []) {
        const anchors = {};
        for (const a of floor.anchors || []) {
            anchors[a.id] = { x: a.x, y: a.y, z: a.z || 0 };
            // Register in ELA anchor registry too
            registerAnchor(a.id, { x: a.x, y: a.y, z: a.z || 0, floor: floor.id, name: 'Anchor ' + a.id });
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

// 6. Per-tag Kalman filters
const kalmanFilters = new Map();

// 7. Runtime Settings
const MQTT_BROKER = process.env.MQTT_BROKER || config.mqtt.broker;
const PILOT_API_URL = process.env.PILOT_API_URL || config.pilot.api_url;
const PILOT_API_KEY = process.env.PILOT_API_KEY || config.pilot.api_key;
const minAnchors = config.positioning.min_anchors || 3;
const kalmanEnabled = config.positioning.kalman_enabled !== false;

// Tag ID -> Pilot unit ID mapping
const tagToUnitId = new Map();
for (const mapping of config.tag_mappings || []) {
    tagToUnitId.set(mapping.tag_id, mapping.pilot_unit_id);
}

// ─── Processing Pipeline (ported from SiteTrack pipeline.ts) ────────

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

    // Stage 1: Enrich with anchor positions
    const enriched = enrichMeasurements(measurements, floorId);
    if (enriched.length < minAnchors) return;

    // Outlier check
    const maxDist = Math.max(...enriched.map(m => m.distance_m));
    if (maxDist > (config.positioning.max_distance_m || 30)) return;

    // Stage 2: Trilaterate (zero-dependency WLS)
    const result = trilaterate(enriched);
    if (!result) return;

    let { x, y } = result;
    const confidence = result.confidence;

    // Stage 3: Kalman smoothing
    let speed = 0;
    if (kalmanEnabled) {
        let kf = kalmanFilters.get(tagId);
        if (!kf) {
            kf = createKalmanFilter({ processNoise: 0.5, measurementNoise: 1.0 });
            kalmanFilters.set(tagId, kf);
        }
        const smoothed = kf.update(x, y);
        x = smoothed.x;
        y = smoothed.y;
        speed = kf.getSpeed();
    }

    // Stage 4: Adaptive rate check (distance-based)
    if (!shouldProcessUpdate(tagId, x, y, floorId)) return;

    // Stage 5: Pixel → Geo conversion
    const transform = transformMap.get(floorId);
    let geo = null;
    if (transform) {
        geo = pixelToGeo(transform, x, y);
    }

    // Stage 6: Zone check
    const zoneEvents = zoneChecker.check({ deviceId: tagId, x, y, floor: floorId });
    const zoneNames = zoneChecker.getDeviceZones(tagId);
    const zoneName = zoneNames.length > 0 ? zoneNames.join(', ') : '';

    // Stage 7: Alert evaluation
    for (const evt of zoneEvents) {
        alertEvaluator.evaluate(evt);
    }

    // Get motion state from adaptive rate tracker
    const motionState = getTagMotionState(tagId);
    const isMoving = motionState ? motionState.isMoving : true;

    // Stage 8: Update device cache
    const device = deviceCache.update({
        id: tagId,
        name: name || tagId,
        type: type || 'person',
        zone: zoneName,
        battery: sensors.battery ?? null,
        temperature: sensors.temperature ?? null,
        humidity: sensors.humidity ?? null,
        lastUpdate: timestamp || Math.floor(Date.now() / 1000),
        isMoving,
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100,
        floor: floorId,
        confidence: Math.round(confidence * 100) / 100,
        geo: geo || null,
        speed: Math.round(speed * 100) / 100,
        zones: zoneNames
    });

    // Stage 9: WebSocket broadcast
    wsBroadcaster.broadcastPosition(device);
    for (const evt of zoneEvents) {
        wsBroadcaster.broadcastZoneEvent(evt);
    }

    // Stage 10: Post to Pilot API
    const unitId = tagToUnitId.get(tagId) || tagId;
    if (PILOT_API_URL && PILOT_API_KEY && geo) {
        postPosition({
            apiUrl: PILOT_API_URL,
            apiKey: PILOT_API_KEY,
            unitId,
            lat: geo.lat,
            lon: geo.lon,
            speed: isMoving ? speed : 0,
            timestamp: timestamp || Math.floor(Date.now() / 1000)
        }).catch(err => {
            console.error(`Pilot API error for ${tagId}:`, err.message);
        });
    }

    const method = measurements[0]?.method || '?';
    console.log(`[${method}] ${tagId}: (${x.toFixed(2)}, ${y.toFixed(2)}) conf=${confidence.toFixed(2)} ${isMoving ? 'MOVING' : 'parked'}${zoneName ? ' [' + zoneName + ']' : ''}`);
}

// ─── MQTT Message Router ─────────────────────────────────────────────
function handleMqttMessage(topic, payload) {
    try {
        const tags = parseMessage(topic, payload);
        for (const tag of tags) {
            processTagData(tag);
        }
    } catch (e) {
        console.error('[Engine] Error processing', topic, ':', e.message);
    }
}

// ─── Periodic Tasks ──────────────────────────────────────────────────

// Stale device sweep (30s)
deviceCache.startSweep(30000);

// Alert health checks (60s)
setInterval(() => {
    const devices = deviceCache.getAll();
    for (const device of devices) {
        alertEvaluator.checkDeviceHealth(device);
    }
    alertEvaluator.cleanCooldowns();
    sweepGateways();
}, 60000);

// Stats broadcast (10s)
const wsConfig = config.websocket || {};
if (wsConfig.enabled !== false) {
    setInterval(() => {
        const elaStats = getElaStats();
        wsBroadcaster.broadcastStats({
            devicesOnline: deviceCache.onlineCount,
            devicesTotal: deviceCache.size,
            uptime: process.uptime(),
            wsClients: wsBroadcaster.clientCount,
            ...elaStats
        });
    }, wsConfig.stats_interval || 10000);
}

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
    const json = (data, status) => { res.setHeader('Content-Type', 'application/json'); res.writeHead(status || 200); res.end(JSON.stringify(data)); };

    // GET /api/indoor/devices — device list for extension
    if (req.method === 'GET' && url.match(/^\/api\/indoor\/devices\/?$/)) {
        return json({ data: deviceCache.getAll() });
    }

    // GET /api/indoor/floors — floor list
    if (req.method === 'GET' && url.match(/^\/api\/indoor\/floors\/?$/)) {
        return json({ floors: config.floors || [] });
    }

    // GET /api/indoor/zones — zones with device counts
    if (req.method === 'GET' && url.match(/^\/api\/indoor\/zones\/?$/)) {
        return json({ zones: zoneChecker.getZonesWithCounts() });
    }

    // GET /api/indoor/alerts — recent alerts
    if (req.method === 'GET' && url.match(/^\/api\/indoor\/alerts\/?$/)) {
        return json({ alerts: alertEvaluator.getRecentAlerts(50) });
    }

    // GET /api/indoor/gateways — gateway status
    if (req.method === 'GET' && url.match(/^\/api\/indoor\/gateways\/?$/)) {
        return json({ gateways: getGatewayStats() });
    }

    // GET /api/indoor/anchors — registered anchors
    if (req.method === 'GET' && url.match(/^\/api\/indoor\/anchors\/?$/)) {
        return json({ anchors: getElaAnchors() });
    }

    // GET /api/indoor/stats — comprehensive engine stats
    if (req.method === 'GET' && url.match(/^\/api\/indoor\/stats\/?$/)) {
        const elaStats = getElaStats();
        return json({
            ...elaStats,
            devicesOnline: deviceCache.onlineCount,
            devicesTotal: deviceCache.size,
            alertsTotal: alertEvaluator.totalAlerts,
            zonesActive: zoneChecker.getZones().length,
            wsClients: wsBroadcaster.clientCount,
            wsMessagesSent: wsBroadcaster.messagesSent,
            uptime: process.uptime()
        });
    }

    // PUT /api/indoor/floors/:id — update floor
    const putFloorMatch = url.match(/^\/api\/indoor\/floors\/(\d+)\/?$/);
    if (req.method === 'PUT' && putFloorMatch) {
        const floorId = parseInt(putFloorMatch[1], 10);
        let body;
        try { body = await parseJsonBody(req); }
        catch (e) { return json({ error: 'Invalid JSON' }, 400); }

        const floors = config.floors || [];
        const idx = floors.findIndex(f => f.id === floorId);
        if (idx === -1) return json({ error: 'Floor not found' }, 404);

        const floor = floors[idx];
        if (body.name !== undefined) floor.name = body.name;
        if (body.plan_url !== undefined) floor.plan_url = body.plan_url;
        if (body.calibration !== undefined) floor.calibration = body.calibration;
        if (body.anchors !== undefined) floor.anchors = body.anchors;
        if (body.bounds !== undefined) floor.bounds = body.bounds;

        try { refreshFloorMaps(); persistConfig(); }
        catch (e) { return json({ error: e.message }, 500); }

        return json({ floor });
    }

    // POST /api/indoor/floors/:id/plan — upload floor plan image
    const postPlanMatch = url.match(/^\/api\/indoor\/floors\/(\d+)\/plan\/?$/);
    if (req.method === 'POST' && postPlanMatch) {
        const floorId = parseInt(postPlanMatch[1], 10);
        let body;
        try { body = await parseJsonBody(req); }
        catch (e) { return json({ error: 'Invalid JSON' }, 400); }

        const base64 = body.plan;
        const filename = (body.filename || 'floor-plan.png').replace(/[^a-zA-Z0-9._-]/g, '_');
        if (!base64) return json({ error: 'Missing plan (base64)' }, 400);

        const floors = config.floors || [];
        const idx = floors.findIndex(f => f.id === floorId);
        if (idx === -1) return json({ error: 'Floor not found' }, 404);

        const plansDir = path.join(__dirname, 'plans');
        if (!fs.existsSync(plansDir)) fs.mkdirSync(plansDir, { recursive: true });
        const ext = path.extname(filename) || '.png';
        const safeName = path.basename(filename, ext) + ext;
        const filePath = path.join(plansDir, safeName);
        try { fs.writeFileSync(filePath, Buffer.from(base64, 'base64')); }
        catch (e) { return json({ error: 'Failed to save: ' + e.message }, 500); }

        const planUrl = '/plans/' + safeName;
        floors[idx].plan_url = planUrl;
        if (body.bounds) floors[idx].bounds = body.bounds;
        try { persistConfig(); }
        catch (e) { return json({ error: e.message }, 500); }

        return json({ plan_url: planUrl, floor: floors[idx] });
    }

    // PUT /api/indoor/zones — update zone config
    if (req.method === 'PUT' && url.match(/^\/api\/indoor\/zones\/?$/)) {
        let body;
        try { body = await parseJsonBody(req); }
        catch (e) { return json({ error: 'Invalid JSON' }, 400); }

        if (Array.isArray(body.zones)) {
            config.zones = body.zones;
            zoneChecker.setZones(config.zones);
            try { persistConfig(); }
            catch (e) { return json({ error: e.message }, 500); }
        }
        return json({ zones: zoneChecker.getZonesWithCounts() });
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

    // Velavu adapter routes
    if (url.startsWith('/api/velavu/')) {
        return velavuAdapter.handleRequest(req, res);
    }

    res.writeHead(404);
    res.end();
});

apiServer.listen(API_PORT, () => {
    const W = 52;
    const pad = (s) => `║  ${s.padEnd(W - 2)} ║`;
    console.log(`\n╔${'═'.repeat(W)}╗`);
    console.log(pad('PILOT Indoor Positioning Engine v3.0'));
    console.log(pad('Dual Engine: Velavu Cloud + Channel Sounding'));
    console.log(pad('Ported from SiteTrack — Production Grade'));
    console.log(`╠${'═'.repeat(W)}╣`);
    console.log(pad(`API:       http://0.0.0.0:${API_PORT}/api/indoor/devices`));
    console.log(pad(`Stats:     http://0.0.0.0:${API_PORT}/api/indoor/stats`));
    console.log(pad(`Zones:     http://0.0.0.0:${API_PORT}/api/indoor/zones`));
    console.log(pad(`Alerts:    http://0.0.0.0:${API_PORT}/api/indoor/alerts`));
    console.log(pad(`Gateways:  http://0.0.0.0:${API_PORT}/api/indoor/gateways`));
    console.log(pad(`WebSocket: ws://0.0.0.0:${API_PORT}`));
    console.log(pad(`MQTT:      ${MQTT_BROKER}`));
    console.log(pad(`Velavu:    ${process.env.VELAVU_API_TOKEN ? 'enabled' : 'disabled (no token)'}`));
    console.log(`╚${'═'.repeat(W)}╝\n`);
});

// Attach WebSocket to HTTP server
if (wsConfig.enabled !== false) {
    wsBroadcaster.attach(apiServer, wsConfig.heartbeat_interval || 30000);

    // Wire Velavu WebSocket subscribers (use _wss — Broadcaster has no .on())
    wsBroadcaster._wss.on('connection', (ws) => {
        ws.on('message', (msg) => {
            try {
                const parsed = JSON.parse(msg);
                if (parsed.type === 'subscribe' && Array.isArray(parsed.channels) && parsed.channels.includes('velavu')) {
                    velavuAdapter.addSubscriber(ws);
                    ws.on('close', () => velavuAdapter.removeSubscriber(ws));
                }
            } catch (e) { /* ignore non-JSON */ }
        });
    });
}

// Start Velavu adapter
velavuAdapter.start();

// ─── MQTT ────────────────────────────────────────────────────────────
const allTopics = getMqttTopics(config.mqtt.topics);

const client = mqtt.connect(MQTT_BROKER, {
    username: config.mqtt.username || undefined,
    password: config.mqtt.password || undefined,
    clientId: `pilot-indoor-engine-${Date.now()}`,
    reconnectPeriod: 5000
});

let mqttErrorLogged = false;
client.on('connect', () => {
    console.log('[MQTT] Connected to', MQTT_BROKER);
    for (const topic of allTopics) {
        client.subscribe(topic, err => {
            if (err) console.error('[MQTT] Subscribe error:', topic, err);
            else console.log('[MQTT] Subscribed:', topic);
        });
    }
    console.log(`[MQTT] Subscribed to ${allTopics.length} topic patterns`);
    mqttErrorLogged = false;
});

client.on('message', (topic, payload) => {
    handleMqttMessage(topic, payload);
});

client.on('error', () => {
    if (!mqttErrorLogged) {
        console.warn('[MQTT] Broker unavailable — will retry every 5s');
        mqttErrorLogged = true;
    }
});

client.on('reconnect', () => { /* silent */ });

// ─── Mock Data (dev) ─────────────────────────────────────────────────
if (process.env.MOCK_DATA === 'true' || process.env.MOCK_DATA === '1') {
    deviceCache.seedMock();

    // Run zone check on mock devices to show zone assignment
    const mockDevices = deviceCache.getAll();
    for (const d of mockDevices) {
        const events = zoneChecker.check({ deviceId: d.id, x: d.x, y: d.y, floor: d.floor });
        if (events.length > 0) {
            const zoneNames = zoneChecker.getDeviceZones(d.id);
            d.zone = zoneNames.join(', ');
            for (const evt of events) {
                alertEvaluator.evaluate(evt);
            }
        }
    }
    console.log(`[Mock] Zone check complete: ${config.zones ? config.zones.length : 0} zones configured`);
}
