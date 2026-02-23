/**
 * ELA Innovation / Wirepas Mesh Gateway Handler — v3.0
 * Ported from SiteTrack wirepas-mesh-gateway.ts — production-grade.
 *
 * Supported hardware:
 *   Tags:    ELA Blue PUCK ID+ MESH, Blue COIN ID+ MESH, Blue LITE MESH
 *   Anchors: ELA Blue ANCHOR (MESH) — battery-powered, IP68
 *   Gateway: SolidSense N6 (Wirepas sink → MQTT)
 *
 * Integration modes:
 *   A. Wirepas protobuf — gw-event/received_data/<gw>/<sink>/<net>/<ep>/<node>
 *   B. WNT JSON         — wirepas/+/received_data (Wirepas Network Tool)
 *   C. ELA JSON          — ela/+/data (ELA microservice)
 *   D. Generic           — pilot/indoor/distances/+ (custom)
 *
 * Features over v2.0:
 *   - Binary protobuf decode (EP 238 positioning, EP 10/11/12 sensors)
 *   - Gateway registry with health tracking
 *   - Mesh anchor management (auto-discover from messages)
 *   - Distance-based adaptive rate (vs old speed-based)
 *   - Configurable RSSI parameters via env vars
 *   - 13 stats counters (vs old 4)
 */

// ── Configuration ──

const RSSI_CONFIG = {
    txPower:          parseInt(process.env.WIREPAS_TX_POWER     || '-59', 10),
    pathLossExponent: parseFloat(process.env.WIREPAS_PATH_LOSS_N || '2.5'),
    minRSSI:          parseInt(process.env.WIREPAS_MIN_RSSI      || '-95', 10),
    maxDistance:       parseFloat(process.env.WIREPAS_MAX_DISTANCE || '30')
};

const CS_CONFIG = {
    enabled:       true,
    minConfidence: parseFloat(process.env.WIREPAS_CS_MIN_CONFIDENCE || '0.6'),
    maxDistance:    30
};

// ── Adaptive Update Rate (distance-based, ported from SiteTrack) ──

const ADAPTIVE_RATE = {
    enabled:              process.env.WIREPAS_ADAPTIVE_RATE !== 'false',
    movingIntervalMs:     parseInt(process.env.WIREPAS_MOVING_INTERVAL_MS    || '5000', 10),   // 5s when moving
    stationaryIntervalMs: parseInt(process.env.WIREPAS_STATIONARY_INTERVAL_MS || '60000', 10), // 60s when parked
    movementThresholdM:   parseFloat(process.env.WIREPAS_MOVEMENT_THRESHOLD_M || '0.5'),       // >0.5m = moved
    stationaryAfterMs:    parseInt(process.env.WIREPAS_STATIONARY_AFTER_MS    || '120000', 10)  // 2min no movement = stationary
};

// ── State ──

// Per-tag motion state for adaptive rate
const tagMotion = new Map();
// Gateway registry
const gatewayRegistry = new Map();
// Mesh anchors (auto-discovered from status messages)
const meshAnchors = new Map();
// ELA device registry
const elaDevices = new Map();
// Per-tag battery cache
const tagBattery = new Map();

// Comprehensive stats (13 counters)
const stats = {
    messagesTotal: 0,
    messagesWNT: 0,
    messagesELA: 0,
    messagesBinary: 0,
    messagesGeneric: 0,
    positionsComputed: 0,
    csUsed: 0,
    rssiUsed: 0,
    skippedByAdaptiveRate: 0,
    lastError: null,
    lastErrorTime: null
};

// ══════════════════════════════════════════════════════════════
//  ADAPTIVE UPDATE RATE (distance-based — ported from SiteTrack)
// ══════════════════════════════════════════════════════════════

/**
 * Check if a tag position update should be processed or skipped.
 * Distance-based: process if moved >0.5m OR timeout reached.
 *
 * @param {string} tagId
 * @param {number|null} x
 * @param {number|null} y
 * @param {number} floor
 * @returns {boolean} true if should process
 */
