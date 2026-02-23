/**
 * WebSocket Broadcast Server — Real-time position, zone, and alert streaming.
 * Attaches to existing HTTP server via 'upgrade' event.
 *
 * Channels:
 *   positions  — device position updates
 *   zones      — zone enter/exit events
 *   alerts     — alert notifications
 *   stats      — engine stats (every 10s)
 *
 * Clients subscribe via: {"type":"subscribe","channels":["positions","zones","alerts"]}
 */

const { WebSocketServer } = require('ws');

const HEARTBEAT_INTERVAL = 30000;  // 30s ping/pong
const VALID_CHANNELS = new Set(['positions', 'zones', 'alerts', 'stats']);

class WebSocketBroadcaster {
    /**
     * @param {object} opts
     * @param {http.Server} opts.server - HTTP server to attach to
     * @param {number} [opts.heartbeatInterval=30000]
     */
    constructor(opts = {}) {
        this._clients = new Set();
        this._messagesSent = 0;
        this._heartbeatTimer = null;

        if (opts.server) {
            this.attach(opts.server, opts.heartbeatInterval);
        }
    }

    /**
     * Attach WebSocket server to an HTTP server.
     * @param {http.Server} server
     * @param {number} [heartbeatInterval]
     */
    attach(server, heartbeatInterval) {
        this._wss = new WebSocketServer({ server });

        this._wss.on('connection', (ws) => {
            // Per-client state
            ws._channels = new Set(['positions']); // default subscription
            ws._alive = true;

            this._clients.add(ws);
            console.log(`[WS] Client connected (total: ${this._clients.size})`);

            // Send welcome message
            this._send(ws, {
                type: 'welcome',
                channels: Array.from(VALID_CHANNELS),
                subscribed: Array.from(ws._channels)
            });

            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    this._handleClientMessage(ws, msg);
                } catch (e) {
                    // Ignore invalid JSON
                }
            });

            ws.on('pong', () => {
                ws._alive = true;
            });

            ws.on('close', () => {
                this._clients.delete(ws);
                console.log(`[WS] Client disconnected (total: ${this._clients.size})`);
            });

            ws.on('error', (err) => {
                console.error('[WS] Client error:', err.message);
                this._clients.delete(ws);
            });
        });

        // Heartbeat: ping/pong to detect dead connections
        const interval = heartbeatInterval || HEARTBEAT_INTERVAL;
        this._heartbeatTimer = setInterval(() => {
            for (const ws of this._clients) {
                if (!ws._alive) {
                    ws.terminate();
                    this._clients.delete(ws);
                    continue;
                }
                ws._alive = false;
                try { ws.ping(); } catch (e) { /* ignore */ }
            }
        }, interval);

        console.log(`[WS] WebSocket server attached (heartbeat: ${interval}ms)`);
    }

    /**
     * Handle incoming client message (subscribe/unsubscribe).
     */
    _handleClientMessage(ws, msg) {
        if (msg.type === 'subscribe' && Array.isArray(msg.channels)) {
            for (const ch of msg.channels) {
                if (VALID_CHANNELS.has(ch)) {
                    ws._channels.add(ch);
                }
            }
            this._send(ws, { type: 'subscribed', channels: Array.from(ws._channels) });
        }

        if (msg.type === 'unsubscribe' && Array.isArray(msg.channels)) {
            for (const ch of msg.channels) {
                ws._channels.delete(ch);
            }
            this._send(ws, { type: 'subscribed', channels: Array.from(ws._channels) });
        }
    }

    /**
     * Send a message to a specific client.
     */
    _send(ws, data) {
        if (ws.readyState === 1) { // OPEN
            try {
                ws.send(JSON.stringify(data));
                this._messagesSent++;
            } catch (e) { /* ignore */ }
        }
    }

    /**
     * Broadcast to all clients subscribed to a channel.
     * @param {string} channel
     * @param {object} data
     */
    _broadcast(channel, data) {
        const payload = JSON.stringify({ type: channel, data });
        for (const ws of this._clients) {
            if (ws.readyState === 1 && ws._channels && ws._channels.has(channel)) {
                try {
                    ws.send(payload);
                    this._messagesSent++;
                } catch (e) { /* ignore */ }
            }
        }
    }

    /**
     * Broadcast a device position update.
     * @param {object} device - device data from cache
     */
    broadcastPosition(device) {
        this._broadcast('positions', {
            id: device.id,
            name: device.name,
            type: device.type,
            x: device.x,
            y: device.y,
            floor: device.floor,
            zone: device.zone,
            status: device.status,
            isMoving: device.isMoving,
            confidence: device.confidence,
            battery: device.battery,
            temperature: device.temperature,
            humidity: device.humidity,
            geo: device.geo,
            lastUpdate: device.lastUpdate
        });
    }

    /**
     * Broadcast a zone enter/exit event.
     * @param {object} event - {deviceId, zoneId, zoneName, zoneType, event}
     */
    broadcastZoneEvent(event) {
        this._broadcast('zones', event);
    }

    /**
     * Broadcast an alert.
     * @param {object} alert - {id, deviceId, zoneId, type, severity, message, timestamp}
     */
    broadcastAlert(alert) {
        this._broadcast('alerts', alert);
    }

    /**
     * Broadcast engine stats.
     * @param {object} stats
     */
    broadcastStats(stats) {
        this._broadcast('stats', stats);
    }

    /**
     * Close the WebSocket server and clean up.
     */
    close() {
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
        if (this._wss) {
            this._wss.close();
        }
        this._clients.clear();
    }

    /** Number of connected clients. */
    get clientCount() {
        return this._clients.size;
    }

    /** Total messages sent since startup. */
    get messagesSent() {
        return this._messagesSent;
    }
}

module.exports = { WebSocketBroadcaster };
