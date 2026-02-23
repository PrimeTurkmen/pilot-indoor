/**
 * PILOT Extension — Indoor Positioning
 * Entry point for the Indoor Positioning module.
 * Tracks people and assets indoors using ELA Innovation / Wirepas mesh
 * with BLE 6.0 Channel Sounding support.
 *
 * @see pilot_extensions/AI_SPECS.md
 * @see pilot_extensions/examples/template-app
 * @see pilot_extensions/examples/airports
 */

Ext.define('Store.indoor-positioning.Module', {
    extend: 'Ext.Component',

    initModule: function () {
        var me = this;
        me.loadConfig(function (config) {
            me.appConfig = config || {};
            me.initUI();
        });
        me.loadStyles();
    },

    loadConfig: function (callback) {
        var base = (typeof Store !== 'undefined' && Store.indoorPositioningBaseUrl) ?
            Store.indoorPositioningBaseUrl : '/store/indoor-positioning/';
        Ext.Ajax.request({
            url: base + 'config.json',
            method: 'GET',
            success: function (resp) {
                try {
                    callback(Ext.JSON.decode(resp.responseText));
                } catch (e) {
                    callback({});
                }
            },
            failure: function () {
                callback({});
            }
        });
    },

    initUI: function () {
        var me = this;
        var config = me.appConfig || {};
        var settings = config.settings || {};

        // 1. Shared device store and engine API base (for load/save floor plans, calibration, anchors)
        var devicesApiUrl = settings.devicesApiUrl || '/ax/indoor/devices.php';
        var engineBaseUrl = (devicesApiUrl && devicesApiUrl.indexOf('/api/indoor/devices') !== -1) ?
            devicesApiUrl.replace(/\/api\/indoor\/devices\/?$/, '') : '';
        var refreshInterval = settings.deviceRefreshInterval || 5000;
        var deviceStore = Ext.create('Ext.data.Store', {
            storeId: 'indoorDevicesStore',
            fields: ['id', 'name', 'type', 'zone', 'battery', 'temperature', 'humidity', 'lastUpdate', 'status', 'isMoving', 'x', 'y', 'floor', 'confidence'],
            proxy: {
                type: 'ajax',
                url: devicesApiUrl,
                reader: { type: 'json', rootProperty: 'data' }
            },
            autoLoad: true
        });

        // 2. Create navigation tab (left panel)
        var navTab = Ext.create('Store.indoor-positioning.IndoorNavPanel', {});

        // 3. Create main floor plan map panel (receives store for markers)
        var mainPanel = Ext.create('Store.indoor-positioning.FloorPlanView', {
            deviceStore: deviceStore,
            floorPlanBounds: settings.defaultFloorPlanBounds || [[0, 0], [1000, 800]],
            engineBaseUrl: engineBaseUrl
        });

        // 4. Link navigation to map (MANDATORY for Pattern 1)
        navTab.map_frame = mainPanel;

        // 5. Register in PILOT interface
        skeleton.navigation.add(navTab);
        skeleton.mapframe.add(mainPanel);

        // 6. Header buttons for quick access, zones, settings
        if (skeleton.header && skeleton.header.insert) {
            skeleton.header.insert(3, Ext.create('Ext.Button', {
                iconCls: 'fa fa-map-marker-alt',
                tooltip: (typeof l === 'function') ? l('Indoor Positioning') : 'Indoor Positioning',
                handler: function () {
                    skeleton.navigation.setActiveItem(navTab);
                    skeleton.mapframe.setActiveItem(mainPanel);
                }
            }));
            skeleton.header.insert(4, Ext.create('Ext.Button', {
                iconCls: 'fa fa-draw-polygon',
                tooltip: (typeof l === 'function') ? l('Zone Manager') : 'Zone Manager',
                handler: function () {
                    var win = Ext.create('Store.indoor-positioning.ZoneManager', {
                        mapPanel: mainPanel
                    });
                    win.show();
                }
            }));
            skeleton.header.insert(5, Ext.create('Ext.Button', {
                iconCls: 'fa fa-cog',
                tooltip: (typeof l === 'function') ? l('Indoor Settings') : 'Indoor Settings',
                handler: function () {
                    var win = Ext.create('Store.indoor-positioning.AdminPanel', {
                        mapPanel: mainPanel,
                        engineBaseUrl: engineBaseUrl
                    });
                    win.show();
                }
            }));
        }

        // 7. DeviceGrid is inside FloorPlanView (docked); give it the shared store
        mainPanel.on('afterlayout', function () {
            var grid = mainPanel.down('indoor-devicegrid');
            if (grid && deviceStore) {
                grid.bindStore(deviceStore);
                if (refreshInterval > 0) {
                    grid.autoRefreshInterval = refreshInterval;
                    grid.startAutoRefresh();
                }
            }
        }, me, { single: true });

        // 8. Sync nav panel tree with device store (Floor → Zone → Device hierarchy)
        deviceStore.on('load', function () { navTab.refreshFromStore(deviceStore); });
        deviceStore.on('datachanged', function () { navTab.refreshFromStore(deviceStore); });
    },

    loadStyles: function () {
        var base = (typeof Store !== 'undefined' && Store.indoorPositioningBaseUrl) ?
            Store.indoorPositioningBaseUrl : '/store/indoor-positioning/';
        var cssLink = document.createElement('link');
        cssLink.setAttribute('rel', 'stylesheet');
        cssLink.setAttribute('type', 'text/css');
        cssLink.setAttribute('href', base + 'styles.css');
        document.head.appendChild(cssLink);
    }
});