function shouldProcessUpdate(tagId, x, y, floor) {
    if (!ADAPTIVE_RATE.enabled) return true;

    const now = Date.now();
    const state = tagMotion.get(tagId);

    if (!state) {
        // First time seeing this tag — always process
        tagMotion.set(tagId, {
            lastX: x, lastY: y, lastFloor: floor,
            lastMovement: now, lastProcessed: now,
            isMoving: true
        });
        return true;
    }

    // Detect movement: distance from last known position
    let moved = false;
    if (x != null && y != null && state.lastX != null && state.lastY != null) {
        const dx = x - state.lastX;
        const dy = y - state.lastY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        moved = dist >= ADAPTIVE_RATE.movementThresholdM || floor !== state.lastFloor;
    } else if (floor !== state.lastFloor) {
        moved = true;
    }

    if (moved) {
        state.lastMovement = now;
        state.isMoving = true;
        state.lastX = x;
        state.lastY = y;
        state.lastFloor = floor;
    } else if (state.isMoving && (now - state.lastMovement) > ADAPTIVE_RATE.stationaryAfterMs) {
        state.isMoving = false;
    }

    // Determine interval based on motion state
    const interval = state.isMoving ? ADAPTIVE_RATE.movingIntervalMs : ADAPTIVE_RATE.stationaryIntervalMs;
    const elapsed = now - state.lastProcessed;

    if (elapsed < interval) {
        stats.skippedByAdaptiveRate++;
        return false;
    }

    state.lastProcessed = now;
    if (x != null && y != null) { state.lastX = x; state.lastY = y; }
    state.lastFloor = floor;
    return true;
}

/**
 * Get motion state for a tag (used by server.js for isMoving flag).
 * @param {string} tagId
 * @returns {{isMoving: boolean}|null}
 */
function getTagMotionState(tagId) {
    return tagMotion.get(tagId) || null;
}

// ══════════════════════════════════════════════════════════════
//  RSSI UTILITIES
// ══════════════════════════════════════════════════════════════

function rssiToDistance(rssi) {
    return Math.min(
        Math.pow(10, (RSSI_CONFIG.txPower - rssi) / (10 * RSSI_CONFIG.pathLossExponent)),
        RSSI_CONFIG.maxDistance
    );
}

function rssiToQuality(rssi) {
    return 0.1 + Math.max(0, Math.min(1, (rssi - RSSI_CONFIG.minRSSI) / (-40 - RSSI_CONFIG.minRSSI))) * 0.9;
}

function extractId(topic) {
    return topic.split('/').pop() || '';
}

// ══════════════════════════════════════════════════════════════
//  BINARY PROTOBUF DECODE (SolidSense N6 native)
// ══════════════════════════════════════════════════════════════

/**
 * Decode binary positioning payload (endpoint 238).
 * Format: [1B version][1B num_neighbors][per neighbor: 4B address LE + 1B rssi]
 *
 * @param {string} nodeId
 * @param {Buffer} payload
 * @returns {Array<{address: string, rssi: number}>}
 */
function decodePositioningPayload(nodeId, payload) {
    if (!Buffer.isBuffer(payload) || payload.length < 2) return [];
    const numNeighbors = payload[1];
    if (payload.length < 2 + numNeighbors * 5) return [];

    const neighbors = [];
    for (let i = 0; i < numNeighbors; i++) {
        const offset = 2 + i * 5;
        neighbors.push({
            address: String(payload.readUInt32LE(offset)),
            rssi: payload.readInt8(offset + 4)
        });
    }
    return neighbors;
}

/**
 * Decode application payload (sensor data).
 * EP 10: temperature, EP 11: temp+humidity, EP 12: motion
 *
 * @param {string} nodeId
 * @param {number} endpoint
 * @param {Buffer} payload
 * @returns {object} sensor data
 */
function decodeApplicationPayload(nodeId, endpoint, payload) {
    if (!Buffer.isBuffer(payload)) return {};

    const sensors = {};
    if (endpoint === 10 && payload.length >= 2) {
        sensors.temperature = payload.readInt16LE(0) / 100.0;
    }
    if (endpoint === 11 && payload.length >= 4) {
        sensors.temperature = payload.readInt16LE(0) / 100.0;
        sensors.humidity = payload.readUInt16LE(2) / 100.0;
    }
    if (endpoint === 12 && payload.length >= 1) {
        sensors.motion = payload[0] === 1;
    }
    return sensors;
}

