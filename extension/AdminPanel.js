/**
 * PILOT Extension -- Indoor Positioning v4.0
 * Settings window with tabbed interface (6 tabs).
 *
 * Tabs:
 *   1. General       -- Engine selector, site selector, poll interval, show toggles
 *   2. Velavu        -- API token, API URL, connection status, test connection
 *   3. Channel Sound -- MQTT broker URL, engine URL, min anchors, path loss
 *   4. Floor Plans   -- Grid of floors per site, upload image, calibration, anchors
 *   5. Alerts        -- Battery thresholds, offline timeout, speed limit, notifications
 *   6. About         -- Version, engine status, device counts, uptime
 *
 * Save button persists settings to config.json / engine API.
 *
 * @see Module.js -- opens this panel from toolbar settings button
 */

Ext.define('Store.indoor-positioning.AdminPanel', {
    extend: 'Ext.window.Window',
    xtype: 'indoor-adminpanel',

    cls: 'indoor-adminpanel',
    title: (typeof l === 'function') ? l('Indoor Positioning Settings') : 'Indoor Positioning Settings',
    iconCls: 'fa fa-cog',
    width: 700,
    height: 500,
    layout: 'fit',
    modal: true,
    bodyPadding: 0,

    /* ------------------------------------------------------------------ */
    /*  Config                                                            */
    /* ------------------------------------------------------------------ */

    config: {
        /** FloorPlanView reference */
        mapPanel: null,
        /** Engine base URL for API calls */
        engineBaseUrl: '',
        /** Current active engine key */
        activeEngine: 'velavu',
        /** Full app config object */
        appConfig: null
    },

    /* ------------------------------------------------------------------ */
    /*  Init                                                              */
    /* ------------------------------------------------------------------ */

    initComponent: function () {
        var me = this;

        me.items = [
            {
                xtype: 'tabpanel',
                itemId: 'adminTabs',
                items: [
                    me._buildGeneralTab(),
                    me._buildVelavuTab(),
                    me._buildChannelSoundingTab(),
                    me._buildFloorPlansTab(),
                    me._buildAlertsTab(),
                    me._buildAboutTab()
                ]
            }
        ];

        me.buttons = [
            {
                text: (typeof l === 'function') ? l('Save') : 'Save',
                iconCls: 'fa fa-save',
                handler: me.onSaveSettings,
                scope: me
            },
            {
                text: (typeof l === 'function') ? l('Close') : 'Close',
                handler: function () { me.close(); }
            }
        ];

        me.on('show', me._onShow, me);

        me.callParent();
    },

    /**
     * Load data when window is shown.
     * @private
     */
    _onShow: function () {
        var me = this;
        me._loadCurrentSettings();
        me.loadFloorsFromEngine();
        me._updateAboutTab();
    },

    /* ================================================================== */
    /*                                                                    */
    /*  TAB 1: GENERAL                                                    */
    /*                                                                    */
    /* ================================================================== */

    /**
     * @returns {Object} Ext config for General tab
     * @private
     */
    _buildGeneralTab: function () {
        var me = this;
        return {
            title: (typeof l === 'function') ? l('General') : 'General',
            iconCls: 'fa fa-sliders-h',
            xtype: 'form',
            itemId: 'tabGeneral',
            bodyPadding: 15,
            layout: { type: 'vbox', align: 'stretch' },
            defaults: { labelWidth: 140, anchor: '100%' },
            autoScroll: true,
            items: [
                {
                    xtype: 'combo',
                    fieldLabel: (typeof l === 'function') ? l('Positioning Engine') : 'Positioning Engine',
                    itemId: 'cmbEngine',
                    store: [
                        ['velavu', 'Velavu Cloud'],
                        ['channelSounding', 'Channel Sounding']
                    ],
                    value: 'velavu',
                    editable: false,
                    queryMode: 'local'
                },
                {
                    xtype: 'combo',
                    fieldLabel: (typeof l === 'function') ? l('Default Site') : 'Default Site',
                    itemId: 'cmbDefaultSite',
                    displayField: 'name',
                    valueField: 'id',
                    store: Ext.create('Ext.data.Store', {
                        fields: ['id', 'name'],
                        data: []
                    }),
                    queryMode: 'local',
                    editable: false,
                    emptyText: (typeof l === 'function') ? l('(auto-select first)') : '(auto-select first)'
                },
                {
                    xtype: 'numberfield',
                    fieldLabel: (typeof l === 'function') ? l('Poll Interval (ms)') : 'Poll Interval (ms)',
                    itemId: 'numPollInterval',
                    value: 10000,
                    minValue: 1000,
                    maxValue: 120000,
                    step: 1000
                },
                {
                    xtype: 'checkbox',
                    fieldLabel: '',
                    boxLabel: (typeof l === 'function') ? l('Show anchors on map') : 'Show anchors on map',
                    itemId: 'chkShowAnchors',
                    checked: false
                },
                {
                    xtype: 'checkbox',
                    fieldLabel: '',
                    boxLabel: (typeof l === 'function') ? l('Show sensor data (temp/humidity)') : 'Show sensor data (temp/humidity)',
                    itemId: 'chkShowSensors',
                    checked: true
                }
            ]
        };
    },

    /* ================================================================== */
    /*                                                                    */
    /*  TAB 2: VELAVU                                                     */
    /*                                                                    */
    /* ================================================================== */

    /**
     * @returns {Object} Ext config for Velavu tab
     * @private
     */
    _buildVelavuTab: function () {
        var me = this;
        return {
            title: 'Velavu',
            iconCls: 'fa fa-cloud',
            xtype: 'form',
            itemId: 'tabVelavu',
            bodyPadding: 15,
            layout: { type: 'vbox', align: 'stretch' },
            defaults: { labelWidth: 140, anchor: '100%' },
            autoScroll: true,
            items: [
                {
                    xtype: 'textfield',
                    fieldLabel: (typeof l === 'function') ? l('API URL') : 'API URL',
                    itemId: 'txtVelavuUrl',
                    value: '/api/velavu',
                    emptyText: '/api/velavu'
                },
                {
                    xtype: 'textfield',
                    fieldLabel: (typeof l === 'function') ? l('API Token') : 'API Token',
                    itemId: 'txtVelavuToken',
                    inputType: 'password',
                    emptyText: (typeof l === 'function') ? l('Enter Velavu API token...') : 'Enter Velavu API token...'
                },
                {
                    xtype: 'fieldcontainer',
                    fieldLabel: (typeof l === 'function') ? l('Connection Status') : 'Connection Status',
                    layout: 'hbox',
                    items: [
                        {
                            xtype: 'displayfield',
                            itemId: 'velavuStatusIndicator',
                            value: '<span class="indoor-status-dot indoor-offline"></span> ' +
                                   ((typeof l === 'function') ? l('Not tested') : 'Not tested'),
                            flex: 1
                        },
                        {
                            xtype: 'button',
                            text: (typeof l === 'function') ? l('Test Connection') : 'Test Connection',
                            iconCls: 'fa fa-plug',
                            handler: me._testVelavuConnection,
                            scope: me
                        }
                    ]
                },
                {
                    xtype: 'displayfield',
                    margin: '20 0 0 0',
                    value: '<i class="fa fa-info-circle"></i> ' +
                           ((typeof l === 'function')
                               ? l('The API token authenticates requests to the Velavu Cloud. Obtain it from your Velavu dashboard.')
                               : 'The API token authenticates requests to the Velavu Cloud. Obtain it from your Velavu dashboard.')
                }
            ]
        };
    },

    /**
     * Test the Velavu API connection.
     * @private
     */
    _testVelavuConnection: function () {
        var me = this;
        var url = me.down('#txtVelavuUrl').getValue() || '/api/velavu';
        var token = me.down('#txtVelavuToken').getValue();
        var indicator = me.down('#velavuStatusIndicator');

        indicator.setValue('<span class="indoor-status-dot" style="background:#f59e0b"></span> ' +
                          ((typeof l === 'function') ? l('Testing...') : 'Testing...'));

        var headers = {};
        if (token) {
            headers['Authorization'] = 'Bearer ' + token;
        }

        Ext.Ajax.request({
            url: url + '/sites',
            method: 'GET',
            headers: headers,
            timeout: 10000,
            success: function (resp) {
                try {
                    var data = Ext.JSON.decode(resp.responseText);
                    var count = 0;
                    if (data.data) count = data.data.length;
                    else if (data.sites) count = data.sites.length;
                    else if (Ext.isArray(data)) count = data.length;

                    indicator.setValue(
                        '<span class="indoor-status-dot indoor-online"></span> ' +
                        ((typeof l === 'function') ? l('Connected') : 'Connected') +
                        ' (' + count + ' sites)'
                    );
                } catch (e) {
                    indicator.setValue(
                        '<span class="indoor-status-dot indoor-online"></span> ' +
                        ((typeof l === 'function') ? l('Connected (parse warning)') : 'Connected (parse warning)')
                    );
                }
            },
            failure: function (resp) {
                var statusText = resp.status ? (' (HTTP ' + resp.status + ')') : '';
                indicator.setValue(
                    '<span class="indoor-status-dot indoor-offline"></span> ' +
                    ((typeof l === 'function') ? l('Failed') : 'Failed') + statusText
                );
            }
        });
    },

    /* ================================================================== */
    /*                                                                    */
    /*  TAB 3: CHANNEL SOUNDING                                           */
    /*                                                                    */
    /* ================================================================== */

    /**
     * @returns {Object} Ext config for Channel Sounding tab
     * @private
     */
    _buildChannelSoundingTab: function () {
        var me = this;
        return {
            title: (typeof l === 'function') ? l('Channel Sounding') : 'Channel Sounding',
            iconCls: 'fa fa-broadcast-tower',
            xtype: 'form',
            itemId: 'tabCS',
            bodyPadding: 15,
            layout: { type: 'vbox', align: 'stretch' },
            defaults: { labelWidth: 140, anchor: '100%' },
            autoScroll: true,
            items: [
                {
                    xtype: 'textfield',
                    fieldLabel: (typeof l === 'function') ? l('MQTT Broker URL') : 'MQTT Broker URL',
                    itemId: 'txtMqttBroker',
                    value: 'mqtt://localhost:1883',
                    emptyText: 'mqtt://localhost:1883'
                },
                {
                    xtype: 'textfield',
                    fieldLabel: (typeof l === 'function') ? l('Engine URL') : 'Engine URL',
                    itemId: 'txtCSEngineUrl',
                    value: '/api/indoor',
                    emptyText: '/api/indoor'
                },
                {
                    xtype: 'numberfield',
                    fieldLabel: (typeof l === 'function') ? l('Min Anchors') : 'Min Anchors',
                    itemId: 'numMinAnchors',
                    value: 3,
                    minValue: 3,
                    maxValue: 10,
                    step: 1
                },
                {
                    xtype: 'fieldset',
                    title: (typeof l === 'function') ? l('Path Loss Model') : 'Path Loss Model',
                    defaults: { labelWidth: 140, anchor: '100%' },
                    items: [
                        {
                            xtype: 'numberfield',
                            fieldLabel: (typeof l === 'function') ? l('Reference RSSI (dBm)') : 'Reference RSSI (dBm)',
                            itemId: 'numRefRssi',
                            value: -59,
                            minValue: -100,
                            maxValue: 0,
                            decimalPrecision: 1
                        },
                        {
                            xtype: 'numberfield',
                            fieldLabel: (typeof l === 'function') ? l('Path Loss Exponent') : 'Path Loss Exponent',
                            itemId: 'numPathLossExp',
                            value: 2.0,
                            minValue: 1.0,
                            maxValue: 6.0,
                            step: 0.1,
                            decimalPrecision: 1
                        },
                        {
                            xtype: 'numberfield',
                            fieldLabel: (typeof l === 'function') ? l('Environment Factor') : 'Environment Factor',
                            itemId: 'numEnvFactor',
                            value: 1.0,
                            minValue: 0.1,
                            maxValue: 5.0,
                            step: 0.1,
                            decimalPrecision: 1
                        }
                    ]
                },
                {
                    xtype: 'displayfield',
                    margin: '10 0 0 0',
                    value: '<i class="fa fa-info-circle"></i> ' +
                           ((typeof l === 'function')
                               ? l('MQTT and path loss settings are applied in the positioning-engine server. Restart the engine after changes.')
                               : 'MQTT and path loss settings are applied in the positioning-engine server. Restart the engine after changes.')
                }
            ]
        };
    },

    /* ================================================================== */
    /*                                                                    */
    /*  TAB 4: FLOOR PLANS                                                */
    /*                                                                    */
    /* ================================================================== */

    /**
     * @returns {Object} Ext config for Floor Plans tab
     * @private
     */
    _buildFloorPlansTab: function () {
        var me = this;
        return {
            title: (typeof l === 'function') ? l('Floor Plans') : 'Floor Plans',
            iconCls: 'fa fa-map',
            xtype: 'panel',
            itemId: 'tabFloorPlans',
            layout: { type: 'vbox', align: 'stretch' },
            bodyPadding: 10,
            autoScroll: true,
            items: [
                /* -- Floor selector ----------------------------------- */
                {
                    xtype: 'combo',
                    fieldLabel: (typeof l === 'function') ? l('Floor') : 'Floor',
                    itemId: 'floorCombo',
                    labelWidth: 100,
                    displayField: 'name',
                    valueField: 'id',
                    store: Ext.create('Ext.data.Store', {
                        fields: ['id', 'name', 'plan_url', 'calibration', 'anchors', 'bounds', 'level'],
                        data: []
                    }),
                    queryMode: 'local',
                    editable: false,
                    listeners: { change: me.onFloorSelect, scope: me }
                },
                /* -- Floor plan URL ----------------------------------- */
                {
                    xtype: 'textfield',
                    fieldLabel: (typeof l === 'function') ? l('Floor Plan URL') : 'Floor Plan URL',
                    itemId: 'floorPlanUrl',
                    labelWidth: 100,
                    emptyText: '/store/indoor-positioning/plans/floor1.png'
                },
                /* -- Image bounds ------------------------------------- */
                {
                    xtype: 'fieldset',
                    title: (typeof l === 'function') ? l('Image Bounds (pixel)') : 'Image Bounds (pixel)',
                    layout: { type: 'hbox' },
                    defaults: { flex: 1, margin: '0 5 0 0' },
                    items: [
                        { xtype: 'numberfield', fieldLabel: 'Min X', itemId: 'boundMinX', value: 0, labelWidth: 40 },
                        { xtype: 'numberfield', fieldLabel: 'Min Y', itemId: 'boundMinY', value: 0, labelWidth: 40 },
                        { xtype: 'numberfield', fieldLabel: 'Max X', itemId: 'boundMaxX', value: 1000, labelWidth: 40 },
                        { xtype: 'numberfield', fieldLabel: 'Max Y', itemId: 'boundMaxY', value: 800, labelWidth: 40 }
                    ]
                },
                /* -- 3-point calibration ------------------------------ */
                {
                    xtype: 'fieldset',
                    title: (typeof l === 'function') ? l('3-Point Calibration') : '3-Point Calibration',
                    collapsible: true,
                    collapsed: true,
                    items: [
                        {
                            xtype: 'displayfield',
                            value: (typeof l === 'function')
                                ? l('Map pixel coordinates to geographic coordinates using 3 reference points.')
                                : 'Map pixel coordinates to geographic coordinates using 3 reference points.'
                        },
                        me._buildCalibrationPointFields('1', 0, 0, 25.2048, 55.2708),
                        me._buildCalibrationPointFields('2', 1000, 0, 25.2048, 55.2718),
                        me._buildCalibrationPointFields('3', 0, 800, 25.2055, 55.2708)
                    ]
                },
                /* -- Anchor positions --------------------------------- */
                {
                    xtype: 'grid',
                    title: (typeof l === 'function') ? l('Anchor Positions') : 'Anchor Positions',
                    itemId: 'anchorGrid',
                    height: 160,
                    collapsible: true,
                    collapsed: true,
                    store: Ext.create('Ext.data.Store', {
                        fields: ['id', 'x', 'y', 'z'],
                        data: []
                    }),
                    columns: [
                        { text: 'ID', dataIndex: 'id', flex: 1, editor: { xtype: 'textfield' } },
                        { text: 'X', dataIndex: 'x', width: 80, editor: { xtype: 'numberfield', decimalPrecision: 2 } },
                        { text: 'Y', dataIndex: 'y', width: 80, editor: { xtype: 'numberfield', decimalPrecision: 2 } },
                        { text: 'Z', dataIndex: 'z', width: 80, editor: { xtype: 'numberfield', decimalPrecision: 2 } }
                    ],
                    plugins: [{ ptype: 'cellediting', clicksToEdit: 1 }],
                    tbar: [
                        { text: (typeof l === 'function') ? l('Add') : 'Add', iconCls: 'fa fa-plus', handler: me.addAnchor, scope: me },
                        { text: (typeof l === 'function') ? l('Remove') : 'Remove', iconCls: 'fa fa-minus', handler: me.removeAnchor, scope: me }
                    ]
                },
                /* -- Action buttons ----------------------------------- */
                {
                    xtype: 'container',
                    layout: 'hbox',
                    margin: '10 0 0 0',
                    items: [
                        {
                            xtype: 'button',
                            text: (typeof l === 'function') ? l('Load on Map') : 'Load on Map',
                            iconCls: 'fa fa-map',
                            handler: me.loadPlanOnMap,
                            scope: me
                        },
                        {
                            xtype: 'button',
                            text: (typeof l === 'function') ? l('Save Floor to Engine') : 'Save Floor to Engine',
                            iconCls: 'fa fa-cloud-upload-alt',
                            margin: '0 0 0 10',
                            handler: me.saveFloorToEngine,
                            scope: me
                        },
                        {
                            xtype: 'button',
                            text: (typeof l === 'function') ? l('Save Calibration') : 'Save Calibration',
                            iconCls: 'fa fa-crosshairs',
                            margin: '0 0 0 10',
                            handler: me.saveCalibrationToEngine,
                            scope: me
                        },
                        {
                            xtype: 'button',
                            text: (typeof l === 'function') ? l('Save Anchors') : 'Save Anchors',
                            iconCls: 'fa fa-anchor',
                            margin: '0 0 0 10',
                            handler: me.saveAnchorsToEngine,
                            scope: me
                        }
                    ]
                },
                /* -- Hint -------------------------------------------- */
                {
                    xtype: 'displayfield',
                    itemId: 'floorPlanHint',
                    value: (typeof l === 'function')
                        ? l('Set engine URL in General or Velavu/CS tab to load/save from positioning engine.')
                        : 'Set engine URL in General or Velavu/CS tab to load/save from positioning engine.',
                    margin: '10 0 0 0',
                    hidden: true
                }
            ]
        };
    },

    /**
     * Build a set of calibration point fields.
     *
     * @param {string} num -- point number ('1', '2', '3')
     * @param {number} px -- default pixel X
     * @param {number} py -- default pixel Y
     * @param {number} lat -- default latitude
     * @param {number} lon -- default longitude
     * @returns {Object}
     * @private
     */
    _buildCalibrationPointFields: function (num, px, py, lat, lon) {
        return {
            xtype: 'fieldcontainer',
            fieldLabel: ((typeof l === 'function') ? l('Point') : 'Point') + ' ' + num,
            labelWidth: 60,
            layout: 'hbox',
            defaults: { margin: '0 5 0 0' },
            items: [
                { xtype: 'numberfield', emptyText: 'Pixel X', itemId: 'cal' + num + 'x', value: px, width: 90, decimalPrecision: 0 },
                { xtype: 'numberfield', emptyText: 'Pixel Y', itemId: 'cal' + num + 'y', value: py, width: 90, decimalPrecision: 0 },
                { xtype: 'numberfield', emptyText: 'Lat', itemId: 'cal' + num + 'lat', value: lat, width: 110, decimalPrecision: 6 },
                { xtype: 'numberfield', emptyText: 'Lon', itemId: 'cal' + num + 'lon', value: lon, width: 110, decimalPrecision: 6 }
            ]
        };
    },

    /* ================================================================== */
    /*                                                                    */
    /*  TAB 5: ALERTS                                                     */
    /*                                                                    */
    /* ================================================================== */

    /**
     * @returns {Object} Ext config for Alerts tab
     * @private
     */
    _buildAlertsTab: function () {
        return {
            title: (typeof l === 'function') ? l('Alerts') : 'Alerts',
            iconCls: 'fa fa-bell',
            xtype: 'form',
            itemId: 'tabAlerts',
            bodyPadding: 15,
            layout: { type: 'vbox', align: 'stretch' },
            defaults: { labelWidth: 180, anchor: '100%' },
            autoScroll: true,
            items: [
                {
                    xtype: 'fieldset',
                    title: (typeof l === 'function') ? l('Battery Thresholds') : 'Battery Thresholds',
                    defaults: { labelWidth: 180 },
                    items: [
                        {
                            xtype: 'numberfield',
                            fieldLabel: (typeof l === 'function') ? l('Warning Level (%)') : 'Warning Level (%)',
                            itemId: 'numBattWarning',
                            value: 20,
                            minValue: 5,
                            maxValue: 50,
                            step: 5
                        },
                        {
                            xtype: 'numberfield',
                            fieldLabel: (typeof l === 'function') ? l('Critical Level (%)') : 'Critical Level (%)',
                            itemId: 'numBattCritical',
                            value: 5,
                            minValue: 1,
                            maxValue: 25,
                            step: 1
                        }
                    ]
                },
                {
                    xtype: 'fieldset',
                    title: (typeof l === 'function') ? l('Device Offline') : 'Device Offline',
                    defaults: { labelWidth: 180 },
                    items: [
                        {
                            xtype: 'numberfield',
                            fieldLabel: (typeof l === 'function') ? l('Offline Timeout (seconds)') : 'Offline Timeout (seconds)',
                            itemId: 'numOfflineTimeout',
                            value: 120,
                            minValue: 30,
                            maxValue: 3600,
                            step: 30
                        }
                    ]
                },
                {
                    xtype: 'fieldset',
                    title: (typeof l === 'function') ? l('Speed Alert') : 'Speed Alert',
                    defaults: { labelWidth: 180 },
                    items: [
                        {
                            xtype: 'numberfield',
                            fieldLabel: (typeof l === 'function') ? l('Speed Limit (m/s)') : 'Speed Limit (m/s)',
                            itemId: 'numSpeedLimit',
                            value: 5,
                            minValue: 0,
                            maxValue: 50,
                            step: 1,
                            decimalPrecision: 1
                        }
                    ]
                },
                {
                    xtype: 'fieldset',
                    title: (typeof l === 'function') ? l('Notifications') : 'Notifications',
                    items: [
                        {
                            xtype: 'checkbox',
                            boxLabel: (typeof l === 'function') ? l('Show toast notifications for alerts') : 'Show toast notifications for alerts',
                            itemId: 'chkToastAlerts',
                            checked: true
                        },
                        {
                            xtype: 'checkbox',
                            boxLabel: (typeof l === 'function') ? l('Sound for critical alerts') : 'Sound for critical alerts',
                            itemId: 'chkSoundAlerts',
                            checked: false
                        },
                        {
                            xtype: 'checkbox',
                            boxLabel: (typeof l === 'function') ? l('Battery low notifications') : 'Battery low notifications',
                            itemId: 'chkBatteryNotify',
                            checked: true
                        },
                        {
                            xtype: 'checkbox',
                            boxLabel: (typeof l === 'function') ? l('Device offline notifications') : 'Device offline notifications',
                            itemId: 'chkOfflineNotify',
                            checked: true
                        },
                        {
                            xtype: 'checkbox',
                            boxLabel: (typeof l === 'function') ? l('Zone entry/exit notifications') : 'Zone entry/exit notifications',
                            itemId: 'chkZoneNotify',
                            checked: true
                        },
                        {
                            xtype: 'checkbox',
                            boxLabel: (typeof l === 'function') ? l('Speed limit notifications') : 'Speed limit notifications',
                            itemId: 'chkSpeedNotify',
                            checked: false
                        }
                    ]
                }
            ]
        };
    },

    /* ================================================================== */
    /*                                                                    */
    /*  TAB 6: ABOUT                                                      */
    /*                                                                    */
    /* ================================================================== */

    /**
     * @returns {Object} Ext config for About tab
     * @private
     */
    _buildAboutTab: function () {
        return {
            title: (typeof l === 'function') ? l('About') : 'About',
            iconCls: 'fa fa-info-circle',
            xtype: 'panel',
            itemId: 'tabAbout',
            bodyPadding: 15,
            autoScroll: true,
            items: [
                {
                    xtype: 'displayfield',
                    itemId: 'aboutVersion',
                    fieldLabel: (typeof l === 'function') ? l('Version') : 'Version',
                    labelWidth: 140,
                    value: '4.0.0'
                },
                {
                    xtype: 'displayfield',
                    itemId: 'aboutEngine',
                    fieldLabel: (typeof l === 'function') ? l('Active Engine') : 'Active Engine',
                    labelWidth: 140,
                    value: '—'
                },
                {
                    xtype: 'displayfield',
                    itemId: 'aboutEngineStatus',
                    fieldLabel: (typeof l === 'function') ? l('Engine Status') : 'Engine Status',
                    labelWidth: 140,
                    value: '<span class="indoor-status-dot indoor-offline"></span> Unknown'
                },
                {
                    xtype: 'displayfield',
                    itemId: 'aboutDeviceCount',
                    fieldLabel: (typeof l === 'function') ? l('Total Devices') : 'Total Devices',
                    labelWidth: 140,
                    value: '0'
                },
                {
                    xtype: 'displayfield',
                    itemId: 'aboutOnlineCount',
                    fieldLabel: (typeof l === 'function') ? l('Online Devices') : 'Online Devices',
                    labelWidth: 140,
                    value: '0'
                },
                {
                    xtype: 'displayfield',
                    itemId: 'aboutUptime',
                    fieldLabel: (typeof l === 'function') ? l('Session Uptime') : 'Session Uptime',
                    labelWidth: 140,
                    value: '—'
                },
                {
                    xtype: 'displayfield',
                    margin: '20 0 0 0',
                    value: '<hr style="border:none;border-top:1px solid #e5e7eb;margin:5px 0"/>' +
                           '<b>PILOT Indoor Positioning Extension v4.0</b><br/>' +
                           'Dual-engine architecture: Velavu Cloud + BLE Channel Sounding<br/>' +
                           'ELA Innovation / Wirepas mesh support<br/>' +
                           '<br/><span style="color:#94a3b8">Built for PILOT Telematics Platform</span>'
                }
            ]
        };
    },

    /**
     * Update the About tab with current runtime info.
     * @private
     */
    _updateAboutTab: function () {
        var me = this;
        var config = me.getAppConfig() || {};
        var version = (config.version) || '4.0.0';

        var aboutVersion = me.down('#aboutVersion');
        if (aboutVersion) aboutVersion.setValue(version);

        var engineLabel = me.getActiveEngine() || 'velavu';
        var aboutEngine = me.down('#aboutEngine');
        if (aboutEngine) {
            var engines = config.engines || {};
            var cfg = engines[engineLabel];
            aboutEngine.setValue((cfg && cfg.label) ? cfg.label : engineLabel);
        }

        // Try to get device counts from the device store
        var deviceStore = Ext.getStore('indoorDevicesStore');
        if (deviceStore) {
            var total = deviceStore.getCount();
            var online = 0;
            deviceStore.each(function (r) {
                if (r.get('online') || r.get('status') === 'online') online++;
            });
            var aboutTotal = me.down('#aboutDeviceCount');
            if (aboutTotal) aboutTotal.setValue(String(total));
            var aboutOnline = me.down('#aboutOnlineCount');
            if (aboutOnline) aboutOnline.setValue(String(online));
        }

        // Session uptime (time since page load)
        if (window.performance && window.performance.now) {
            var uptimeMs = window.performance.now();
            var uptimeSec = Math.floor(uptimeMs / 1000);
            var hours = Math.floor(uptimeSec / 3600);
            var minutes = Math.floor((uptimeSec % 3600) / 60);
            var seconds = uptimeSec % 60;
            var uptimeStr = hours + 'h ' + minutes + 'm ' + seconds + 's';
            var aboutUptime = me.down('#aboutUptime');
            if (aboutUptime) aboutUptime.setValue(uptimeStr);
        }
    },

    /* ================================================================== */
    /*                                                                    */
    /*  LOAD CURRENT SETTINGS                                             */
    /*                                                                    */
    /* ================================================================== */

    /**
     * Populate form fields from the current app config.
     * @private
     */
    _loadCurrentSettings: function () {
        var me = this;
        var config = me.getAppConfig() || {};
        var settings = config.settings || {};
        var engines = config.engines || {};

        // General tab
        var cmbEngine = me.down('#cmbEngine');
        if (cmbEngine) cmbEngine.setValue(settings.defaultEngine || me.getActiveEngine() || 'velavu');

        var numPoll = me.down('#numPollInterval');
        if (numPoll) numPoll.setValue(settings.deviceRefreshInterval || 10000);

        var chkAnchors = me.down('#chkShowAnchors');
        if (chkAnchors) chkAnchors.setValue(!!settings.showAnchors);

        var chkSensors = me.down('#chkShowSensors');
        if (chkSensors) chkSensors.setValue(settings.showSensorData !== false);

        // Velavu tab
        var velavuCfg = engines.velavu || {};
        var txtVUrl = me.down('#txtVelavuUrl');
        if (txtVUrl) txtVUrl.setValue(velavuCfg.apiBase || '/api/velavu');

        var txtVToken = me.down('#txtVelavuToken');
        if (txtVToken && velavuCfg.token) txtVToken.setValue(velavuCfg.token);

        // CS tab
        var csCfg = engines.channelSounding || {};
        var txtCSUrl = me.down('#txtCSEngineUrl');
        if (txtCSUrl) txtCSUrl.setValue(csCfg.apiBase || '/api/indoor');

        var txtMqtt = me.down('#txtMqttBroker');
        if (txtMqtt && csCfg.mqttBroker) txtMqtt.setValue(csCfg.mqttBroker);

        var numMinAnc = me.down('#numMinAnchors');
        if (numMinAnc && csCfg.minAnchors) numMinAnc.setValue(csCfg.minAnchors);

        // Path loss model
        var pathLoss = csCfg.pathLoss || {};
        var numRefRssi = me.down('#numRefRssi');
        if (numRefRssi && pathLoss.referenceRssi !== undefined) numRefRssi.setValue(pathLoss.referenceRssi);
        var numPLE = me.down('#numPathLossExp');
        if (numPLE && pathLoss.exponent !== undefined) numPLE.setValue(pathLoss.exponent);
        var numEnv = me.down('#numEnvFactor');
        if (numEnv && pathLoss.environmentFactor !== undefined) numEnv.setValue(pathLoss.environmentFactor);

        // Alerts tab
        var alerts = settings.alerts || {};
        var numBW = me.down('#numBattWarning');
        if (numBW && alerts.batteryWarning !== undefined) numBW.setValue(alerts.batteryWarning);
        var numBC = me.down('#numBattCritical');
        if (numBC && alerts.batteryCritical !== undefined) numBC.setValue(alerts.batteryCritical);
        var numOT = me.down('#numOfflineTimeout');
        if (numOT && alerts.offlineTimeout !== undefined) numOT.setValue(alerts.offlineTimeout);
        var numSL = me.down('#numSpeedLimit');
        if (numSL && alerts.speedLimit !== undefined) numSL.setValue(alerts.speedLimit);

        var notifications = settings.notifications || {};
        var chkToast = me.down('#chkToastAlerts');
        if (chkToast && notifications.toast !== undefined) chkToast.setValue(notifications.toast);
        var chkSound = me.down('#chkSoundAlerts');
        if (chkSound && notifications.sound !== undefined) chkSound.setValue(notifications.sound);
        var chkBatt = me.down('#chkBatteryNotify');
        if (chkBatt && notifications.battery !== undefined) chkBatt.setValue(notifications.battery);
        var chkOffline = me.down('#chkOfflineNotify');
        if (chkOffline && notifications.offline !== undefined) chkOffline.setValue(notifications.offline);
        var chkZone = me.down('#chkZoneNotify');
        if (chkZone && notifications.zone !== undefined) chkZone.setValue(notifications.zone);
        var chkSpeed = me.down('#chkSpeedNotify');
        if (chkSpeed && notifications.speed !== undefined) chkSpeed.setValue(notifications.speed);
    },

    /* ================================================================== */
    /*                                                                    */
    /*  FLOOR PLAN MANAGEMENT                                             */
    /*                                                                    */
    /* ================================================================== */

    /**
     * @returns {Ext.data.Store}
     */
    getFloorsStore: function () {
        var combo = this.down('#floorCombo');
        return combo ? combo.getStore() : null;
    },

    /**
     * @returns {Ext.data.Model|null}
     */
    getSelectedFloor: function () {
        var combo = this.down('#floorCombo');
        return combo ? combo.getSelectedRecord() : null;
    },

    /**
     * Load floors from the engine API.
     */
    loadFloorsFromEngine: function () {
        var me = this;
        var base = me.getEngineBaseUrl();
        if (!base) {
            var hint = me.down('#floorPlanHint');
            if (hint) hint.setHidden(false);
            return;
        }

        var hint2 = me.down('#floorPlanHint');
        if (hint2) hint2.setHidden(true);

        Ext.Ajax.request({
            url: base + '/api/indoor/floors',
            method: 'GET',
            success: function (resp) {
                var data;
                try {
                    data = Ext.JSON.decode(resp.responseText);
                } catch (e) { return; }
                var floors = data.floors || data.data || [];
                var store = me.getFloorsStore();
                if (store) {
                    store.loadData(floors);
                    if (floors.length && !me.down('#floorCombo').getValue()) {
                        me.down('#floorCombo').setValue(floors[0].id);
                    }
                }
            },
            failure: function () {
                console.warn('[Indoor v4] AdminPanel: Could not load floors');
            }
        });
    },

    /**
     * Handle floor combo selection -- populate form fields.
     */
    onFloorSelect: function () {
        var me = this;
        var floor = me.getSelectedFloor();
        if (!floor) return;
        var rec = floor.getData ? floor.getData() : floor;

        // Floor plan URL
        var urlField = me.down('#floorPlanUrl');
        if (urlField) urlField.setValue(rec.plan_url || '');

        // Bounds
        var b = rec.bounds || [[0, 0], [1000, 800]];
        me.down('#boundMinX').setValue(Array.isArray(b[0]) ? b[0][0] : 0);
        me.down('#boundMinY').setValue(Array.isArray(b[0]) ? b[0][1] : 0);
        me.down('#boundMaxX').setValue(Array.isArray(b[1]) ? b[1][0] : 1000);
        me.down('#boundMaxY').setValue(Array.isArray(b[1]) ? b[1][1] : 800);

        // Calibration
        var cal = rec.calibration && rec.calibration.points;
        if (cal && cal.length >= 3) {
            for (var i = 0; i < 3; i++) {
                var num = String(i + 1);
                me.down('#cal' + num + 'x').setValue(cal[i].pixel[0]);
                me.down('#cal' + num + 'y').setValue(cal[i].pixel[1]);
                me.down('#cal' + num + 'lat').setValue(cal[i].geo[0]);
                me.down('#cal' + num + 'lon').setValue(cal[i].geo[1]);
            }
        }

        // Anchors
        var anchors = rec.anchors || [];
        var grid = me.down('#anchorGrid');
        if (grid && grid.getStore()) {
            grid.getStore().loadData(anchors);
        }
    },

    /**
     * Load the current floor plan on the map view.
     */
    loadPlanOnMap: function () {
        var me = this;
        var url = me.down('#floorPlanUrl').getValue();
        var minX = me.down('#boundMinX').getValue();
        var minY = me.down('#boundMinY').getValue();
        var maxX = me.down('#boundMaxX').getValue();
        var maxY = me.down('#boundMaxY').getValue();
        var bounds = [[minY, minX], [maxY, maxX]];
        var mp = me.getMapPanel();
        if (mp) {
            if (mp.updateFloorPlanOverlay) mp.updateFloorPlanOverlay(url, bounds);
            if (mp.setMapCenterBounds) mp.setMapCenterBounds(bounds);
        }
    },

    /**
     * Save floor plan URL and bounds to the engine.
     */
    saveFloorToEngine: function () {
        var me = this;
        var base = me.getEngineBaseUrl();
        var floor = me.getSelectedFloor();
        if (!base || !floor) {
            Ext.Msg.alert(
                (typeof l === 'function') ? l('Save') : 'Save',
                (typeof l === 'function') ? l('Connect to engine and select a floor.') : 'Connect to engine and select a floor.'
            );
            return;
        }
        var floorId = floor.get ? floor.get('id') : floor.id;
        var url = me.down('#floorPlanUrl').getValue();
        var minX = me.down('#boundMinX').getValue();
        var minY = me.down('#boundMinY').getValue();
        var maxX = me.down('#boundMaxX').getValue();
        var maxY = me.down('#boundMaxY').getValue();

        Ext.Ajax.request({
            url: base + '/api/indoor/floors/' + floorId,
            method: 'PUT',
            jsonData: {
                plan_url: url || undefined,
                bounds: [[minX, minY], [maxX, maxY]]
            },
            success: function () {
                Ext.Msg.alert(
                    (typeof l === 'function') ? l('Saved') : 'Saved',
                    (typeof l === 'function') ? l('Floor plan saved to engine.') : 'Floor plan saved to engine.'
                );
            },
            failure: function () {
                Ext.Msg.alert(
                    (typeof l === 'function') ? l('Error') : 'Error',
                    (typeof l === 'function') ? l('Could not save to engine.') : 'Could not save to engine.'
                );
            }
        });
    },

    /**
     * Save calibration points to the engine.
     */
    saveCalibrationToEngine: function () {
        var me = this;
        var base = me.getEngineBaseUrl();
        var floor = me.getSelectedFloor();
        if (!base || !floor) {
            Ext.Msg.alert(
                (typeof l === 'function') ? l('Save') : 'Save',
                (typeof l === 'function') ? l('Connect to engine and select a floor.') : 'Connect to engine and select a floor.'
            );
            return;
        }
        var floorId = floor.get ? floor.get('id') : floor.id;
        var pts = [];
        for (var i = 1; i <= 3; i++) {
            var num = String(i);
            pts.push({
                pixel: [me.down('#cal' + num + 'x').getValue(), me.down('#cal' + num + 'y').getValue()],
                geo: [me.down('#cal' + num + 'lat').getValue(), me.down('#cal' + num + 'lon').getValue()]
            });
        }

        Ext.Ajax.request({
            url: base + '/api/indoor/floors/' + floorId,
            method: 'PUT',
            jsonData: { calibration: { points: pts } },
            success: function () {
                Ext.Msg.alert(
                    (typeof l === 'function') ? l('Saved') : 'Saved',
                    (typeof l === 'function') ? l('Calibration saved to engine.') : 'Calibration saved to engine.'
                );
            },
            failure: function () {
                Ext.Msg.alert(
                    (typeof l === 'function') ? l('Error') : 'Error',
                    (typeof l === 'function') ? l('Could not save calibration.') : 'Could not save calibration.'
                );
            }
        });
    },

    /* ------------------------------------------------------------------ */
    /*  Anchor Management                                                 */
    /* ------------------------------------------------------------------ */

    addAnchor: function () {
        var grid = this.down('#anchorGrid');
        if (grid && grid.getStore()) {
            grid.getStore().add({
                id: 'anchor_' + (grid.getStore().getCount() + 1),
                x: 0,
                y: 0,
                z: 2.5
            });
        }
    },

    removeAnchor: function () {
        var grid = this.down('#anchorGrid');
        if (grid) {
            var sel = grid.getSelectionModel().getSelection();
            if (sel.length) grid.getStore().remove(sel);
        }
    },

    /**
     * Save anchor positions to the engine.
     */
    saveAnchorsToEngine: function () {
        var me = this;
        var base = me.getEngineBaseUrl();
        var floor = me.getSelectedFloor();
        if (!base || !floor) {
            Ext.Msg.alert(
                (typeof l === 'function') ? l('Save') : 'Save',
                (typeof l === 'function') ? l('Connect to engine and select a floor.') : 'Connect to engine and select a floor.'
            );
            return;
        }
        var floorId = floor.get ? floor.get('id') : floor.id;
        var grid = me.down('#anchorGrid');
        var anchors = [];
        if (grid && grid.getStore()) {
            grid.getStore().getData().each(function (r) {
                anchors.push({
                    id: r.get('id'),
                    x: r.get('x'),
                    y: r.get('y'),
                    z: r.get('z')
                });
            });
        }

        Ext.Ajax.request({
            url: base + '/api/indoor/floors/' + floorId,
            method: 'PUT',
            jsonData: { anchors: anchors },
            success: function () {
                Ext.Msg.alert(
                    (typeof l === 'function') ? l('Saved') : 'Saved',
                    (typeof l === 'function') ? l('Anchors saved to engine.') : 'Anchors saved to engine.'
                );
            },
            failure: function () {
                Ext.Msg.alert(
                    (typeof l === 'function') ? l('Error') : 'Error',
                    (typeof l === 'function') ? l('Could not save anchors.') : 'Could not save anchors.'
                );
            }
        });
    },

    /* ================================================================== */
    /*                                                                    */
    /*  SAVE ALL SETTINGS                                                 */
    /*                                                                    */
    /* ================================================================== */

    /**
     * Collect all settings from all tabs and persist them.
     * Posts to the engine's /api/indoor/settings endpoint if available,
     * otherwise logs the config to console for manual copy.
     */
    onSaveSettings: function () {
        var me = this;

        var settings = {
            defaultEngine: me.down('#cmbEngine').getValue(),
            deviceRefreshInterval: me.down('#numPollInterval').getValue(),
            showAnchors: me.down('#chkShowAnchors').getValue(),
            showSensorData: me.down('#chkShowSensors').getValue(),
            alerts: {
                batteryWarning: me.down('#numBattWarning').getValue(),
                batteryCritical: me.down('#numBattCritical').getValue(),
                offlineTimeout: me.down('#numOfflineTimeout').getValue(),
                speedLimit: me.down('#numSpeedLimit').getValue()
            },
            notifications: {
                toast: me.down('#chkToastAlerts').getValue(),
                sound: me.down('#chkSoundAlerts').getValue(),
                battery: me.down('#chkBatteryNotify').getValue(),
                offline: me.down('#chkOfflineNotify').getValue(),
                zone: me.down('#chkZoneNotify').getValue(),
                speed: me.down('#chkSpeedNotify').getValue()
            }
        };

        var engines = {
            velavu: {
                enabled: true,
                label: 'Velavu Cloud',
                apiBase: me.down('#txtVelavuUrl').getValue() || '/api/velavu',
                token: me.down('#txtVelavuToken').getValue() || undefined
            },
            channelSounding: {
                enabled: true,
                label: 'Channel Sounding',
                apiBase: me.down('#txtCSEngineUrl').getValue() || '/api/indoor',
                mqttBroker: me.down('#txtMqttBroker').getValue() || 'mqtt://localhost:1883',
                minAnchors: me.down('#numMinAnchors').getValue(),
                pathLoss: {
                    referenceRssi: me.down('#numRefRssi').getValue(),
                    exponent: me.down('#numPathLossExp').getValue(),
                    environmentFactor: me.down('#numEnvFactor').getValue()
                }
            }
        };

        var fullConfig = {
            settings: settings,
            engines: engines
        };

        var base = me.getEngineBaseUrl();
        if (base) {
            Ext.Ajax.request({
                url: base + '/api/indoor/settings',
                method: 'PUT',
                jsonData: fullConfig,
                success: function () {
                    Ext.Msg.alert(
                        (typeof l === 'function') ? l('Saved') : 'Saved',
                        (typeof l === 'function') ? l('Settings saved to engine.') : 'Settings saved to engine.'
                    );
                },
                failure: function () {
                    // Fallback: log to console
                    console.log('[Indoor v4] Settings (copy to config.json):', JSON.stringify(fullConfig, null, 2));
                    Ext.Msg.alert(
                        (typeof l === 'function') ? l('Settings') : 'Settings',
                        (typeof l === 'function')
                            ? l('Could not save to engine. Settings logged to browser console. Copy to config.json manually.')
                            : 'Could not save to engine. Settings logged to browser console. Copy to config.json manually.'
                    );
                }
            });
        } else {
            console.log('[Indoor v4] Settings (copy to config.json):', JSON.stringify(fullConfig, null, 2));
            Ext.Msg.alert(
                (typeof l === 'function') ? l('Settings') : 'Settings',
                (typeof l === 'function')
                    ? l('No engine URL configured. Settings logged to browser console. Copy to config.json.')
                    : 'No engine URL configured. Settings logged to browser console. Copy to config.json.'
            );
        }
    },

    /* ================================================================== */
    /*                                                                    */
    /*  CONFIG ACCESSORS                                                  */
    /*                                                                    */
    /* ================================================================== */

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

    setActiveEngine: function (engine) {
        this.activeEngine = engine;
    },

    getActiveEngine: function () {
        return this.activeEngine || 'velavu';
    },

    setAppConfig: function (config) {
        this.appConfig = config;
    },

    getAppConfig: function () {
        return this.appConfig || {};
    }
});
