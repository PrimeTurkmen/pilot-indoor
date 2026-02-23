/**
 * Velavu Cloud API Adapter — v1.0
 * ================================
 * Proxies Velavu REST API for the PILOT Indoor Positioning extension.
 * Transforms Velavu data models into PILOT-normalized format.
 *
 * Endpoints exposed:
 *   GET  /api/velavu/devices    — all devices (tags + anchors + gateways)
 *   GET  /api/velavu/assets     — named assets paired to devices
 *   GET  /api/velavu/sites      — sites with floors, floor plans, walls
 *   GET  /api/velavu/geofences  — geofence boundaries
 *   GET  /api/velavu/events/:category — events (LOCATION, BATTERY, ENVIRONMENT, etc.)
 *   GET  /api/velavu/status     — connection status + stats
 *
 * Environment:
 *   VELAVU_API_TOKEN  — Bearer token from Velavu dashboard
 *   VELAVU_API_URL    — Base URL (default: https://api.velavu.com)
 *   VELAVU_POLL_MS    — Polling interval in ms (default: 10000)
 */

'use strict';

const https = require('https');
const http  = require('http');
const url   = require('url');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const VELAVU_API_URL = process.env.VELAVU_API_URL || 'https://api.velavu.com';
const VELAVU_TOKEN   = process.env.VELAVU_API_TOKEN || '';
const POLL_INTERVAL  = parseInt(process.env.VELAVU_POLL_MS, 10) || 10000;

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------
const cache = {
    devices:    [],
    assets:     [],
    sites:      [],
    geofences:  [],
    lastUpdate: null,
    pollTimer:  null,
    stats: {
        apiCalls:   0,
        errors:     0,
        lastError:  null,
        uptime:     Date.now()
    }
};

// WebSocket subscribers (engine pushes updates to extension)
const wsSubscribers = new Set();

// ---------------------------------------------------------------------------
// Velavu API client
// ---------------------------------------------------------------------------

/**
 * Generic GET request to Velavu REST API.
 * Returns parsed JSON or throws.
 */
function velavuGet(endpoint) {
    return new Promise((resolve, reject) => {
        const fullUrl = VELAVU_API_URL + endpoint;
        const parsed  = url.parse(fullUrl);
        const mod     = parsed.protocol === 'https:' ? https : http;

        const opts = {
            hostname: parsed.hostname,
            port:     parsed.port,
            path:     parsed.path,
            method:   'GET',
            headers: {
                'Authorization': 'Bearer ' + VELAVU_TOKEN,
                'Accept':        'application/json'
            }
        };

        cache.stats.apiCalls++;

        const req = mod.request(opts, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(JSON.parse(body)); }
                    catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
                } else if (res.statusCode === 403) {
                    // Token scope limitation — return empty array gracefully
                    resolve([]);
                } else {
                    cache.stats.errors++;
                    cache.stats.lastError = body;
                    reject(new Error('Velavu API ' + res.statusCode + ': ' + body));
                }
            });
        });

        req.on('error', (e) => {
            cache.stats.errors++;
            cache.stats.lastError = e.message;
            reject(e);
        });

        req.setTimeout(15000, () => {
            req.destroy();
            reject(new Error('Velavu API timeout'));
        });

        req.end();
    });
}

// ---------------------------------------------------------------------------
// Data normalization — Velavu → PILOT format
// ---------------------------------------------------------------------------

/**
 * Normalize a Velavu device into PILOT indoor device format.
 */
function normalizeDevice(dev) {
    const loc = dev.location || {};
    const env = dev.environment || {};
    const state = dev.state || {};
    const power = state.power || {};
    const routing = state.routing || {};
    const asset = dev.asset || null;

    return {
        id:             dev.id,
        serial:         dev.serial_code,
        name:           asset ? asset.name : dev.model || dev.id,
        type:           mapCategory(dev.category, asset),
        category:       dev.category,                          // TAG, ANCHOR, GATEWAY
        hardware:       dev.hardware,                          // meridian, panicbutton, argo
        model:          dev.model,                             // Pavo HD, Minew B10, Vesta
        online:         dev.online || false,
        battery:        power.battery_level != null ? power.battery_level : null,
        batteryCharging: power.battery_charging || false,
        usbPower:       power.usb_power || false,
        // Position
        lat:            loc.coordinates ? loc.coordinates[0] : null,
        lng:            loc.coordinates ? loc.coordinates[1] : null,
        accuracy:       loc.accuracy || null,
        locationType:   loc.location_type || null,             // MESH, FIXED, GPS, PROXIMITY
        floorId:        loc.floor_id || null,
        locationTime:   loc.timestamp || null,
        locked:         loc.locked || false,
        // Environment sensors
        temperature:    env.temperature_c != null ? env.temperature_c : null,
        humidity:       env.humidity != null ? env.humidity : null,
        envTime:        env.timestamp || null,
        // Network
        rssi:           routing.rssi || null,
        installQuality: routing.install_quality || null,
        txPower:        routing.tx_power || null,
        routeTo:        routing.device_id || null,
        gatewayId:      dev.gateway_id || null,
        siteId:         dev.site_id || null,
        // Firmware
        appVersion:     state.app_version || null,
        // Heartbeat
        heartbeat:      dev.heartbeat || null,
        lastUpdate:     loc.timestamp || dev.heartbeat || null,
        // Asset link
        assetId:        asset ? asset.id : null,
        assetName:      asset ? asset.name : null,
        assetGroup:     asset ? asset.group : null,
        assetCategory:  asset ? asset.category : null,
        // Config snapshot
        config:         dev.config || null,
        // Raw Velavu object (for advanced use)
        _raw:           dev
    };
}