// ══════════════════════════════════════════════════════════════
//  GATEWAY & ANCHOR REGISTRY
// ══════════════════════════════════════════════════════════════

/**
 * Track gateway health from gw-event/status messages.
 */
function updateGateway(gwId, sinkId) {
    const gw = gatewayRegistry.get(gwId);
    if (gw) {
        gw.lastSeen = Date.now();
        gw.messagesProcessed++;
        if (sinkId && !gw.sinks.includes(sinkId)) gw.sinks.push(sinkId);
    } else {
        gatewayRegistry.set(gwId, {
            id: gwId,
            status: 'online',
            sinks: sinkId ? [sinkId] : [],
            lastSeen: Date.now(),
            messagesProcessed: 1,
            model: 'SolidSense N6'
        });
    }
}

/**
 * Register or update a mesh anchor (from status messages or config).
 */
function registerAnchor(id, data) {
    const ex = meshAnchors.get(id);
    meshAnchors.set(id, {
        id,
        name:            data.name     ?? (ex ? ex.name : 'Anchor ' + id),
        x:               data.x        ?? (ex ? ex.x : 0),
        y:               data.y        ?? (ex ? ex.y : 0),
        z:               data.z        ?? (ex ? ex.z : 2.5),
        floor:           data.floor    ?? (ex ? ex.floor : 1),
        status:          'online',
        lastSeen:        Date.now(),
        batteryLevel:    data.battery  ?? (ex ? ex.batteryLevel : null),
        firmwareVersion: data.firmware ?? (ex ? ex.firmwareVersion : ''),
        meshAddress:     data.meshAddress ?? (ex ? ex.meshAddress : id),
        model:           data.model    ?? (ex ? ex.model : 'ELA Blue ANCHOR')
    });
}

/**
 * Update ELA device registry.
 */
function updateELADevice(id, upd) {
    const ex = elaDevices.get(id);
    elaDevices.set(id, {
        id,
        name:          upd.name          ?? (ex ? ex.name : id),
        model:         upd.model         ?? (ex ? ex.model : 'Unknown ELA Device'),
        role:          upd.role          ?? (ex ? ex.role : 'unknown'),
        floor:         upd.floor         ?? (ex ? ex.floor : 1),
        battery:       upd.battery       ?? (ex ? ex.battery : null),
        firmware:      upd.firmware      ?? (ex ? ex.firmware : ''),
        lastSeen:      upd.lastSeen      ?? (ex ? ex.lastSeen : Date.now()),
        hopCount:      upd.hopCount      ?? (ex ? ex.hopCount : 0),
        meshNeighbors: upd.meshNeighbors ?? (ex ? ex.meshNeighbors : 0),
        x:             upd.x             ?? (ex ? ex.x : null),
        y:             upd.y             ?? (ex ? ex.y : null),
        temperature:   upd.temperature   ?? (ex ? ex.temperature : null),
        humidity:      upd.humidity       ?? (ex ? ex.humidity : null),
        motion:        upd.motion        ?? (ex ? ex.motion : null)
    });
}

/**
 * Infer floor from anchor positions in measurements.
 */
function inferFloorFromAnchors(measurements) {
    for (const m of measurements) {
        const anchor = meshAnchors.get(m.anchor_id);
        if (anchor) return anchor.floor;
    }
    return 1;
}

/**
 * Mark gateways offline if not seen in 5 minutes.
 */
function sweepGateways() {
    const threshold = Date.now() - 5 * 60 * 1000;
    for (const gw of gatewayRegistry.values()) {
        if (gw.lastSeen < threshold && gw.status === 'online') {
            gw.status = 'offline';
        }
    }
}

// ══════════════════════════════════════════════════════════════
//  MESSAGE PARSERS
// ══════════════════════════════════════════════════════════════

