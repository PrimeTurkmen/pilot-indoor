/**
 * ELA Innovation / Wirepas Mesh Gateway Handler
 * Parses ELA Blue PUCK/COIN/ANCHOR data from Wirepas mesh network.
 * Supports Channel Sounding (BT 6.0) for sub-meter accuracy.
 *
 * Compatible devices:
 *   - ELA Blue PUCK RHT (temp/humidity)
 *   - ELA Blue PUCK MOV (motion/accelerometer)
 *   - ELA Blue COIN ID (asset tracking)
 *   - ELA Blue ANCHOR (fixed reference points)
 *   - SolidSense N6 gateway
 *
 * MQTT Topics (Wirepas):
 *   wirepas/+/received_data      — WNT JSON format
 *   gw-event/received_data/+/+/+ — Wirepas protobuf-like
 *   ela/+/data                   — ELA proprietary JSON
 */

// Adaptive update rate: moving tags report fast, parked tags save battery
const MOTION_CONFIG = {
    movingInterval: 5000,    // 5s when moving
    parkedInterval: 300000,  // 5min when stationary
    speedThreshold: 0.3,     // m/s — below = parked
    historySize: 5           // position samples for speed calc
};

// Channel Sounding configuration
const CS_CONFIG = {
    enabled: true,
    minConfidence: 0.6,      // reject CS below this
    maxDistance: 30           // meters — reject beyond
};

// Per-tag state: last positions, motion, sensors
const tagState = new Map();

function getOrCreateTagState(tagId) {
    if (!tagState.has(tagId)) {
        tagState.set(tagId, {
            positions: [],       // last N {x, y, ts}
            lastReportTs: 0,
            isMoving: true,
            sensors: {},         // temp, humidity, motion, battery
            anchorDistances: new Map() // anchorId -> {distance, quality, ts}
        });
    }
    return tagState.get(tagId);
}

/**
 * Calculate speed from position history
 */
function calcSpeed(positions) {
    if (positions.length < 2) return 0;
    const last = positions[positions.length - 1];
    const prev = positions[positions.length - 2];
    const dx = last.x - prev.x;
    const dy = last.y - prev.y;
    const dt = (last.ts - prev.ts) / 1000;
    if (dt <= 0) return 0;
    return Math.sqrt(dx * dx + dy * dy) / dt;
}

/**
 * Check if tag should report based on motion state (adaptive rate)
 */
function shouldReport(state) {
    const now = Date.now();
    const interval = state.isMoving ? MOTION_CONFIG.movingInterval : MOTION_CONFIG.parkedInterval;
    return (now - state.lastReportTs) >= interval;
}

/**
 * Parse WNT JSON format (Wirepas Network Tool)
 * Topic: wirepas/+/received_data
 */
function parseWNT(payload) {
    const results = [];
    const items = Array.isArray(payload) ? payload : [payload];

    for (const item of items) {
        const tagId = item.source_address || item.src || item.node_id;
        if (!tagId) continue;

        const anchors = item.positioning_data || item.neighbors || [];
        const measurements = [];

        for (const a of anchors) {
            const anchorId = String(a.address || a.anchor_id || a.node_address);
            const rssi = a.rss || a.rssi;
            let distance = a.distance_m || a.distance;
            const csConf = a.cs_confidence;

            // Channel Sounding: use direct distance if available
            if (CS_CONFIG.enabled && distance != null && (csConf ?? 0) >= CS_CONFIG.minConfidence) {
                if (distance <= CS_CONFIG.maxDistance) {
                    measurements.push({
                        anchor_id: anchorId,
                        distance_m: distance,
                        quality: csConf ?? 0.95,
                        method: 'cs'
                    });
                    continue;
                }
            }

            // Fallback: RSSI-based distance estimation
            if (rssi != null) {
                const txPower = a.tx_power || -59; // dBm at 1m
                const n = 2.5; // path loss exponent (indoor)
                const dist = Math.pow(10, (txPower - rssi) / (10 * n));
                if (dist > 0 && dist < CS_CONFIG.maxDistance) {
                    measurements.push({
                        anchor_id: anchorId,
                        distance_m: dist,
                        quality: Math.max(0.1, Math.min(0.8, 1 - Math.abs(rssi + 40) / 60)),
                        method: 'rssi'
                    });
                }
            }
        }

        // Extract sensor data
        const sensors = {};
        if (item.temperature != null) sensors.temperature = item.temperature;
        if (item.humidity != null) sensors.humidity = item.humidity;
        if (item.battery != null) sensors.battery = item.battery;
        if (item.motion != null || item.accelerometer != null) sensors.motion = true;

        results.push({
            tagId: String(tagId),
            measurements,
            sensors,
            floor: item.floor_id || item.floor || 1,
            name: item.tag_name || item.name || null,
            type: item.device_type || 'person',
            timestamp: item.timestamp || Math.floor(Date.now() / 1000)
        });
    }
    return results;
}

