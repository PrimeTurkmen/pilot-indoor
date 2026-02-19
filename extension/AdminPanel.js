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
    width: 520,
    height: 540,
    layout: 'fit',
    modal: false,
    bodyPadding: 0,

    config: {
        mapPanel: null
    },

    initComponent: function () {
        var me = this;

        me.items = [
            {
                xtype: 'tabpanel',
                items: [
                    {
                        title: (typeof l === 'function') ? l('Floor plan') : 'Floor plan',
                        layout: { type: 'vbox', align: 'stretch' },
                        padding: 10,
                        items: [
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
                                xtype: 'displayfield',
                                value: (typeof l === 'function') ? l('Upload via your server; enter the resulting URL above.') : 'Upload via your server; enter the resulting URL above.',
                                margin: '10 0 0 0'
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
                                xtype: 'button',
                                text: (typeof l === 'function') ? l('Save calibration') : 'Save calibration',
                                iconCls: 'fa fa-save',
                                handler: me.saveCalibration,
                                scope: me
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
                                value: (typeof l === 'function') ? l('Anchor positions are configured in positioning-engine/config.json. Click on map to preview.') : 'Anchor positions are configured in positioning-engine/config.json. Click on map to preview.',
                                margin: '0 0 10 0'
                            },
                            {
                                xtype: 'grid',
                                itemId: 'anchorGrid',
                                height: 200,
                                store: Ext.create('Ext.data.Store', {
                                    fields: ['id', 'x', 'y', 'z'],
                                    data: [
                                        { id: 'anchor_01', x: 0, y: 0, z: 2.5 },
                                        { id: 'anchor_02', x: 20, y: 0, z: 2.5 },
                                        { id: 'anchor_03', x: 10, y: 15, z: 2.5 }
                                    ]
                                }),
                                columns: [
                                    { text: 'ID', dataIndex: 'id', flex: 1 },
                                    { text: 'X', dataIndex: 'x', width: 70 },
                                    { text: 'Y', dataIndex: 'y', width: 70 },
                                    { text: 'Z', dataIndex: 'z', width: 70 }
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

        me.callParent();
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

    setMapPanel: function (panel) {
        this.mapPanel = panel;
    },

    getMapPanel: function () {
        return this.mapPanel;
    }
});