/**
 * Parse WNT JSON format (Wirepas Network Tool).
 * Topic: wirepas/+/received_data
 */
function parseWNT(payload) {
    stats.messagesWNT++;
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
                    stats.csUsed++;
                    continue;
                }
            }

            // Fallback: RSSI-based distance estimation
            if (rssi != null && rssi >= RSSI_CONFIG.minRSSI) {
                const dist = rssiToDistance(rssi);
                if (dist > 0 && dist <= RSSI_CONFIG.maxDistance) {
                    measurements.push({
                        anchor_id: anchorId,
                        distance_m: dist,
                        quality: rssiToQuality(rssi),
                        method: 'rssi'
                    });
                    stats.rssiUsed++;
                }
            }
        }

        // Extract sensor data
        const sensors = {};
        if (item.temperature != null) sensors.temperature = item.temperature;
        if (item.humidity != null) sensors.humidity = item.humidity;
        if (item.battery != null) { sensors.battery = item.battery; tagBattery.set(String(tagId), item.battery); }
        if (item.voltage != null) {
            sensors.battery = Math.max(0, Math.min(100, Math.round(((item.voltage - 2.1) / 0.9) * 100)));
            tagBattery.set(String(tagId), sensors.battery);
        }
        if (item.motion != null || item.accelerometer != null) sensors.motion = true;

        const floor = inferFloorFromAnchors(measurements) || item.floor_id || item.floor || 1;

        results.push({
            tagId: String(tagId),
            measurements,
            sensors,
            floor,
            name: item.tag_name || item.name || (elaDevices.get(String(tagId)) || {}).name || null,
            type: item.device_type || 'person',
            timestamp: item.timestamp || Math.floor(Date.now() / 1000)
        });
    }
    return results;
}

/**
 * Parse ELA proprietary JSON format.
 * Topic: ela/+/data
 */
function parseELA(payload) {
    stats.messagesELA++;
    const results = [];
    const items = Array.isArray(payload.devices || payload) ? (payload.devices || payload) : [payload];

    for (const item of items) {
        const tagId = item.mac || item.id || item.device_id;
        if (!tagId) continue;

        // Update ELA device registry
        updateELADevice(String(tagId), {
            name: item.name || item.label,
            role: 'tag',
            battery: item.battery_level || item.battery,
            temperature: item.temperature,
            humidity: item.humidity,
            motion: item.movement,
            lastSeen: Date.now()
        });

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
                    quality: b.quality || b.cs_confidence || 0.9,
                    method: 'cs'
                });
                stats.csUsed++;
            } else if (rssi != null && rssi >= RSSI_CONFIG.minRSSI) {
                const dist = rssiToDistance(rssi);
                if (dist > 0 && dist <= RSSI_CONFIG.maxDistance) {
                    measurements.push({
                        anchor_id: anchorId,
                        distance_m: dist,
                        quality: rssiToQuality(rssi),
                        method: 'rssi'
                    });
                    stats.rssiUsed++;
                }
            }
        }

        const sensors = {};
        if (item.temperature != null) sensors.temperature = item.temperature;
        if (item.humidity != null) sensors.humidity = item.humidity;
        if (item.battery_level != null) { sensors.battery = item.battery_level; tagBattery.set(String(tagId), item.battery_level); }
        if (item.battery != null) { sensors.battery = item.battery; tagBattery.set(String(tagId), item.battery); }
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
 * Parse Wirepas protobuf message.
 * Topic: gw-event/received_data/<gw>/<sink>/<net>/<ep>/<node>
 */