/**
 * Parse ELA proprietary JSON format
 * Topic: ela/+/data
 */
function parseELA(payload) {
    const results = [];
    const items = Array.isArray(payload.devices || payload) ? (payload.devices || payload) : [payload];

    for (const item of items) {
        const tagId = item.mac || item.id || item.device_id;
        if (!tagId) continue;

        const measurements = [];
        const beacons = item.beacons || item.anchors || item.scan_results || [];

        for (const b of beacons) {
            const anchorId = String(b.mac || b.id || b.anchor_id);
            const rssi = b.rssi;
            const distance = b.distance_m || b.distance;

            if (distance != null && distance > 0 && distance <= CS_CONFIG.maxDistance) {
                measurements.push({
                    anchor_id: anchorId,
                    distance_m: distance,
                    quality: b.quality || 0.9,
                    method: 'cs'
                });
            } else if (rssi != null) {
                const txPower = b.tx_power || -59;
                const n = 2.5;
                const dist = Math.pow(10, (txPower - rssi) / (10 * n));
                if (dist > 0 && dist < CS_CONFIG.maxDistance) {
                    measurements.push({
                        anchor_id: anchorId,
                        distance_m: dist,
                        quality: 0.5,
                        method: 'rssi'
                    });
                }
            }
        }

        const sensors = {};
        if (item.temperature != null) sensors.temperature = item.temperature;
        if (item.humidity != null) sensors.humidity = item.humidity;
        if (item.battery_level != null) sensors.battery = item.battery_level;
        if (item.battery != null) sensors.battery = item.battery;
        if (item.movement != null) sensors.motion = item.movement;

        results.push({
            tagId: String(tagId),
            measurements,
            sensors,
            floor: item.floor || 1,
            name: item.name || item.label || null,
            type: item.type || 'person',
            timestamp: item.timestamp || Math.floor(Date.now() / 1000)
        });
    }
    return results;
}

/**
 * Parse generic distance message
 * Topic: pilot/indoor/distances/+
 */
function parseGeneric(payload) {
    return [{
        tagId: payload.tag_id || payload.tagId,
        measurements: payload.measurements || [],
        sensors: {},
        floor: payload.floor ?? 1,
        name: payload.tag_name || payload.tagName || null,
        type: payload.type || 'person',
        timestamp: payload.timestamp || Math.floor(Date.now() / 1000)
    }];
}

/**
 * Detect message format from MQTT topic and route to parser
 */
function parseMessage(topic, payload) {
    let data;
    try {
        data = typeof payload === 'string' ? JSON.parse(payload) : JSON.parse(payload.toString());
    } catch (e) {
        console.error('[ELA] Invalid JSON on', topic, ':', e.message);
        return [];
    }

    if (topic.includes('wirepas') || topic.includes('received_data')) {
        return parseWNT(data);
    }
    if (topic.startsWith('ela/') || topic.includes('/ela/')) {
        return parseELA(data);
    }
    return parseGeneric(data);
}

module.exports = {
    parseMessage,
    parseWNT,
    parseELA,
    parseGeneric,
    getOrCreateTagState,
    calcSpeed,
    shouldReport,
    tagState,
    MOTION_CONFIG,
    CS_CONFIG
};
