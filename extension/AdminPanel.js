/**
 * PILOT Extension — Indoor Positioning
 * Admin settings: floor plan upload, 3-point calibration, anchor placement, MQTT connection.
 *
 * @see TECHNICAL_SPEC.md — AdminPanel requirements
 */

Ext.define('Store.indoor-positioning.AdminPanel', {
    extend: 'Ext.window.Window',
    xtype: 'indoor-adminpanel',

    cls: 'indoor-adminpanel',
    title: (typeof l === 'function') ? l('Indoor Positioning — Settings') : 'Indoor Positioning — Settings',
    width: 560,
    height: 580,
    layout: 'fit',
    modal: false,
    bodyPadding: 0,

    config: {
        mapPanel: null,
        engineBaseUrl: ''
    },

    initComponent: function () {
        var me = this;

        me.items = [
            {
                xtype: 'tabpanel',
                itemId: 'adminTabs',
                items: [
                    {
                        title: (typeof l === 'function') ? l('Floor plan') : 'Floor plan',
                        layout: { type: 'vbox', align: 'stretch' },
                        padding: 10,
                        items: [
                            {
                                xtype: 'combo',
                                itemId: 'floorCombo',
                                fieldLabel: (typeof l === 'function') ? l('Floor') : 'Floor',
                                displayField: 'name',
                                valueField: 'id',
                                store: Ext.create('Ext.data.Store', {
                                    fields: ['id', 'name', 'plan_url', 'calibration', 'anchors', 'bounds'],
                                    data: []
                                }),
                                queryMode: 'local',
                                editable: false,
                                listeners: { change: me.onFloorSelect, scope: me }
                            },
                            {
                                xtype: 'textfield',
                                fieldLabel: (typeof l === 'function') ? l('Floor plan URL') : 'Floor plan URL',
                                itemId: 'floorPlanUrl',
                                emptyText: '/store/indoor-positioning/plans/floor1.png',
                                listeners: {
                                    change: function (f, v) {
                                        var mp = me.getMapPanel();
                                        if (mp && mp.updateFloorPlanOverlay) mp.updateFloorPlanOverlay(v);
                                    }
                                }
                            },
                            {
                                xtype: 'fieldset',
                                title: (typeof l === 'function') ? l('Image bounds (pixel)') : 'Image bounds (pixel)',
                                items: [
                                    { xtype: 'numberfield', fieldLabel: 'Min X', itemId: 'boundMinX', value: 0 },
                                    { xtype: 'numberfield', fieldLabel: 'Min Y', itemId: 'boundMinY', value: 0 },
                                    { xtype: 'numberfield', fieldLabel: 'Max X', itemId: 'boundMaxX', value: 1000 },
                                    { xtype: 'numberfield', fieldLabel: 'Max Y', itemId: 'boundMaxY', value: 800 }
                                ]
                            },
                            {
                                xtype: 'container',
                                layout: 'hbox',
                                margin: '10 0 0 0',
                                items: [
                                    { xtype: 'button', text: (typeof l === 'function') ? l('Load on map') : 'Load on map', iconCls: 'fa fa-map', handler: me.loadPlanOnMap, scope: me },
                                    { xtype: 'button', text: (typeof l === 'function') ? l('Save to engine') : 'Save to engine', iconCls: 'fa fa-save', handler: me.saveFloorPlan, scope: me, margin: '0 0 0 10' }
                                ]
                            },
                            {
                                xtype: 'displayfield',
                                itemId: 'floorPlanHint',
                                value: (typeof l === 'function') ? l('Set devicesApiUrl in config to load/save from positioning engine.') : 'Set devicesApiUrl in config to load/save from positioning engine.',
                                margin: '10 0 0 0',
                                hidden: true
                            }
                        ]
                    },
                    {
                        title: (typeof l === 'function') ? l('Calibration') : 'Calibration',
                        layout: { type: 'vbox', align: 'stretch' },
                        padding: 10,
                        items: [
                            {
                                xtype: 'displayfield',
                                value: (typeof l === 'function') ? l('3-point calibration: map pixel coordinates to geo. Set 3 reference points.') : '3-point calibration: map pixel coordinates to geo. Set 3 reference points.',
                                margin: '0 0 10 0'
                            },
                            {
                                xtype: 'fieldset',
                                title: (typeof l === 'function') ? l('Point 1') : 'Point 1',
                                items: [
                                    { xtype: 'numberfield', fieldLabel: 'Pixel X', itemId: 'cal1x', value: 0 },
                                    { xtype: 'numberfield', fieldLabel: 'Pixel Y', itemId: 'cal1y', value: 0 },
                                    { xtype: 'numberfield', fieldLabel: 'Lat', itemId: 'cal1lat', value: 25.2048, decimalPrecision: 6 },
                                    { xtype: 'numberfield', fieldLabel: 'Lon', itemId: 'cal1lon', value: 55.2708, decimalPrecision: 6 }
                                ]
                            },
                            {
                                xtype: 'fieldset',
                                title: (typeof l === 'function') ? l('Point 2') : 'Point 2',
                                items: [
                                    { xtype: 'numberfield', fieldLabel: 'Pixel X', itemId: 'cal2x', value: 1000 },
                                    { xtype: 'numberfield', fieldLabel: 'Pixel Y', itemId: 'cal2y', value: 0 },
                                    { xtype: 'numberfield', fieldLabel: 'Lat', itemId: 'cal2lat', value: 25.2048, decimalPrecision: 6 },
                                    { xtype: 'numberfield', fieldLabel: 'Lon', itemId: 'cal2lon', value: 55.2718, decimalPrecision: 6 }
                                ]
                            },
                            {
                                xtype: 'fieldset',
                                title: (typeof l === 'function') ? l('Point 3') : 'Point 3',
                                items: [
                                    { xtype: 'numberfield', fieldLabel: 'Pixel X', itemId: 'cal3x', value: 0 },
                                    { xtype: 'numberfield', fieldLabel: 'Pixel Y', itemId: 'cal3y', value: 800 },
                                    { xtype: 'numberfield', fieldLabel: 'Lat', itemId: 'cal3lat', value: 25.2055, decimalPrecision: 6 },
                                    { xtype: 'numberfield', fieldLabel: 'Lon', itemId: 'cal3lon', value: 55.2708, decimalPrecision: 6 }
                                ]
                            },
                            {
                                xtype: 'container',
                                layout: 'hbox',
                                items: [
                                    { xtype: 'button', text: (typeof l === 'function') ? l('Save calibration') : 'Save calibration', iconCls: 'fa fa-save', handler: me.saveCalibration, scope: me },
                                    { xtype: 'button', text: (typeof l === 'function') ? l('Save to engine') : 'Save to engine', iconCls: 'fa fa-cloud-upload-alt', handler: me.saveCalibrationToEngine, scope: me, margin: '0 0 0 10' }
                                ]
                            }
                        ]
                    },
                    {
                        title: (typeof l === 'function') ? l('Anchors') : 'Anchors',
                        layout: { type: 'vbox', align: 'stretch' },
                        padding: 10,
                        items: [
                            {
                                xtype: 'displayfield',
                                itemId: 'anchorsHint',
                                value: (typeof l === 'function') ? l('Select a floor to load anchors. Edit and click Save to engine.') : 'Select a floor to load anchors. Edit and click Save to engine.',
                                margin: '0 0 10 0'
                            },
                            {
                                xtype: 'grid',
                                itemId: 'anchorGrid',
                                height: 220,
                                store: Ext.create('Ext.data.Store', {
                                    fields: ['id', 'x', 'y', 'z'],
                                    data: []
                                }),
                                columns: [
                                    { text: 'ID', dataIndex: 'id', flex: 1, editor: { xtype: 'textfield' } },
                                    { text: 'X', dataIndex: 'x', width: 70, editor: { xtype: 'numberfield' } },
                                    { text: 'Y', dataIndex: 'y', width: 70, editor: { xtype: 'numberfield' } },
                                    { text: 'Z', dataIndex: 'z', width: 70, editor: { xtype: 'numberfield' } }
                                ],
                                plugins: [{ ptype: 'cellediting', clicksToEdit: 1 }],
                                tbar: [
                                    { xtype: 'button', text: (typeof l === 'function') ? l('Add anchor') : 'Add anchor', iconCls: 'fa fa-plus', handler: me.addAnchor, scope: me },
                                    { xtype: 'button', text: (typeof l === 'function') ? l('Remove') : 'Remove', iconCls: 'fa fa-minus', handler: me.removeAnchor, scope: me },
                                    { xtype: 'tbfill' },
                                    { xtype: 'button', text: (typeof l === 'function') ? l('Save to engine') : 'Save to engine', iconCls: 'fa fa-save', handler: me.saveAnchorsToEngine, scope: me }
                                ]
                            }
                        ]
                    },
                    {
                        title: 'MQTT',
                        layout: { type: 'vbox', align: 'stretch' },
                        padding: 10,
                        items: [
                            {
                                xtype: 'textfield',
                                fieldLabel: (typeof l === 'function') ? l('Broker URL') : 'Broker URL',
                                itemId: 'mqttBroker',
                                value: 'mqtt://localhost:1883',
                                emptyText: 'mqtt://localhost:1883'
                            },
                            {
                                xtype: 'textfield',
                                fieldLabel: (typeof l === 'function') ? l('Username') : 'Username',
                                itemId: 'mqttUser'
                            },
                            {
                                xtype: 'textfield',
                                fieldLabel: (typeof l === 'function') ? l('Password') : 'Password',
                                inputType: 'password',
                                itemId: 'mqttPass'
                            },
                            {
                                xtype: 'displayfield',
                                value: (typeof l === 'function') ? l('MQTT settings are applied in positioning-engine. Restart the engine after changes.') : 'MQTT settings are applied in positioning-engine. Restart the engine after changes.',
                                margin: '10 0 0 0'
                            }
                        ]
                    }
                ]
            }
        ];

        me.listeners = me.listeners || {};
        me.listeners.show = function () {
            me.loadFloorsFromEngine();
        };
        me.callParent();
    },

    getFloorsStore: function () {
        var combo = this.down('#floorCombo');
        return combo ? combo.getStore() : null;
    },

    getSelectedFloor: function () {
        var combo = this.down('#floorCombo');
        return combo ? combo.getSelectedRecord() : null;
    },

    loadFloorsFromEngine: function () {
        var me = this;
        var base = me.getEngineBaseUrl();
        if (!base) {
            me.down('#floorPlanHint').setHidden(false);
            return;
        }
        me.down('#floorPlanHint').setHidden(true);
        Ext.Ajax.request({
            url: base + '/api/indoor/floors',
            method: 'GET',
            success: function (resp) {
                var data;
                try {
                    data = Ext.JSON.decode(resp.responseText);
                } catch (e) { return; }
                var floors = data.floors || [];
                var store = me.getFloorsStore();
                if (store) {
                    store.loadData(floors);
                    if (floors.length && !me.down('#floorCombo').getValue()) {
                        me.down('#floorCombo').setValue(floors[0].id);
                        me.onFloorSelect();
                    }
                }
            },
            failure: function () {
                Ext.Msg.alert((typeof l === 'function') ? l('Load failed') : 'Load failed', (typeof l === 'function') ? l('Could not load floors from engine. Check engine URL and CORS.') : 'Could not load floors from engine. Check engine URL and CORS.');
            }
        });
    },

    onFloorSelect: function () {
        var me = this;
        var floor = me.getSelectedFloor();
        if (!floor) return;
        var rec = floor.getData ? floor.getData() : floor;
        me.down('#floorPlanUrl').setValue(rec.plan_url || '');
        var b = rec.bounds || [[0, 0], [1000, 800]];
        me.down('#boundMinX').setValue(Array.isArray(b[0]) ? b[0][0] : 0);
        me.down('#boundMinY').setValue(Array.isArray(b[0]) ? b[0][1] : 0);
        me.down('#boundMaxX').setValue(Array.isArray(b[1]) ? b[1][0] : 1000);
        me.down('#boundMaxY').setValue(Array.isArray(b[1]) ? b[1][1] : 800);
        var cal = rec.calibration && rec.calibration.points;
        if (cal && cal.length >= 3) {
            me.down('#cal1x').setValue(cal[0].pixel[0]); me.down('#cal1y').setValue(cal[0].pixel[1]);
            me.down('#cal1lat').setValue(cal[0].geo[0]); me.down('#cal1lon').setValue(cal[0].geo[1]);
            me.down('#cal2x').setValue(cal[1].pixel[0]); me.down('#cal2y').setValue(cal[1].pixel[1]);
            me.down('#cal2lat').setValue(cal[1].geo[0]); me.down('#cal2lon').setValue(cal[1].geo[1]);
            me.down('#cal3x').setValue(cal[2].pixel[0]); me.down('#cal3y').setValue(cal[2].pixel[1]);
            me.down('#cal3lat').setValue(cal[2].geo[0]); me.down('#cal3lon').setValue(cal[2].geo[1]);
        }
        var anchors = rec.anchors || [];
        var grid = me.down('#anchorGrid');
        if (grid && grid.getStore()) {
            grid.getStore().loadData(anchors);
        }
    },

    loadPlanOnMap: function () {
        var me = this;
        var url = me.down('#floorPlanUrl').getValue();
        var minX = me.down('#boundMinX').getValue(), minY = me.down('#boundMinY').getValue();
        var maxX = me.down('#boundMaxX').getValue(), maxY = me.down('#boundMaxY').getValue();
        var bounds = [[minY, minX], [maxY, maxX]];
        var mp = me.getMapPanel();
        if (mp) {
            if (mp.updateFloorPlanOverlay) mp.updateFloorPlanOverlay(url, bounds);
            if (mp.setMapCenterBounds) mp.setMapCenterBounds(bounds);
        }
    },

    saveFloorPlan: function () {
        var me = this;
        var base = me.getEngineBaseUrl();
        var floor = me.getSelectedFloor();
        if (!base || !floor) {
            Ext.Msg.alert((typeof l === 'function') ? l('Save') : 'Save', (typeof l === 'function') ? l('Connect to engine and select a floor.') : 'Connect to engine and select a floor.');
            return;
        }
        var floorId = floor.get ? floor.get('id') : floor.id;
        var url = me.down('#floorPlanUrl').getValue();
        var minX = me.down('#boundMinX').getValue(), minY = me.down('#boundMinY').getValue();
        var maxX = me.down('#boundMaxX').getValue(), maxY = me.down('#boundMaxY').getValue();
        var body = { plan_url: url || undefined, bounds: [[minX, minY], [maxX, maxY]] };
        Ext.Ajax.request({
            url: base + '/api/indoor/floors/' + floorId,
            method: 'PUT',
            jsonData: body,
            success: function () {
                Ext.Msg.alert((typeof l === 'function') ? l('Saved') : 'Saved', (typeof l === 'function') ? l('Floor plan saved to engine.') : 'Floor plan saved to engine.');
            },
            failure: function () {
                Ext.Msg.alert((typeof l === 'function') ? l('Save failed') : 'Save failed', (typeof l === 'function') ? l('Could not save to engine.') : 'Could not save to engine.');
            }
        });
    },

    saveCalibration: function () {
        var me = this;
        var pts = [
            { pixel: [me.down('#cal1x').getValue(), me.down('#cal1y').getValue()], geo: [me.down('#cal1lat').getValue(), me.down('#cal1lon').getValue()] },
            { pixel: [me.down('#cal2x').getValue(), me.down('#cal2y').getValue()], geo: [me.down('#cal2lat').getValue(), me.down('#cal2lon').getValue()] },
            { pixel: [me.down('#cal3x').getValue(), me.down('#cal3y').getValue()], geo: [me.down('#cal3lat').getValue(), me.down('#cal3lon').getValue()] }
        ];
        var data = JSON.stringify({ calibration: { points: pts } }, null, 2);
        console.log('Calibration (copy to config.json):', data);
        Ext.Msg.alert((typeof l === 'function') ? l('Calibration') : 'Calibration', (typeof l === 'function') ? l('Calibration data logged to console. Copy to positioning-engine/config.json floors[].calibration') : 'Calibration data logged to console. Copy to positioning-engine/config.json floors[].calibration');
    },

    saveCalibrationToEngine: function () {
        var me = this;
        var base = me.getEngineBaseUrl();
        var floor = me.getSelectedFloor();
        if (!base || !floor) {
            Ext.Msg.alert((typeof l === 'function') ? l('Save') : 'Save', (typeof l === 'function') ? l('Connect to engine and select a floor.') : 'Connect to engine and select a floor.');
            return;
        }
        var floorId = floor.get ? floor.get('id') : floor.id;
        var pts = [
            { pixel: [me.down('#cal1x').getValue(), me.down('#cal1y').getValue()], geo: [me.down('#cal1lat').getValue(), me.down('#cal1lon').getValue()] },
            { pixel: [me.down('#cal2x').getValue(), me.down('#cal2y').getValue()], geo: [me.down('#cal2lat').getValue(), me.down('#cal2lon').getValue()] },
            { pixel: [me.down('#cal3x').getValue(), me.down('#cal3y').getValue()], geo: [me.down('#cal3lat').getValue(), me.down('#cal3lon').getValue()] }
        ];
        Ext.Ajax.request({
            url: base + '/api/indoor/floors/' + floorId,
            method: 'PUT',
            jsonData: { calibration: { points: pts } },
            success: function () {
                Ext.Msg.alert((typeof l === 'function') ? l('Saved') : 'Saved', (typeof l === 'function') ? l('Calibration saved to engine.') : 'Calibration saved to engine.');
            },
            failure: function () {
                Ext.Msg.alert((typeof l === 'function') ? l('Save failed') : 'Save failed', (typeof l === 'function') ? l('Could not save to engine.') : 'Could not save to engine.');
            }
        });
    },

    addAnchor: function () {
        var grid = this.down('#anchorGrid');
        if (grid && grid.getStore()) {
            grid.getStore().add({ id: 'anchor_' + (grid.getStore().getCount() + 1), x: 0, y: 0, z: 2.5 });
        }
    },

    removeAnchor: function () {
        var grid = this.down('#anchorGrid');
        if (grid) {
            var sel = grid.getSelectionModel().getSelection();
            if (sel.length) grid.getStore().remove(sel);
        }
    },

    saveAnchorsToEngine: function () {
        var me = this;
        var base = me.getEngineBaseUrl();
        var floor = me.getSelectedFloor();
        if (!base || !floor) {
            Ext.Msg.alert((typeof l === 'function') ? l('Save') : 'Save', (typeof l === 'function') ? l('Connect to engine and select a floor.') : 'Connect to engine and select a floor.');
            return;
        }
        var floorId = floor.get ? floor.get('id') : floor.id;
        var grid = me.down('#anchorGrid');
        var anchors = [];
        if (grid && grid.getStore()) {
            grid.getStore().getData().each(function (r) {
                anchors.push({ id: r.get('id'), x: r.get('x'), y: r.get('y'), z: r.get('z') });
            });
        }
        Ext.Ajax.request({
            url: base + '/api/indoor/floors/' + floorId,
            method: 'PUT',
            jsonData: { anchors: anchors },
            success: function () {
                Ext.Msg.alert((typeof l === 'function') ? l('Saved') : 'Saved', (typeof l === 'function') ? l('Anchors saved to engine.') : 'Anchors saved to engine.');
            },
            failure: function () {
                Ext.Msg.alert((typeof l === 'function') ? l('Save failed') : 'Save failed', (typeof l === 'function') ? l('Could not save to engine.') : 'Could not save to engine.');
            }
        });
    },

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
    }
});
