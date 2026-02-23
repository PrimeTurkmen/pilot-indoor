/**
 * Zone Checker — The Brain of Indoor Positioning.
 * Ported from SiteTrack ZoneChecker — adapted for indoor x/y coordinates.
 *
 * On every position update:
 *   1. Tests device position against all zone polygons (point-in-polygon)
 *   2. Detects enter/exit transitions per device
 *   3. Returns zone events for alert evaluation + WebSocket broadcast
 *
 * Unlike SiteTrack (which uses lat/lon geo-polygons), this version works
 * with indoor x/y pixel/meter coordinates directly.
 */

const { pointInPolygon } = require('./geo-utils');

class ZoneChecker {
    constructor() {
        // deviceId -> Set of zone IDs the device is currently in
        this._deviceZoneState = new Map();

        // Zone definitions: array of {id, name, floor, type, polygon: [[x,y],...], alertOnEnter, alertOnExit}
        this._zones = [];
    }

    /**
     * Load/update zone definitions.
     * @param {Array<{id: string, name: string, floor: number, type?: string, polygon: [number,number][], alertOnEnter?: boolean, alertOnExit?: boolean}>} zones
     */
    setZones(zones) {
        this._zones = (zones || []).map(z => ({
            id: z.id,
            name: z.name,
            floor: z.floor || 1,
            type: z.type || 'general',
            polygon: z.polygon || [],
            alertOnEnter: z.alertOnEnter !== false,  // default true
            alertOnExit: z.alertOnExit !== false       // default true
        }));
    }

    /**
     * Get current zone definitions.
     * @returns {object[]}
     */
    getZones() {
        return this._zones;
    }

    /**
     * Check a device position against all zones.
     * Returns array of zone events (enter/exit/inside).
     *
     * @param {{deviceId: string, x: number, y: number, floor: number}} position
     * @returns {Array<{deviceId: string, zoneId: string, zoneName: string, zoneType: string, event: string, alertOnEnter: boolean, alertOnExit: boolean}>}
     */
    check(position) {
        if (!position || position.x == null || position.y == null) return [];
        if (this._zones.length === 0) return [];

        const { deviceId, x, y, floor } = position;
        const point = [x, y];

        // Get device's current zone set (or create empty)
        if (!this._deviceZoneState.has(deviceId)) {
            this._deviceZoneState.set(deviceId, new Set());
        }
        const currentZones = this._deviceZoneState.get(deviceId);
        const events = [];

        // Test against all zones on same floor
        const nowInZones = new Set();
        for (const zone of this._zones) {
            if (zone.floor !== floor) continue;
            if (!zone.polygon || zone.polygon.length < 3) continue;

            const inside = pointInPolygon(point, zone.polygon);

            if (inside) {
                nowInZones.add(zone.id);

                // ENTER event — device just entered this zone
                if (!currentZones.has(zone.id)) {
                    events.push({
                        deviceId,
                        zoneId: zone.id,
                        zoneName: zone.name,
                        zoneType: zone.type,
                        event: 'enter',
                        alertOnEnter: zone.alertOnEnter,
                        alertOnExit: zone.alertOnExit
                    });
                    console.log(`[Zone] ${deviceId} ENTER "${zone.name}" (${zone.type})`);
                } else {
                    // INSIDE — still in zone (no event emitted, but useful for dwell tracking)
                }
            }
        }

        // EXIT events — device left zones it was previously in
        for (const zoneId of currentZones) {
            if (!nowInZones.has(zoneId)) {
                const zone = this._zones.find(z => z.id === zoneId);
                if (zone) {
                    events.push({
                        deviceId,
                        zoneId: zone.id,
                        zoneName: zone.name,
                        zoneType: zone.type,
                        event: 'exit',
                        alertOnEnter: zone.alertOnEnter,
                        alertOnExit: zone.alertOnExit
                    });
                    console.log(`[Zone] ${deviceId} EXIT "${zone.name}" (${zone.type})`);
                }
            }
        }

        // Update device zone state
        this._deviceZoneState.set(deviceId, nowInZones);

        return events;
    }

    /**
     * Get current zone names for a device.
     * @param {string} deviceId
     * @returns {string[]} zone names
     */
    getDeviceZones(deviceId) {
        const zoneIds = this._deviceZoneState.get(deviceId);
        if (!zoneIds || zoneIds.size === 0) return [];
        return this._zones
            .filter(z => zoneIds.has(z.id))
            .map(z => z.name);
    }

    /**
     * Get current zone IDs for a device.
     * @param {string} deviceId
     * @returns {string[]} zone IDs
     */
    getDeviceZoneIds(deviceId) {
        const zoneIds = this._deviceZoneState.get(deviceId);
        if (!zoneIds) return [];
        return Array.from(zoneIds);
    }

    /**
     * Get zone by ID.
     * @param {string} zoneId
     * @returns {object|undefined}
     */
    getZoneById(zoneId) {
        return this._zones.find(z => z.id === zoneId);
    }

    /**
     * Get zones with device counts (for API).
     * @returns {Array<{id: string, name: string, floor: number, type: string, deviceCount: number, polygon: Array}>}
     */
    getZonesWithCounts() {
        return this._zones.map(z => {
            let deviceCount = 0;
            for (const [, zoneIds] of this._deviceZoneState) {
                if (zoneIds.has(z.id)) deviceCount++;
            }
            return { ...z, deviceCount };
        });
    }

    /**
     * Clear all device zone state (e.g., on config reload).
     */
    clearState() {
        this._deviceZoneState.clear();
    }
}

module.exports = { ZoneChecker };