/**
 * Map Velavu category to PILOT type string.
 */
function mapCategory(category, asset) {
    if (category === 'ANCHOR') return 'anchor';
    if (asset && asset.group && asset.group.toLowerCase().includes('staff')) return 'person';
    if (asset && asset.category === 'VEHICLE') return 'vehicle';
    if (category === 'TAG') return 'asset';
    return 'device';
}

/**
 * Normalize a Velavu site into PILOT format.
 */
function normalizeSite(site) {
    return {
        id:         site.id,
        name:       site.name,
        online:     site.online || false,
        lat:        site.coordinates ? site.coordinates[0] : null,
        lng:        site.coordinates ? site.coordinates[1] : null,
        boundary:   site.boundary || null,
        boundaryFactor: site.boundary_factor || 1.5,
        floors:     (site.floors || []).map(normalizeFloor),
        _raw:       site
    };
}

/**
 * Normalize a Velavu floor.
 */
function normalizeFloor(floor) {
    const img = floor.img || {};
    return {
        id:         floor.id,
        name:       floor.name,
        level:      floor.level,
        imageUrl:   img.url || null,
        imageFilename: img.filename || null,
        imageScale: img.scale || 1,
        imageRotation: img.rotation || 0,
        imageOpacity:  img.opacity || 1,
        imageWidth: img.width || 0,
        imageHeight: img.height || 0,
        imageCenter: img.center || null,
        imageCoords: img.coordinates || null,     // [[lat,lng], ...] corners
        walls:      (floor.geometry && floor.geometry.walls) || null,
        floorplan:  floor.floorplan || null
    };
}

/**
 * Normalize a Velavu asset.
 */
