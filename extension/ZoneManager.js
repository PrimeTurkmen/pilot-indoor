/**
 * PILOT Extension -- Indoor Positioning v4.0
 * Modal window for managing geofences/zones.
 *
 * Dual-engine zone sources:
 *   Velavu:           /api/velavu/geofences (GeoJSON boundaries)
 *   Channel Sounding: /api/indoor/zones     (polygon arrays)
 *
 * Features:
 *   - Grid of zones: Name, Type (normal/restricted), Floor, Device Count, Actions
 *   - Draw new zone: polygon tool on Leaflet map
 *   - Edit zone: click row to highlight on map, rename via prompt
 *   - Zone type selector: Normal / Restricted
 *   - Alert rules: enter_alert, exit_alert checkboxes
 *   - Save/delete via API
 *   - Close button returns to normal map mode
 *
 * @see Module.js -- opens this window from toolbar
 */

Ext.define('Store.indoor-positioning.ZoneManager', {
    extend: 'Ext.window.Window',
    xtype: 'indoor-zonemanager',

    cls: 'indoor-zonemanager',
    title: (typeof l === 'function') ? l('Zone Manager') : 'Zone Manager',
    iconCls: 'fa fa-draw-polygon',
    width: 560,
    height: 520,
    layout: 'fit',
    modal: true,
    bodyPadding: 0,
    closeAction: 'hide',

    /* ------------------------------------------------------------------ */
    /*  Config                                                            */
    /* ------------------------------------------------------------------ */

    config: {
        /** FloorPlanView reference for map drawing */
        mapPanel: null,
        /** API base URL for zone CRUD */
        engineBaseUrl: '',
        /** Current engine: 'velavu' or 'channelSounding' */
        engine: 'velavu'
    },

    /* ------------------------------------------------------------------ */
    /*  Init                                                              */
    /* ------------------------------------------------------------------ */

    initComponent: function () {
        var me = this;

        me.items = [
            {
                xtype: 'panel',
                layout: { type: 'vbox', align: 'stretch' },
                items: [
                    /* -- Toolbar ---------------------------------------- */
                    {
                        xtype: 'toolbar',
                        items: [
                            {
                                text: (typeof l === 'function') ? l('Draw Zone') : 'Draw Zone',
                                iconCls: 'fa fa-draw-polygon',
                                itemId: 'btnDrawZone',
                                handler: me.onDrawZone,
                                scope: me
                            },
                            {
                                text: (typeof l === 'function') ? l('Edit') : 'Edit',
                                iconCls: 'fa fa-edit',
                                itemId: 'btnEdit',
                                disabled: true,
                                handler: me.onEditZone,
                                scope: me
                            },
                            {
                                text: (typeof l === 'function') ? l('Delete') : 'Delete',
                                iconCls: 'fa fa-trash',
                                itemId: 'btnDelete',
                                disabled: true,
                                handler: me.onDeleteZone,
                                scope: me
                            },
                            '->',
                            {
                                text: (typeof l === 'function') ? l('Refresh') : 'Refresh',
                                iconCls: 'fa fa-rotate',
                                handler: me.loadZones,
                                scope: me
                            }
                        ]
                    },
                    /* -- Zone Grid -------------------------------------- */
                    {
                        xtype: 'grid',
                        itemId: 'zoneGrid',
                        flex: 1,
                        store: me._createZoneStore(),
                        columns: [
                            {
                                text: (typeof l === 'function') ? l('Name') : 'Name',
                                dataIndex: 'name',
                                flex: 1
                            },
                            {
                                text: (typeof l === 'function') ? l('Type') : 'Type',
                                dataIndex: 'type',
                                width: 100,
                                renderer: function (v) {
                                    if (v === 'restricted') {
                                        return '<span class="indoor-zone-badge indoor-zone-badge-restricted">' +
                                               '<i class="fa fa-shield-alt" style="margin-right:3px"></i>' +
                                               ((typeof l === 'function') ? l('Restricted') : 'Restricted') + '</span>';
                                    }
                                    return '<span class="indoor-zone-badge">' +
                                           ((typeof l === 'function') ? l('Normal') : 'Normal') + '</span>';
                                }
                            },
                            {
                                text: (typeof l === 'function') ? l('Floor') : 'Floor',
                                dataIndex: 'floor',
                                width: 70,
                                renderer: function (v) {
                                    return v || '—';
                                }
                            },
                            {
                                text: (typeof l === 'function') ? l('Devices') : 'Devices',
                                dataIndex: 'deviceCount',
                                width: 70,
                                align: 'center',
                                renderer: function (v) {
                                    return (v !== undefined && v !== null) ? v : '—';
                                }
                            },
                            {
                                text: (typeof l === 'function') ? l('Alerts') : 'Alerts',
                                dataIndex: 'alertEnter',
                                width: 80,
                                renderer: function (v, meta, r) {
                                    var parts = [];
                                    if (r.get('alertEnter')) parts.push('enter');
                                    if (r.get('alertExit')) parts.push('exit');
                                    return parts.length ? parts.join(', ') : '—';
                                }
                            }
                        ],
                        listeners: {
                            select: me.onZoneSelect,
                            scope: me
                        }
                    },
                    /* -- Zone Properties -------------------------------- */
                    {
                        xtype: 'form',
                        itemId: 'zonePropsForm',
                        bodyPadding: 10,
                        layout: { type: 'vbox', align: 'stretch' },
                        defaults: { labelWidth: 90 },
                        items: [
                            {
                                xtype: 'combo',
                                fieldLabel: (typeof l === 'function') ? l('Zone Type') : 'Zone Type',
                                itemId: 'cmbZoneType',
                                store: [
                                    ['normal', (typeof l === 'function') ? l('Normal') : 'Normal'],
                                    ['restricted', (typeof l === 'function') ? l('Restricted') : 'Restricted']
                                ],
                                value: 'normal',
                                editable: false,
                                queryMode: 'local',
                                listeners: {
                                    change: me.onZoneTypeChange,
                                    scope: me
                                }
                            },
                            {
                                xtype: 'fieldcontainer',
                                layout: 'hbox',
                                items: [
                                    {
                                        xtype: 'checkbox',
                                        boxLabel: (typeof l === 'function') ? l('Enter alert') : 'Enter alert',
                                        itemId: 'chkAlertEnter',
                                        margin: '0 20 0 0',
                                        listeners: { change: me.onAlertRuleChange, scope: me }
                                    },
                                    {
                                        xtype: 'checkbox',
                                        boxLabel: (typeof l === 'function') ? l('Exit alert') : 'Exit alert',
                                        itemId: 'chkAlertExit',
                                        listeners: { change: me.onAlertRuleChange, scope: me }
                                    }
                                ]
                            },
                            {
                                xtype: 'container',
                                layout: 'hbox',
                                margin: '5 0 0 0',
                                items: [
                                    {
                                        xtype: 'button',
                                        text: (typeof l === 'function') ? l('Save Zone') : 'Save Zone',
                                        iconCls: 'fa fa-save',
                                        itemId: 'btnSaveZone',
                                        disabled: true,
                                        handler: me.onSaveZone,
                                        scope: me
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }
        ];

        me.buttons = [
            {
                text: (typeof l === 'function') ? l('Close') : 'Close',
                handler: function () {
                    me.setDrawingMode(false);
                    me.close();
                }
            }
        ];

        me.on('show', me.loadZones, me);
        me.on('close', function () {
            me.setDrawingMode(false);
        }, me);

        me.callParent();
    },

    /* ------------------------------------------------------------------ */
    /*  Zone Store                                                        */
    /* ------------------------------------------------------------------ */

    /**
     * Create the local zone store.
     * @returns {Ext.data.Store}
     * @private
     */
    _createZoneStore: function () {
        this._zoneStore = Ext.create('Ext.data.Store', {
            fields: [
                'id', 'name', 'type', 'floor', 'color',
                'bounds', 'polygon', 'geojson',
                'deviceCount', 'alertEnter', 'alertExit'
            ],
            data: [],
            proxy: { type: 'memory' }
        });
        return this._zoneStore;
    },

    /**
     * @returns {Ext.data.Store}
     */
    getZoneStore: function () {
        return this._zoneStore;
    },

    /* ------------------------------------------------------------------ */
    /*  Load Zones from API                                               */
    /* ------------------------------------------------------------------ */

    /**
     * Load zones from the appropriate API endpoint based on engine.
     */
    loadZones: function () {
        var me = this;
        var base = me.getEngineBaseUrl();
        if (!base) return;

        var engine = me.getEngine();
        var url;

        if (engine === 'velavu') {
            url = base + '/geofences';
        } else {
            url = base + '/zones';
        }

        Ext.Ajax.request({
            url: url,
            method: 'GET',
            success: function (resp) {
                try {
                    var payload = Ext.JSON.decode(resp.responseText);
                    var zones;

                    if (engine === 'velavu') {
                        zones = me._parseVelavuGeofences(payload);
                    } else {
                        zones = payload.zones || payload.data || payload || [];
                    }

                    me.getZoneStore().loadData(zones);
                    me._drawAllZonesOnMap(zones);
                } catch (e) {
                    console.warn('[Indoor v4] ZoneManager load error:', e);
                }
            },
            failure: function () {
                Ext.Msg.alert(
                    (typeof l === 'function') ? l('Error') : 'Error',
                    (typeof l === 'function') ? l('Could not load zones from engine.') : 'Could not load zones from engine.'
                );
            }
        });
    },

    /**
     * Parse Velavu geofences (GeoJSON format) into normalized zone objects.
     *
     * @param {Object} payload -- API response
     * @returns {Array}
     * @private
     */
    _parseVelavuGeofences: function (payload) {
        var geofences = payload.data || payload.geofences || payload || [];
        if (!Ext.isArray(geofences)) geofences = [];

        var zones = [];
        for (var i = 0; i < geofences.length; i++) {
            var gf = geofences[i];
            var bounds = [];

            // Extract polygon from GeoJSON geometry
            if (gf.geometry && gf.geometry.coordinates && gf.geometry.coordinates.length) {
                var ring = gf.geometry.coordinates[0] || gf.geometry.coordinates;
                for (var j = 0; j < ring.length; j++) {
                    bounds.push({ x: ring[j][0], y: ring[j][1] });
                }
            } else if (gf.bounds) {
                bounds = gf.bounds;
            }

            zones.push({
                id: gf.id,
                name: gf.name || gf.properties && gf.properties.name || ('Geofence ' + (i + 1)),
                type: gf.type || (gf.properties && gf.properties.type) || 'normal',
                floor: gf.floor || (gf.properties && gf.properties.floor) || '',
                color: gf.color || (gf.properties && gf.properties.color) || '#3388ff',
                bounds: bounds,
                geojson: gf.geometry || null,
                deviceCount: gf.deviceCount !== undefined ? gf.deviceCount : null,
                alertEnter: gf.alertEnter !== undefined ? gf.alertEnter : (gf.properties && gf.properties.alertEnter) || false,
                alertExit: gf.alertExit !== undefined ? gf.alertExit : (gf.properties && gf.properties.alertExit) || false
            });
        }
        return zones;
    },

    /* ------------------------------------------------------------------ */
    /*  Map Drawing                                                       */
    /* ------------------------------------------------------------------ */

    /**
     * Draw all loaded zones on the map as polygon overlays.
     *
     * @param {Array} zones
     * @private
     */
    _drawAllZonesOnMap: function (zones) {
        var me = this;
        var mapPanel = me.getMapPanel();
        if (!mapPanel || !mapPanel.map) return;

        // Clear previous zone manager overlays
        if (me._zoneOverlayGroup) {
            mapPanel.map.removeLayer(me._zoneOverlayGroup);
        }
        me._zoneOverlayGroup = new L.FeatureGroup().addTo(mapPanel.map);
        me._zoneLayerMap = {};

        for (var i = 0; i < zones.length; i++) {
            me._addZoneOverlay(zones[i]);
        }
    },

    /**
     * Add a single zone polygon overlay to the map.
     *
     * @param {Object} zone
     * @private
     */
    _addZoneOverlay: function (zone) {
        var me = this;
        if (!me._zoneOverlayGroup) return;

        var pts = me._getZoneLatLngs(zone);
        if (!pts || pts.length < 3) return;

        var isRestricted = zone.type === 'restricted';
        var color = zone.color || (isRestricted ? '#ef4444' : '#3388ff');

        var poly = L.polygon(pts, {
            color: color,
            fillOpacity: isRestricted ? 0.25 : 0.15,
            weight: 2,
            dashArray: isRestricted ? '6, 4' : null
        });

        var label = '<b>' + Ext.String.htmlEncode(zone.name) + '</b>';
        if (isRestricted) label += '<br/><span style="color:#ef4444">Restricted</span>';
        if (zone.deviceCount !== undefined && zone.deviceCount !== null) {
            label += '<br/>' + zone.deviceCount + ' device(s)';
        }
        poly.bindTooltip(label, { sticky: true });

        poly.zoneId = zone.id;
        me._zoneOverlayGroup.addLayer(poly);
        me._zoneLayerMap = me._zoneLayerMap || {};
        me._zoneLayerMap[zone.id] = poly;
    },

    /**
     * Convert zone bounds/polygon to Leaflet LatLng array.
     *
     * @param {Object} zone
     * @returns {Array}
     * @private
     */
    _getZoneLatLngs: function (zone) {
        var pts = [];

        if (zone.polygon && zone.polygon.length) {
            // CS format: [[x, y], ...]
            for (var i = 0; i < zone.polygon.length; i++) {
                pts.push([zone.polygon[i][1], zone.polygon[i][0]]);
            }
        } else if (zone.bounds && zone.bounds.length) {
            // Bounds format: [{x, y}, ...]
            for (var j = 0; j < zone.bounds.length; j++) {
                var b = zone.bounds[j];
                if (Array.isArray(b)) {
                    pts.push([b[1], b[0]]);
                } else {
                    pts.push([b.y, b.x]);
                }
            }
        } else if (zone.geojson && zone.geojson.coordinates) {
            // GeoJSON format: [[[lng, lat], ...]]
            var ring = zone.geojson.coordinates[0] || zone.geojson.coordinates;
            for (var k = 0; k < ring.length; k++) {
                pts.push([ring[k][1], ring[k][0]]);
            }
        }

        return pts;
    },

    /* ------------------------------------------------------------------ */
    /*  Polygon Drawing Mode                                              */
    /* ------------------------------------------------------------------ */

    /**
     * Start drawing a new zone polygon on the map.
     */
    onDrawZone: function () {
        var me = this;
        var mapPanel = me.getMapPanel();
        if (!mapPanel || !mapPanel.map) {
            Ext.Msg.alert(
                (typeof l === 'function') ? l('Error') : 'Error',
                (typeof l === 'function') ? l('Map not ready') : 'Map not ready'
            );
            return;
        }
        me.setDrawingMode(true);
    },

    /**
     * Enable or disable polygon drawing mode on the map.
     *
     * @param {boolean} enable
     */
    setDrawingMode: function (enable) {
        var me = this;
        var mapPanel = me.getMapPanel();
        if (!mapPanel || !mapPanel.map) return;

        var map = mapPanel.map;

        // Clean up previous draw state
        if (me._drawLayer) {
            map.removeLayer(me._drawLayer);
            me._drawLayer = null;
        }
        if (me._drawClickHandler) {
            map.off('click', me._drawClickHandler);
            me._drawClickHandler = null;
        }
        if (me._drawDblClickHandler) {
            map.off('dblclick', me._drawDblClickHandler);
            me._drawDblClickHandler = null;
        }
        me._drawPoints = null;
        me._drawPolygon = null;

        // Update button state
        var btnDraw = me.down('#btnDrawZone');
        if (btnDraw) {
            btnDraw.setIconCls(enable ? 'fa fa-stop' : 'fa fa-draw-polygon');
            btnDraw.setText(enable
                ? ((typeof l === 'function') ? l('Cancel Drawing') : 'Cancel Drawing')
                : ((typeof l === 'function') ? l('Draw Zone') : 'Draw Zone'));
        }

        if (enable) {
            me._drawPoints = [];
            me._drawLayer = new L.FeatureGroup().addTo(map);

            me._drawClickHandler = function (e) {
                var latlng = e.latlng;
                me._drawPoints.push([latlng.lat, latlng.lng]);

                // Draw vertex marker
                L.circleMarker(latlng, {
                    radius: 4,
                    fillColor: '#3388ff',
                    color: '#fff',
                    weight: 2,
                    fillOpacity: 1
                }).addTo(me._drawLayer);

                // Update polygon preview
                if (me._drawPoints.length >= 3) {
                    if (me._drawPolygon) me._drawLayer.removeLayer(me._drawPolygon);
                    me._drawPolygon = L.polygon(me._drawPoints, {
                        color: '#3388ff',
                        fillOpacity: 0.2,
                        dashArray: '4, 4'
                    }).addTo(me._drawLayer);
                }
            };

            me._drawDblClickHandler = function (e) {
                L.DomEvent.stopPropagation(e);
                L.DomEvent.preventDefault(e);
                if (me._drawPoints && me._drawPoints.length >= 3) {
                    me._finishDrawZone(me._drawPoints);
                }
                me.setDrawingMode(false);
            };

            map.on('click', me._drawClickHandler);
            map.on('dblclick', me._drawDblClickHandler);

            Ext.Msg.alert(
                (typeof l === 'function') ? l('Draw Zone') : 'Draw Zone',
                (typeof l === 'function') ? l('Click to add vertices, double-click to finish the polygon.') : 'Click to add vertices, double-click to finish the polygon.'
            );
        }
    },

    /**
     * Complete zone drawing -- prompt for name, add to store, draw on map.
     *
     * @param {Array} points -- [[lat, lng], ...]
     * @private
     */
    _finishDrawZone: function (points) {
        var me = this;
        var nextNum = me.getZoneStore().getCount() + 1;
        var defaultName = 'Zone ' + nextNum;

        Ext.Msg.prompt(
            (typeof l === 'function') ? l('New Zone') : 'New Zone',
            (typeof l === 'function') ? l('Zone name:') : 'Zone name:',
            function (btn, text) {
                if (btn !== 'ok') return;

                var name = (text || '').trim() || defaultName;
                var bounds = [];
                for (var i = 0; i < points.length; i++) {
                    bounds.push({ y: points[i][0], x: points[i][1] });
                }

                var zone = {
                    id: 'zone_' + Date.now(),
                    name: name,
                    type: 'normal',
                    floor: '',
                    color: '#3388ff',
                    bounds: bounds,
                    deviceCount: 0,
                    alertEnter: true,
                    alertExit: true
                };

                me.getZoneStore().add(zone);
                me._addZoneOverlay(zone);
            },
            me,
            false,
            defaultName
        );
    },

    /* ------------------------------------------------------------------ */
    /*  Zone Selection and Editing                                        */
    /* ------------------------------------------------------------------ */

    /**
     * Handle zone grid row selection.
     */
    onZoneSelect: function (grid, record) {
        var me = this;
        me.down('#btnEdit').setDisabled(false);
        me.down('#btnDelete').setDisabled(false);
        me.down('#btnSaveZone').setDisabled(false);
        me.down('#cmbZoneType').setValue(record.get('type') || 'normal');
        me.down('#chkAlertEnter').setValue(!!record.get('alertEnter'));
        me.down('#chkAlertExit').setValue(!!record.get('alertExit'));

        // Highlight the zone on the map
        me._highlightZoneOnMap(record.get('id'));
    },

    /**
     * Highlight a specific zone polygon on the map with a bolder style.
     *
     * @param {string} zoneId
     * @private
     */
    _highlightZoneOnMap: function (zoneId) {
        var me = this;
        if (!me._zoneLayerMap) return;

        // Reset all zones to normal style
        Ext.Object.each(me._zoneLayerMap, function (id, layer) {
            layer.setStyle({ weight: 2, opacity: 0.7 });
        });

        // Highlight selected zone
        var layer = me._zoneLayerMap[zoneId];
        if (layer) {
            layer.setStyle({ weight: 4, opacity: 1 });
            var mapPanel = me.getMapPanel();
            if (mapPanel && mapPanel.map) {
                mapPanel.map.fitBounds(layer.getBounds(), { padding: [30, 30] });
            }
        }
    },

    /**
     * Edit the selected zone name via prompt.
     */
    onEditZone: function () {
        var me = this;
        var grid = me.down('#zoneGrid');
        var sel = grid.getSelectionModel().getSelection();
        if (!sel.length) return;

        var rec = sel[0];
        Ext.Msg.prompt(
            (typeof l === 'function') ? l('Edit Zone') : 'Edit Zone',
            (typeof l === 'function') ? l('Zone name:') : 'Zone name:',
            function (btn, text) {
                if (btn === 'ok' && text) {
                    rec.set('name', text.trim());
                }
            },
            me,
            false,
            rec.get('name')
        );
    },

    /**
     * Handle zone type combo change -- update selected record.
     */
    onZoneTypeChange: function (combo, newVal) {
        var me = this;
        var grid = me.down('#zoneGrid');
        var sel = grid.getSelectionModel().getSelection();
        if (sel.length) {
            sel[0].set('type', newVal);
        }
    },

    /**
     * Handle alert rule checkbox change -- update selected record.
     */
    onAlertRuleChange: function () {
        var me = this;
        var grid = me.down('#zoneGrid');
        var sel = grid.getSelectionModel().getSelection();
        if (sel.length) {
            sel[0].set('alertEnter', me.down('#chkAlertEnter').getValue());
            sel[0].set('alertExit', me.down('#chkAlertExit').getValue());
        }
    },

    /* ------------------------------------------------------------------ */
    /*  Delete                                                            */
    /* ------------------------------------------------------------------ */

    /**
     * Delete the selected zone with confirmation.
     */
    onDeleteZone: function () {
        var me = this;
        var grid = me.down('#zoneGrid');
        var sel = grid.getSelectionModel().getSelection();
        if (!sel.length) return;

        var rec = sel[0];

        Ext.Msg.confirm(
            (typeof l === 'function') ? l('Delete Zone') : 'Delete Zone',
            (typeof l === 'function') ? l('Delete zone') : 'Delete zone' + ' "' + Ext.String.htmlEncode(rec.get('name')) + '"?',
            function (btn) {
                if (btn !== 'yes') return;

                var zoneId = rec.get('id');

                // Remove overlay from map
                if (me._zoneLayerMap && me._zoneLayerMap[zoneId]) {
                    if (me._zoneOverlayGroup) {
                        me._zoneOverlayGroup.removeLayer(me._zoneLayerMap[zoneId]);
                    }
                    delete me._zoneLayerMap[zoneId];
                }

                // Remove from local store
                me.getZoneStore().remove(rec);

                // Delete from server
                me._deleteZoneFromServer(zoneId);

                // Reset buttons
                me.down('#btnEdit').setDisabled(true);
                me.down('#btnDelete').setDisabled(true);
                me.down('#btnSaveZone').setDisabled(true);
            },
            me
        );
    },

    /**
     * Delete a zone from the server API.
     *
     * @param {string} zoneId
     * @private
     */
    _deleteZoneFromServer: function (zoneId) {
        var me = this;
        var base = me.getEngineBaseUrl();
        if (!base) return;

        var engine = me.getEngine();
        var url;

        if (engine === 'velavu') {
            url = base + '/geofences/' + encodeURIComponent(zoneId);
        } else {
            url = base + '/zones/' + encodeURIComponent(zoneId);
        }

        Ext.Ajax.request({
            url: url,
            method: 'DELETE',
            success: function () {
                console.log('[Indoor v4] Zone deleted:', zoneId);
            },
            failure: function () {
                Ext.Msg.alert(
                    (typeof l === 'function') ? l('Error') : 'Error',
                    (typeof l === 'function') ? l('Could not delete zone from server.') : 'Could not delete zone from server.'
                );
            }
        });
    },

    /* ------------------------------------------------------------------ */
    /*  Save                                                              */
    /* ------------------------------------------------------------------ */

    /**
     * Save the selected zone to the server API.
     */
    onSaveZone: function () {
        var me = this;
        var grid = me.down('#zoneGrid');
        var sel = grid.getSelectionModel().getSelection();
        if (!sel.length) return;

        var rec = sel[0];
        var base = me.getEngineBaseUrl();
        if (!base) {
            Ext.Msg.alert(
                (typeof l === 'function') ? l('Error') : 'Error',
                (typeof l === 'function') ? l('No engine URL configured.') : 'No engine URL configured.'
            );
            return;
        }

        var engine = me.getEngine();
        var zoneId = rec.get('id');
        var body;
        var url;
        var method;

        if (engine === 'velavu') {
            // Velavu: POST/PUT to /geofences with GeoJSON body
            var coordinates = [];
            var bounds = rec.get('bounds') || [];
            for (var i = 0; i < bounds.length; i++) {
                var b = bounds[i];
                coordinates.push([b.x, b.y]);
            }
            // Close the ring for GeoJSON
            if (coordinates.length && (coordinates[0][0] !== coordinates[coordinates.length - 1][0] ||
                coordinates[0][1] !== coordinates[coordinates.length - 1][1])) {
                coordinates.push(coordinates[0]);
            }

            body = {
                name: rec.get('name'),
                type: rec.get('type') || 'normal',
                floor: rec.get('floor') || '',
                alertEnter: !!rec.get('alertEnter'),
                alertExit: !!rec.get('alertExit'),
                geometry: {
                    type: 'Polygon',
                    coordinates: [coordinates]
                }
            };

            // Use PUT for existing, POST for new
            if (zoneId && zoneId.indexOf('zone_') !== 0) {
                url = base + '/geofences/' + encodeURIComponent(zoneId);
                method = 'PUT';
            } else {
                url = base + '/geofences';
                method = 'POST';
            }
        } else {
            // Channel Sounding: POST/PUT to /zones
            var polygon = [];
            var zoneBounds = rec.get('bounds') || [];
            for (var j = 0; j < zoneBounds.length; j++) {
                var p = zoneBounds[j];
                polygon.push([p.x, p.y]);
            }

            body = {
                name: rec.get('name'),
                type: rec.get('type') || 'normal',
                floor: rec.get('floor') || '',
                polygon: polygon,
                alertEnter: !!rec.get('alertEnter'),
                alertExit: !!rec.get('alertExit')
            };

            if (zoneId && zoneId.indexOf('zone_') !== 0) {
                url = base + '/zones/' + encodeURIComponent(zoneId);
                method = 'PUT';
            } else {
                url = base + '/zones';
                method = 'POST';
            }
        }

        Ext.Ajax.request({
            url: url,
            method: method,
            jsonData: body,
            success: function (resp) {
                try {
                    var data = Ext.JSON.decode(resp.responseText);
                    // Update local record with server-assigned ID if new
                    if (data.id && (!zoneId || zoneId.indexOf('zone_') === 0)) {
                        rec.set('id', data.id);
                    }
                } catch (e) {}

                Ext.Msg.alert(
                    (typeof l === 'function') ? l('Saved') : 'Saved',
                    (typeof l === 'function') ? l('Zone saved successfully.') : 'Zone saved successfully.'
                );
            },
            failure: function () {
                Ext.Msg.alert(
                    (typeof l === 'function') ? l('Error') : 'Error',
                    (typeof l === 'function') ? l('Could not save zone to server.') : 'Could not save zone to server.'
                );
            }
        });
    },

    /* ------------------------------------------------------------------ */
    /*  Config Accessors                                                  */
    /* ------------------------------------------------------------------ */

    setMapPanel: function (panel) {
        this.mapPanel = panel;
    },

    getMapPanel: function () {
        return this.mapPanel;
    },

    setEngineBaseUrl: function (url) {
        this.engineBaseUrl = url;
    },

    getEngineBaseUrl: function () {
        return this.engineBaseUrl || '';
    },

    setEngine: function (engine) {
        this.engine = engine;
    },

    getEngine: function () {
        return this.engine || 'velavu';
    },

    /* ------------------------------------------------------------------ */
    /*  Cleanup                                                           */
    /* ------------------------------------------------------------------ */

    onDestroy: function () {
        var me = this;
        me.setDrawingMode(false);
        if (me._zoneOverlayGroup) {
            var mapPanel = me.getMapPanel();
            if (mapPanel && mapPanel.map) {
                mapPanel.map.removeLayer(me._zoneOverlayGroup);
            }
            me._zoneOverlayGroup = null;
        }
        me.callParent(arguments);
    }
});
