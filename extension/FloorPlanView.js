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

    cls: 'map_canvas',
    bodyCls: 'map_canvas',
    layout: 'fit',

    // Default floor plan bounds (pixel coords for CRS.Simple)
    // Admin can override via calibration
    floorPlanBounds: [[0, 0], [1000, 800]],

    initComponent: function () {
        var me = this;

        me.dockedItems = [
            {
                xtype: 'indoor-devicegrid',
                dock: 'bottom',
                height: 200,
                split: true,
                mapPanel: me
            }
        ];

        me.listeners = {
            render: function () {
                me.initMap();
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
    }
});