function normalizeAsset(asset) {
    return {
        id:         asset.id,
        name:       asset.name,
        category:   asset.category,     // EQUIPMENT, VEHICLE
        group:      asset.group,        // Staff, etc.
        notes:      asset.notes || '',
        deviceId:   asset.device_id,
        online:     asset.online || false,
        profileImg: asset.profile_img || null
    };
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

async function pollVelavu() {
    try {
        // Fetch devices (primary data — always available)
        const rawDevices = await velavuGet('/devices');
        if (Array.isArray(rawDevices)) {
            cache.devices = rawDevices.map(normalizeDevice);
        }

        // Fetch assets
        try {
            const rawAssets = await velavuGet('/assets');
            if (Array.isArray(rawAssets)) {
                cache.assets = rawAssets.map(normalizeAsset);
            }
        } catch (e) { /* token scope */ }

        // Fetch sites (less frequently — every 5th poll)
        if (!cache.lastUpdate || (cache.stats.apiCalls % 5 === 0)) {
            try {
                const rawSites = await velavuGet('/sites');
                if (Array.isArray(rawSites)) {
                    cache.sites = rawSites.map(normalizeSite);
                }
            } catch (e) { /* token scope */ }

            try {
                const rawGeo = await velavuGet('/geofences');
                if (Array.isArray(rawGeo)) {
                    cache.geofences = rawGeo;
                }
            } catch (e) { /* token scope */ }
        }

        cache.lastUpdate = new Date().toISOString();

        // Push to WebSocket subscribers
        broadcastUpdate();

    } catch (err) {
        console.error('[Velavu] Poll error:', err.message);
    }
}

function broadcastUpdate() {
    const payload = JSON.stringify({
        type: 'velavu_update',
        data: {
            devices:   cache.devices,
            assets:    cache.assets,
            timestamp: cache.lastUpdate
        }
    });

    for (const ws of wsSubscribers) {
        try {
            if (ws.readyState === 1) ws.send(payload);
            else wsSubscribers.delete(ws);
        } catch (e) {
            wsSubscribers.delete(ws);
        }
    }
}

// ---------------------------------------------------------------------------
// Express/HTTP route handler
// ---------------------------------------------------------------------------

/**
 * Register Velavu adapter routes on the given Express-like app or raw HTTP handler.
 * @param {object} app — Express app or { get(path, handler) } interface
 */
function registerRoutes(app) {
    // Devices (tags + anchors + gateways)
    app.get('/api/velavu/devices', (req, res) => {
        const category = req.query && req.query.category;
        let devices = cache.devices;
        if (category) {
            devices = devices.filter(d => d.category === category.toUpperCase());
        }
        res.json(devices);
    });

    // Tags only (convenience)
    app.get('/api/velavu/tags', (req, res) => {
        res.json(cache.devices.filter(d => d.category === 'TAG'));
    });

    // Anchors only (convenience)
    app.get('/api/velavu/anchors', (req, res) => {
        res.json(cache.devices.filter(d => d.category === 'ANCHOR'));
    });

    // Assets
    app.get('/api/velavu/assets', (req, res) => {
        res.json(cache.assets);
    });

    // Sites with floors
    app.get('/api/velavu/sites', (req, res) => {
        res.json(cache.sites);
    });

    // Single site
    app.get('/api/velavu/sites/:id', (req, res) => {
        const site = cache.sites.find(s => s.id === req.params.id);
        if (site) res.json(site);
        else res.status(404).json({ error: 'Site not found' });
    });

    // Geofences
    app.get('/api/velavu/geofences', (req, res) => {
        res.json(cache.geofences);
    });

    // Events (proxy to Velavu)
    app.get('/api/velavu/events/:category', async (req, res) => {
        try {
            const limit = req.query.limit || 50;
            const data = await velavuGet('/events/' + req.params.category + '?limit=' + limit);
            res.json(data);
        } catch (e) {
            res.status(502).json({ error: e.message });
        }
    });

    // Status & stats
    app.get('/api/velavu/status', (req, res) => {
        res.json({
            engine:      'velavu',
            connected:   !!cache.lastUpdate,
            lastUpdate:  cache.lastUpdate,
            deviceCount: cache.devices.length,
            tagCount:    cache.devices.filter(d => d.category === 'TAG').length,
            anchorCount: cache.devices.filter(d => d.category === 'ANCHOR').length,
            assetCount:  cache.assets.length,
            siteCount:   cache.sites.length,
            pollInterval: POLL_INTERVAL,
            stats:       cache.stats
        });
    });

    // Proxy any other Velavu endpoint (passthrough)
    app.get('/api/velavu/proxy/*', async (req, res) => {
        try {
            const path = '/' + req.params[0];
            const data = await velavuGet(path);
            res.json(data);
        } catch (e) {
            res.status(502).json({ error: e.message });
        }
    });
}

/**
 * Handle raw HTTP request (for non-Express servers).
 */
function handleRequest(req, res) {
    const parsed = url.parse(req.url, true);
    const path   = parsed.pathname;

    // Quick JSON helper
    res.json = function(data) {
        res.writeHead(200, {
            'Content-Type':                'application/json',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify(data));
    };

    // Attach query + params
    req.query = parsed.query || {};

    if (path === '/api/velavu/devices') {
        const category = req.query.category;
        let devices = cache.devices;
        if (category) devices = devices.filter(d => d.category === category.toUpperCase());
        return res.json(devices);
    }
    if (path === '/api/velavu/tags') {
        return res.json(cache.devices.filter(d => d.category === 'TAG'));
    }
    if (path === '/api/velavu/anchors') {
        return res.json(cache.devices.filter(d => d.category === 'ANCHOR'));
    }
    if (path === '/api/velavu/assets') {
        return res.json(cache.assets);
    }
    if (path === '/api/velavu/sites') {
        return res.json(cache.sites);
    }
    if (path === '/api/velavu/geofences') {
        return res.json(cache.geofences);
    }
    if (path === '/api/velavu/status') {
        return res.json({
            engine:      'velavu',
            connected:   !!cache.lastUpdate,
            lastUpdate:  cache.lastUpdate,
            deviceCount: cache.devices.length,
            tagCount:    cache.devices.filter(d => d.category === 'TAG').length,
            anchorCount: cache.devices.filter(d => d.category === 'ANCHOR').length,
            assetCount:  cache.assets.length,
            siteCount:   cache.sites.length,
            pollInterval: POLL_INTERVAL,
            stats:       cache.stats
        });
    }

    return false; // Not handled
}

// ---------------------------------------------------------------------------
// WebSocket subscriber management
// ---------------------------------------------------------------------------
function addSubscriber(ws) {
    wsSubscribers.add(ws);
    // Send current state immediately
    try {
        ws.send(JSON.stringify({
            type: 'velavu_snapshot',
            data: {
                devices:   cache.devices,
                assets:    cache.assets,
                sites:     cache.sites,
                geofences: cache.geofences,
                timestamp: cache.lastUpdate
            }
        }));
    } catch (e) { /* ignore */ }
}

function removeSubscriber(ws) {
    wsSubscribers.delete(ws);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function start() {
    if (!VELAVU_TOKEN) {
        console.warn('[Velavu] No VELAVU_API_TOKEN set — adapter disabled');
        return;
    }

    console.log('[Velavu] Starting adapter — polling every', POLL_INTERVAL, 'ms');
    console.log('[Velavu] API URL:', VELAVU_API_URL);

    // Initial fetch
    pollVelavu();

    // Start polling loop
    cache.pollTimer = setInterval(pollVelavu, POLL_INTERVAL);
}

function stop() {
    if (cache.pollTimer) {
        clearInterval(cache.pollTimer);
        cache.pollTimer = null;
    }
    wsSubscribers.clear();
    console.log('[Velavu] Adapter stopped');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
    start,
    stop,
    registerRoutes,
    handleRequest,
    addSubscriber,
    removeSubscriber,
    getCache: () => cache,
    pollNow:  pollVelavu,
    velavuGet
};
