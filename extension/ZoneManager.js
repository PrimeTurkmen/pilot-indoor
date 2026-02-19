/**
 * PILOT Extension — Indoor Positioning
 * Zone CRUD with polygon creation on map.
 * Alert rules: tag entered zone, tag left zone.
 * Uses Leaflet polygon drawing (L.polygon or L.Draw when available).
 *
 * @see TECHNICAL_SPEC.md — ZoneManager requirements
 */

Ext.define('Store.indoor-positioning.ZoneManager', {
    extend: 'Ext.window.Window',
    xtype: 'indoor-zonemanager',

    cls: 'indoor-zonemanager',
    title: (typeof l === 'function') ? l('Zone Manager') : 'Zone Manager',
    width: 420,
    height: 480,
    layout: 'fit',
    modal: false,
    bodyPadding: 0,

    config: {
        mapPanel: null  // FloorPlanView reference
    },

    initComponent: function () {
        var me = this;

        me.items = [
            {
                xtype: 'panel',
                layout: { type: 'vbox', align: 'stretch' },
                padding: 10,
                items: [
                    {
                        xtype: 'toolbar',
                        items: [
                            {
                                text: (typeof l === 'function') ? l('Add zone') : 'Add zone',
                                iconCls: 'fa fa-draw-polygon',
                                itemId: 'btnAddZone',
                                handler: me.onAddZone,
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
                            }
                        ]
                    },
                    {
                        xtype: 'grid',
                        itemId: 'zoneGrid',
                        flex: 1,
                        store: me.getZoneStore(),
                        columns: [
                            { text: (typeof l === 'function') ? l('Name') : 'Name', dataIndex: 'name', flex: 1 },
                            {
                                text: (typeof l === 'function') ? l('Floor') : 'Floor',
                                dataIndex: 'floor',
                                width: 80
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
                    {
                        xtype: 'fieldset',
                        title: (typeof l === 'function') ? l('Alert rules') : 'Alert rules',
                        itemId: 'alertFieldset',
                        items: [
                            {
                                xtype: 'checkbox',
                                boxLabel: (typeof l === 'function') ? l('Alert when tag enters zone') : 'Alert when tag enters zone',
                                itemId: 'chkAlertEnter',
                                listeners: { change: me.onAlertRuleChange, scope: me }
                            },
                            {
                                xtype: 'checkbox',
                                boxLabel: (typeof l === 'function') ? l('Alert when tag leaves zone') : 'Alert when tag leaves zone',
                                itemId: 'chkAlertExit',
                                listeners: { change: me.onAlertRuleChange, scope: me }
                            }
                        ]
                    }
                ]
            }
        ];

        me.callParent();
    },

    getZoneStore: function () {
        if (this._zoneStore) return this._zoneStore;
        this._zoneStore = Ext.create('Ext.data.Store', {
            fields: ['id', 'name', 'floor', 'color', 'bounds', 'alertEnter', 'alertExit'],
            data: [],
            proxy: { type: 'memory' }
        });
        return this._zoneStore;
    },

    onAddZone: function () {
        var me = this;
        var mapPanel = me.getMapPanel();
        if (!mapPanel || !mapPanel.map) {
            Ext.Msg.alert((typeof l === 'function') ? l('Error') : 'Error', (typeof l === 'function') ? l('Map not ready') : 'Map not ready');
            return;
        }
        me.setDrawingMode(true);
    },

    setDrawingMode: function (enable) {
        var me = this;
        var mapPanel = me.getMapPanel();
        if (!mapPanel || !mapPanel.map) return;

        var map = mapPanel.map;
        if (me._drawLayer) {
            map.removeLayer(me._drawLayer);
            me._drawLayer = null;
        }
        if (me._drawHandler) {
            map.off('click', me._drawHandler);
            map.off('dblclick', me._drawDblClickHandler);
            me._drawHandler = null;
            me._drawDblClickHandler = null;
        }

        if (enable) {
            me._drawPoints = [];
            me._drawLayer = new L.FeatureGroup().addTo(map);
            me._drawHandler = function (e) {
                var latlng = e.latlng;
                me._drawPoints.push([latlng.lat, latlng.lng]);
                if (me._drawPoints.length >= 3) {
                    if (me._drawPolygon) me._drawLayer.removeLayer(me._drawPolygon);
                    me._drawPolygon = L.polygon(me._drawPoints, { color: '#3388ff', fillOpacity: 0.2 }).addTo(me._drawLayer);
                }
            };
            me._drawDblClickHandler = function () {
                if (me._drawPoints.length >= 3) {
                    me.finishDrawZone(me._drawPoints);
                }
                me.setDrawingMode(false);
            };
            map.on('click', me._drawHandler);
            map.on('dblclick', me._drawDblClickHandler);
            Ext.Msg.alert((typeof l === 'function') ? l('Draw zone') : 'Draw zone', (typeof l === 'function') ? l('Click to add vertices, double-click to finish') : 'Click to add vertices, double-click to finish');
        }
    },

    finishDrawZone: function (points) {
        var me = this;
        var name = 'Zone ' + (me.getZoneStore().getCount() + 1);
        var bounds = points.map(function (p) { return { y: p[0], x: p[1] }; });
        var zone = {
            id: 'zone_' + Date.now(),
            name: name,
            floor: 1,
            color: '#3388ff',
            bounds: bounds,
            alertEnter: true,
            alertExit: true
        };
        me.getZoneStore().add(zone);
        me.addZoneToMap(zone);
        me.setDrawingMode(false);
    },

    addZoneToMap: function (zone) {
        var me = this;
        var mapPanel = me.getMapPanel();
        if (!mapPanel || !mapPanel.map || !zone.bounds) return;
        var pts = zone.bounds.map(function (b) { return [b.y, b.x]; });
        var poly = L.polygon(pts, { color: zone.color || '#3388ff', fillOpacity: 0.3 });
        poly.zoneId = zone.id;
        if (!mapPanel.zoneLayers) mapPanel.zoneLayers = {};
        mapPanel.zoneLayers[zone.id] = poly;
        mapPanel.map.addLayer(poly);
    },

    onEditZone: function () {
        var grid = this.down('#zoneGrid');
        var sel = grid.getSelectionModel().getSelection();
        if (sel.length) {
            Ext.Msg.prompt((typeof l === 'function') ? l('Edit zone') : 'Edit zone', (typeof l === 'function') ? l('Zone name') : 'Zone name', function (btn, text) {
                if (btn === 'ok' && text) sel[0].set('name', text);
            }, this, false, sel[0].get('name'));
        }
    },

    onDeleteZone: function () {
        var me = this;
        var grid = me.down('#zoneGrid');
        var sel = grid.getSelectionModel().getSelection();
        if (sel.length) {
            var rec = sel[0];
            var layer = me.getMapPanel() && me.getMapPanel().zoneLayers && me.getMapPanel().zoneLayers[rec.get('id')];
            if (layer) me.getMapPanel().map.removeLayer(layer);
            me.getZoneStore().remove(rec);
        }
    },

    onZoneSelect: function (grid, record) {
        this.down('#btnEdit').setDisabled(false);
        this.down('#btnDelete').setDisabled(false);
        this.down('#chkAlertEnter').setValue(record.get('alertEnter'));
        this.down('#chkAlertExit').setValue(record.get('alertExit'));
    },

    onAlertRuleChange: function () {
        var grid = this.down('#zoneGrid');
        var sel = grid.getSelectionModel().getSelection();
        if (sel.length) {
            sel[0].set('alertEnter', this.down('#chkAlertEnter').getValue());
            sel[0].set('alertExit', this.down('#chkAlertExit').getValue());
        }
    },

    setMapPanel: function (panel) {
        this.mapPanel = panel;
    },

    getMapPanel: function () {
        return this.mapPanel;
    }
});
