/**
 * PILOT Extension — Indoor Positioning v3.0
 * Floor plan map view with Leaflet CRS.Simple and image overlay.
 * Displays real-time tag positions on indoor floor plans.
 *
 * v3.0: Animated marker movement via WebSocket position updates.
 *       Zone boundary overlays on floor plan (polygons from engine).
 *       Restricted-zone device highlighting (red pulse animation).
 *
 * @see TECHNICAL_SPEC.md — FloorPlanView requirements
 * @see pilot_extensions/examples/airports/Map.js — MapContainer pattern
 * @see pilot_extensions/docs/MapContainer.md
 */

Ext.define('Store.indoor-positioning.FloorPlanView', {
    extend: 'Ext.panel.Panel',
    xtype: 'indoor-floorplanview',

    cls: 'indoor-floor-plan map_canvas',
    bodyCls: 'map_canvas',
    layout: 'fit',

    floorPlanBounds: [[0, 0], [1000, 800]],
    engineBaseUrl: '',

    initComponent: function () {
        var me = this;

        // Marker cache: deviceId → L.circleMarker (for animated position updates)
        me._markerMap = {};
        // Zone overlay layer (polygons)
        me._zoneLayer = null;

        me.dockedItems = [
            {
                xtype: 'indoor-devicegrid',
                dock: 'bottom',
                height: 200,
                split: true,
                mapPanel: me,
                store: me.deviceStore || null
            }
        ];

        me.listeners = {
            render: function () {
                me.initMap();
                me.bindDeviceMarkers();
                me.loadDefaultFloorFromEngine();
                me.loadZoneOverlays();
            },
            resize: function (panel, width, height) {
                if (me.mapContainer && me.mapContainer.checkResize) {
                    me.mapContainer.checkResize();
                }
            }
        };

        me.callParent();
    },

    /**
     * If engineBaseUrl is set, load floors from engine and apply first floor's plan + bounds to map.
     */
    loadDefaultFloorFromEngine: function () {
        var me = this;
        var base = me.engineBaseUrl || '';
        if (!base) return;
        Ext.Ajax.request({
            url: base + '/api/indoor/floors',
            method: 'GET',
            success: function (resp) {
                try {
                    var data = Ext.JSON.decode(resp.responseText);
                    var floors = data.floors || [];
                    if (floors.length) {
                        var f = floors[0];
                        var url = f.plan_url;
                        var b = f.bounds ? f.bounds : me.floorPlanBounds;
                        if (Array.isArray(b[0]) && Array.isArray(b[1])) {
                            b = [[b[0][1], b[0][0]], [b[1][1], b[1][0]]];
                        }
                        if (url && me.updateFloorPlanOverlay) {
                            me.updateFloorPlanOverlay(url, b);
                            if (me.map && me.map.fitBounds) me.map.fitBounds(b);
                        }
                    }
                } catch (e) {}
            }
        });
    },

    /**
     * Load zone polygons from engine API and draw overlays on the map.
     * Restricted zones get a red fill; general zones get a teal fill.
     * Refreshes every 60 seconds to pick up zone config changes.
     */
    loadZoneOverlays: function () {
        var me = this;
        var base = me.engineBaseUrl || '';
        if (!base || !me.map) return;

        function fetchAndDraw() {
            Ext.Ajax.request({
                url: base + '/api/indoor/zones',
                method: 'GET',
                success: function (resp) {
                    try {
                        var data = Ext.JSON.decode(resp.responseText);
                        var zones = data.zones || [];
                        me.drawZoneOverlays(zones);
                    } catch (e) {}
                }
            });
        }

        fetchAndDraw();
        // Refresh zone overlays every 60s
        me._zoneRefreshTimer = setInterval(fetchAndDraw, 60000);
    },

    /**
     * Draw zone polygons on the map.
     * @param {Array} zones - Array of {id, name, type, polygon: [[x,y],...], deviceCount}
     */
    drawZoneOverlays: function (zones) {
        var me = this;
        if (!me.map) return;

        // Remove existing zone layer
        if (me._zoneLayer) {
            me.map.removeLayer(me._zoneLayer);
        }
        me._zoneLayer = new L.LayerGroup().addTo(me.map);

        for (var i = 0; i < zones.length; i++) {
            var z = zones[i];
            if (!z.polygon || !z.polygon.length) continue;

            // Convert [x, y] → [y, x] for Leaflet CRS.Simple (lat=y, lng=x)
            var latlngs = [];
            for (var j = 0; j < z.polygon.length; j++) {
                latlngs.push([z.polygon[j][1], z.polygon[j][0]]);
            }

            var isRestricted = z.type === 'restricted';
            var poly = L.polygon(latlngs, {
                color: isRestricted ? '#ef4444' : 'var(--indoor-accent, #0d9488)',
                fillColor: isRestricted ? 'rgba(239, 68, 68, 0.15)' : 'rgba(13, 148, 136, 0.10)',
                fillOpacity: 1,
                weight: 2,
                dashArray: isRestricted ? '6, 4' : '4, 4',
                interactive: true,
                className: isRestricted ? 'indoor-zone-restricted' : 'indoor-zone-general'
            });

            var label = '<b>' + Ext.String.htmlEncode(z.name) + '</b>';
            if (isRestricted) label += '<br/><span style="color:#ef4444">Restricted Zone</span>';
            if (z.deviceCount !== undefined) label += '<br/>' + z.deviceCount + ' device(s)';
            poly.bindTooltip(label, { sticky: true, className: 'indoor-zone-tooltip' });

            me._zoneLayer.addLayer(poly);
        }
    },

    /**
     * Initialize MapContainer with CRS.Simple for indoor pixel coordinates.
     * Floor plan is displayed as L.imageOverlay when plan URL is set.
     */
    initMap: function () {
        var me = this;
        var containerId = me.id + '-body';

        me.mapContainer = new MapContainer('indoor-positioning');
        me.mapContainer.init(0, 0, 2, containerId, {
            crs: L.CRS.Simple,
            minZoom: -2,
            maxZoom: 4,
            withControls: false
        });

        me.map = me.mapContainer.map || me.mapContainer;

        // Add floor plan overlay when URL is configured
        me.updateFloorPlanOverlay();

        // Set view to fit floor plan bounds (or default 0,0 area)
        if (me.map && me.floorPlanBounds) {
            me.map.fitBounds(me.floorPlanBounds);
        }
    },

    /**
     * Add or update floor plan image overlay.
     * Called on init and when floor plan URL changes via AdminPanel.
     *
     * @param {string} [url] - PNG/SVG URL of floor plan. If omitted, uses floorPlanUrl config.
     * @param {Array} [bounds] - [[y1,x1],[y2,x2]] for CRS.Simple (Leaflet uses [lat,lng] = [y,x])
     */
    updateFloorPlanOverlay: function (url, bounds) {
        var me = this;
        if (!me.map) return;

        if (me.floorPlanOverlay) {
            me.map.removeLayer(me.floorPlanOverlay);
            me.floorPlanOverlay = null;
        }

        url = url || me.floorPlanUrl;
        if (!url) return; // No floor plan configured yet

        bounds = bounds || me.floorPlanBounds || [[0, 0], [1000, 800]];

        // L.imageOverlay(url, bounds) — bounds as [[south, west], [north, east]]
        // For CRS.Simple: [0,0] top-left, [height, width] bottom-right
        try {
            me.floorPlanOverlay = L.imageOverlay(url, bounds).addTo(me.map);
        } catch (e) {
            Ext.log('Indoor: floor plan overlay failed (url may be invalid): ' + url);
        }
    },

    /**
     * Center map on a tag/device position (pixel coords).
     *
     * @param {number} x - X pixel
     * @param {number} y - Y pixel
     * @param {number} [zoom] - Optional zoom level
     */
    setMapCenter: function (x, y, zoom) {
        var me = this;
        if (!me.map) return;
        // CRS.Simple: lat = y, lng = x
        me.map.setView([y, x], zoom !== undefined ? zoom : me.map.getZoom());
    },

    /**
     * Fit map to given bounds [[y1,x1],[y2,x2]].
     *
     * @param {Array} bounds
     */
    setMapCenterBounds: function (bounds) {
        var me = this;
        if (!me.map || !bounds) return;
        me.map.fitBounds(bounds);
    },

    /**
     * Subscribe to device store and draw/update tag markers on the map.
     * v3.0: Uses marker cache (_markerMap) for incremental updates instead of
     * clearing all markers on every store change. Enables smooth animation
     * when WebSocket pushes individual position updates.
     */
    bindDeviceMarkers: function () {
        var me = this;
        var store = me.deviceStore;
        if (!store) return;

        me.deviceMarkerLayer = me.deviceMarkerLayer || (me.map ? new L.LayerGroup().addTo(me.map) : null);

        /**
         * Full redraw — used on initial store load and bulk datachanged events.
         */
        function fullRedraw() {
            if (!me.map || !me.deviceMarkerLayer) return;
            me.deviceMarkerLayer.clearLayers();
            me._markerMap = {};
            var records = store.getData().getRange();
            for (var i = 0; i < records.length; i++) {
                me._createOrUpdateMarker(records[i]);
            }
        }

        store.on('load', fullRedraw);
        store.on('datachanged', fullRedraw);
        if (store.getCount()) fullRedraw();
    },

    /**
     * Create or update a single device marker on the map.
     * If the marker already exists, smoothly animate it to the new position.
     *
     * @param {Ext.data.Model} record - Device record from the store
     */
    _createOrUpdateMarker: function (record) {
        var me = this;
        if (!me.map || !me.deviceMarkerLayer) return;

        var id = record.get('id');
        var x = record.get('x');
        var y = record.get('y');
        if (x === undefined || y === undefined || x === null || y === null) return;

        var type = record.get('type') || 'person';
        var status = record.get('status') || 'offline';
        var zone = record.get('zone') || '';
        var name = record.get('name') || id || '';

        // Determine marker color based on status + type + zone
        var color, cssClass;
        if (me._isDeviceInRestrictedZone(record)) {
            color = '#ef4444';  // Red for devices in restricted zones
            cssClass = 'indoor-marker-restricted';
        } else if (status === 'online') {
            color = type === 'asset' ? '#f59e0b' : '#059669';
            cssClass = 'indoor-marker-online';
        } else {
            color = '#94a3b8';
            cssClass = 'indoor-marker-offline';
        }

        var existing = me._markerMap[id];
        if (existing) {
            // Animate marker to new position
            var oldLatLng = existing.getLatLng();
            var newLatLng = L.latLng(y, x);

            // Only animate if position actually changed
            if (Math.abs(oldLatLng.lat - newLatLng.lat) > 0.01 ||
                Math.abs(oldLatLng.lng - newLatLng.lng) > 0.01) {
                me._animateMarker(existing, oldLatLng, newLatLng, 500);
            }

            // Update marker style
            existing.setStyle({
                fillColor: color,
                className: cssClass
            });

            // Update popup content
            existing.setPopupContent(me._buildPopupHtml(record));
        } else {
            // Create new marker
            var marker = L.circleMarker([y, x], {
                radius: 8,
                fillColor: color,
                color: '#fff',
                weight: 2,
                fillOpacity: 0.9,
                className: cssClass
            });
            marker.bindPopup(me._buildPopupHtml(record));
            me.deviceMarkerLayer.addLayer(marker);
            me._markerMap[id] = marker;
        }
    },

    /**
     * Animate a marker from one position to another using requestAnimationFrame.
     * Produces smooth movement over the given duration.
     *
     * @param {L.CircleMarker} marker
     * @param {L.LatLng} from
     * @param {L.LatLng} to
     * @param {number} duration - Animation duration in ms
     */
    _animateMarker: function (marker, from, to, duration) {
        var start = null;
        var dLat = to.lat - from.lat;
        var dLng = to.lng - from.lng;

        function step(timestamp) {
            if (!start) start = timestamp;
            var progress = Math.min((timestamp - start) / duration, 1);
            // Ease-out cubic for natural deceleration
            var ease = 1 - Math.pow(1 - progress, 3);
            var lat = from.lat + dLat * ease;
            var lng = from.lng + dLng * ease;
            marker.setLatLng([lat, lng]);
            if (progress < 1) {
                requestAnimationFrame(step);
            }
        }

        requestAnimationFrame(step);
    },

    /**
     * Check if a device record is in a restricted zone.
     * Used to apply red pulse styling.
     *
     * @param {Ext.data.Model} record
     * @returns {boolean}
     */
    _isDeviceInRestrictedZone: function (record) {
        var zone = record.get('zone') || '';
        // The zone field may contain the zone name. Check against known restricted zones.
        // If zone overlays have been loaded, we can cross-reference.
        if (!zone) return false;
        if (this._restrictedZoneNames && this._restrictedZoneNames[zone]) return true;
        return false;
    },

    /**
     * Build popup HTML for a device marker.
     * @param {Ext.data.Model} record
     * @returns {string}
     */
    _buildPopupHtml: function (record) {
        var lines = ['<b>' + Ext.String.htmlEncode(record.get('name') || record.get('id') || '') + '</b>'];
        if (record.get('zone')) lines.push(Ext.String.htmlEncode(record.get('zone')));
        if (record.get('battery') != null) lines.push('Battery: ' + record.get('battery') + '%');
        if (record.get('temperature') != null) lines.push('Temp: ' + record.get('temperature') + ' C');
        if (record.get('humidity') != null) lines.push('Humidity: ' + record.get('humidity') + '%');
        if (record.get('isMoving') != null) lines.push(record.get('isMoving') ? 'Moving' : 'Parked');
        if (record.get('confidence') != null) lines.push('Signal: ' + Math.round(record.get('confidence') * 100) + '%');
        if (record.get('lastUpdate')) {
            var d = typeof record.get('lastUpdate') === 'number' ? new Date(record.get('lastUpdate') * 1000) : new Date(record.get('lastUpdate'));
            if (!isNaN(d.getTime())) lines.push(Ext.util.Format.date(d, 'd.m.Y H:i:s'));
        }
        return lines.join('<br/>');
    },

    /**
     * Public method called by Module.js when WebSocket pushes a single position update.
     * Incrementally updates the marker for one device without full redraw.
     */
    refreshMarkers: function () {
        var me = this;
        var store = me.deviceStore;
        if (!store || !me.map || !me.deviceMarkerLayer) return;

        var records = store.getData().getRange();
        var seen = {};
        for (var i = 0; i < records.length; i++) {
            var id = records[i].get('id');
            seen[id] = true;
            me._createOrUpdateMarker(records[i]);
        }

        // Remove markers for devices no longer in store
        for (var deviceId in me._markerMap) {
            if (!seen[deviceId]) {
                me.deviceMarkerLayer.removeLayer(me._markerMap[deviceId]);
                delete me._markerMap[deviceId];
            }
        }
    },

    /**
     * Update the restricted zone name cache (called when zone data arrives).
     * @param {Array} zones - Zone array from engine API
     */
    updateRestrictedZones: function (zones) {
        var me = this;
        me._restrictedZoneNames = {};
        if (!zones) return;
        for (var i = 0; i < zones.length; i++) {
            if (zones[i].type === 'restricted') {
                me._restrictedZoneNames[zones[i].name] = true;
            }
        }
    },

    onDestroy: function () {
        var me = this;
        if (me._zoneRefreshTimer) {
            clearInterval(me._zoneRefreshTimer);
        }
        me.callParent(arguments);
    }
});
