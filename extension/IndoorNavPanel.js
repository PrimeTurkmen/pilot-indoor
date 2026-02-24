/**
 * PILOT Extension -- Indoor Positioning v4.0
 * Left sidebar tree navigation with hierarchical grouping.
 *
 * Dual-engine hierarchy:
 *   Velavu:           Site > Floor > Group (asset group) > Device
 *   Channel Sounding: Building > Floor > Zone > Device
 *
 * Features:
 *   - Node icons: site=building, floor=layers, group=people/box, device=circle
 *   - Click device node -> fire 'deviceselect' -> center map + select grid row
 *   - Click floor node -> switch floor on map
 *   - Click site node -> switch site
 *   - Search field at top (filters tree nodes by name)
 *   - Auto-refresh: rebuild tree when deviceStore changes
 *   - Badge on groups: count of online devices
 *
 * @see Module.js -- creates and wires this panel
 */

Ext.define('Store.indoor-positioning.IndoorNavPanel', {
    extend: 'Ext.tree.Panel',
    xtype: 'indoor-navpanel',

    cls: 'indoor-nav-panel',
    title: (typeof l === 'function') ? l('Indoor Positioning') : 'Indoor Positioning',
    iconCls: 'fa fa-map-marker-alt',
    width: 260,
    collapsible: true,
    rootVisible: false,
    useArrows: true,

    /* ------------------------------------------------------------------ */
    /*  Config                                                            */
    /* ------------------------------------------------------------------ */

    config: {
        /** Current engine key: 'velavu' or 'channelSounding' */
        engine: 'velavu'
    },

    /* ------------------------------------------------------------------ */
    /*  Column definition                                                 */
    /* ------------------------------------------------------------------ */

    columns: [
        {
            xtype: 'treecolumn',
            text: (typeof l === 'function') ? l('Name') : 'Name',
            dataIndex: 'text',
            flex: 1,
            renderer: function (value, meta, record) {
                var nodeType = record.get('nodeType');
                var status = record.get('status');
                var onlineCount = record.get('onlineCount');
                var icon = '';

                // Node-type icons
                if (nodeType === 'site') {
                    icon = '<i class="fa fa-building" style="margin-right:4px;color:#6366f1"></i>';
                } else if (nodeType === 'floor') {
                    icon = '<i class="fa fa-layer-group" style="margin-right:4px;color:#0ea5e9"></i>';
                } else if (nodeType === 'group') {
                    var groupType = record.get('groupType');
                    if (groupType === 'person' || groupType === 'Staff') {
                        icon = '<i class="fa fa-users" style="margin-right:4px;color:#8b5cf6"></i>';
                    } else {
                        icon = '<i class="fa fa-box" style="margin-right:4px;color:#f59e0b"></i>';
                    }
                } else if (nodeType === 'zone') {
                    var zoneType = record.get('zoneType');
                    if (zoneType === 'restricted') {
                        icon = '<i class="fa fa-shield-alt" style="margin-right:4px;color:#ef4444"></i>';
                    } else {
                        icon = '<i class="fa fa-draw-polygon" style="margin-right:4px;color:#0d9488"></i>';
                    }
                } else if (nodeType === 'device') {
                    // Colored circle based on status
                    if (status === 'online') {
                        icon = '<span class="indoor-status-dot indoor-online" title="Online"></span> ';
                    } else if (status === 'offline') {
                        icon = '<span class="indoor-status-dot indoor-offline" title="Offline"></span> ';
                    } else {
                        icon = '<span class="indoor-status-dot" title="Unknown"></span> ';
                    }
                }

                // Online count badge for group/zone nodes
                var badge = '';
                if ((nodeType === 'group' || nodeType === 'zone') && onlineCount !== undefined && onlineCount > 0) {
                    badge = ' <span class="indoor-nav-badge">' + onlineCount + '</span>';
                }

                return icon + Ext.String.htmlEncode(value) + badge;
            }
        }
    ],

    /* ------------------------------------------------------------------ */
    /*  Init                                                              */
    /* ------------------------------------------------------------------ */

    initComponent: function () {
        var me = this;

        me.tbar = [
            {
                xtype: 'textfield',
                itemId: 'searchField',
                emptyText: (typeof l === 'function') ? l('Search...') : 'Search...',
                flex: 1,
                triggers: {
                    clear: {
                        cls: 'x-form-clear-trigger',
                        handler: function () {
                            this.setValue('');
                        }
                    }
                },
                listeners: {
                    change: me.onSearchChange,
                    buffer: 300,
                    scope: me
                }
            },
            {
                iconCls: 'fa fa-rotate',
                tooltip: (typeof l === 'function') ? l('Refresh') : 'Refresh',
                handler: function () {
                    me.fireEvent('refreshrequested');
                }
            }
        ];

        me.store = Ext.create('Ext.data.TreeStore', {
            fields: [
                'text', 'nodeType', 'status', 'battery', 'deviceId',
                'siteId', 'floorId', 'groupType', 'zoneType',
                'onlineCount', 'x', 'y', 'lat', 'lng'
            ],
            root: {
                expanded: true,
                children: []
            }
        });

        me.listeners = Ext.apply(me.listeners || {}, {
            itemclick: me.onItemClick,
            scope: me
        });

        /* Events: deviceselect, floorselect, siteselect, refreshrequested */
        /* (no addEvents call — Ext JS 5+ fires custom events without declaration) */

        me.callParent();
    },

    /* ------------------------------------------------------------------ */
    /*  Public API                                                        */
    /* ------------------------------------------------------------------ */

    /**
     * Build the tree from current device data and site/floor metadata.
     * Dispatches to engine-specific builder based on current engine.
     *
     * @param {Array} devices  -- array of device records or plain objects
     * @param {Array} [sites]  -- array of site objects (Velavu) or building objects (CS)
     */
    buildTree: function (devices, sites) {
        var me = this;
        var children;

        if (me.getEngine() === 'velavu') {
            children = me._buildVelavuTree(devices, sites);
        } else {
            children = me._buildCSTree(devices, sites);
        }

        var root = me.getRootNode();
        if (root) {
            root.removeAll();
            if (children && children.length) {
                root.appendChild(children);
                root.expandChildren(true);
            }
        }
    },

    /**
     * Select and highlight a specific device node in the tree.
     *
     * @param {string} deviceId -- the device ID to find and select
     */
    selectNode: function (deviceId) {
        var me = this;
        if (!deviceId) return;

        var root = me.getRootNode();
        if (!root) return;

        var node = root.findChildBy(function (n) {
            return n.get('deviceId') === deviceId;
        }, null, true);

        if (node) {
            me.ensureVisible(node, { select: true });
            me.getSelectionModel().select(node);
        }
    },

    /**
     * Set the active engine and reconfigure tree hierarchy style.
     *
     * @param {string} engine -- 'velavu' or 'channelSounding'
     */
    setEngine: function (engine) {
        this.engine = engine;
    },

    /**
     * @returns {string}
     */
    getEngine: function () {
        return this.engine || 'velavu';
    },

    /**
     * Refresh the tree from a device store (convenience method for Module.js).
     * Called when deviceStore fires load/datachanged.
     *
     * @param {Ext.data.Store} store -- the device store
     * @param {Array} [sites] -- optional site data
     */
    refreshFromStore: function (store, sites) {
        var me = this;
        if (!store) return;
        var records = store.getData ? store.getData().getRange() : [];
        me.buildTree(records, sites || me._lastSites);
    },

    /**
     * Cache site data for rebuilds triggered by deviceStore changes.
     *
     * @param {Array} sites
     */
    setSites: function (sites) {
        this._lastSites = sites;
    },

    /* ------------------------------------------------------------------ */
    /*  Velavu Tree Builder                                               */
    /* ------------------------------------------------------------------ */

    /**
     * Build tree hierarchy for Velavu engine:
     *   Site > Floor > Group (asset group) > Device
     *
     * @param {Array} devices
     * @param {Array} [sites]
     * @returns {Array}
     * @private
     */
    _buildVelavuTree: function (devices, sites) {
        if (!devices || !devices.length) return [];

        // Index devices by siteId > floorId > assetGroup
        var siteMap = {};

        for (var i = 0; i < devices.length; i++) {
            var d = devices[i];
            var siteId = (d.get ? d.get('siteId') : d.siteId) || '_default';
            var floorId = (d.get ? d.get('floorId') : d.floorId) || (d.get ? d.get('floor') : d.floor) || '_default';
            var group = (d.get ? d.get('assetGroup') : d.assetGroup) || ((typeof l === 'function') ? l('Unassigned') : 'Unassigned');
            var status = (d.get ? d.get('status') : d.status) || ((d.get ? d.get('online') : d.online) ? 'online' : 'offline');
            var devName = (d.get ? d.get('name') : d.name) || (d.get ? d.get('assetName') : d.assetName) || (d.get ? d.get('serial') : d.serial) || (d.get ? d.get('id') : d.id) || 'Unknown';

            if (!siteMap[siteId]) siteMap[siteId] = {};
            if (!siteMap[siteId][floorId]) siteMap[siteId][floorId] = {};
            if (!siteMap[siteId][floorId][group]) siteMap[siteId][floorId][group] = [];

            siteMap[siteId][floorId][group].push({
                text: devName,
                leaf: true,
                nodeType: 'device',
                deviceId: d.get ? d.get('id') : d.id,
                status: status,
                battery: d.get ? d.get('battery') : d.battery,
                x: d.get ? d.get('x') : d.x,
                y: d.get ? d.get('y') : d.y,
                lat: d.get ? d.get('lat') : d.lat,
                lng: d.get ? d.get('lng') : d.lng,
                siteId: siteId,
                floorId: floorId
            });
        }

        // Build site name lookup from sites array
        var siteNames = {};
        var siteFloorNames = {};
        if (sites && sites.length) {
            for (var si = 0; si < sites.length; si++) {
                var s = sites[si];
                var sid = s.id || s.get && s.get('id');
                var sname = s.name || s.get && s.get('name');
                siteNames[sid] = sname || sid;
                // Build floor name lookup
                var floors = s.floors || (s.get && s.get('floors')) || [];
                siteFloorNames[sid] = {};
                for (var fi = 0; fi < floors.length; fi++) {
                    var fl = floors[fi];
                    siteFloorNames[sid][fl.id] = fl.name || ('Floor ' + (fl.level !== undefined ? fl.level : fl.id));
                }
            }
        }

        // Assemble tree
        var tree = [];
        var siteIds = Object.keys(siteMap).sort();

        for (var sIdx = 0; sIdx < siteIds.length; sIdx++) {
            var sId = siteIds[sIdx];
            var floorMap = siteMap[sId];
            var floorNodes = [];
            var floorIds = Object.keys(floorMap).sort();

            for (var fIdx = 0; fIdx < floorIds.length; fIdx++) {
                var fId = floorIds[fIdx];
                var groupMap = floorMap[fId];
                var groupNodes = [];
                var groupNames = Object.keys(groupMap).sort();

                for (var gIdx = 0; gIdx < groupNames.length; gIdx++) {
                    var gName = groupNames[gIdx];
                    var devNodes = groupMap[gName];
                    var onlineCount = 0;
                    for (var di = 0; di < devNodes.length; di++) {
                        if (devNodes[di].status === 'online') onlineCount++;
                    }

                    groupNodes.push({
                        text: gName,
                        expanded: true,
                        nodeType: 'group',
                        groupType: gName,
                        onlineCount: onlineCount,
                        children: devNodes
                    });
                }

                var floorLabel = (siteFloorNames[sId] && siteFloorNames[sId][fId])
                    ? siteFloorNames[sId][fId]
                    : (fId === '_default'
                        ? ((typeof l === 'function') ? l('Default Floor') : 'Default Floor')
                        : (((typeof l === 'function') ? l('Floor') : 'Floor') + ' ' + fId));

                floorNodes.push({
                    text: floorLabel,
                    expanded: true,
                    nodeType: 'floor',
                    floorId: fId,
                    siteId: sId,
                    children: groupNodes
                });
            }

            var siteLabel = siteNames[sId] || (sId === '_default'
                ? ((typeof l === 'function') ? l('Default Site') : 'Default Site')
                : sId);

            // If only one site, skip the site level
            if (siteIds.length === 1 && sId === '_default') {
                tree = floorNodes;
            } else {
                tree.push({
                    text: siteLabel,
                    expanded: true,
                    nodeType: 'site',
                    siteId: sId,
                    children: floorNodes
                });
            }
        }

        return tree;
    },

    /* ------------------------------------------------------------------ */
    /*  Channel Sounding Tree Builder                                     */
    /* ------------------------------------------------------------------ */

    /**
     * Build tree hierarchy for Channel Sounding engine:
     *   Building > Floor > Zone > Device
     *
     * @param {Array} devices
     * @param {Array} [sites]  -- treated as buildings for CS engine
     * @returns {Array}
     * @private
     */
    _buildCSTree: function (devices, sites) {
        if (!devices || !devices.length) return [];

        var floorMap = {};

        for (var i = 0; i < devices.length; i++) {
            var d = devices[i];
            var floorKey = (d.get ? d.get('floor') : d.floor) || (d.get ? d.get('floorId') : d.floorId) || 1;
            var zoneName = (d.get ? d.get('zone') : d.zone) || ((typeof l === 'function') ? l('Unassigned') : 'Unassigned');
            var status = (d.get ? d.get('status') : d.status) || 'offline';
            var devName = (d.get ? d.get('name') : d.name) || (d.get ? d.get('id') : d.id) || 'Unknown';

            if (!floorMap[floorKey]) floorMap[floorKey] = {};
            if (!floorMap[floorKey][zoneName]) floorMap[floorKey][zoneName] = [];

            floorMap[floorKey][zoneName].push({
                text: devName,
                leaf: true,
                nodeType: 'device',
                deviceId: d.get ? d.get('id') : d.id,
                status: status,
                battery: d.get ? d.get('battery') : d.battery,
                x: d.get ? d.get('x') : d.x,
                y: d.get ? d.get('y') : d.y,
                floorId: floorKey
            });
        }

        var tree = [];
        var floorKeys = Object.keys(floorMap).sort();

        for (var fi = 0; fi < floorKeys.length; fi++) {
            var fk = floorKeys[fi];
            var zones = floorMap[fk];
            var zoneNodes = [];
            var zoneNames = Object.keys(zones).sort();

            for (var zi = 0; zi < zoneNames.length; zi++) {
                var zName = zoneNames[zi];
                var devNodes = zones[zName];
                var onlineCount = 0;
                for (var di = 0; di < devNodes.length; di++) {
                    if (devNodes[di].status === 'online') onlineCount++;
                }

                zoneNodes.push({
                    text: zName,
                    expanded: true,
                    nodeType: 'zone',
                    zoneType: 'normal',
                    onlineCount: onlineCount,
                    children: devNodes
                });
            }

            tree.push({
                text: ((typeof l === 'function') ? l('Floor') : 'Floor') + ' ' + fk,
                expanded: true,
                nodeType: 'floor',
                floorId: fk,
                children: zoneNodes
            });
        }

        // Wrap in building node if sites data provided
        if (sites && sites.length) {
            var buildingNodes = [];
            for (var bi = 0; bi < sites.length; bi++) {
                var bldg = sites[bi];
                buildingNodes.push({
                    text: bldg.name || bldg.id || ((typeof l === 'function') ? l('Building') : 'Building'),
                    expanded: true,
                    nodeType: 'site',
                    siteId: bldg.id,
                    children: tree
                });
            }
            return buildingNodes;
        }

        return tree;
    },

    /* ------------------------------------------------------------------ */
    /*  Search                                                            */
    /* ------------------------------------------------------------------ */

    /**
     * Filter tree nodes by search text. Leaf nodes (devices) are matched
     * by name; branch nodes remain visible if any child matches.
     *
     * @param {Ext.form.field.Text} field
     * @param {string} value
     */
    onSearchChange: function (field, value) {
        var me = this;
        var store = me.getStore();
        value = (value || '').toLowerCase().trim();

        if (!value) {
            store.clearFilter();
            me.getRootNode().expandChildren(true);
            return;
        }

        store.filterBy(function (node) {
            // Always show non-leaf (branch) nodes
            if (!node.get('leaf')) return true;
            // Match leaf node text
            var text = (node.get('text') || '').toLowerCase();
            var devId = (node.get('deviceId') || '').toLowerCase();
            return text.indexOf(value) !== -1 || devId.indexOf(value) !== -1;
        });

        me.getRootNode().expandChildren(true);
    },

    /* ------------------------------------------------------------------ */
    /*  Click Handlers                                                    */
    /* ------------------------------------------------------------------ */

    /**
     * Handle tree node click. Dispatches based on node type:
     *   device -> fire deviceselect, center map
     *   floor  -> fire floorselect, switch floor on map
     *   site   -> fire siteselect, switch site
     */
    onItemClick: function (view, record) {
        var me = this;
        var nodeType = record.get('nodeType');

        if (nodeType === 'device') {
            var deviceId = record.get('deviceId');
            var x = record.get('x');
            var y = record.get('y');
            var lat = record.get('lat');
            var lng = record.get('lng');

            me.fireEvent('deviceselect', deviceId, record);

            // Center map on device position
            if (me.map_frame && me.map_frame.setMapCenter) {
                var mapX = (lng !== undefined && lng !== null) ? lng : x;
                var mapY = (lat !== undefined && lat !== null) ? lat : y;
                if (mapX !== undefined && mapX !== null && mapY !== undefined && mapY !== null) {
                    me.map_frame.setMapCenter(mapX, mapY, 3);
                }
            }
        } else if (nodeType === 'floor') {
            var floorId = record.get('floorId');
            me.fireEvent('floorselect', floorId, record);
        } else if (nodeType === 'site') {
            var siteId = record.get('siteId');
            me.fireEvent('siteselect', siteId, record);
        }
    }
});
