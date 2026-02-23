/**
 * PILOT Extension — Indoor Positioning
 * Navigation panel with hierarchical tree: Building → Floor → Zone
 * Tag list with search and status indicators.
 * Click on tag centers map on device position.
 *
 * @see pilot_extensions/examples/airports/Tab.js — nav panel pattern
 */

Ext.define('Store.indoor-positioning.IndoorNavPanel', {
    extend: 'Ext.tree.Panel',
    xtype: 'indoor-navpanel',

    cls: 'indoor-nav-panel',
    title: (typeof l === 'function') ? l('Indoor Positioning') : 'Indoor Positioning',
    iconCls: 'fa fa-map-marker-alt',
    iconAlign: 'top',
    layout: 'fit',
    rootVisible: false,
    useArrows: true,

    columns: [
        {
            xtype: 'treecolumn',
            text: (typeof l === 'function') ? l('Name') : 'Name',
            dataIndex: 'text',
            flex: 1,
            renderer: function (value, meta, record) {
                var status = record.get('status');
                var battery = record.get('battery');
                var icon = '';
                if (status === 'online') {
                    icon = '<span class="indoor-status-dot indoor-online" title="Online"></span> ';
                } else if (status === 'offline') {
                    icon = '<span class="indoor-status-dot indoor-offline" title="Offline"></span> ';
                } else if (battery !== undefined && battery < 20) {
                    icon = '<span class="indoor-status-dot indoor-low-battery" title="Low battery"></span> ';
                }
                return icon + Ext.String.htmlEncode(value);
            }
        },
        {
            text: (typeof l === 'function') ? l('Status') : 'Status',
            dataIndex: 'status',
            width: 70,
            renderer: function (value) {
                if (!value) return '';
                var cls = value === 'online' ? 'indoor-online' : (value === 'low_battery' ? 'indoor-low-battery' : 'indoor-offline');
                return '<span class="indoor-status-badge ' + cls + '">' + value + '</span>';
            }
        }
    ],

    initComponent: function () {
        var me = this;

        me.tbar = [
            {
                xtype: 'textfield',
                itemId: 'searchField',
                emptyText: (typeof l === 'function') ? l('Search tags...') : 'Search tags...',
                flex: 1,
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
                    me.getStore().load();
                }
            }
        ];

        me.store = Ext.create('Ext.data.TreeStore', {
            root: {
                expanded: true,
                children: []
            }
        });

        me.listeners = {
            itemclick: me.onItemClick,
            scope: me
        };

        me.callParent();
    },

    /**
     * Build hierarchy from device store data grouped by floor and zone.
     * Returns empty tree if no devices loaded yet.
     */
    buildHierarchy: function (devices) {
        if (!devices || !devices.length) return [];
        var floors = {};
        for (var i = 0; i < devices.length; i++) {
            var d = devices[i];
            var floorKey = d.get ? d.get('floor') : d.floor;
            var zoneName = (d.get ? d.get('zone') : d.zone) || ((typeof l === 'function') ? l('Unassigned') : 'Unassigned');
            floorKey = floorKey || 1;
            if (!floors[floorKey]) floors[floorKey] = {};
            if (!floors[floorKey][zoneName]) floors[floorKey][zoneName] = [];
            floors[floorKey][zoneName].push({
                text: (d.get ? d.get('name') : d.name) || (d.get ? d.get('id') : d.id) || 'Unknown',
                leaf: true,
                x: d.get ? d.get('x') : d.x,
                y: d.get ? d.get('y') : d.y,
                status: d.get ? d.get('status') : d.status,
                battery: d.get ? d.get('battery') : d.battery,
                type: d.get ? d.get('type') : d.type
            });
        }
        var tree = [];
        var floorKeys = Object.keys(floors).sort();
        for (var fi = 0; fi < floorKeys.length; fi++) {
            var fk = floorKeys[fi];
            var zones = floors[fk];
            var zoneNodes = [];
            var zoneNames = Object.keys(zones).sort();
            for (var zi = 0; zi < zoneNames.length; zi++) {
                zoneNodes.push({ text: zoneNames[zi], expanded: true, children: zones[zoneNames[zi]] });
            }
            tree.push({
                text: ((typeof l === 'function') ? l('Floor') : 'Floor') + ' ' + fk,
                expanded: true,
                children: zoneNodes
            });
        }
        return tree;
    },

    /**
     * Refresh the tree from a device store.
     * Called by Module.js when device data changes.
     */
    refreshFromStore: function (store) {
        var me = this;
        if (!store) return;
        var records = store.getData ? store.getData().getRange() : [];
        var children = me.buildHierarchy(records);
        var root = me.getRootNode();
        if (root) {
            root.removeAll();
            if (children.length) {
                root.appendChild(children);
                root.expandChildren(true);
            }
        }
    },

    onSearchChange: function (field, value) {
        var me = this;
        var store = me.getStore();
        value = (value || '').toLowerCase().trim();
        if (!value) {
            store.clearFilter();
            return;
        }
        store.filterBy(function (node) {
            if (node.get('leaf') && node.get('text')) {
                return node.get('text').toLowerCase().indexOf(value) !== -1;
            }
            return true;
        });
        me.getRootNode().expandChildren(true);
    },

    onItemClick: function (view, record) {
        var me = this;
        if (!record.get('leaf')) return;
        var x = record.get('x');
        var y = record.get('y');
        if (x === undefined || y === undefined) return;
        if (me.map_frame && me.map_frame.setMapCenter) {
            me.map_frame.setMapCenter(x, y, 3);
        }
    }
});
