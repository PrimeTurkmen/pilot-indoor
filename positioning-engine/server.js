/**
 * Positioning Engine — MQTT subscriber, trilateration, Pilot API bridge.
 * Subscribes to pilot/indoor/distances/+, computes positions, posts to Pilot API V3.
 * Exposes GET /api/indoor/devices for the PILOT extension frontend.
 */

const mqtt = require('mqtt');
const path = require('path');
const fs = require('fs');
const http = require('http');

const { trilaterate } = require('./trilateration');
const { createKalmanFilter } = require('./kalman');
const { buildAffineTransform, pixelToGeo, postPosition } = require('./pilot-bridge');

// Load config (mutable for API updates)
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

const MQTT_BROKER = process.env.MQTT_BROKER || config.mqtt.broker;
const PILOT_API_URL = process.env.PILOT_API_URL || config.pilot.api_url;
const PILOT_API_KEY = process.env.PILOT_API_KEY || config.pilot.api_key;

const minAnchors = config.positioning.min_anchors || 3;
const kalmanEnabled = config.positioning.kalman_enabled !== false;
const outlierThreshold = config.positioning.outlier_threshold_m || 10;

// Anchor lookup by floor: floorId -> { anchor_id -> {x, y, z} }
const anchorMap = new Map();
for (const floor of config.floors || []) {
    const anchors = {};
    for (const a of floor.anchors || []) {
        anchors[a.id] = { x: a.x, y: a.y, z: a.z || 0 };
    }
    anchorMap.set(floor.id, anchors);
}

// Calibration transforms by floor
const transformMap = new Map();
for (const floor of config.floors || []) {
    const cal = floor.calibration;
    if (cal && cal.points && cal.points.length >= 3) {
        const points = cal.points.map(p => ({ pixel: p.pixel, geo: p.geo }));
        transformMap.set(floor.id, buildAffineTransform(points));
    }
}

// Per-tag Kalman filters
const kalmanFilters = new Map();

// Tag ID -> Pilot unit ID mapping (configure via API or config)
const tagToUnitId = new Map();

// In-memory device cache for extension GET /api/indoor/devices
const deviceCache = new Map();

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

function processMessage(topic, payload) {
    let data;
    try {
        data = JSON.parse(payload.toString());
    } catch (e) {
        console.error('Invalid JSON:', e.message);
        return;
    }

    const tagId = data.tag_id || data.tagId;
    const measurements = data.measurements || [];
    const floorId = data.floor ?? 1;

    if (!tagId || !measurements.length) return;

    const enriched = enrichMeasurements(measurements, floorId);
    if (enriched.length < minAnchors) {
        console.log(`Tag ${tagId}: insufficient anchors (${enriched.length} < ${minAnchors})`);
        return;
    }

    const result = trilaterate(enriched);
    if (!result) {
        console.log(`Tag ${tagId}: trilateration failed`);
        return;
    }

    let { x, y } = result;
    const confidence = result.confidence;

    // Outlier check
    const maxDist = Math.max(...enriched.map(m => m.distance_m));
    if (maxDist > (config.positioning.max_distance_m || 30)) {
        console.log(`Tag ${tagId}: outlier distance ${maxDist}m`);
        return;
    }

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

    const transform = transformMap.get(floorId);
    let geo = null;
    if (transform) {
        geo = pixelToGeo(transform, x, y);
    }

    const unitId = tagToUnitId.get(tagId) || tagId;
    if (PILOT_API_URL && PILOT_API_KEY && geo) {
        postPosition({
            apiUrl: PILOT_API_URL,
            apiKey: PILOT_API_KEY,
            unitId,
            lat: geo.lat,
            lon: geo.lon,
            timestamp: data.timestamp || Math.floor(Date.now() / 1000)
        }).catch(err => console.error(`Pilot API error for ${tagId}:`, err.message));
    }

    // Update device cache for extension API
    const name = data.tag_name || data.tagName || tagId;
    const ts = data.timestamp || Math.floor(Date.now() / 1000);
    deviceCache.set(tagId, {
        id: tagId,
        name: name,
        type: data.type || 'person',
        zone: data.zone || '',
        battery: data.battery != null ? data.battery : null,
        lastUpdate: ts,
        status: 'online',
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100,
        floor: floorId
    });

    console.log(`Tag ${tagId}: (${x.toFixed(2)}, ${y.toFixed(2)}) conf=${confidence.toFixed(2)}`);
}