function parseProtobuf(topic, payload) {
    stats.messagesBinary++;

    const parts = topic.split('/');
    if (parts.length < 7) return [];

    const gwId    = parts[2];
    const sinkId  = parts[3];
    const endpoint = parseInt(parts[5], 10);
    const nodeId   = parts[6];

    // Track gateway
    updateGateway(gwId, sinkId);

    // Try JSON decode first (SolidSense JSON transport mode)
    try {
        const jsonData = JSON.parse(payload.toString());
        if (endpoint === 238 && (jsonData.neighbors || jsonData.payload_data)) {
            const neighbors = jsonData.neighbors || jsonData.payload_data;
            return parseNeighborScan(nodeId, neighbors);
        }
        if (jsonData.payload_data || jsonData.data_payload) {
            const sensorData = jsonData.payload_data || jsonData.data_payload;
            if (typeof sensorData === 'object') {
                updateELADevice(nodeId, {
                    temperature: sensorData.temperature,
                    humidity: sensorData.humidity,
                    motion: sensorData.motion,
                    battery: sensorData.battery,
                    lastSeen: Date.now()
                });
                if (sensorData.battery != null) tagBattery.set(nodeId, sensorData.battery);
            }
        }
        return [];
    } catch (e) { /* not JSON — binary */ }

    // Binary decode
    if (endpoint === 238) {
        const neighbors = decodePositioningPayload(nodeId, payload);
        if (neighbors.length > 0) {
            return parseNeighborScan(nodeId, neighbors);
        }
    } else {
        const sensors = decodeApplicationPayload(nodeId, endpoint, payload);
        if (Object.keys(sensors).length > 0) {
            updateELADevice(nodeId, { ...sensors, lastSeen: Date.now() });
        }
    }
    return [];
}

/**
 * Convert neighbor scan data to tag measurements.
 */
function parseNeighborScan(tagNodeId, neighbors) {
    const measurements = [];
    for (const n of neighbors) {
        const anchorId = String(n.address || n.anchor_id || n.node_id || n.addr || '');
        const rssi = n.rssi ?? n.signal_strength;
        if (!anchorId || rssi == null || rssi < RSSI_CONFIG.minRSSI) continue;

        // Channel Sounding
        if (CS_CONFIG.enabled && n.distance_m != null && (n.cs_confidence ?? 0) >= CS_CONFIG.minConfidence) {
            measurements.push({ anchor_id: anchorId, distance_m: n.distance_m, quality: n.cs_confidence ?? 0.95, method: 'cs' });
            stats.csUsed++;
            continue;
        }

        const distance = rssiToDistance(rssi);
        if (distance <= RSSI_CONFIG.maxDistance) {
            measurements.push({ anchor_id: anchorId, distance_m: distance, quality: rssiToQuality(rssi), method: 'rssi' });
            stats.rssiUsed++;
        }
    }

    if (measurements.length === 0) return [];

    const floor = inferFloorFromAnchors(measurements);
    const elaDevice = elaDevices.get(tagNodeId);

    return [{
        tagId: tagNodeId,
        measurements,
        sensors: { battery: tagBattery.get(tagNodeId) || null },
        floor,
        name: elaDevice ? elaDevice.name : null,
        type: elaDevice && elaDevice.model && elaDevice.model.toLowerCase().includes('puck') ? 'person' : 'asset',
        timestamp: Math.floor(Date.now() / 1000)
    }];
}

/**
 * Parse generic distance message.
 * Topic: pilot/indoor/distances/+
 */
