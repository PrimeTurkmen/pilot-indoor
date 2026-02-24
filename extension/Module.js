/**
 * PILOT Extension -- Indoor Positioning v4.0
 * Main entry point for the Indoor Positioning module.
 *
 * Dual-engine architecture:
 *   1. Velavu Cloud   -- HTTP polling /api/velavu/{devices,sites,assets}
 *                        with optional WebSocket upgrade for real-time.
 *   2. Channel Sounding -- WebSocket-first to /api/indoor engine
 *                          (ELA Innovation / Wirepas mesh, BLE 6.0 CS).
 *
 * On init the module loads config.json, creates shared Ext.data.Store
 * instances (devices, sites, assets), builds the PILOT layout
 * (nav panel, floor plan, device grid, toolbar, status bar), and
 * connects to the selected engine.
 *
 * Engine switching is live -- the toolbar dropdown lets users flip
 * between Velavu and Channel Sounding without page reload.
 *
 * @see config.json          -- engine configuration
 * @see pilot_extensions/AI_SPECS.md
 * @see pilot_extensions/examples/template-app
 */

Ext.define('Store.indoor-positioning.Module', {
    extend: 'Ext.Component',

    /* ------------------------------------------------------------------ */
    /*  Constants                                                         */
    /* ------------------------------------------------------------------ */

    /** Default HTTP polling interval for Velavu engine (ms). */
    VELAVU_POLL_INTERVAL: 10000,

    /** WebSocket reconnect: initial delay (ms). */
    WS_RECONNECT_MIN: 1000,

    /** WebSocket reconnect: maximum backoff cap (ms). */
    WS_RECONNECT_MAX: 30000,

    /** WebSocket channels we subscribe to on connect. */
    WS_CHANNELS: ['positions', 'zones', 'alerts', 'stats'],

    /* ------------------------------------------------------------------ */
    /*  Entry point                                                       */
    /* ------------------------------------------------------------------ */

    /**
     * Called by the PILOT extension loader after all JS files are loaded.
     * Kicks off config load, stylesheet injection, and UI creation.
     */
    initModule: function () {
        var me = this;

        me.loadStyles();

        me.loadConfig(function (config) {
            me.appConfig  = config || {};
            me.engines    = config.engines || {};
            me.settings   = config.settings || {};

            // Resolve active engine from config (default: velavu)
            me.activeEngine = me.settings.defaultEngine || 'velavu';

            // Create shared data stores
            me.createStores();

            // Build UI (panels, toolbar, status bar)
            me.initUI();

            // Connect to the initial engine
            me.connectEngine(me.activeEngine);
        });
    },

    /* ------------------------------------------------------------------ */
    /*  Configuration                                                     */
    /* ------------------------------------------------------------------ */

    /**
     * Resolve the base URL used for all asset paths (CSS, config, plans).
     * Supports Store.indoorPositioningBaseUrl for CDN-hosted deployments.
     *
     * @returns {string}
     */
    getBaseUrl: function () {
        return (typeof Store !== 'undefined' && Store.indoorPositioningBaseUrl)
            ? Store.indoorPositioningBaseUrl
            : '/store/indoor-positioning/';
    },

    /**
     * Load config.json from the extension base URL.
     *
     * @param {Function} callback -- receives parsed config object (or {})
     */
    loadConfig: function (callback) {
        Ext.Ajax.request({
            url: this.getBaseUrl() + 'config.json',
            method: 'GET',
            success: function (resp) {
                try {
                    callback(Ext.JSON.decode(resp.responseText));
                } catch (e) {
                    console.warn('[Indoor v4] config.json parse error:', e);
                    callback({});
                }
            },
            failure: function () {
                console.warn('[Indoor v4] config.json not found, using defaults');
                callback({});
            }
        });
    },

    /**
     * Inject the extension stylesheet.
     */
    loadStyles: function () {
        var link = document.createElement('link');
        link.setAttribute('rel', 'stylesheet');
        link.setAttribute('type', 'text/css');
        link.setAttribute('href', this.getBaseUrl() + 'styles.css');
        document.head.appendChild(link);
    },

    /* ------------------------------------------------------------------ */
    /*  Shared Data Stores                                                */
    /* ------------------------------------------------------------------ */

    /**
     * Create the three shared Ext.data.Stores used by every UI component.
     *
     * deviceStore -- all tracked devices / tags
     * siteStore   -- Velavu sites (buildings / locations)
     * assetStore  -- Velavu assets (logical names mapped to devices)
     *
     * Store fields follow the Velavu normalized format so that both
     * engines can write into the same store shape.
     */
    createStores: function () {
        var me = this;

        me.deviceStore = Ext.create('Ext.data.Store', {
            storeId: 'indoorDevicesStore',
            fields: [
                'id', 'serial', 'name', 'type', 'category',
                'hardware', 'model', 'online', 'battery', 'batteryCharging',
                'usbPower', 'lat', 'lng', 'accuracy', 'locationType',
                'floorId', 'locationTime', 'temperature', 'humidity', 'rssi',
                'installQuality', 'gatewayId', 'siteId', 'appVersion',
                'heartbeat', 'lastUpdate', 'assetId', 'assetName', 'assetGroup',
                /* v3 compat fields used by FloorPlanView / DeviceGrid */
                'status', 'isMoving', 'x', 'y', 'floor', 'zone', 'confidence'
            ],
            data: []
        });

        me.siteStore = Ext.create('Ext.data.Store', {
            storeId: 'indoorSitesStore',
            fields: ['id', 'name', 'address', 'floors', 'latitude', 'longitude'],
            data: []
        });

        me.assetStore = Ext.create('Ext.data.Store', {
            storeId: 'indoorAssetsStore',
            fields: ['id', 'name', 'group', 'deviceId'],
            data: []
        });
    },

    /* ------------------------------------------------------------------ */
    /*  UI Construction                                                   */
    /* ------------------------------------------------------------------ */

    /**
     * Build the full PILOT layout:
     *   - West:   IndoorNavPanel (tree: Site > Floor > Zone > Device)
     *   - Center: FloorPlanView  (Leaflet CRS.Simple map + markers)
     *   - South:  DeviceGrid     (docked inside FloorPlanView)
     *   - Float:  AssetPanel     (opened on demand)
     *   - Header: Toolbar buttons (engine, site, floor, refresh, settings, search)
     *   - Footer: Status bar     (engine name, connection dot, counts, last update)
     */
    initUI: function () {
        var me      = this;
        var config  = me.appConfig;
        var settings = me.settings;

        // Derive engine base URL for Channel Sounding (v3 compat)
        var csApiBase = (me.engines.channelSounding && me.engines.channelSounding.apiBase)
            ? me.engines.channelSounding.apiBase.replace(/\/api\/indoor\/?$/, '')
            : '';

        // ----------------------------------------------------------
        // 1. Navigation panel (west)
        // ----------------------------------------------------------
        me.navPanel = Ext.create('Store.indoor-positioning.IndoorNavPanel', {});

        // ----------------------------------------------------------
        // 2. Floor plan view (center)
        // ----------------------------------------------------------
        me.mainPanel = Ext.create('Store.indoor-positioning.FloorPlanView', {
            deviceStore:     me.deviceStore,
            floorPlanBounds: settings.defaultFloorPlanBounds || [[0, 0], [1000, 800]],
            engineBaseUrl:   csApiBase
        });

        // Link nav panel to map (required for item-click -> map center)
        me.navPanel.map_frame = me.mainPanel;

        // ----------------------------------------------------------
        // 3. Register panels in PILOT skeleton
        // ----------------------------------------------------------
        skeleton.navigation.add(me.navPanel);
        skeleton.mapframe.add(me.mainPanel);

        // ----------------------------------------------------------
        // 4. Header toolbar
        // ----------------------------------------------------------
        me.buildToolbar();

        // ----------------------------------------------------------
        // 5. Status bar (appended to DeviceGrid toolbar on first layout)
        // ----------------------------------------------------------
        me.mainPanel.on('afterlayout', function () {
            var grid = me.mainPanel.down('indoor-devicegrid');
            if (grid && me.deviceStore) {
                grid.bindStore(me.deviceStore);
            }
            me.buildStatusBar();
        }, me, { single: true });

        // ----------------------------------------------------------
        // 6. Sync nav tree with device store changes
        // ----------------------------------------------------------
        me.deviceStore.on('load',        function () { me.navPanel.refreshFromStore(me.deviceStore); });
        me.deviceStore.on('datachanged', function () { me.navPanel.refreshFromStore(me.deviceStore); });
    },

    /* ------------------------------------------------------------------ */
    /*  Toolbar                                                           */
    /* ------------------------------------------------------------------ */

    /**
     * Build header toolbar buttons:
     *   [Engine ▾] [Site ▾] [Floor ▾]  |  Refresh  Settings  [Search ...]
     */
    buildToolbar: function () {
        var me = this;
        if (!skeleton.header || !skeleton.header.insert) return;

        var insertIdx = 3;

        // -- Engine selector dropdown --------------------------------
        var engineItems = [];
        Ext.Object.each(me.engines, function (key, cfg) {
            if (cfg.enabled !== false) {
                engineItems.push({
                    text: cfg.label || key,
                    engineKey: key,
                    checked: key === me.activeEngine,
                    group: 'indoorEngine',
                    handler: function (item) {
                        me.switchEngine(item.engineKey);
                    }
                });
            }
        });

        skeleton.header.insert(insertIdx++, Ext.create('Ext.Button', {
            text: me.getEngineLabel(me.activeEngine),
            itemId: 'indoorEngineBtn',
            iconCls: 'fa fa-satellite-dish',
            tooltip: (typeof l === 'function') ? l('Select positioning engine') : 'Select positioning engine',
            menu: engineItems
        }));

        // -- Site selector dropdown ----------------------------------
        me.siteSelectorBtn = Ext.create('Ext.Button', {
            text: (typeof l === 'function') ? l('Site') : 'Site',
            itemId: 'indoorSiteBtn',
            iconCls: 'fa fa-building',
            tooltip: (typeof l === 'function') ? l('Select site') : 'Select site',
            menu: []
        });
        skeleton.header.insert(insertIdx++, me.siteSelectorBtn);

        // -- Floor selector dropdown ---------------------------------
        me.floorSelectorBtn = Ext.create('Ext.Button', {
            text: (typeof l === 'function') ? l('Floor') : 'Floor',
            itemId: 'indoorFloorBtn',
            iconCls: 'fa fa-layer-group',
            tooltip: (typeof l === 'function') ? l('Select floor') : 'Select floor',
            menu: []
        });
        skeleton.header.insert(insertIdx++, me.floorSelectorBtn);

        // -- Separator -----------------------------------------------
        skeleton.header.insert(insertIdx++, Ext.create('Ext.toolbar.Separator'));

        // -- Focus on indoor positioning button -----------------------
        skeleton.header.insert(insertIdx++, Ext.create('Ext.Button', {
            iconCls: 'fa fa-map-marker-alt',
            tooltip: (typeof l === 'function') ? l('Indoor Positioning') : 'Indoor Positioning',
            handler: function () {
                skeleton.navigation.setActiveItem(me.navPanel);
                skeleton.mapframe.setActiveItem(me.mainPanel);
            }
        }));

        // -- Refresh button ------------------------------------------
        skeleton.header.insert(insertIdx++, Ext.create('Ext.Button', {
            iconCls: 'fa fa-rotate',
            tooltip: (typeof l === 'function') ? l('Refresh devices') : 'Refresh devices',
            handler: function () {
                me.refreshActiveEngine();
            }
        }));

        // -- Settings button -----------------------------------------
        skeleton.header.insert(insertIdx++, Ext.create('Ext.Button', {
            iconCls: 'fa fa-cog',
            tooltip: (typeof l === 'function') ? l('Indoor Settings') : 'Indoor Settings',
            handler: function () {
                var win = Ext.create('Store.indoor-positioning.AdminPanel', {
                    mapPanel: me.mainPanel,
                    engineBaseUrl: me.getActiveEngineBaseUrl()
                });
                win.show();
            }
        }));

        // -- Search field --------------------------------------------
        skeleton.header.insert(insertIdx++, Ext.create('Ext.form.field.Text', {
            itemId: 'indoorSearchField',
            emptyText: (typeof l === 'function') ? l('Search devices...') : 'Search devices...',
            width: 180,
            cls: 'indoor-search-field',
            listeners: {
                change: { fn: me.onGlobalSearch, scope: me, buffer: 300 }
            }
        }));
    },

    /**
     * Get human-readable label for an engine key.
     *
     * @param {string} engineKey
     * @returns {string}
     */
    getEngineLabel: function (engineKey) {
        var cfg = this.engines[engineKey];
        return (cfg && cfg.label) ? cfg.label : engineKey;
    },

    /**
     * Get the API base URL for the currently active engine.
     *
     * @returns {string}
     */
    getActiveEngineBaseUrl: function () {
        var cfg = this.engines[this.activeEngine];
        return (cfg && cfg.apiBase) ? cfg.apiBase : '';
    },

    /**
     * Handle global search field change -- filter device store.
     *
     * @param {Ext.form.field.Text} field
     * @param {string} value
     */
    onGlobalSearch: function (field, value) {
        var me = this;
        var v = (value || '').toLowerCase().trim();
        if (!v) {
            me.deviceStore.clearFilter();
            return;
        }
        me.deviceStore.filterBy(function (rec) {
            var name = (rec.get('name') || '').toLowerCase();
            var serial = (rec.get('serial') || '').toLowerCase();
            var assetName = (rec.get('assetName') || '').toLowerCase();
            return name.indexOf(v) !== -1 ||
                   serial.indexOf(v) !== -1 ||
                   assetName.indexOf(v) !== -1;
        });
    },

    /* ------------------------------------------------------------------ */
    /*  Status Bar                                                        */
    /* ------------------------------------------------------------------ */

    /**
     * Build the status bar at the bottom of the DeviceGrid toolbar.
     * Shows: engine name, connection dot, device counts, last update time.
     */
    buildStatusBar: function () {
        var me = this;
        if (me._statusBarBuilt) return;
        me._statusBarBuilt = true;

        me._statusBar = Ext.create('Ext.toolbar.Toolbar', {
            dock: 'bottom',
            cls: 'indoor-status-bar',
            items: [
                {
                    xtype: 'tbtext',
                    itemId: 'statusEngine',
                    html: '<b>' + Ext.String.htmlEncode(me.getEngineLabel(me.activeEngine)) + '</b>'
                },
                {
                    xtype: 'tbtext',
                    itemId: 'statusDot',
                    html: '<span class="indoor-status-dot indoor-offline" title="Disconnected"></span>'
                },
                { xtype: 'tbseparator' },
                {
                    xtype: 'tbtext',
                    itemId: 'statusCounts',
                    html: '0 devices'
                },
                '->',
                {
                    xtype: 'tbtext',
                    itemId: 'statusLastUpdate',
                    html: ''
                }
            ]
        });

        var grid = me.mainPanel.down('indoor-devicegrid');
        if (grid) {
            grid.addDocked(me._statusBar);
        }
    },

    /**
     * Update the status bar with current engine state.
     *
     * @param {Object} opts
     * @param {boolean}  opts.connected   -- green dot if true, red if false
     * @param {number}   [opts.online]    -- count of online devices
     * @param {number}   [opts.total]     -- total device count
     * @param {Date}     [opts.lastUpdate]-- last data timestamp
     */
    updateStatusBar: function (opts) {
        var me = this;
        if (!me._statusBar) return;
        opts = opts || {};

        var dotItem = me._statusBar.down('#statusDot');
        if (dotItem) {
            var cls = opts.connected ? 'indoor-online' : 'indoor-offline';
            var title = opts.connected ? 'Connected' : 'Disconnected';
            dotItem.setHtml('<span class="indoor-status-dot ' + cls + '" title="' + title + '"></span>');
        }

        var engineItem = me._statusBar.down('#statusEngine');
        if (engineItem) {
            engineItem.setHtml('<b>' + Ext.String.htmlEncode(me.getEngineLabel(me.activeEngine)) + '</b>');
        }

        if (opts.total !== undefined) {
            var countsItem = me._statusBar.down('#statusCounts');
            if (countsItem) {
                var online = opts.online !== undefined ? opts.online : 0;
                countsItem.setHtml(online + '/' + opts.total + ' devices online');
            }
        }

        if (opts.lastUpdate) {
            var timeItem = me._statusBar.down('#statusLastUpdate');
            if (timeItem) {
                var d = Ext.isDate(opts.lastUpdate) ? opts.lastUpdate : new Date(opts.lastUpdate);
                if (!isNaN(d.getTime())) {
                    timeItem.setHtml('Updated: ' + Ext.util.Format.date(d, 'H:i:s'));
                }
            }
        }
    },

    /* ------------------------------------------------------------------ */
    /*  Engine Switching                                                  */
    /* ------------------------------------------------------------------ */

    /**
     * Switch the active positioning engine.
     * Tears down the current engine connection and starts the new one.
     *
     * @param {string} engineKey -- 'velavu' or 'channelSounding'
     */
    switchEngine: function (engineKey) {
        var me = this;
        if (engineKey === me.activeEngine) return;

        console.log('[Indoor v4] Switching engine:', me.activeEngine, '->', engineKey);

        // Tear down current engine
        me.disconnectEngine();

        // Clear device store for clean slate
        me.deviceStore.removeAll();

        // Activate new engine
        me.activeEngine = engineKey;

        // Update toolbar button text
        var btn = skeleton.header.down('#indoorEngineBtn');
        if (btn) {
            btn.setText(me.getEngineLabel(engineKey));
        }

        // Update status bar engine label
        me.updateStatusBar({ connected: false });

        // Connect to the new engine
        me.connectEngine(engineKey);
    },

    /**
     * Connect to the specified engine.
     * Dispatches to the appropriate engine-specific init method.
     *
     * @param {string} engineKey
     */
    connectEngine: function (engineKey) {
        var me = this;
        console.log('[Indoor v4] Connecting engine:', engineKey);

        if (engineKey === 'velavu') {
            me.initVelavuEngine();
        } else if (engineKey === 'channelSounding') {
            me.initChannelSoundingEngine();
        } else {
            console.warn('[Indoor v4] Unknown engine:', engineKey);
        }
    },

    /**
     * Disconnect and clean up the active engine.
     * Closes WebSocket, clears polling timers, resets state.
     */
    disconnectEngine: function () {
        var me = this;

        // Close WebSocket if open
        if (me._ws) {
            try { me._ws.onclose = null; me._ws.close(); } catch (e) {}
            me._ws = null;
        }

        // Clear Velavu HTTP polling timer
        if (me._velavuPollTimer) {
            clearInterval(me._velavuPollTimer);
            me._velavuPollTimer = null;
        }

        // Clear Channel Sounding HTTP fallback timer
        if (me._csFallbackTimer) {
            clearInterval(me._csFallbackTimer);
            me._csFallbackTimer = null;
        }

        // Clear reconnect timeout
        if (me._wsReconnectTimeout) {
            clearTimeout(me._wsReconnectTimeout);
            me._wsReconnectTimeout = null;
        }

        // Stop grid auto-refresh
        var grid = me.mainPanel ? me.mainPanel.down('indoor-devicegrid') : null;
        if (grid && grid.stopAutoRefresh) {
            grid.stopAutoRefresh();
        }

        me._wsReconnectDelay = me.WS_RECONNECT_MIN;
    },

    /**
     * Trigger a manual refresh for the currently active engine.
     */
    refreshActiveEngine: function () {
        var me = this;
        if (me.activeEngine === 'velavu') {
            me.velavuFetchAll();
        } else if (me.activeEngine === 'channelSounding') {
            me.deviceStore.load();
        }
    },

    /* ================================================================== */
    /*                                                                    */
    /*  VELAVU CLOUD ENGINE                                               */
    /*                                                                    */
    /* ================================================================== */

    /**
     * Initialize the Velavu Cloud engine.
     *
     * Data flow:
     *   1. GET /api/velavu/sites   -> populate siteStore, build floor selector
     *   2. GET /api/velavu/devices -> populate deviceStore
     *   3. GET /api/velavu/assets  -> enrich device records with asset names
     *   4. Start HTTP polling every 10 s for devices
     *   5. Attempt WebSocket upgrade for real-time; fall back to polling
     */
    initVelavuEngine: function () {
        var me = this;
        var apiBase = (me.engines.velavu && me.engines.velavu.apiBase) || '/api/velavu';

        me._velavuApiBase = apiBase;

        // Initial fetch of all three endpoints
        me.velavuFetchAll();

        // Start HTTP polling for devices
        var interval = me.settings.deviceRefreshInterval || me.VELAVU_POLL_INTERVAL;
        me._velavuPollTimer = setInterval(function () {
            me.velavuFetchDevices();
        }, interval);

        // Try WebSocket upgrade for real-time
        me.velavuConnectWebSocket(apiBase);

        me.updateStatusBar({ connected: true });
    },

    /**
     * Fetch all Velavu endpoints in parallel (sites, devices, assets).
     * Called on init and on manual refresh.
     */
    velavuFetchAll: function () {
        var me = this;
        me.velavuFetchSites();
        me.velavuFetchDevices();
        me.velavuFetchAssets();
    },

    /* --  Sites  ------------------------------------------------------- */

    /**
     * Fetch /api/velavu/sites and populate siteStore.
     * Also rebuilds the Site and Floor selector dropdowns.
     */
    velavuFetchSites: function () {
        var me = this;
        Ext.Ajax.request({
            url: me._velavuApiBase + '/sites',
            method: 'GET',
            success: function (resp) {
                try {
                    var payload = Ext.JSON.decode(resp.responseText);
                    var sites = payload.data || payload.sites || payload || [];
                    if (!Ext.isArray(sites)) sites = [];
                    me.siteStore.loadData(sites);
                    me.rebuildSiteSelector(sites);
                } catch (e) {
                    console.warn('[Indoor v4] Velavu sites parse error:', e);
                }
            },
            failure: function () {
                console.warn('[Indoor v4] Velavu sites fetch failed');
            }
        });
    },

    /**
     * Rebuild the header Site selector dropdown from site data.
     *
     * @param {Array} sites
     */
    rebuildSiteSelector: function (sites) {
        var me = this;
        if (!me.siteSelectorBtn) return;

        var items = [];
        for (var i = 0; i < sites.length; i++) {
            (function (site) {
                items.push({
                    text: site.name || site.id,
                    siteId: site.id,
                    checked: i === 0,
                    group: 'indoorSite',
                    handler: function () {
                        me.onSiteSelected(site);
                    }
                });
            })(sites[i]);
        }

        me.siteSelectorBtn.menu = Ext.create('Ext.menu.Menu', { items: items });

        // Auto-select first site
        if (sites.length) {
            me.siteSelectorBtn.setText(sites[0].name || sites[0].id);
            me.onSiteSelected(sites[0]);
        }
    },

    /**
     * Handle user selecting a site from the dropdown.
     * Updates the floor selector and filters devices by site.
     *
     * @param {Object} site
     */
    onSiteSelected: function (site) {
        var me = this;
        me._activeSiteId = site.id;

        if (me.siteSelectorBtn) {
            me.siteSelectorBtn.setText(site.name || site.id);
        }

        // Rebuild floor selector from site.floors array
        var floors = site.floors || [];
        me.rebuildFloorSelector(floors);

        // Filter device store to this site
        me.filterDevicesBySite(site.id);
    },

    /**
     * Rebuild the header Floor selector dropdown from floor data.
     *
     * @param {Array} floors
     */
    rebuildFloorSelector: function (floors) {
        var me = this;
        if (!me.floorSelectorBtn) return;

        var items = [{
            text: (typeof l === 'function') ? l('All Floors') : 'All Floors',
            floorId: null,
            checked: true,
            group: 'indoorFloor',
            handler: function () {
                me.onFloorSelected(null, (typeof l === 'function') ? l('All Floors') : 'All Floors');
            }
        }];

        for (var i = 0; i < floors.length; i++) {
            (function (floor) {
                items.push({
                    text: floor.name || ('Floor ' + (floor.level !== undefined ? floor.level : floor.id)),
                    floorId: floor.id,
                    group: 'indoorFloor',
                    handler: function () {
                        me.onFloorSelected(floor.id, floor.name || ('Floor ' + (floor.level !== undefined ? floor.level : floor.id)));
                    }
                });
            })(floors[i]);
        }

        me.floorSelectorBtn.menu = Ext.create('Ext.menu.Menu', { items: items });
        me.floorSelectorBtn.setText((typeof l === 'function') ? l('All Floors') : 'All Floors');
        me._activeFloorId = null;
    },

    /**
     * Handle user selecting a floor from the dropdown.
     *
     * @param {string|null} floorId
     * @param {string} label
     */
    onFloorSelected: function (floorId, label) {
        var me = this;
        me._activeFloorId = floorId;

        if (me.floorSelectorBtn) {
            me.floorSelectorBtn.setText(label);
        }

        me.filterDevicesByFloor(floorId);
    },

    /**
     * Filter device store to show only devices at a given site.
     *
     * @param {string} siteId
     */
    filterDevicesBySite: function (siteId) {
        var me = this;
        if (!siteId) {
            me.deviceStore.clearFilter();
            return;
        }
        me.deviceStore.clearFilter(true);
        me.deviceStore.filterBy(function (rec) {
            var recSite = rec.get('siteId');
            // If device has no siteId, show it (unfiltered)
            if (!recSite) return true;
            return recSite === siteId;
        });
    },

    /**
     * Filter device store to show only devices on a given floor.
     *
     * @param {string|null} floorId -- null means show all floors
     */
    filterDevicesByFloor: function (floorId) {
        var me = this;
        if (!floorId) {
            // Only re-apply site filter if active
            if (me._activeSiteId) {
                me.filterDevicesBySite(me._activeSiteId);
            } else {
                me.deviceStore.clearFilter();
            }
            return;
        }
        me.deviceStore.clearFilter(true);
        me.deviceStore.filterBy(function (rec) {
            var recFloor = rec.get('floorId');
            var recSite  = rec.get('siteId');
            var floorOk  = !recFloor || recFloor === floorId;
            var siteOk   = !me._activeSiteId || !recSite || recSite === me._activeSiteId;
            return floorOk && siteOk;
        });
    },

    /* --  Devices  ----------------------------------------------------- */

    /**
     * Fetch /api/velavu/devices and populate the device store.
     * Merges asset names from assetStore if available.
     */
    velavuFetchDevices: function () {
        var me = this;
        Ext.Ajax.request({
            url: me._velavuApiBase + '/devices',
            method: 'GET',
            success: function (resp) {
                try {
                    var payload = Ext.JSON.decode(resp.responseText);
                    var devices = payload.data || payload.devices || payload || [];
                    if (!Ext.isArray(devices)) devices = [];

                    // Normalize and enrich each device record
                    var normalized = [];
                    for (var i = 0; i < devices.length; i++) {
                        normalized.push(me.normalizeVelavuDevice(devices[i]));
                    }

                    me.deviceStore.loadData(normalized);

                    // Update status bar counts
                    var online = 0;
                    for (var j = 0; j < normalized.length; j++) {
                        if (normalized[j].online || normalized[j].status === 'online') online++;
                    }
                    me.updateStatusBar({
                        connected:  true,
                        online:     online,
                        total:      normalized.length,
                        lastUpdate: new Date()
                    });

                    // Update nav panel title with count
                    me.updateNavTitle(online, normalized.length);

                } catch (e) {
                    console.warn('[Indoor v4] Velavu devices parse error:', e);
                }
            },
            failure: function () {
                console.warn('[Indoor v4] Velavu devices fetch failed');
                me.updateStatusBar({ connected: false });
            }
        });
    },

    /**
     * Normalize a raw Velavu device object into the store field format.
     * Also enriches with asset name from the assetStore if available.
     *
     * @param {Object} raw -- raw device JSON from Velavu API
     * @returns {Object}
     */
    normalizeVelavuDevice: function (raw) {
        var me = this;

        // Compute v3-compat status field
        var status = raw.online ? 'online' : 'offline';

        // Compute x/y from lat/lng for map display (FloorPlanView uses x/y)
        var x = raw.lng !== undefined ? raw.lng : (raw.x !== undefined ? raw.x : null);
        var y = raw.lat !== undefined ? raw.lat : (raw.y !== undefined ? raw.y : null);

        // Determine type from category
        var type = raw.type || raw.category || 'device';

        // Look up asset name
        var assetId   = raw.assetId || null;
        var assetName = raw.assetName || '';
        var assetGroup = raw.assetGroup || '';
        if (assetId && !assetName && me.assetStore) {
            var assetRec = me.assetStore.getById(assetId);
            if (assetRec) {
                assetName  = assetRec.get('name') || '';
                assetGroup = assetRec.get('group') || '';
            }
        }

        return {
            id:              raw.id,
            serial:          raw.serial || raw.id,
            name:            raw.name || assetName || raw.serial || raw.id,
            type:            type,
            category:        raw.category || '',
            hardware:        raw.hardware || '',
            model:           raw.model || '',
            online:          !!raw.online,
            battery:         raw.battery !== undefined ? raw.battery : null,
            batteryCharging: !!raw.batteryCharging,
            usbPower:        !!raw.usbPower,
            lat:             raw.lat !== undefined ? raw.lat : null,
            lng:             raw.lng !== undefined ? raw.lng : null,
            accuracy:        raw.accuracy !== undefined ? raw.accuracy : null,
            locationType:    raw.locationType || '',
            floorId:         raw.floorId || raw.floor || null,
            locationTime:    raw.locationTime || raw.lastUpdate || null,
            temperature:     raw.temperature !== undefined ? raw.temperature : null,
            humidity:        raw.humidity !== undefined ? raw.humidity : null,
            rssi:            raw.rssi !== undefined ? raw.rssi : null,
            installQuality:  raw.installQuality !== undefined ? raw.installQuality : null,
            gatewayId:       raw.gatewayId || null,
            siteId:          raw.siteId || null,
            appVersion:      raw.appVersion || '',
            heartbeat:       raw.heartbeat || null,
            lastUpdate:      raw.lastUpdate || raw.locationTime || null,
            assetId:         assetId,
            assetName:       assetName,
            assetGroup:      assetGroup,
            /* v3 compat */
            status:          status,
            isMoving:        !!raw.isMoving,
            x:               x,
            y:               y,
            floor:           raw.floorId || raw.floor || null,
            zone:            raw.zone || '',
            confidence:      raw.accuracy !== undefined ? raw.accuracy : null
        };
    },

    /* --  Assets  ------------------------------------------------------ */

    /**
     * Fetch /api/velavu/assets and populate the asset store.
     * After loading, re-enriches device records with asset names.
     */
    velavuFetchAssets: function () {
        var me = this;
        Ext.Ajax.request({
            url: me._velavuApiBase + '/assets',
            method: 'GET',
            success: function (resp) {
                try {
                    var payload = Ext.JSON.decode(resp.responseText);
                    var assets = payload.data || payload.assets || payload || [];
                    if (!Ext.isArray(assets)) assets = [];
                    me.assetStore.loadData(assets);

                    // Enrich existing device records with asset names
                    me.enrichDevicesWithAssets();
                } catch (e) {
                    console.warn('[Indoor v4] Velavu assets parse error:', e);
                }
            },
            failure: function () {
                console.warn('[Indoor v4] Velavu assets fetch failed');
            }
        });
    },

    /**
     * Walk the device store and fill in assetName / assetGroup
     * from matching asset store records.
     */
    enrichDevicesWithAssets: function () {
        var me = this;
        if (!me.assetStore || !me.deviceStore) return;

        // Build deviceId -> asset lookup
        var assetByDevice = {};
        me.assetStore.each(function (assetRec) {
            var devId = assetRec.get('deviceId');
            if (devId) {
                assetByDevice[devId] = assetRec;
            }
        });

        me.deviceStore.each(function (devRec) {
            var assetId = devRec.get('assetId');
            var devId   = devRec.get('id');
            var assetRec = null;

            if (assetId) {
                assetRec = me.assetStore.getById(assetId);
            }
            if (!assetRec && devId && assetByDevice[devId]) {
                assetRec = assetByDevice[devId];
            }
            if (assetRec) {
                devRec.set({
                    assetName:  assetRec.get('name') || '',
                    assetGroup: assetRec.get('group') || ''
                });
                // Also update display name if currently generic
                var currentName = devRec.get('name') || '';
                var serial = devRec.get('serial') || '';
                if (!currentName || currentName === devRec.get('id') || currentName === serial) {
                    devRec.set('name', assetRec.get('name') || currentName);
                }
                devRec.commit();
            }
        });
    },

    /* --  Velavu WebSocket (optional real-time upgrade)  --------------- */

    /**
     * Attempt a WebSocket connection to the Velavu engine for real-time
     * position updates. If unavailable, HTTP polling continues as fallback.
     *
     * @param {string} apiBase -- e.g. '/api/velavu'
     */
    velavuConnectWebSocket: function (apiBase) {
        var me = this;

        // Derive WebSocket URL from apiBase (may be absolute URL to our engine server)
        var wsUrl;
        if (apiBase.indexOf('http://') === 0 || apiBase.indexOf('https://') === 0) {
            // Absolute URL — extract host from apiBase
            var a = document.createElement('a');
            a.href = apiBase;
            var wsProtocol = a.protocol === 'https:' ? 'wss:' : 'ws:';
            wsUrl = wsProtocol + '//' + a.host + '/ws';
        } else {
            // Relative URL — use current page host
            var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            wsUrl = protocol + '//' + window.location.host + apiBase + '/ws';
        }

        me._wsReconnectDelay = me.WS_RECONNECT_MIN;

        function connect() {
            try {
                me._ws = new WebSocket(wsUrl);
            } catch (e) {
                // WebSocket not available at this URL -- stay on HTTP polling
                console.log('[Indoor v4] Velavu WS not available, using HTTP polling only');
                return;
            }

            me._ws.onopen = function () {
                console.log('[Indoor v4] Velavu WS connected:', wsUrl);
                me._wsReconnectDelay = me.WS_RECONNECT_MIN;

                // Stop HTTP polling -- WS handles updates now
                if (me._velavuPollTimer) {
                    clearInterval(me._velavuPollTimer);
                    me._velavuPollTimer = null;
                }

                // Stop grid auto-refresh
                var grid = me.mainPanel ? me.mainPanel.down('indoor-devicegrid') : null;
                if (grid && grid.stopAutoRefresh) grid.stopAutoRefresh();
                if (grid && grid.setWsStatus) grid.setWsStatus(true);

                me.updateStatusBar({ connected: true });

                // Subscribe to channels
                me._ws.send(JSON.stringify({
                    type: 'subscribe',
                    channels: me.WS_CHANNELS
                }));
            };

            me._ws.onmessage = function (event) {
                me.handleWebSocketMessage(event);
            };

            me._ws.onclose = function () {
                console.log('[Indoor v4] Velavu WS disconnected');
                me.onWebSocketDisconnect();
            };

            me._ws.onerror = function () {
                // onclose fires after onerror
            };
        }

        connect();
    },

    /* ================================================================== */
    /*                                                                    */
    /*  CHANNEL SOUNDING ENGINE                                           */
    /*                                                                    */
    /* ================================================================== */

    /**
     * Initialize the Channel Sounding engine (v3.0 architecture).
     * WebSocket-first with HTTP polling fallback.
     *
     * Uses /api/indoor endpoints served by the positioning-engine
     * (ELA Innovation / Wirepas mesh + BLE 6.0 Channel Sounding).
     */
    initChannelSoundingEngine: function () {
        var me = this;
        var cfg = me.engines.channelSounding || {};
        var apiBase = cfg.apiBase || '/api/indoor';

        // Derive engine base URL (strip trailing /api/indoor)
        var engineBaseUrl = apiBase.replace(/\/api\/indoor\/?$/, '') || '';

        me._csApiBase = apiBase;
        me._csEngineBaseUrl = engineBaseUrl;

        // Update FloorPlanView engine URL for floor loading / zone overlays
        if (me.mainPanel) {
            me.mainPanel.engineBaseUrl = engineBaseUrl;
        }

        // Configure device store proxy for HTTP fallback
        if (me.deviceStore.getProxy) {
            me.deviceStore.setProxy({
                type: 'ajax',
                url: engineBaseUrl + '/api/indoor/devices',
                reader: { type: 'json', rootProperty: 'data' }
            });
        }

        // Load restricted zones for FloorPlanView + DeviceGrid
        me.loadRestrictedZones(engineBaseUrl);

        // Connect WebSocket
        me.csConnectWebSocket(engineBaseUrl);

        me.updateStatusBar({ connected: false });
    },

    /**
     * Connect to the Channel Sounding engine WebSocket.
     * On success, subscribes to positions/zones/alerts/stats channels.
     * On failure, falls back to HTTP polling with exponential backoff reconnect.
     *
     * @param {string} engineBaseUrl
     */
    csConnectWebSocket: function (engineBaseUrl) {
        var me = this;
        var wsUrl = engineBaseUrl.replace(/^http/, 'ws');
        if (!wsUrl) {
            // No engine URL -- use HTTP polling only
            me.csStartHttpPolling();
            return;
        }

        me._wsReconnectDelay = me.WS_RECONNECT_MIN;

        function connect() {
            try {
                me._ws = new WebSocket(wsUrl);
            } catch (e) {
                me.csStartHttpPolling();
                return;
            }

            me._ws.onopen = function () {
                console.log('[Indoor v4] CS WebSocket connected:', wsUrl);
                me._wsReconnectDelay = me.WS_RECONNECT_MIN;

                // Stop HTTP fallback polling
                me.csStopHttpPolling();

                // Update grid WS status
                var grid = me.mainPanel ? me.mainPanel.down('indoor-devicegrid') : null;
                if (grid && grid.setWsStatus) grid.setWsStatus(true);
                if (grid && grid.stopAutoRefresh) grid.stopAutoRefresh();

                me.updateStatusBar({ connected: true });

                // Subscribe to all channels
                me._ws.send(JSON.stringify({
                    type: 'subscribe',
                    channels: me.WS_CHANNELS
                }));
            };

            me._ws.onmessage = function (event) {
                me.handleWebSocketMessage(event);
            };

            me._ws.onclose = function () {
                console.log('[Indoor v4] CS WebSocket disconnected, reconnecting in',
                    me._wsReconnectDelay, 'ms');
                me.onWebSocketDisconnect();

                // Schedule reconnect with exponential backoff
                me._wsReconnectTimeout = setTimeout(function () {
                    me._wsReconnectDelay = Math.min(
                        me._wsReconnectDelay * 2,
                        me.WS_RECONNECT_MAX
                    );
                    connect();
                }, me._wsReconnectDelay);
            };

            me._ws.onerror = function () {
                // onclose fires after onerror
            };
        }

        connect();
    },

    /**
     * Start HTTP polling fallback for Channel Sounding engine.
     */
    csStartHttpPolling: function () {
        var me = this;
        if (me._csFallbackTimer) return;

        console.log('[Indoor v4] CS falling back to HTTP polling');
        me._csFallbackTimer = setInterval(function () {
            me.deviceStore.load();
        }, me.settings.deviceRefreshInterval || 5000);

        // Restart grid auto-refresh as fallback
        var grid = me.mainPanel ? me.mainPanel.down('indoor-devicegrid') : null;
        if (grid && !grid.refreshTask) grid.startAutoRefresh();
    },

    /**
     * Stop HTTP polling fallback for Channel Sounding engine.
     */
    csStopHttpPolling: function () {
        var me = this;
        if (me._csFallbackTimer) {
            clearInterval(me._csFallbackTimer);
            me._csFallbackTimer = null;
        }
    },

    /* ================================================================== */
    /*                                                                    */
    /*  SHARED WEBSOCKET MESSAGE HANDLING                                 */
    /*                                                                    */
    /* ================================================================== */

    /**
     * Handle an incoming WebSocket message from either engine.
     * Dispatches by message type: positions, zones, alerts, stats.
     *
     * @param {MessageEvent} event
     */
    handleWebSocketMessage: function (event) {
        var me = this;
        var msg;
        try {
            msg = JSON.parse(event.data);
        } catch (e) {
            return;
        }

        if (msg.type === 'positions' && msg.data) {
            me.onWsPosition(msg.data);
        }

        if (msg.type === 'zones' && msg.data) {
            me.onWsZoneEvent(msg.data);
        }

        if (msg.type === 'alerts' && msg.data) {
            me.onWsAlert(msg.data);
        }

        if (msg.type === 'stats' && msg.data) {
            me.onWsStats(msg.data);
        }
    },

    /**
     * Handle a position update from WebSocket.
     * Updates or adds the device record in the store and refreshes
     * the map markers incrementally.
     *
     * @param {Object} d -- device position data
     */
    onWsPosition: function (d) {
        var me = this;
        var record = me.deviceStore.getById(d.id);

        if (record) {
            // Update existing record in-place (triggers marker animation)
            var fields = {};
            if (d.name !== undefined)        fields.name        = d.name;
            if (d.type !== undefined)        fields.type        = d.type;
            if (d.zone !== undefined)        fields.zone        = d.zone;
            if (d.battery !== undefined)     fields.battery     = d.battery;
            if (d.temperature !== undefined) fields.temperature = d.temperature;
            if (d.humidity !== undefined)    fields.humidity    = d.humidity;
            if (d.lastUpdate !== undefined)  fields.lastUpdate  = d.lastUpdate;
            if (d.status !== undefined)      fields.status      = d.status;
            if (d.online !== undefined)      fields.online      = d.online;
            if (d.isMoving !== undefined)    fields.isMoving    = d.isMoving;
            if (d.x !== undefined)           fields.x           = d.x;
            if (d.y !== undefined)           fields.y           = d.y;
            if (d.lat !== undefined)         fields.lat         = d.lat;
            if (d.lng !== undefined)         fields.lng         = d.lng;
            if (d.floor !== undefined)       fields.floor       = d.floor;
            if (d.floorId !== undefined)     fields.floorId     = d.floorId;
            if (d.confidence !== undefined)  fields.confidence  = d.confidence;
            if (d.accuracy !== undefined)    fields.accuracy    = d.accuracy;
            if (d.rssi !== undefined)        fields.rssi        = d.rssi;

            record.set(fields);
            record.commit();
        } else {
            // New device -- add to store
            me.deviceStore.add(d);
        }

        // Refresh markers on map (animated incremental update)
        if (me.mainPanel && me.mainPanel.refreshMarkers) {
            me.mainPanel.refreshMarkers();
        }
    },

    /**
     * Handle a zone event from WebSocket (enter/exit).
     * Shows toast notification for restricted zone entries.
     *
     * @param {Object} evt
     */
    onWsZoneEvent: function (evt) {
        var me = this;

        if (evt.event === 'enter' && evt.zoneType === 'restricted') {
            me.showAlert(
                'critical',
                'Zone Alert: ' + (evt.deviceId || 'Unknown') +
                ' entered restricted zone "' + (evt.zoneName || '') + '"'
            );

            // Refresh map markers to show restricted highlighting
            if (me.mainPanel && me.mainPanel.refreshMarkers) {
                me.mainPanel.refreshMarkers();
            }
        }

        if (evt.event === 'exit' && evt.zoneType === 'restricted') {
            me.showAlert(
                'info',
                (evt.deviceId || 'Unknown') +
                ' left restricted zone "' + (evt.zoneName || '') + '"'
            );
        }
    },

    /**
     * Handle an alert from WebSocket.
     * Shows toast notification and updates the grid alert indicator.
     *
     * @param {Object} alert
     */
    onWsAlert: function (alert) {
        var me = this;

        me.showAlert(alert.severity || 'info', alert.message || 'Alert');

        // Update alert indicator on device grid row
        var grid = me.mainPanel ? me.mainPanel.down('indoor-devicegrid') : null;
        if (grid && grid.setDeviceAlert && alert.deviceId) {
            grid.setDeviceAlert(alert.deviceId, alert.severity);
        }
    },

    /**
     * Handle stats from WebSocket (device counts, engine health).
     * Updates nav panel title and status bar.
     *
     * @param {Object} s -- { devicesOnline, devicesTotal, ... }
     */
    onWsStats: function (s) {
        var me = this;
        if (s.devicesOnline !== undefined) {
            me.updateNavTitle(s.devicesOnline, s.devicesTotal);
        }
        me.updateStatusBar({
            connected:  true,
            online:     s.devicesOnline,
            total:      s.devicesTotal,
            lastUpdate: new Date()
        });
    },

    /**
     * Common handler when a WebSocket disconnects.
     * Updates UI indicators and starts HTTP fallback if on CS engine.
     */
    onWebSocketDisconnect: function () {
        var me = this;

        // Update grid WS indicator
        var grid = me.mainPanel ? me.mainPanel.down('indoor-devicegrid') : null;
        if (grid && grid.setWsStatus) grid.setWsStatus(false);

        me.updateStatusBar({ connected: false });

        // Start appropriate fallback
        if (me.activeEngine === 'channelSounding') {
            me.csStartHttpPolling();
        } else if (me.activeEngine === 'velavu') {
            // Restart Velavu HTTP polling
            if (!me._velavuPollTimer) {
                var interval = me.settings.deviceRefreshInterval || me.VELAVU_POLL_INTERVAL;
                me._velavuPollTimer = setInterval(function () {
                    me.velavuFetchDevices();
                }, interval);
            }
        }
    },

    /* ================================================================== */
    /*                                                                    */
    /*  ALERT / TOAST SYSTEM                                              */
    /*                                                                    */
    /* ================================================================== */

    /**
     * Show a toast notification for an alert.
     * Supports severity levels: critical, warning, info.
     *
     * @param {string} severity -- 'critical', 'warning', or 'info'
     * @param {string} message
     */
    showAlert: function (severity, message) {
        if (typeof Ext.toast !== 'function') return;

        var cls = '';
        if (severity === 'critical') cls = 'indoor-alert-critical';
        else if (severity === 'warning') cls = 'indoor-alert-warning';

        var label = severity ? severity.toUpperCase() : 'INFO';

        Ext.toast({
            html: '<b>' + Ext.String.htmlEncode(label) + ':</b> ' +
                  Ext.String.htmlEncode(message),
            closable: true,
            align: 'tr',
            cls: cls,
            slideInDuration: 400
        });
    },

    /* ================================================================== */
    /*                                                                    */
    /*  RESTRICTED ZONES                                                  */
    /*                                                                    */
    /* ================================================================== */

    /**
     * Load restricted zone names from the Channel Sounding engine API
     * and push them to FloorPlanView + DeviceGrid for visual highlighting.
     *
     * @param {string} engineBaseUrl
     */
    loadRestrictedZones: function (engineBaseUrl) {
        var me = this;
        if (!engineBaseUrl) return;

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
                    if (me.mainPanel && me.mainPanel.updateRestrictedZones) {
                        me.mainPanel.updateRestrictedZones(zones);
                    }

                    // Push to DeviceGrid
                    if (me.mainPanel) {
                        var grid = me.mainPanel.down('indoor-devicegrid');
                        if (grid && grid.setRestrictedZones) {
                            grid.setRestrictedZones(restricted);
                        }
                    }
                } catch (e) {
                    console.warn('[Indoor v4] Restricted zones parse error:', e);
                }
            }
        });
    },

    /* ================================================================== */
    /*                                                                    */
    /*  HELPERS                                                           */
    /*                                                                    */
    /* ================================================================== */

    /**
     * Update the navigation panel title with device counts.
     *
     * @param {number} online
     * @param {number} total
     */
    updateNavTitle: function (online, total) {
        var me = this;
        if (!me.navPanel) return;

        var label = (typeof l === 'function') ? l('Indoor Positioning') : 'Indoor Positioning';
        if (total !== undefined) {
            label += ' (' + (online || 0) + '/' + total + ')';
        }
        me.navPanel.setTitle(label);
    },

    /* ------------------------------------------------------------------ */
    /*  Cleanup                                                           */
    /* ------------------------------------------------------------------ */

    /**
     * Clean up all timers, WebSocket connections, and stores on destroy.
     */
    onDestroy: function () {
        var me = this;
        me.disconnectEngine();
        me.callParent(arguments);
    }
});
