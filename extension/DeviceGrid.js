/**
 * PILOT Extension — Indoor Positioning
 * Device table with columns: Name, Type, Zone, Battery%, Last Update, Status.
 * Row click centers map on device. CSV export. Auto-refresh every 5 seconds.
 *
 * @see TECHNICAL_SPEC.md — DeviceGrid requirements
 */

Ext.define('Store.indoor-positioning.DeviceGrid', {
    extend: 'Ext.grid.Panel',
    xtype: 'indoor-devicegrid',

    cls: 'indoor-device-grid',
    title: (typeof l === 'function') ? l('Devices') : 'Devices',
    autoRefreshInterval: 5000,
    viewConfig: {
        stripeRows: true,
        emptyText: '<div class="x-grid-empty">No devices yet. Connect the positioning engine or add devices in settings.</div>'
    },

    columns: [
        { text: (typeof l === 'function') ? l('Name') : 'Name', dataIndex: 'name', flex: 1 },
        {
            text: (typeof l === 'function') ? l('Type') : 'Type',
            dataIndex: 'type',
            width: 90,
            renderer: function (v) {
                return v === 'person' ? ((typeof l === 'function') ? l('Person') : 'Person') :
                       v === 'asset' ? ((typeof l === 'function') ? l('Asset') : 'Asset') : v || '';
            }
        },
        { text: (typeof l === 'function') ? l('Zone') : 'Zone', dataIndex: 'zone', flex: 1 },
        {
            text: (typeof l === 'function') ? l('Battery') : 'Battery',
            dataIndex: 'battery',
            width: 80,
            renderer: function (v) {
                if (v === undefined || v === null) return '—';
                var pct = parseInt(v, 10);
                var cls = pct > 50 ? 'indoor-online' : (pct > 20 ? 'indoor-low-battery' : 'indoor-offline');
                return '<span class="' + cls + '">' + pct + '%</span>';
            }
        },
        {
            text: (typeof l === 'function') ? l('Last Update') : 'Last Update',
            dataIndex: 'lastUpdate',
            width: 140,
            renderer: function (v) {
                if (v == null) return '—';
                var d = Ext.isDate(v) ? v : (typeof v === 'number' ? new Date(v * 1000) : new Date(v));
                return isNaN(d.getTime()) ? v : Ext.util.Format.date(d, 'd.m.Y H:i');
            }
        },
        {
            text: (typeof l === 'function') ? l('Status') : 'Status',
            dataIndex: 'status',
            width: 90,
            renderer: function (v) {
                var cls = v === 'online' ? 'indoor-online' : 'indoor-offline';
                return '<span class="indoor-status-badge ' + cls + '">' + (v || '—') + '</span>';
            }
        }
    ],

    initComponent: function () {
        var me = this;

        me.tbar = [
            {
                text: (typeof l === 'function') ? l('Export CSV') : 'Export CSV',
                iconCls: 'fa fa-file-csv',
                handler: me.exportCsv,
                scope: me
            },
            '->',
            {
                iconCls: 'fa fa-rotate',
                tooltip: (typeof l === 'function') ? l('Refresh') : 'Refresh',
                handler: function () {
                    var s = me.getStore();
                    if (s) s.load();
                }
            }
        ];

        if (!me.store) {
            me.store = Ext.create('Ext.data.Store', {
                fields: ['id', 'name', 'type', 'zone', 'battery', 'temperature', 'humidity', 'lastUpdate', 'status', 'isMoving', 'x', 'y', 'floor', 'confidence'],
                proxy: {
                    type: 'ajax',
                    url: me.storeUrl || '/ax/indoor/devices.php',
                    reader: { type: 'json', rootProperty: 'data' }
                },
                autoLoad: true
            });
        }

        me.listeners = {
            itemclick: me.onRowClick,
            scope: me
        };

        me.callParent();

        if (me.autoRefreshInterval > 0 && me.getStore()) {
            me.startAutoRefresh();
        }
    },

    onRowClick: function (view, record) {
        var me = this;
        var mapPanel = me.mapPanel || me.up('indoor-floorplanview');
        if (!mapPanel || !mapPanel.setMapCenter) return;
        var x = record.get('x');
        var y = record.get('y');
        if (x !== undefined && y !== undefined) {
            mapPanel.setMapCenter(x, y, 3);
        }
    },

    exportCsv: function () {
        var me = this;
        var store = me.getStore();
        var cols = ['name', 'type', 'zone', 'battery', 'lastUpdate', 'status'];
        var header = cols.join(',');
        var rows = store.getData().getRange().map(function (r) {
            return cols.map(function (c) {
                var v = r.get(c);
                if (v === undefined || v === null) return '';
                var s = String(v);
                if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1) {
                    return '"' + s.replace(/"/g, '""') + '"';
                }
                return s;
            }).join(',');
        });
        var csv = [header].concat(rows).join('\n');
        var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'indoor-devices-' + Ext.Date.format(new Date(), 'Y-m-d-Hi') + '.csv';
        a.click();
        URL.revokeObjectURL(a.href);
    },

    startAutoRefresh: function () {
        var me = this;
        if (me.autoRefreshInterval > 0) {
            me.refreshTask = Ext.interval(function () {
                if (me.store && !me.store.isLoading()) {
                    me.store.load();
                }
            }, me.autoRefreshInterval);
        }
    },

    onDestroy: function () {
        var me = this;
        if (me.refreshTask) {
            clearInterval(me.refreshTask);
        }
        me.callParent(arguments);
    }
});
