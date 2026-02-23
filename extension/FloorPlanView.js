/**
 * PILOT Extension — Indoor Positioning
 * Floor plan map view with Leaflet CRS.Simple and image overlay.
 * Displays real-time tag positions on indoor floor plans.
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
                        var b = f.bounds || (f.calibration && f.calibration.points && f.calibration.points.length >= 3) ?
                            [[0, 0], [1000, 800]] : me.floorPlanBounds;
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
     */
    bindDeviceMarkers: function () {
        var me = this;
        var store = me.deviceStore;
        if (!store) return;

        me.deviceMarkerLayer = me.deviceMarkerLayer || (me.map ? new L.LayerGroup().addTo(me.map) : null);
        function updateMarkers() {
            if (!me.map || !me.deviceMarkerLayer) return;
            me.deviceMarkerLayer.clearLayers();
            var records = store.getData().getRange();
            for (var i = 0; i < records.length; i++) {
                var r = records[i];
                var x = r.get('x');
                var y = r.get('y');
                if (x === undefined || y === undefined) continue;
                var type = r.get('type') || 'person';
                var status = r.get('status') || 'offline';
                var color = status === 'online' ? '#27ae60' : '#95a5a6';
                if (type === 'asset') color = '#f39c12';
                var name = r.get('name') || r.get('id') || '';
                var marker = L.circleMarker([y, x], {
                    radius: 8,
                    fillColor: color,
                    color: '#fff',
                    weight: 2,
                    fillOpacity: 0.9
                });
                var popupLines = ['<b>' + Ext.String.htmlEncode(name) + '</b>'];
                if (r.get('zone')) popupLines.push(Ext.String.htmlEncode(r.get('zone')));
                if (r.get('battery') != null) popupLines.push('🔋 ' + r.get('battery') + '%');
                if (r.get('temperature') != null) popupLines.push('🌡️ ' + r.get('temperature') + '°C');
                if (r.get('humidity') != null) popupLines.push('💧 ' + r.get('humidity') + '%');
                if (r.get('isMoving') != null) popupLines.push(r.get('isMoving') ? '🏃 Moving' : '🅿️ Parked');
                if (r.get('confidence') != null) popupLines.push('📡 ' + Math.round(r.get('confidence') * 100) + '% conf');
                if (r.get('lastUpdate')) {
                    var d = typeof r.get('lastUpdate') === 'number' ? new Date(r.get('lastUpdate') * 1000) : new Date(r.get('lastUpdate'));
                    if (!isNaN(d.getTime())) popupLines.push('🕐 ' + Ext.util.Format.date(d, 'd.m.Y H:i:s'));
                }
                marker.bindPopup(popupLines.join('<br/>'));
                me.deviceMarkerLayer.addLayer(marker);
            }
        }

        store.on('load', updateMarkers);
        store.on('datachanged', updateMarkers);
        if (store.getCount()) updateMarkers();
    }
});
