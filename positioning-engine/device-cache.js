/**
 * Device Cache — In-memory store for tracked device state.
 * Ported from SiteTrack DeviceCache with merge semantics and stale sweep.
 *
 * Features:
 *   - Merge update: only overwrites non-null fields
 *   - Floor-based queries
 *   - Automatic stale sweep (marks offline after timeout)
 *   - Mock data seeding for development
 */

const OFFLINE_TIMEOUT_MS = 5 * 60 * 1000;  // 5 minutes
const SWEEP_INTERVAL_MS  = 30 * 1000;      // 30 seconds

class DeviceCache {
    constructor(opts = {}) {
        this._cache = new Map();
        this._offlineTimeout = opts.offlineTimeout || OFFLINE_TIMEOUT_MS;
        this._sweepTimer = null;
    }

    /**
     * Update device in cache with merge semantics.
     * Only overwrites fields that are non-null/non-undefined.
     *
     * @param {object} device - device data
     * @param {string} device.id - unique device ID
     */
    update(device) {
        if (!device || !device.id) return;

        const existing = this._cache.get(device.id);
        const merged = {
            id:          device.id,
            name:        device.name       ?? (existing ? existing.name : device.id),
            type:        device.type       ?? (existing ? existing.type : 'person'),
            zone:        device.zone       ?? (existing ? existing.zone : ''),
            battery:     device.battery    ?? (existing ? existing.battery : null),
            temperature: device.temperature ?? (existing ? existing.temperature : null),
            humidity:    device.humidity   ?? (existing ? existing.humidity : null),
            lastUpdate:  device.lastUpdate ?? Math.floor(Date.now() / 1000),
            status:      'online',
            isMoving:    device.isMoving   ?? (existing ? existing.isMoving : false),
            x:           device.x          ?? (existing ? existing.x : null),
            y:           device.y          ?? (existing ? existing.y : null),
            floor:       device.floor      ?? (existing ? existing.floor : 1),
            confidence:  device.confidence ?? (existing ? existing.confidence : 0),
            geo:         device.geo        ?? (existing ? existing.geo : null),
            speed:       device.speed      ?? (existing ? existing.speed : 0),
            zones:       device.zones      ?? (existing ? existing.zones : [])
        };

        this._cache.set(device.id, merged);
        return merged;
    }

    /**
     * Get device by ID.
     * @param {string} id
     * @returns {object|undefined}
     */
    get(id) {
        return this._cache.get(id);
    }

    /**
     * Get all devices as array.
     * @returns {object[]}
     */
    getAll() {
        return Array.from(this._cache.values());
    }

    /**
     * Get all devices on a specific floor.
     * @param {number} floor
     * @returns {object[]}
     */
    getAllForFloor(floor) {
        return this.getAll().filter(d => d.floor === floor);
    }

    /**
     * Mark devices as offline if no update in timeout period.
     * Returns list of devices that just went offline.
     * @returns {object[]} newly offline devices
     */
    sweepStale() {
        const now = Date.now();
        const nowSec = Math.floor(now / 1000);
        const thresholdSec = nowSec - (this._offlineTimeout / 1000);
        const newlyOffline = [];

        for (const device of this._cache.values()) {
            if (device.lastUpdate < thresholdSec && device.status === 'online') {
                device.status = 'offline';
                newlyOffline.push(device);
            }
        }

        return newlyOffline;
    }

    /**
     * Start automatic stale sweep interval.
     * @param {number} [intervalMs=30000]
     */
    startSweep(intervalMs) {
        if (this._sweepTimer) return;
        this._sweepTimer = setInterval(() => this.sweepStale(), intervalMs || SWEEP_INTERVAL_MS);
    }

    /**
     * Stop automatic stale sweep.
     */
    stopSweep() {
        if (this._sweepTimer) {
            clearInterval(this._sweepTimer);
            this._sweepTimer = null;
        }
    }

    /**
     * Remove a device from cache.
     * @param {string} id
     */
    remove(id) {
        this._cache.delete(id);
    }

    /**
     * Clear all devices.
     */
    clear() {
        this._cache.clear();
    }

    /** Total number of cached devices. */
    get size() {
        return this._cache.size;
    }

    /** Number of online devices. */
    get onlineCount() {
        let count = 0;
        for (const d of this._cache.values()) {
            if (d.status === 'online') count++;
        }
        return count;
    }

    /**
     * Seed mock devices for development/demo.
     */
    seedMock() {
        const now = Math.floor(Date.now() / 1000);
        const mocks = [
            { id: 'ela_puck_001', name: 'Worker Ahmed',    type: 'person', zone: 'Zone A',  battery: 87, x: 5.2,  y: 3.1,  floor: 1 },
            { id: 'ela_puck_002', name: 'Forklift #3',     type: 'asset',  zone: 'Zone B',  battery: 64, x: 12.0, y: 8.5,  floor: 1 },
            { id: 'ela_coin_003', name: 'Pallet Jack B',   type: 'asset',  zone: 'Loading', battery: 92, x: 18.3, y: 1.7,  floor: 1 },
            { id: 'ela_puck_004', name: 'Worker Sarah',    type: 'person', zone: 'Zone A',  battery: 45, x: 8.8,  y: 11.2, floor: 1 },
            { id: 'ela_coin_005', name: 'Crane Sensor C',  type: 'asset',  zone: 'Staging', battery: 78, x: 15.0, y: 6.0,  floor: 1 }
        ];

        for (const m of mocks) {
            this.update({
                ...m,
                lastUpdate: now,
                isMoving: true,
                confidence: 0.85,
                temperature: null,
                humidity: null,
                geo: null
            });
        }

        console.log('[DeviceCache] Mock data loaded:', mocks.length, 'ELA devices');
    }
}

module.exports = { DeviceCache, OFFLINE_TIMEOUT_MS };
