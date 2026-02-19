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

// Load config
const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

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

const apiServer = http.createServer((req, res) => {
    // CORS for extension (can be on different origin)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    if (req.method === 'GET' && (req.url === '/api/indoor/devices' || req.url === '/api/indoor/devices/')) {
        const data = Array.from(deviceCache.values());
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ data: data }));
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