const API_PORT = parseInt(process.env.API_PORT || config.api_port || '3080', 10);

function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

const apiServer = http.createServer(async (req, res) => {
    // CORS for extension (can be on different origin)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && (url === '/api/indoor/devices' || url === '/api/indoor/devices/')) {
        const data = Array.from(deviceCache.values());
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ data: data }));
        return;
    }
    if (req.method === 'GET' && (url === '/api/indoor/floors' || url === '/api/indoor/floors/')) {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ floors: config.floors || [] }));
        return;
    }
    const putFloorMatch = url.match(/^\/api\/indoor\/floors\/(\d+)\/?$/);
    if (req.method === 'PUT' && putFloorMatch) {
        const floorId = parseInt(putFloorMatch[1], 10);
        let body;
        try {
            body = await parseJsonBody(req);
        } catch (e) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
        }
        const floors = config.floors || [];
        const idx = floors.findIndex(f => f.id === floorId);
        if (idx === -1) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Floor not found' }));
            return;
        }
        const floor = floors[idx];
        if (body.name !== undefined) floor.name = body.name;
        if (body.plan_url !== undefined) floor.plan_url = body.plan_url;
        if (body.calibration !== undefined) floor.calibration = body.calibration;
        if (body.anchors !== undefined) floor.anchors = body.anchors;
        if (body.bounds !== undefined) floor.bounds = body.bounds;
        try {
            refreshFloorMaps();
            persistConfig();
        } catch (e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
            return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ floor: floor }));
        return;
    }
    res.writeHead(404);
    res.end();
});

apiServer.listen(API_PORT, () => {
    console.log('Devices API: http://0.0.0.0:' + API_PORT + '/api/indoor/devices');
});

const client = mqtt.connect(MQTT_BROKER, {
    username: config.mqtt.username || undefined,
    password: config.mqtt.password || undefined
});

client.on('connect', () => {
    console.log('Connected to MQTT broker:', MQTT_BROKER);
    client.subscribe(config.mqtt.topics.distances, err => {
        if (err) console.error('Subscribe error:', err);
    });
});

client.on('message', (topic, payload) => {
    processMessage(topic, payload);
});

client.on('error', err => {
    console.error('MQTT error:', err);
});

//  Mock / demo data (seeded when MOCK_DATA env is set or no real MQTT data) 
if (process.env.MOCK_DATA === 'true' || process.env.MOCK_DATA === '1') {
  const mockDevices = [
    { id: 'tag_001', name: 'Forklift A',   type: 'asset',  zone: 'Warehouse', battery: 87, x: 5.2,  y: 3.1,  floor: 1 },
    { id: 'tag_002', name: 'John D.',      type: 'person', zone: 'Office',    battery: 64, x: 12.0, y: 8.5,  floor: 1 },
    { id: 'tag_003', name: 'Pallet Jack B', type: 'asset',  zone: 'Loading',   battery: 92, x: 18.3, y: 1.7,  floor: 1 },
    { id: 'tag_004', name: 'Sarah M.',     type: 'person', zone: 'Warehouse', battery: 45, x: 8.8,  y: 11.2, floor: 1 },
    { id: 'tag_005', name: 'Drone C',      type: 'asset',  zone: 'Staging',   battery: 78, x: 15.0, y: 6.0,  floor: 1 },
  ];
  const now = Math.floor(Date.now() / 1000);
  for (const d of mockDevices) {
    deviceCache.set(d.id, {
      id: d.id,
      name: d.name,
      type: d.type,
      zone: d.zone,
      battery: d.battery,
      lastUpdate: now,
      status: 'online',
      x: Math.round(d.x * 100) / 100,
      y: Math.round(d.y * 100) / 100,
      floor: d.floor
    });
  }
  console.log('Mock data loaded:', mockDevices.length, 'devices');
}
