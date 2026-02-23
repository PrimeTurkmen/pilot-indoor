/**
 * PILOT Extension — Indoor Positioning v3.0
 * Entry point for the Indoor Positioning module.
 * Tracks people and assets indoors using ELA Innovation / Wirepas mesh
 * with BLE 6.0 Channel Sounding support.
 *
 * v3.0: WebSocket real-time updates (positions, zones, alerts).
 *       Falls back to HTTP polling if WebSocket disconnects.
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

        // 9. WebSocket real-time connection (v3.0)
        if (engineBaseUrl) {
            me.connectWebSocket(engineBaseUrl, deviceStore, navTab, mainPanel);
        }
    },

    /**
     * Connect to engine WebSocket for real-time position/zone/alert updates.
     * Falls back to HTTP polling if WebSocket disconnects.
     * Auto-reconnects with exponential backoff (1s → 2s → 4s → max 30s).
     */
    connectWebSocket: function (engineBaseUrl, deviceStore, navTab, mainPanel) {
        var me = this;
        var wsUrl = engineBaseUrl.replace(/^http/, 'ws');
        var reconnectDelay = 1000;
        var maxReconnectDelay = 30000;
        var ws = null;
        var httpPollingTimer = null;

        // Load restricted zone names from engine and push to FloorPlanView + DeviceGrid
        me.loadRestrictedZones(engineBaseUrl, mainPanel);

        function getGrid() {
            return mainPanel ? mainPanel.down('indoor-devicegrid') : null;
        }

        function setWsStatus(connected) {
            var grid = getGrid();
            if (grid && grid.setWsStatus) grid.setWsStatus(connected);
        }

        function startHttpPolling() {
            if (httpPollingTimer) return;
            httpPollingTimer = setInterval(function () {
                deviceStore.load();
            }, 5000);
            setWsStatus(false);
            // Restart grid auto-refresh as fallback
            var grid = getGrid();
            if (grid && !grid.refreshTask) grid.startAutoRefresh();
            console.log('[Indoor WS] Falling back to HTTP polling');
        }

        function stopHttpPolling() {
            if (httpPollingTimer) {
                clearInterval(httpPollingTimer);
                httpPollingTimer = null;
            }
            // Stop grid auto-refresh — WS handles updates now
            var grid = getGrid();
            if (grid && grid.stopAutoRefresh) grid.stopAutoRefresh();
        }

        function connect() {
            try {
                ws = new WebSocket(wsUrl);
            } catch (e) {
                startHttpPolling();
                return;
            }

            ws.onopen = function () {
                console.log('[Indoor WS] Connected to', wsUrl);
                reconnectDelay = 1000;
                stopHttpPolling();
                setWsStatus(true);

                // Subscribe to all channels
                ws.send(JSON.stringify({
                    type: 'subscribe',
                    channels: ['positions', 'zones', 'alerts', 'stats']
                }));
            };

            ws.onmessage = function (event) {
                try {
                    var msg = JSON.parse(event.data);
                } catch (e) {
                    return;
                }

                // Position update — update device store record in-place
                if (msg.type === 'positions' && msg.data) {
                    var d = msg.data;
                    var record = deviceStore.getById(d.id);
                    if (record) {
                        record.set({
                            name: d.name, type: d.type, zone: d.zone,
                            battery: d.battery, temperature: d.temperature,
                            humidity: d.humidity, lastUpdate: d.lastUpdate,
                            status: d.status, isMoving: d.isMoving,
                            x: d.x, y: d.y, floor: d.floor,
                            confidence: d.confidence
                        });
                        record.commit();
                    } else {
                        deviceStore.add(d);
                    }
                    // Refresh markers on map (animated incremental update)
                    if (mainPanel && mainPanel.refreshMarkers) {
                        mainPanel.refreshMarkers();
                    }
                }

                // Zone event — show notification + update map zone overlays
                if (msg.type === 'zones' && msg.data) {
                    var evt = msg.data;
                    if (evt.event === 'enter' && evt.zoneType === 'restricted') {
                        if (typeof Ext.toast === 'function') {
                            Ext.toast({
                                html: '<b>Zone Alert:</b> ' + Ext.String.htmlEncode(evt.deviceId) +
                                      ' entered restricted zone "' + Ext.String.htmlEncode(evt.zoneName) + '"',
                                closable: true,
                                align: 'tr',
                                cls: 'indoor-alert-critical',
                                slideInDuration: 400
                            });
                        }
                        // Refresh markers to show restricted highlighting
                        if (mainPanel && mainPanel.refreshMarkers) {
                            mainPanel.refreshMarkers();
                        }
                    }
                }

                // Alert — show toast notification + update grid alert indicator
                if (msg.type === 'alerts' && msg.data) {
                    var alert = msg.data;
                    if (typeof Ext.toast === 'function') {
                        var cls = alert.severity === 'critical' ? 'indoor-alert-critical' :
                                  alert.severity === 'warning' ? 'indoor-alert-warning' : '';
                        Ext.toast({
                            html: '<b>' + Ext.String.htmlEncode(alert.severity.toUpperCase()) + ':</b> ' +
                                  Ext.String.htmlEncode(alert.message),
                            closable: true,
                            align: 'tr',
                            cls: cls,
                            slideInDuration: 400
                        });
                    }
                    // Update alert indicator on device grid row
                    var grid = getGrid();
                    if (grid && grid.setDeviceAlert && alert.deviceId) {
                        grid.setDeviceAlert(alert.deviceId, alert.severity);
                    }
                }

                // Stats — update nav panel title with device count
                if (msg.type === 'stats' && msg.data) {
                    var s = msg.data;
                    if (navTab && s.devicesOnline !== undefined) {
                        navTab.setTitle(
                            ((typeof l === 'function') ? l('Indoor Positioning') : 'Indoor Positioning') +
                            ' (' + s.devicesOnline + '/' + s.devicesTotal + ')'
                        );
                    }
                }
            };

            ws.onclose = function () {
                console.log('[Indoor WS] Disconnected, reconnecting in', reconnectDelay, 'ms');
                setWsStatus(false);
                startHttpPolling();
                setTimeout(function () {
                    reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
                    connect();
                }, reconnectDelay);
            };

            ws.onerror = function () {
                // onclose will fire after onerror
            };
        }

        connect();
        me._ws = ws;
    },

    /**
     * Load restricted zone names from engine API and push to FloorPlanView + DeviceGrid.
     * This enables red-highlight markers for devices in restricted zones and
     * restricted-zone badges in the grid's Zone column.
     */
    loadRestrictedZones: function (engineBaseUrl, mainPanel) {
        Ext.Ajax.request({
            url: engineBaseUrl + '/api/indoor/zones',
            method: 'GET',
            success: function (resp) {
                try {
                    var data = Ext.JSON.decode(resp.responseText);
                    var zones = data.zones || [];
                    // Build restricted names hash
                    var restricted = {};
                    for (var i = 0; i < zones.length; i++) {
                        if (zones[i].type === 'restricted') {
                            restricted[zones[i].name] = true;
                        }
                    }
                    // Push to FloorPlanView
                    if (mainPanel && mainPanel.updateRestrictedZones) {
                        mainPanel.updateRestrictedZones(zones);
                    }
                    // Push to DeviceGrid
                    if (mainPanel) {
                        var grid = mainPanel.down('indoor-devicegrid');
                        if (grid && grid.setRestrictedZones) {
                            grid.setRestrictedZones(restricted);
                        }
                    }
                } catch (e) {}
            }
        });
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
