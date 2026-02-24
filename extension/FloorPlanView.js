/**
 * PILOT Extension -- Indoor Positioning v4.0
 * Central map view component using Leaflet.js for indoor positioning.
 *
 * Dual-engine rendering:
 *   1. Velavu Cloud   -- OpenStreetMap tiles with geo coordinates (lat/lng).
 *                        Floor plan overlaid via L.imageOverlay with imageCoords.
 *                        Wall geometry rendered as GeoJSON polylines.
 *   2. Channel Sounding -- CRS.Simple pixel-based map with floor plan image.
 *                          Devices have x/y pixel coordinates.
 *
 * Features:
 *   - Animated device marker movement (requestAnimationFrame, ease-out cubic)
 *   - Marker color coding by status, type, battery, and anchor role
 *   - Zone overlays with restricted/normal styling
 *   - Site boundary polygon
 *   - Anchor marker display (diamond shape, togglable)
 *   - Floor plan image rotation via CSS transform
 *   - Device selection with highlight and map centering
 *
 * @see Module.js      -- engine switching, data stores, WebSocket
 * @see DeviceGrid.js  -- docked device table
 * @see ZoneManager.js -- zone CRUD with polygon drawing
 */

Ext.define('Store.indoor-positioning.FloorPlanView', {
    extend: 'Ext.panel.Panel',
    xtype: 'indoor-floorplanview',

    cls: 'indoor-floor-plan map_canvas',
    bodyCls: 'map_canvas',
    layout: 'fit',

    /* ------------------------------------------------------------------ */
    /*  Config                                                            */
    /* ------------------------------------------------------------------ */

    config: {
        /** Active positioning engine: 'velavu' or 'channelSounding'. */
        engine: 'velavu',
        /** Currently selected Velavu site object. */
        currentSite: null,
        /** Currently selected floor object. */
        currentFloor: null
    },

    /** Default floor plan pixel bounds for CRS.Simple mode. */
    floorPlanBounds: [[0, 0], [1000, 800]],

    /** Engine base URL for Channel Sounding HTTP endpoints. */
    engineBaseUrl: '',

    /** Whether to display anchor markers on the map. */
    showAnchors: false,

    /* ------------------------------------------------------------------ */
    /*  Marker color constants                                            */
    /* ------------------------------------------------------------------ */

    COLOR_PERSON_ONLINE:  '#059669',
    COLOR_ASSET_ONLINE:   '#0d9488',
    COLOR_OFFLINE:        '#94a3b8',
    COLOR_LOW_BATTERY:    '#d97706',
    COLOR_ANCHOR:         '#6366f1',
    COLOR_ZONE_NORMAL:    '#3b82f6',
    COLOR_ZONE_RESTRICTED:'#ef4444',
    COLOR_SITE_BOUNDARY:  '#60a5fa',

    MARKER_RADIUS:         8,
    MARKER_RADIUS_SELECTED:12,
    ANCHOR_RADIUS:         5,

    /* ------------------------------------------------------------------ */
    /*  Lifecycle                                                         */
    /* ------------------------------------------------------------------ */

    initComponent: function () {
        var me = this;

        me._markerMap       = {};   // deviceId -> L.circleMarker
        me._anchorMarkers   = {};   // anchorId -> L.marker
        me._selectedDeviceId = null;
        me._selectedZoneId   = null;
        me._restrictedZoneNames = {};

        me._deviceGrid = Ext.create('Store.indoor-positioning.DeviceGrid', {
            dock: 'bottom',
            height: 200,
            split: true,
            mapPanel: me,
            store: me.deviceStore || null
        });

        me.dockedItems = [ me._deviceGrid ];

        me.listeners = {
            render: function () {
                me.initMap();
                me.bindDeviceMarkers();
                if (me.getEngine() === 'channelSounding') {
                    me.loadDefaultFloorFromEngine();
                    me.loadZoneOverlays();
                }
            },
            resize: function () {
                if (me.map && me.map.invalidateSize) {
                    me.map.invalidateSize();
                }
            }
        };

        me.callParent();
    },

    /* ================================================================== */
    /*                                                                    */
    /*  MAP INITIALIZATION                                                */
    /*                                                                    */
    /* ================================================================== */

    /**
     * Create the Leaflet map instance.
     * For Velavu engine: standard geo map with OpenStreetMap tiles.
     * For Channel Sounding: CRS.Simple pixel map (no tiles).
     */
    initMap: function () {
        var me = this;
        var containerId = me.body ? me.body.id : (me.id + '-body');
        var engine = me.getEngine();

        if (engine === 'channelSounding') {
            me._initSimpleMap(containerId);
        } else {
            me._initGeoMap(containerId);
        }

        // Create shared layer groups
        me.deviceMarkerLayer = new L.LayerGroup().addTo(me.map);
        me.anchorMarkerLayer = new L.LayerGroup().addTo(me.map);
        me._zoneLayer        = new L.LayerGroup().addTo(me.map);
        me._wallLayer        = new L.LayerGroup().addTo(me.map);
        me._boundaryLayer    = new L.LayerGroup().addTo(me.map);
    },

    /**
     * Initialize a geo-coordinate Leaflet map with OpenStreetMap tiles.
     * Used by the Velavu engine where devices report lat/lng.
     *
     * @param {string} containerId - DOM element ID for the map
     * @private
     */
    _initGeoMap: function (containerId) {
        var me = this;

        me.map = L.map(containerId, {
            center: [25.2048, 55.2708],  // Default: Dubai
            zoom: 16,
            zoomControl: true,
            attributionControl: false
        });

        me._tileLayer = L.tileLayer(
            'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
            { maxZoom: 22, maxNativeZoom: 19 }
        ).addTo(me.map);
    },

    /**
     * Initialize a CRS.Simple pixel-coordinate Leaflet map.
     * Used by the Channel Sounding engine where devices report x/y pixels.
     *
     * @param {string} containerId - DOM element ID for the map
     * @private
     */
    _initSimpleMap: function (containerId) {
        var me = this;

        // Attempt MapContainer integration if available (PILOT pattern)
        if (typeof MapContainer !== 'undefined') {
            me.mapContainer = new MapContainer('indoor-positioning');
            me.mapContainer.init(0, 0, 2, containerId, {
                crs: L.CRS.Simple,
                minZoom: -2,
                maxZoom: 4,
                withControls: false
            });
            me.map = me.mapContainer.map || me.mapContainer;
        } else {
            me.map = L.map(containerId, {
                crs: L.CRS.Simple,
                minZoom: -2,
                maxZoom: 4,
                zoomControl: true,
                attributionControl: false
            });
        }

        // Fit to default bounds
        if (me.floorPlanBounds) {
            me.map.fitBounds(me.floorPlanBounds);
        }
    },

    /* ================================================================== */
    /*                                                                    */
    /*  ENGINE SWITCHING                                                  */
    /*                                                                    */
    /* ================================================================== */

    /**
     * Switch the rendering engine. Tears down the current map and rebuilds
     * with the appropriate CRS and tile configuration.
     *
     * @param {string} engine - 'velavu' or 'channelSounding'
     */
    setEngine: function (engine) {
        var me = this;
        if (engine === me.getEngine() && me.map) return;

        me.config.engine = engine;

        // Tear down existing map if present
        if (me.map) {
            me._clearAllLayers();
            me.map.remove();
            me.map = null;
            me.mapContainer = null;
            me._tileLayer = null;
            me.floorPlanOverlay = null;
        }

        // Reset caches
        me._markerMap = {};
        me._anchorMarkers = {};
        me._selectedDeviceId = null;
        me._selectedZoneId = null;

        // Rebuild
        if (me.rendered) {
            me.initMap();
            me.bindDeviceMarkers();
        }
    },

    /**
     * Return the Leaflet map instance.
     *
     * @returns {L.Map|null}
     */
    getMap: function () {
        return this.map || null;
    },

    /* ================================================================== */
    /*                                                                    */
    /*  SITE & FLOOR LOADING                                              */
    /*                                                                    */
    /* ================================================================== */

    /**
     * Load a Velavu site: show boundary, set floors, fit map to boundary.
     *
     * @param {Object} site - Site object with id, name, boundary, floors, latitude, longitude
     */
    setSite: function (site) {
        var me = this;
        me.setCurrentSite(site);

        if (!site || !me.map) return;

        // Show site boundary if available
        if (site.boundary) {
            me.showSiteBoundary(site.boundary);
        }

        // Center map on site coordinates
        if (site.latitude && site.longitude && me.getEngine() === 'velavu') {
            me.map.setView([site.latitude, site.longitude], 17);
        }
    },

    /**
     * Load a floor: overlay floor plan image, draw walls, load zones.
     *
     * @param {Object} floor - Floor object. Shape depends on engine:
     *   Velavu:  { id, imageUrl, imageCoords, imageOpacity, imageRotation, walls, geofences }
     *   CS:      { id, plan_url, bounds, zones }
     */
    setFloor: function (floor) {
        var me = this;
        me.setCurrentFloor(floor);

        if (!floor || !me.map) return;

        me.loadFloorPlan(floor);

        // Draw wall geometry (Velavu only)
        if (floor.walls) {
            me.drawWalls(floor.walls);
        } else {
            me._clearLayer(me._wallLayer);
        }

        // Load zones if embedded in floor data
        if (floor.geofences) {
            me.loadZones(floor.geofences);
        } else if (floor.zones) {
            me.loadZones(floor.zones);
        }
    },

    /* ================================================================== */
    /*                                                                    */
    /*  FLOOR PLAN OVERLAY                                                */
    /*                                                                    */
    /* ================================================================== */

    /**
     * Overlay a floor plan image on the map.
     *
     * For Velavu engine:
     *   floor.imageUrl     - URL of the floor plan image
     *   floor.imageCoords  - [[south, west], [north, east]] lat/lng corners
     *   floor.imageOpacity - 0..1 transparency
     *   floor.imageRotation- degrees clockwise rotation
     *
     * For Channel Sounding engine:
     *   floor.plan_url - URL of the floor plan image
     *   floor.bounds   - [[0,0], [width, height]] pixel bounds
     *
     * @param {Object} floor - Floor data object
     */
    loadFloorPlan: function (floor) {
        var me = this;
        if (!me.map) return;

        // Remove existing overlay
        if (me.floorPlanOverlay) {
            me.map.removeLayer(me.floorPlanOverlay);
            me.floorPlanOverlay = null;
        }

        var engine = me.getEngine();
        var url, bounds, opacity, rotation;

        if (engine === 'velavu') {
            url = floor.imageUrl;
            bounds = floor.imageCoords;
            opacity = floor.imageOpacity !== undefined ? floor.imageOpacity : 0.8;
            rotation = floor.imageRotation || 0;
        } else {
            url = floor.plan_url;
            var b = floor.bounds || me.floorPlanBounds;
            // Ensure bounds are in [[lat_min, lng_min], [lat_max, lng_max]] format
            // CRS.Simple: lat = y, lng = x
            if (b && b.length === 2) {
                bounds = [[b[0][1] || 0, b[0][0] || 0], [b[1][1] || 800, b[1][0] || 1000]];
            }
            opacity = 1;
            rotation = 0;
        }

        if (!url) return;
        bounds = bounds || me.floorPlanBounds;

        try {
            me.floorPlanOverlay = L.imageOverlay(url, bounds, {
                opacity: opacity,
                interactive: false
            }).addTo(me.map);

            // Apply CSS rotation if specified
            if (rotation && me.floorPlanOverlay.getElement) {
                var el = me.floorPlanOverlay.getElement();
                if (el) {
                    el.style.transformOrigin = 'center center';
                    el.style.transform = 'rotate(' + rotation + 'deg)';
                }
            }

            me.map.fitBounds(bounds);
        } catch (e) {
            console.warn('[Indoor v4] Floor plan overlay failed:', url, e);
        }
    },

    /**
     * Add or update floor plan image overlay (v3 compat method).
     * Called by AdminPanel when the user changes the floor plan URL.
     *
     * @param {string} [url]    - PNG/SVG URL of floor plan
     * @param {Array}  [bounds] - [[y1,x1],[y2,x2]] for CRS.Simple
     */
    updateFloorPlanOverlay: function (url, bounds) {
        var me = this;
        if (!me.map) return;

        if (me.floorPlanOverlay) {
            me.map.removeLayer(me.floorPlanOverlay);
            me.floorPlanOverlay = null;
        }

        url = url || me.floorPlanUrl;
        if (!url) return;

        bounds = bounds || me.floorPlanBounds || [[0, 0], [1000, 800]];

        try {
            me.floorPlanOverlay = L.imageOverlay(url, bounds).addTo(me.map);
        } catch (e) {
            console.warn('[Indoor v4] Floor plan overlay failed:', url, e);
        }
    },

    /**
     * Load floor plan from Channel Sounding engine API (v3 compat).
     * Fetches /api/indoor/floors and applies the first floor.
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
                        if (url) {
                            me.updateFloorPlanOverlay(url, b);
                            if (me.map && me.map.fitBounds) {
                                me.map.fitBounds(b);
                            }
                        }
                    }
                } catch (e) {
                    console.warn('[Indoor v4] Floor load error:', e);
                }
            }
        });
    },

    /* ================================================================== */
    /*                                                                    */
    /*  WALL GEOMETRY                                                     */
    /*                                                                    */
    /* ================================================================== */

    /**
     * Render wall geometry from Velavu floor data as polylines.
     * Walls are provided as GeoJSON LineString or MultiLineString features.
     *
     * @param {Object|Array} walls - GeoJSON FeatureCollection or array of coordinate arrays
     */
    drawWalls: function (walls) {
        var me = this;
        if (!me.map || !me._wallLayer) return;

        me._clearLayer(me._wallLayer);

        var wallStyle = {
            color: '#374151',
            weight: 2,
            opacity: 0.7,
            dashArray: '6, 3',
            interactive: false
        };

        // Handle GeoJSON FeatureCollection
        if (walls && walls.type === 'FeatureCollection') {
            try {
                L.geoJSON(walls, { style: wallStyle }).addTo(me._wallLayer);
            } catch (e) {
                console.warn('[Indoor v4] Wall GeoJSON render error:', e);
            }
            return;
        }

        // Handle array of coordinate arrays (simple polylines)
        if (Array.isArray(walls)) {
            for (var i = 0; i < walls.length; i++) {
                var coords = walls[i];
                if (!coords || !coords.length) continue;

                // If it is a GeoJSON Feature, extract geometry
                if (coords.type === 'Feature' && coords.geometry) {
                    try {
                        L.geoJSON(coords, { style: wallStyle }).addTo(me._wallLayer);
                    } catch (e) { /* skip malformed */ }
                    continue;
                }

                // Plain coordinate array: [[lat,lng], [lat,lng], ...]
                if (Array.isArray(coords[0])) {
                    L.polyline(coords, wallStyle).addTo(me._wallLayer);
                }
            }
        }
    },

    /* ================================================================== */
    /*                                                                    */
    /*  DEVICE MARKERS                                                    */
    /*                                                                    */
    /* ================================================================== */

    /**
     * Bind to the device store for automatic marker drawing.
     * Uses marker cache (_markerMap) for incremental updates.
     */
    bindDeviceMarkers: function () {
        var me = this;
        var store = me.deviceStore;
        if (!store) return;

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
     * Update all device markers from the current store contents.
     * Called by Module.js after WebSocket position updates.
     *
     * @param {Array} [devices] - Optional array of device data objects.
     *   If omitted, reads from me.deviceStore.
     */
    refreshMarkers: function (devices) {
        var me = this;
        var store = me.deviceStore;
        if (!me.map || !me.deviceMarkerLayer) return;

        var records, i, id;

        if (devices && Array.isArray(devices)) {
            // Direct data array (not store records)
            var seen = {};
            for (i = 0; i < devices.length; i++) {
                var d = devices[i];
                id = d.id;
                seen[id] = true;
                me._createOrUpdateMarkerFromData(d);
            }
            // Remove stale
            for (var devId in me._markerMap) {
                if (!seen[devId]) {
                    me.deviceMarkerLayer.removeLayer(me._markerMap[devId]);
                    delete me._markerMap[devId];
                }
            }
            return;
        }

        // Store-based refresh
        if (!store) return;
        records = store.getData().getRange();
        var seenIds = {};

        for (i = 0; i < records.length; i++) {
            id = records[i].get('id');
            seenIds[id] = true;
            me._createOrUpdateMarker(records[i]);
        }

        // Remove markers for devices no longer in store
        for (var deviceId in me._markerMap) {
            if (!seenIds[deviceId]) {
                me.deviceMarkerLayer.removeLayer(me._markerMap[deviceId]);
                delete me._markerMap[deviceId];
            }
        }
    },

    /**
     * Create or update a single device marker from a store record.
     * Existing markers animate to their new position.
     *
     * @param {Ext.data.Model} record
     * @private
     */
    _createOrUpdateMarker: function (record) {
        var me = this;
        if (!me.map || !me.deviceMarkerLayer) return;

        var id   = record.get('id');
        var lat  = record.get('lat');
        var lng  = record.get('lng');
        var x    = record.get('x');
        var y    = record.get('y');
        var engine = me.getEngine();

        // Determine coordinates based on engine
        var mapLat, mapLng;
        if (engine === 'velavu') {
            mapLat = lat;
            mapLng = lng;
            // Fall back to x/y if lat/lng not available
            if ((mapLat === null || mapLat === undefined) && y !== null && y !== undefined) {
                mapLat = y;
            }
            if ((mapLng === null || mapLng === undefined) && x !== null && x !== undefined) {
                mapLng = x;
            }
        } else {
            // CRS.Simple: lat = y, lng = x
            mapLat = (y !== null && y !== undefined) ? y : lat;
            mapLng = (x !== null && x !== undefined) ? x : lng;
        }

        if (mapLat === null || mapLat === undefined ||
            mapLng === null || mapLng === undefined) return;

        var type    = record.get('type') || record.get('category') || 'device';
        var status  = record.get('status') || (record.get('online') ? 'online' : 'offline');
        var battery = record.get('battery');
        var name    = record.get('name') || record.get('assetName') || id || '';
        var isSelected = (id === me._selectedDeviceId);

        var color = me._resolveMarkerColor(type, status, battery);
        var radius = isSelected ? me.MARKER_RADIUS_SELECTED : me.MARKER_RADIUS;

        var existing = me._markerMap[id];
        if (existing) {
            // Animate to new position
            var oldLatLng = existing.getLatLng();
            var newLatLng = L.latLng(mapLat, mapLng);

            if (Math.abs(oldLatLng.lat - newLatLng.lat) > 0.001 ||
                Math.abs(oldLatLng.lng - newLatLng.lng) > 0.001) {
                me._animateMarker(existing, oldLatLng, newLatLng, 500);
            }

            existing.setStyle({
                fillColor: color,
                radius: radius,
                weight: isSelected ? 3 : 2
            });
            existing.setPopupContent(me._buildPopupHtml(record));
            existing.setTooltipContent(name);
        } else {
            var marker = L.circleMarker([mapLat, mapLng], {
                radius: radius,
                fillColor: color,
                color: isSelected ? '#1d4ed8' : '#ffffff',
                weight: isSelected ? 3 : 2,
                fillOpacity: 0.9
            });
            marker.bindPopup(me._buildPopupHtml(record));
            marker.bindTooltip(name, {
                permanent: false,
                direction: 'top',
                offset: [0, -10]
            });
            marker._deviceId = id;

            // Click to select
            marker.on('click', function () {
                me.selectDevice(id);
            });

            me.deviceMarkerLayer.addLayer(marker);
            me._markerMap[id] = marker;
        }
    },

    /**
     * Create or update a marker from a plain data object (non-store).
     *
     * @param {Object} d - Device data with id, x, y, lat, lng, etc.
     * @private
     */
    _createOrUpdateMarkerFromData: function (d) {
        var me = this;
        if (!me.map || !me.deviceMarkerLayer) return;

        var id = d.id;
        var engine = me.getEngine();
        var mapLat, mapLng;

        if (engine === 'velavu') {
            mapLat = d.lat !== undefined ? d.lat : d.y;
            mapLng = d.lng !== undefined ? d.lng : d.x;
        } else {
            mapLat = d.y !== undefined ? d.y : d.lat;
            mapLng = d.x !== undefined ? d.x : d.lng;
        }

        if (mapLat === null || mapLat === undefined ||
            mapLng === null || mapLng === undefined) return;

        var type    = d.type || d.category || 'device';
        var status  = d.status || (d.online ? 'online' : 'offline');
        var battery = d.battery;
        var name    = d.name || d.assetName || id || '';
        var color   = me._resolveMarkerColor(type, status, battery);
        var isSelected = (id === me._selectedDeviceId);
        var radius  = isSelected ? me.MARKER_RADIUS_SELECTED : me.MARKER_RADIUS;

        var existing = me._markerMap[id];
        if (existing) {
            var oldLatLng = existing.getLatLng();
            var newLatLng = L.latLng(mapLat, mapLng);
            if (Math.abs(oldLatLng.lat - newLatLng.lat) > 0.001 ||
                Math.abs(oldLatLng.lng - newLatLng.lng) > 0.001) {
                me._animateMarker(existing, oldLatLng, newLatLng, 500);
            }
            existing.setStyle({ fillColor: color, radius: radius });
        } else {
            var marker = L.circleMarker([mapLat, mapLng], {
                radius: radius,
                fillColor: color,
                color: '#ffffff',
                weight: 2,
                fillOpacity: 0.9
            });
            marker.bindTooltip(name, {
                permanent: false,
                direction: 'top',
                offset: [0, -10]
            });
            marker._deviceId = id;
            marker.on('click', function () {
                me.selectDevice(id);
            });
            me.deviceMarkerLayer.addLayer(marker);
            me._markerMap[id] = marker;
        }
    },

    /**
     * Determine marker fill color based on device type, status, and battery.
     *
     * @param {string} type    - 'person', 'asset', 'anchor', etc.
     * @param {string} status  - 'online' or 'offline'
     * @param {number} battery - Battery percentage (0-100)
     * @returns {string} Hex color
     * @private
     */
    _resolveMarkerColor: function (type, status, battery) {
        var me = this;

        if (type === 'anchor') {
            return me.COLOR_ANCHOR;
        }
        if (status !== 'online') {
            return me.COLOR_OFFLINE;
        }
        if (battery !== null && battery !== undefined && battery < 15) {
            return me.COLOR_LOW_BATTERY;
        }
        if (type === 'asset') {
            return me.COLOR_ASSET_ONLINE;
        }
        return me.COLOR_PERSON_ONLINE;
    },

    /**
     * Animate a marker from one position to another using requestAnimationFrame.
     * Uses ease-out cubic for natural deceleration.
     *
     * @param {L.CircleMarker} marker
     * @param {L.LatLng} from
     * @param {L.LatLng} to
     * @param {number} duration - ms
     * @private
     */
    _animateMarker: function (marker, from, to, duration) {
        var start = null;
        var dLat = to.lat - from.lat;
        var dLng = to.lng - from.lng;

        function step(timestamp) {
            if (!start) start = timestamp;
            var progress = Math.min((timestamp - start) / duration, 1);
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
     * Build popup HTML content for a device marker.
     *
     * @param {Ext.data.Model} record
     * @returns {string}
     * @private
     */
    _buildPopupHtml: function (record) {
        var lines = [];
        var name = record.get('name') || record.get('assetName') || record.get('id') || '';
        lines.push('<b>' + Ext.String.htmlEncode(name) + '</b>');

        var status = record.get('status') || (record.get('online') ? 'online' : 'offline');
        var statusCls = status === 'online' ? 'indoor-online' : 'indoor-offline';
        lines.push('Status: <span class="' + statusCls + '">' + status + '</span>');

        if (record.get('battery') != null) {
            var batt = parseInt(record.get('battery'), 10);
            var battCls = batt > 50 ? 'indoor-online' : (batt > 15 ? '' : 'indoor-offline');
            lines.push('Battery: <span class="' + battCls + '">' + batt + '%</span>');
        }

        if (record.get('zone'))        lines.push('Zone: ' + Ext.String.htmlEncode(record.get('zone')));
        if (record.get('temperature') != null) lines.push('Temp: ' + record.get('temperature') + '&deg;C');
        if (record.get('humidity') != null)    lines.push('Humidity: ' + record.get('humidity') + '%');
        if (record.get('isMoving') != null)    lines.push(record.get('isMoving') ? 'Moving' : 'Stationary');

        if (record.get('lastUpdate')) {
            var d;
            var raw = record.get('lastUpdate');
            if (typeof raw === 'number') {
                d = new Date(raw > 1e12 ? raw : raw * 1000);
            } else {
                d = new Date(raw);
            }
            if (!isNaN(d.getTime())) {
                lines.push('Updated: ' + Ext.util.Format.date(d, 'd.m.Y H:i:s'));
            }
        }

        return '<div class="indoor-marker-popup">' + lines.join('<br/>') + '</div>';
    },

    /* ================================================================== */
    /*                                                                    */
    /*  ANCHOR MARKERS                                                    */
    /*                                                                    */
    /* ================================================================== */

    /**
     * Render anchor positions as diamond-shaped markers.
     * Only displayed when showAnchors config is true.
     *
     * @param {Array} anchors - Array of { id, x, y, lat, lng, rssi, installQuality, battery }
     */
    showAnchorMarkers: function (anchors) {
        var me = this;
        if (!me.map || !me.anchorMarkerLayer) return;

        me.anchorMarkerLayer.clearLayers();
        me._anchorMarkers = {};

        if (!me.showAnchors || !anchors || !anchors.length) return;

        var engine = me.getEngine();

        for (var i = 0; i < anchors.length; i++) {
            var a = anchors[i];
            var aLat, aLng;

            if (engine === 'velavu') {
                aLat = a.lat !== undefined ? a.lat : a.y;
                aLng = a.lng !== undefined ? a.lng : a.x;
            } else {
                aLat = a.y !== undefined ? a.y : a.lat;
                aLng = a.x !== undefined ? a.x : a.lng;
            }

            if (aLat === null || aLat === undefined ||
                aLng === null || aLng === undefined) continue;

            // Diamond marker using SVG icon
            var icon = L.divIcon({
                className: 'indoor-anchor-icon',
                html: '<div style="' +
                    'width:12px;height:12px;' +
                    'background:' + me.COLOR_ANCHOR + ';' +
                    'transform:rotate(45deg);' +
                    'border:2px solid #fff;' +
                    'box-shadow:0 1px 3px rgba(0,0,0,0.3);' +
                    '"></div>',
                iconSize: [12, 12],
                iconAnchor: [6, 6]
            });

            var anchorMarker = L.marker([aLat, aLng], { icon: icon });

            // Build anchor popup
            var popupLines = ['<b>Anchor: ' + Ext.String.htmlEncode(a.id || '') + '</b>'];
            if (a.rssi !== undefined)           popupLines.push('RSSI: ' + a.rssi + ' dBm');
            if (a.installQuality !== undefined)  popupLines.push('Quality: ' + a.installQuality);
            if (a.battery !== undefined)         popupLines.push('Battery: ' + a.battery + '%');
            anchorMarker.bindPopup(popupLines.join('<br/>'));

            me.anchorMarkerLayer.addLayer(anchorMarker);
            me._anchorMarkers[a.id] = anchorMarker;
        }
    },

    /* ================================================================== */
    /*                                                                    */
    /*  ZONE OVERLAYS                                                     */
    /*                                                                    */
    /* ================================================================== */

    /**
     * Render zone/geofence boundaries on the map.
     *
     * For Velavu: zones are GeoJSON Polygon features from /geofences.
     * For Channel Sounding: zones have polygon arrays of [x,y] points.
     *
     * @param {Array} zones - Array of zone objects
     */
    loadZones: function (zones) {
        var me = this;
        if (!me.map || !me._zoneLayer) return;

        me._clearLayer(me._zoneLayer);
        me._restrictedZoneNames = {};
        me._zonePolygons = {};

        if (!zones || !zones.length) return;

        var engine = me.getEngine();

        for (var i = 0; i < zones.length; i++) {
            var z = zones[i];
            var isRestricted = (z.type === 'restricted');

            if (isRestricted) {
                me._restrictedZoneNames[z.name || z.id] = true;
            }

            var latlngs = me._resolveZoneCoords(z, engine);
            if (!latlngs || !latlngs.length) continue;

            var color     = isRestricted ? me.COLOR_ZONE_RESTRICTED : me.COLOR_ZONE_NORMAL;
            var fillColor = isRestricted ? 'rgba(239, 68, 68, 0.12)' : 'rgba(59, 130, 246, 0.08)';

            var poly = L.polygon(latlngs, {
                color: color,
                fillColor: fillColor,
                fillOpacity: 1,
                weight: 2,
                dashArray: isRestricted ? '6, 4' : null,
                interactive: true
            });

            // Zone tooltip at centroid
            var label = '<b>' + Ext.String.htmlEncode(z.name || z.id || '') + '</b>';
            if (isRestricted) {
                label += '<br/><span style="color:' + me.COLOR_ZONE_RESTRICTED + '">Restricted Zone</span>';
            }
            if (z.deviceCount !== undefined) {
                label += '<br/>' + z.deviceCount + ' device(s)';
            }
            poly.bindTooltip(label, { sticky: true, className: 'indoor-zone-tooltip' });

            // Store zone ID on polygon for selection
            poly._zoneId = z.id;
            poly.on('click', function () {
                me.selectZone(this._zoneId);
            });

            me._zoneLayer.addLayer(poly);
            me._zonePolygons[z.id] = poly;
        }
    },

    /**
     * Resolve zone coordinates to Leaflet [lat, lng] arrays.
     *
     * @param {Object} zone   - Zone object
     * @param {string} engine - 'velavu' or 'channelSounding'
     * @returns {Array} Array of [lat, lng] pairs
     * @private
     */
    _resolveZoneCoords: function (zone, engine) {
        // GeoJSON geometry
        if (zone.geometry && zone.geometry.type === 'Polygon' && zone.geometry.coordinates) {
            var ring = zone.geometry.coordinates[0]; // exterior ring
            var result = [];
            for (var g = 0; g < ring.length; g++) {
                // GeoJSON is [lng, lat], Leaflet wants [lat, lng]
                result.push([ring[g][1], ring[g][0]]);
            }
            return result;
        }

        // Plain polygon array
        var pts = zone.polygon || zone.points || zone.coordinates;
        if (!pts || !pts.length) return null;

        var coords = [];
        for (var j = 0; j < pts.length; j++) {
            var p = pts[j];
            if (Array.isArray(p)) {
                if (engine === 'channelSounding') {
                    // [x, y] -> [lat=y, lng=x]
                    coords.push([p[1], p[0]]);
                } else {
                    // Assume [lat, lng] for Velavu
                    coords.push([p[0], p[1]]);
                }
            } else if (p && typeof p === 'object') {
                if (engine === 'channelSounding') {
                    coords.push([p.y || 0, p.x || 0]);
                } else {
                    coords.push([p.lat || p.y || 0, p.lng || p.x || 0]);
                }
            }
        }
        return coords;
    },

    /**
     * Load zone overlays from Channel Sounding engine API (v3 compat).
     * Refreshes every 60 seconds.
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
                        me.loadZones(zones);
                    } catch (e) {
                        console.warn('[Indoor v4] Zone overlay parse error:', e);
                    }
                }
            });
        }

        fetchAndDraw();
        me._zoneRefreshTimer = setInterval(fetchAndDraw, 60000);
    },

    /* ================================================================== */
    /*                                                                    */
    /*  SITE BOUNDARY                                                     */
    /*                                                                    */
    /* ================================================================== */

    /**
     * Render a site boundary polygon on the map.
     * Light blue dashed outline, no fill.
     *
     * @param {Object|Array} boundary - GeoJSON Polygon or array of [lat,lng] coords
     */
    showSiteBoundary: function (boundary) {
        var me = this;
        if (!me.map || !me._boundaryLayer) return;

        me._clearLayer(me._boundaryLayer);

        if (!boundary) return;

        var latlngs;

        // GeoJSON Polygon
        if (boundary.type === 'Polygon' && boundary.coordinates) {
            var ring = boundary.coordinates[0];
            latlngs = [];
            for (var i = 0; i < ring.length; i++) {
                latlngs.push([ring[i][1], ring[i][0]]);
            }
        } else if (Array.isArray(boundary)) {
            latlngs = boundary;
        } else {
            return;
        }

        if (!latlngs.length) return;

        var poly = L.polygon(latlngs, {
            color: me.COLOR_SITE_BOUNDARY,
            weight: 2,
            dashArray: '8, 4',
            fill: false,
            interactive: false
        });

        me._boundaryLayer.addLayer(poly);

        // Fit map to boundary
        if (me.getEngine() === 'velavu') {
            me.map.fitBounds(poly.getBounds(), { padding: [20, 20] });
        }
    },

    /* ================================================================== */
    /*                                                                    */
    /*  SELECTION                                                         */
    /*                                                                    */
    /* ================================================================== */

    /**
     * Select and highlight a device marker on the map.
     * Centers the map on the device position.
     *
     * @param {string} deviceId
     */
    selectDevice: function (deviceId) {
        var me = this;

        // Deselect previous
        if (me._selectedDeviceId && me._markerMap[me._selectedDeviceId]) {
            var prev = me._markerMap[me._selectedDeviceId];
            prev.setStyle({
                radius: me.MARKER_RADIUS,
                color: '#ffffff',
                weight: 2
            });
        }

        me._selectedDeviceId = deviceId;

        var marker = me._markerMap[deviceId];
        if (!marker) return;

        // Highlight selected marker
        marker.setStyle({
            radius: me.MARKER_RADIUS_SELECTED,
            color: '#1d4ed8',
            weight: 3
        });
        marker.bringToFront();

        // Center map on device
        var latlng = marker.getLatLng();
        if (latlng && me.map) {
            me.map.setView(latlng, me.map.getZoom(), { animate: true });
        }

        // Open popup
        marker.openPopup();

        // Fire event for other components
        me.fireEvent('deviceselected', deviceId);
    },

    /**
     * Select and highlight a zone polygon.
     *
     * @param {string} zoneId
     */
    selectZone: function (zoneId) {
        var me = this;

        // Deselect previous
        if (me._selectedZoneId && me._zonePolygons && me._zonePolygons[me._selectedZoneId]) {
            me._zonePolygons[me._selectedZoneId].setStyle({ weight: 2 });
        }

        me._selectedZoneId = zoneId;

        if (!me._zonePolygons || !me._zonePolygons[zoneId]) return;

        var poly = me._zonePolygons[zoneId];
        poly.setStyle({ weight: 4 });
        poly.bringToFront();

        // Fit map to zone bounds
        if (me.map) {
            me.map.fitBounds(poly.getBounds(), { padding: [30, 30] });
        }

        me.fireEvent('zoneselected', zoneId);
    },

    /* ================================================================== */
    /*                                                                    */
    /*  PUBLIC NAVIGATION METHODS                                         */
    /*                                                                    */
    /* ================================================================== */

    /**
     * Center map on a specific coordinate.
     *
     * For Velavu:          centerOn(lat, lng, zoom)
     * For Channel Sounding: centerOn(y, x, zoom) -- CRS.Simple lat=y, lng=x
     *
     * @param {number} lat  - Latitude or Y pixel
     * @param {number} lng  - Longitude or X pixel
     * @param {number} [zoom] - Optional zoom level
     */
    centerOn: function (lat, lng, zoom) {
        var me = this;
        if (!me.map) return;
        me.map.setView([lat, lng], zoom !== undefined ? zoom : me.map.getZoom(), {
            animate: true
        });
    },

    /**
     * Center map on a position (v3 compat -- CRS.Simple x,y coords).
     *
     * @param {number} x - X pixel
     * @param {number} y - Y pixel
     * @param {number} [zoom]
     */
    setMapCenter: function (x, y, zoom) {
        var me = this;
        if (!me.map) return;
        // CRS.Simple: lat = y, lng = x
        me.map.setView([y, x], zoom !== undefined ? zoom : me.map.getZoom());
    },

    /**
     * Fit map to given bounds.
     *
     * @param {Array} bounds - [[south, west], [north, east]]
     */
    setMapCenterBounds: function (bounds) {
        var me = this;
        if (!me.map || !bounds) return;
        me.map.fitBounds(bounds);
    },

    /* ================================================================== */
    /*                                                                    */
    /*  RESTRICTED ZONE TRACKING                                          */
    /*                                                                    */
    /* ================================================================== */

    /**
     * Update the restricted zone name cache.
     * Called by Module.js when zone data arrives.
     *
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

    /**
     * Check if a device record is in a restricted zone.
     *
     * @param {Ext.data.Model} record
     * @returns {boolean}
     */
    _isDeviceInRestrictedZone: function (record) {
        var zone = record.get('zone') || '';
        if (!zone) return false;
        return !!(this._restrictedZoneNames && this._restrictedZoneNames[zone]);
    },

    /* ================================================================== */
    /*                                                                    */
    /*  LAYER HELPERS                                                     */
    /*                                                                    */
    /* ================================================================== */

    /**
     * Clear all layers from a Leaflet LayerGroup.
     *
     * @param {L.LayerGroup} layer
     * @private
     */
    _clearLayer: function (layer) {
        if (layer && layer.clearLayers) {
            layer.clearLayers();
        }
    },

    /**
     * Clear all overlay layers (zones, walls, boundary, anchors, devices).
     * Called before tearing down the map on engine switch.
     *
     * @private
     */
    _clearAllLayers: function () {
        var me = this;
        me._clearLayer(me.deviceMarkerLayer);
        me._clearLayer(me.anchorMarkerLayer);
        me._clearLayer(me._zoneLayer);
        me._clearLayer(me._wallLayer);
        me._clearLayer(me._boundaryLayer);

        if (me.floorPlanOverlay && me.map) {
            me.map.removeLayer(me.floorPlanOverlay);
            me.floorPlanOverlay = null;
        }
    },

    /* ================================================================== */
    /*                                                                    */
    /*  CLEANUP                                                           */
    /*                                                                    */
    /* ================================================================== */

    onDestroy: function () {
        var me = this;

        if (me._zoneRefreshTimer) {
            clearInterval(me._zoneRefreshTimer);
            me._zoneRefreshTimer = null;
        }

        if (me.map) {
            me._clearAllLayers();
            me.map.remove();
            me.map = null;
        }

        me._markerMap = {};
        me._anchorMarkers = {};
        me._zonePolygons = {};

        me.callParent(arguments);
    }
});