function parseGeneric(payload) {
    stats.messagesGeneric++;
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
 * Parse gateway status message.
 * Topic: gw-event/status/+
 */
function parseGatewayStatus(topic, payload) {
    let data;
    try { data = JSON.parse(typeof payload === 'string' ? payload : payload.toString()); }
    catch (e) { return; }

    const gwId = data.gw_id || extractId(topic);
    if (!gwId) return;

    gatewayRegistry.set(gwId, {
        id: gwId,
        status: data.state === 'online' || data.online === true ? 'online' : 'offline',
        sinks: data.sinks || [],
        lastSeen: Date.now(),
        messagesProcessed: (gatewayRegistry.get(gwId) || {}).messagesProcessed || 0,
        model: data.model || 'SolidSense N6'
    });
}

/**
 * Parse node status message (anchor/tag health).
 * Topic: wirepas/status/+
 */
function parseNodeStatus(topic, payload) {
    let data;
    try { data = JSON.parse(typeof payload === 'string' ? payload : payload.toString()); }
    catch (e) { return; }

    const nodeId = data.node_id || data.nodeId || extractId(topic);
    if (!nodeId) return;

    if (data.node_type === 'anchor' && data.x != null && data.y != null) {
        registerAnchor(nodeId, {
            name: data.name, x: data.x, y: data.y, z: data.z,
            floor: data.floor, battery: data.battery,
            model: data.model || 'ELA Blue ANCHOR', firmware: data.firmware,
            meshAddress: data.mesh_address
        });
    }

    if (data.battery != null) {
        tagBattery.set(nodeId, data.battery);
        updateELADevice(nodeId, {
            role: data.node_type === 'anchor' ? 'anchor' : 'tag',
            battery: data.battery,
            model: data.model,
            firmware: data.firmware,
            hopCount: data.hop_count,
            meshNeighbors: data.mesh_neighbors,
            lastSeen: Date.now()
        });
    }
}

// ══════════════════════════════════════════════════════════════
//  MAIN MESSAGE ROUTER
// ══════════════════════════════════════════════════════════════

/**
 * Route MQTT message to correct parser based on topic.
 * @param {string} topic
 * @param {Buffer|string} payload
 * @returns {Array} parsed tag data array
 */
function parseMessage(topic, payload) {
    stats.messagesTotal++;

    // Gateway status (no tag data returned)
    if (topic.startsWith('gw-event/status/')) {
        parseGatewayStatus(topic, payload);
        return [];
    }

    // Node status (anchor/tag health)
    if (topic.startsWith('wirepas/status/')) {
        parseNodeStatus(topic, payload);
        return [];
    }

    // Binary protobuf from SolidSense N6
    if (topic.startsWith('gw-event/received_data/')) {
        return parseProtobuf(topic, payload);
    }

    // JSON-based messages
    let data;
    try {
        data = typeof payload === 'string' ? JSON.parse(payload) : JSON.parse(payload.toString());
    } catch (e) {
        stats.lastError = 'Invalid JSON on ' + topic;
        stats.lastErrorTime = new Date().toISOString();
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

// ══════════════════════════════════════════════════════════════
//  PUBLIC API
// ══════════════════════════════════════════════════════════════

/**
 * Get all MQTT topics to subscribe to.
 * @param {object} mqttConfig - from config.json mqtt.topics
 * @returns {string[]}
 */
function getMqttTopics(mqttConfig) {
    const topics = [
        mqttConfig.distances,               // pilot/indoor/distances/+
        mqttConfig.wirepas || null,          // wirepas/+/received_data
        mqttConfig.ela || null,              // ela/+/data
        mqttConfig.protobuf || 'gw-event/received_data/#',  // binary protobuf
        mqttConfig.gatewayStatus || 'gw-event/status/+',    // gateway health
        mqttConfig.nodeStatus || 'wirepas/status/+'         // node health
    ];
    return topics.filter(Boolean);
}

function getStats() {
    return {
        ...stats,
        gatewaysActive: Array.from(gatewayRegistry.values()).filter(g => g.status === 'online').length,
        gatewaysTotal: gatewayRegistry.size,
        anchorsRegistered: meshAnchors.size,
        elaDevicesTracked: elaDevices.size,
        adaptiveRate: {
            enabled: ADAPTIVE_RATE.enabled,
            trackedTags: tagMotion.size,
            movingTags: Array.from(tagMotion.values()).filter(s => s.isMoving).length,
            stationaryTags: Array.from(tagMotion.values()).filter(s => !s.isMoving).length
        }
    };
}

function getGatewayStats() {
    return Array.from(gatewayRegistry.values());
}

function getAnchors() {
    return Array.from(meshAnchors.values());
}

function getELADeviceList() {
    return Array.from(elaDevices.values());
}

module.exports = {
    // Core
    parseMessage,
    getMqttTopics,
    shouldProcessUpdate,
    getTagMotionState,

    // Registries
    registerAnchor,
    updateELADevice,
    meshAnchors,
    elaDevices,
    gatewayRegistry,
    tagBattery,

    // Stats & monitoring
    getStats,
    getGatewayStats,
    getAnchors,
    getELADeviceList,
    sweepGateways,

    // Config
    RSSI_CONFIG,
    CS_CONFIG,
    ADAPTIVE_RATE,
    stats
};
