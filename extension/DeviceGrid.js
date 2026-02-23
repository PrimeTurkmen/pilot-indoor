/**
 * PILOT Extension — Indoor Positioning v3.0
 * Device table with columns: Name, Type, Zone, Battery%, Last Update, Status, Alerts.
 * Row click centers map on device. CSV export.
 *
 * v3.0: Zone column with restricted-zone badge highlighting.
 *       Alert indicator column (warning icon for active alerts).
 *       Auto-refresh disabled when WebSocket is active (Module.js
 *       pushes updates directly via deviceStore record.set()).
 *       Supports stopAutoRefresh() to hand off to WebSocket.
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
                var icon = v === 'person' ? '<i class="fa fa-user" style="margin-right:4px;color:var(--indoor-accent)"></i>' :
                           v === 'asset' ? '<i class="fa fa-box" style="margin-right:4px;color:#f59e0b"></i>' : '';
                var label = v === 'person' ? ((typeof l === 'function') ? l('Person') : 'Person') :
                            v === 'asset' ? ((typeof l === 'function') ? l('Asset') : 'Asset') : v || '';
                return icon + label;
            }
        },
        {
            text: (typeof l === 'function') ? l('Zone') : 'Zone',
            dataIndex: 'zone',
            flex: 1,
            renderer: function (v, meta) {
                if (!v) return '<span style="color:var(--indoor-text-muted)">—</span>';
                // Check if this zone is in our restricted set (set from Module.js)
                var grid = meta.column.up('grid');
                var isRestricted = grid && grid._restrictedZoneNames && grid._restrictedZoneNames[v];
                if (isRestricted) {
                    return '<span class="indoor-zone-badge indoor-zone-badge-restricted">' +
                           '<i class="fa fa-exclamation-triangle" style="margin-right:3px"></i>' +
                           Ext.String.htmlEncode(v) + '</span>';
                }
                return '<span class="indoor-zone-badge">' + Ext.String.htmlEncode(v) + '</span>';
            }
        },
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
        },
        {
            text: '<i class="fa fa-bell" title="Alerts"></i>',
            dataIndex: 'id',
            width: 45,
            align: 'center',
            sortable: false,
            menuDisabled: true,
            renderer: function (v, meta) {
                var grid = meta.column.up('grid');
                var hasAlert = grid && grid._deviceAlerts && grid._deviceAlerts[v];
                if (hasAlert) {
                    var severity = grid._deviceAlerts[v];
                    var color = severity === 'critical' ? '#ef4444' : (severity === 'warning' ? '#f59e0b' : 'var(--indoor-text-muted)');
                    return '<i class="fa fa-exclamation-circle indoor-alert-icon" style="color:' + color + '" title="' +
                           Ext.String.htmlEncode(severity) + ' alert"></i>';
                }
                return '';
            }
        }
    ],

    initComponent: function () {
        var me = this;

        // Track restricted zone names for badge rendering
        me._restrictedZoneNames = {};
        // Track device alerts: deviceId → severity
        me._deviceAlerts = {};

        me.tbar = [
            {
                text: (typeof l === 'function') ? l('Export CSV') : 'Export CSV',
                iconCls: 'fa fa-file-csv',
                handler: me.exportCsv,
                scope: me
            },
            '->',
            {
                xtype: 'tbtext',
                itemId: 'wsStatus',
                html: ''
            },
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

    /**
     * Set restricted zone names for badge rendering in the Zone column.
     * Called by Module.js when zone data arrives from engine.
     *
     * @param {Object} names - Hash of restricted zone names: {name: true, ...}
     */
    setRestrictedZones: function (names) {
        this._restrictedZoneNames = names || {};
        this.getView().refresh();
    },

    /**
     * Set an alert for a device (shown as icon in the Alerts column).
     * Called by Module.js when WebSocket alert event arrives.
     *
     * @param {string} deviceId
     * @param {string} severity - 'critical', 'warning', or 'info'
     */
    setDeviceAlert: function (deviceId, severity) {
        var me = this;
        me._deviceAlerts[deviceId] = severity;
        // Refresh just the affected row if possible
        var store = me.getStore();
        if (store) {
            var record = store.getById(deviceId);
            if (record) {
                var idx = store.indexOf(record);
                if (idx >= 0 && me.getView().refreshNode) {
                    me.getView().refreshNode(idx);
                }
            }
        }
    },

    /**
     * Clear alert for a device.
     *
     * @param {string} deviceId
     */
    clearDeviceAlert: function (deviceId) {
        delete this._deviceAlerts[deviceId];
    },

    /**
     * Update WebSocket connection status indicator in the toolbar.
     *
     * @param {boolean} connected
     */
    setWsStatus: function (connected) {
        var me = this;
        var statusItem = me.down('#wsStatus');
        if (statusItem) {
            if (connected) {
                statusItem.setHtml('<span class="indoor-ws-indicator indoor-ws-connected" title="Real-time"></span>');
            } else {
                statusItem.setHtml('<span class="indoor-ws-indicator indoor-ws-polling" title="Polling"></span>');
            }
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

    /**
     * Stop HTTP polling auto-refresh. Called by Module.js when WebSocket connects
     * to prevent redundant HTTP requests.
     */
    stopAutoRefresh: function () {
        var me = this;
        if (me.refreshTask) {
            clearInterval(me.refreshTask);
            me.refreshTask = null;
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
