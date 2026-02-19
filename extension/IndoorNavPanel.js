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
                children: me.getSampleHierarchy()
            }
        });

        me.listeners = {
            itemclick: me.onItemClick,
            scope: me
        };

        me.callParent();
    },

    /**
     * Sample hierarchy for development. Replace with API data.
     */
    getSampleHierarchy: function () {
        return [
            {
                text: (typeof l === 'function') ? l('Building A') : 'Building A',
                expanded: true,
                children: [
                    {
                        text: (typeof l === 'function') ? l('Floor 1') : 'Floor 1',
                        expanded: true,
                        children: [
                            {
                                text: (typeof l === 'function') ? l('Zone A1') : 'Zone A1',
                                expanded: true,
                                children: [
                                    { text: 'Worker_01', leaf: true, x: 150, y: 200, status: 'online', battery: 85, type: 'person' },
                                    { text: 'Asset_T01', leaf: true, x: 300, y: 250, status: 'online', battery: 92, type: 'asset' },
                                    { text: 'Worker_02', leaf: true, x: 180, y: 350, status: 'offline', battery: 15, type: 'person' }
                                ]
                            }
                        ]
                    }
                ]
            }
        ];
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
