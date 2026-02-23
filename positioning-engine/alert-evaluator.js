/**
 * Alert Evaluator — Decides when to fire alerts based on zone events and device health.
 * Ported from SiteTrack AlertEvaluator — adapted for pilot-indoor (no DB, callback-based).
 *
 * Supports:
 *   - Zone enter alerts (restricted area breach = critical)
 *   - Zone exit alerts (info)
 *   - Low battery alerts (warning <15%, critical <5%)
 *   - Offline device alerts (info)
 *   - Speed violation alerts (warning >40km/h, critical >60km/h)
 *
 * Cooldown system prevents alert spam (5 min per device+type+zone).
 */

const crypto = require('crypto');

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RECENT_ALERTS = 100;

class AlertEvaluator {
    /**
     * @param {object} opts
     * @param {number} [opts.cooldownMs=300000] - Cooldown period in ms
     * @param {number} [opts.batteryWarning=15] - Battery warning threshold %
     * @param {number} [opts.batteryCritical=5] - Battery critical threshold %
     * @param {number} [opts.offlineTimeoutMs=600000] - Offline timeout in ms
     * @param {number} [opts.speedLimitKmh=40] - Speed limit km/h
     * @param {function} [opts.onAlert] - Callback when alert fires: (alert) => void
     */
    constructor(opts = {}) {
        this._cooldownMs = opts.cooldownMs || DEFAULT_COOLDOWN_MS;
        this._batteryWarning = opts.batteryWarning || 15;
        this._batteryCritical = opts.batteryCritical || 5;
        this._offlineTimeoutMs = opts.offlineTimeoutMs || 10 * 60 * 1000;
        this._speedLimitKmh = opts.speedLimitKmh || 40;
        this._onAlert = opts.onAlert || null;

        // Cooldown: key -> timestamp
        this._cooldown = new Map();

        // Recent alerts ring buffer (for API)
        this._recentAlerts = [];
    }

    /**
     * Evaluate a zone event and potentially generate alerts.
     * @param {{deviceId: string, zoneId: string, zoneName: string, zoneType: string, event: string, alertOnEnter: boolean, alertOnExit: boolean}} zoneEvent
     */
    evaluate(zoneEvent) {
        const { deviceId, zoneId, zoneName, zoneType, event, alertOnEnter, alertOnExit } = zoneEvent;

        // Zone enter — restricted area breach
        if (event === 'enter' && alertOnEnter) {
            const severity = zoneType === 'restricted' ? 'critical' : 'warning';
            const message = zoneType === 'restricted'
                ? `RESTRICTED ZONE BREACH: ${deviceId} entered "${zoneName}"`
                : `${deviceId} entered zone "${zoneName}"`;

            this._fireAlert({
                deviceId,
                zoneId,
                type: 'zone_enter',
                severity,
                message
            });
        }

        // Zone exit
        if (event === 'exit' && alertOnExit) {
            this._fireAlert({
                deviceId,
                zoneId,
                type: 'zone_exit',
                severity: 'info',
                message: `${deviceId} exited zone "${zoneName}"`
            });
        }
    }

    /**
     * Check device health metrics (battery, offline, speed).
     * Called periodically from server sweep.
     *
     * @param {{id: string, name: string, battery: number|null, speed: number|null, lastUpdate: number, status: string}} device
     */
    checkDeviceHealth(device) {
        if (!device) return;
        const name = device.name || device.id;

        // Low battery
        if (device.battery != null && device.battery < this._batteryWarning) {
            const severity = device.battery < this._batteryCritical ? 'critical' : 'warning';
            this._fireAlert({
                deviceId: device.id,
                zoneId: null,
                type: 'low_battery',
                severity,
                message: `Low battery: ${name} at ${device.battery}%`
            });
        }

        // Speed violation
        if (device.speed != null && device.speed > this._speedLimitKmh) {
            const severity = device.speed > 60 ? 'critical' : 'warning';
            this._fireAlert({
                deviceId: device.id,
                zoneId: null,
                type: 'speed',
                severity,
                message: `Speed violation: ${name} at ${device.speed} km/h`
            });
        }

        // Offline detection
        const lastUpdateMs = (device.lastUpdate || 0) * 1000;
        const silentMs = Date.now() - lastUpdateMs;
        if (silentMs > this._offlineTimeoutMs && device.status === 'online') {
            this._fireAlert({
                deviceId: device.id,
                zoneId: null,
                type: 'offline',
                severity: 'info',
                message: `Device offline: ${name} (last seen ${Math.round(silentMs / 60000)}m ago)`
            });
        }
    }

    /**
     * Fire an alert — check cooldown, log, store, invoke callback.
     * @param {{deviceId: string, zoneId: string|null, type: string, severity: string, message: string}} alert
     */
    _fireAlert(alert) {
        // Cooldown check — prevent alert spam
        const cooldownKey = `${alert.deviceId}:${alert.type}:${alert.zoneId || 'none'}`;
        const lastFired = this._cooldown.get(cooldownKey) || 0;
        if (Date.now() - lastFired < this._cooldownMs) return;
        this._cooldown.set(cooldownKey, Date.now());

        // Build full alert object
        const fullAlert = {
            id: crypto.randomUUID(),
            deviceId: alert.deviceId,
            zoneId: alert.zoneId,
            type: alert.type,
            severity: alert.severity,
            message: alert.message,
            timestamp: new Date().toISOString()
        };

        // Store in recent alerts ring buffer
        this._recentAlerts.push(fullAlert);
        if (this._recentAlerts.length > MAX_RECENT_ALERTS) {
            this._recentAlerts.shift();
        }

        console.log(`[Alert] ${alert.severity.toUpperCase()}: ${alert.message}`);

        // Invoke callback (WebSocket broadcast, webhook, etc.)
        if (this._onAlert) {
            try { this._onAlert(fullAlert); }
            catch (e) { console.error('[Alert] Callback error:', e.message); }
        }
    }

    /**
     * Get recent alerts (for API).
     * @param {number} [limit=50]
     * @returns {object[]}
     */
    getRecentAlerts(limit) {
        const n = limit || 50;
        return this._recentAlerts.slice(-n);
    }

    /**
     * Clean old cooldown entries (prevent memory leak).
     * Called periodically.
     */
    cleanCooldowns() {
        const now = Date.now();
        for (const [key, time] of this._cooldown) {
            if (now - time > this._cooldownMs * 2) {
                this._cooldown.delete(key);
            }
        }
    }

    /**
     * Set the alert callback.
     * @param {function} fn - (alert) => void
     */
    setOnAlert(fn) {
        this._onAlert = fn;
    }

    /** Number of alerts fired (since startup). */
    get totalAlerts() {
        return this._recentAlerts.length;
    }
}

module.exports = { AlertEvaluator };
