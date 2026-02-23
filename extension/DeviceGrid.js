/**
 * PILOT Extension -- Indoor Positioning v4.0
 * Dockable device grid with 12 columns adapted for Velavu + Channel Sounding data.
 *
 * Columns: Status, Name, Type, Model, Group, Battery, Temperature, Humidity,
 *          Location, Accuracy, Last Update, Signal.
 *
 * Features:
 *   - Column sorting on all columns.
 *   - Row click fires 'deviceselect' event and centers map on device.
 *   - Right-click context menu: Locate on Map, View Details, Copy Serial.
 *   - External search filtering (bound from Module toolbar).
 *   - CSV export in header toolbar.
 *   - Auto-refresh indicator + manual refresh button.
 *   - Footer toolbar with device count summary and export button.
 *   - Collapsible, docked south in FloorPlanView, 250px default height, resizable.
 *   - WebSocket status indicator and stopAutoRefresh() handoff.
 *
 * Binds to the shared deviceStore (storeId: 'indoorDevicesStore') created by Module.js.
 *
 * v4.0: Expanded from 6 to 12 columns for full Velavu device data.
 *       Context menu with Locate / Details / Copy Serial.
 *       Footer toolbar with live counts and export.
 *       Relative time display for Last Update column.
 *
 * @see Module.js -- createStores(), deviceStore field list
 * @see FloorPlanView.js -- docks this grid south
 */

Ext.define('Store.indoor-positioning.DeviceGrid', {
    extend: 'Ext.grid.Panel',
    xtype: 'indoor-devicegrid',

    cls: 'indoor-device-grid',
    title: (typeof l === 'function') ? l('Devices') : 'Devices',
    collapsible: true,
    collapseDirection: 'bottom',
    animCollapse: false,
    height: 250,
    split: true,
    autoRefreshInterval: 5000,

    viewConfig: {
        stripeRows: true,
        emptyText: '<div class="x-grid-empty">No devices yet. Connect the positioning engine or add devices in settings.</div>'
    },

    /* ------------------------------------------------------------------ */
    /*  Columns                                                           */
    /* ------------------------------------------------------------------ */

    columns: [
        /* 1. Status -- colored dot */
        {
            text: '',
            dataIndex: 'online',
            width: 40,
            align: 'center',
            sortable: true,
            menuDisabled: true,
            renderer: function (v, meta, record) {
                var battery = record.get('battery');
                var isOnline = v === true || v === 'true' || record.get('status') === 'online';
                var isLowBat = battery !== null && battery !== undefined && battery < 15;
                var color, title;
                if (isOnline && !isLowBat) {
                    color = '#059669'; title = 'Online';
                } else if (isOnline && isLowBat) {
                    color = '#f59e0b'; title = 'Online (low battery)';
                } else {
                    color = '#94a3b8'; title = 'Offline';
                }
                return '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;' +
                       'background:' + color + ';" title="' + title + '"></span>';
            }
        },

        /* 2. Name */
        {
            text: (typeof l === 'function') ? l('Name') : 'Name',
            dataIndex: 'name',
            flex: 2,
            sortable: true,
            renderer: function (v, meta, record) {
                var name = v || record.get('assetName') || record.get('serial') || record.get('id') || '';
                return Ext.String.htmlEncode(name);
            }
        },

        /* 3. Type -- icon + text */
        {
            text: (typeof l === 'function') ? l('Type') : 'Type',
            dataIndex: 'type',
            width: 100,
            sortable: true,
            renderer: function (v) {
                var icons = {
                    person:  '<i class="fa fa-user" style="margin-right:4px;color:#059669"></i>',
                    asset:   '<i class="fa fa-box" style="margin-right:4px;color:#f59e0b"></i>',
                    anchor:  '<i class="fa fa-broadcast-tower" style="margin-right:4px;color:#6366f1"></i>',
                    vehicle: '<i class="fa fa-truck" style="margin-right:4px;color:#3b82f6"></i>'
                };
                var labels = {
                    person:  (typeof l === 'function') ? l('Person')  : 'Person',
                    asset:   (typeof l === 'function') ? l('Asset')   : 'Asset',
                    anchor:  (typeof l === 'function') ? l('Anchor')  : 'Anchor',
                    vehicle: (typeof l === 'function') ? l('Vehicle') : 'Vehicle'
                };
                var key = (v || '').toLowerCase();
                var icon = icons[key] || '';
                var label = labels[key] || Ext.String.htmlEncode(v || '');
                return icon + label;
            }
        },

        /* 4. Model -- hardware model */
        {
            text: (typeof l === 'function') ? l('Model') : 'Model',
            dataIndex: 'model',
            width: 120,
            sortable: true,
            renderer: function (v, meta, record) {
                var model = v || record.get('hardware') || '';
                return Ext.String.htmlEncode(model) || '<span style="color:var(--indoor-text-muted,#94a3b8)">--</span>';
            }
        },

        /* 5. Group -- asset group */
        {
            text: (typeof l === 'function') ? l('Group') : 'Group',
            dataIndex: 'assetGroup',
            width: 100,
            sortable: true,
            renderer: function (v) {
                if (!v) return '<span style="color:var(--indoor-text-muted,#94a3b8)">--</span>';
                return '<span class="indoor-zone-badge">' + Ext.String.htmlEncode(v) + '</span>';
            }
        },

        /* 6. Battery -- percentage with colored bar */
        {
            text: (typeof l === 'function') ? l('Battery') : 'Battery',
            dataIndex: 'battery',
            width: 90,
            sortable: true,
            renderer: function (v, meta, record) {
                if (v === undefined || v === null) return '<span style="color:var(--indoor-text-muted,#94a3b8)">--</span>';
                var pct = parseInt(v, 10);
                if (isNaN(pct)) return '--';
                var barColor = pct > 50 ? '#059669' : (pct > 15 ? '#f59e0b' : '#ef4444');
                var charging = record.get('batteryCharging') ? ' <i class="fa fa-bolt" style="color:#f59e0b" title="Charging"></i>' : '';
                return '<div style="display:flex;align-items:center;gap:4px">' +
                       '<div style="flex:1;height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden">' +
                       '<div style="width:' + Math.min(pct, 100) + '%;height:100%;background:' + barColor + ';border-radius:3px"></div>' +
                       '</div>' +
                       '<span style="font-size:11px;min-width:28px;text-align:right">' + pct + '%</span>' +
                       charging +
                       '</div>';
            }
        },

        /* 7. Temperature */
        {
            text: (typeof l === 'function') ? l('Temp') : 'Temp',
            dataIndex: 'temperature',
            width: 70,
            sortable: true,
            align: 'right',
            renderer: function (v) {
                if (v === undefined || v === null) return '<span style="color:var(--indoor-text-muted,#94a3b8)">--</span>';
                return v + ' &deg;C';
            }
        },

        /* 8. Humidity */
        {
            text: (typeof l === 'function') ? l('Humidity') : 'Humidity',
            dataIndex: 'humidity',
            width: 75,
            sortable: true,
            align: 'right',
            renderer: function (v) {
                if (v === undefined || v === null) return '<span style="color:var(--indoor-text-muted,#94a3b8)">--</span>';
                return v + '%';
            }
        },

        /* 9. Location -- MESH / FIXED / GPS badge */
        {
            text: (typeof l === 'function') ? l('Location') : 'Location',
            dataIndex: 'locationType',
            width: 80,
            sortable: true,
            align: 'center',
            renderer: function (v) {
                if (!v) return '<span style="color:var(--indoor-text-muted,#94a3b8)">--</span>';
                var colors = {
                    MESH:  'background:#6366f1;color:#fff',
                    FIXED: 'background:#059669;color:#fff',
                    GPS:   'background:#3b82f6;color:#fff'
                };
                var upper = (v || '').toUpperCase();
                var style = colors[upper] || 'background:#94a3b8;color:#fff';
                return '<span style="display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;' +
                       style + '">' + Ext.String.htmlEncode(upper) + '</span>';
            }
        },

        /* 10. Accuracy -- meters */
        {
            text: (typeof l === 'function') ? l('Accuracy') : 'Accuracy',
            dataIndex: 'accuracy',
            width: 75,
            sortable: true,
            align: 'right',
            renderer: function (v) {
                if (v === undefined || v === null) return '<span style="color:var(--indoor-text-muted,#94a3b8)">--</span>';
                var m = parseFloat(v);
                if (isNaN(m)) return '--';
                return m.toFixed(1) + ' m';
            }
        },

        /* 11. Last Update -- relative time */
        {
            text: (typeof l === 'function') ? l('Last Update') : 'Last Update',
            dataIndex: 'lastUpdate',
            width: 110,
            sortable: true,
            renderer: function (v) {
                if (v == null) return '<span style="color:var(--indoor-text-muted,#94a3b8)">--</span>';
                var d;
                if (Ext.isDate(v)) {
                    d = v;
                } else if (typeof v === 'number') {
                    // Unix seconds or milliseconds
                    d = v > 1e12 ? new Date(v) : new Date(v * 1000);
                } else {
                    d = new Date(v);
                }
                if (isNaN(d.getTime())) return Ext.String.htmlEncode(String(v));

                var now = new Date();
                var diffMs = now.getTime() - d.getTime();
                var diffSec = Math.floor(diffMs / 1000);

                if (diffSec < 0) return 'just now';
                if (diffSec < 60) return diffSec + 's ago';
                var diffMin = Math.floor(diffSec / 60);
                if (diffMin < 60) return diffMin + 'm ago';
                var diffHr = Math.floor(diffMin / 60);
                if (diffHr < 24) return diffHr + 'h ago';
                var diffDay = Math.floor(diffHr / 24);
                return diffDay + 'd ago';
            }
        },

        /* 12. Signal -- RSSI with bar */
        {
            text: (typeof l === 'function') ? l('Signal') : 'Signal',
            dataIndex: 'rssi',
            width: 90,
            sortable: true,
            renderer: function (v) {
                if (v === undefined || v === null) return '<span style="color:var(--indoor-text-muted,#94a3b8)">--</span>';
                var rssi = parseInt(v, 10);
                if (isNaN(rssi)) return '--';
                // RSSI typically -100 (weak) to -30 (strong): normalize to 0-100
                var pct = Math.max(0, Math.min(100, ((rssi + 100) / 70) * 100));
                var barColor = pct > 60 ? '#059669' : (pct > 30 ? '#f59e0b' : '#ef4444');
                return '<div style="display:flex;align-items:center;gap:4px">' +
                       '<div style="flex:1;height:4px;background:#e5e7eb;border-radius:2px;overflow:hidden">' +
                       '<div style="width:' + Math.round(pct) + '%;height:100%;background:' + barColor + ';border-radius:2px"></div>' +
                       '</div>' +
                       '<span style="font-size:10px;min-width:30px;text-align:right">' + rssi + '</span>' +
                       '</div>';
            }
        }
    ],

    /* ------------------------------------------------------------------ */
    /*  Init                                                              */
    /* ------------------------------------------------------------------ */

    initComponent: function () {
        var me = this;

        // Track restricted zone names for badge rendering (compat with v3)
        me._restrictedZoneNames = {};
        // Track device alerts: deviceId -> severity
        me._deviceAlerts = {};

        /* -- Header toolbar -------------------------------------------- */
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
                xtype: 'tbtext',
                itemId: 'autoRefreshIndicator',
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

        /* -- Footer toolbar (device count + export) -------------------- */
        me.bbar = [
            {
                xtype: 'tbtext',
                itemId: 'deviceCountSummary',
                html: '0 devices'
            },
            '->',
            {
                text: (typeof l === 'function') ? l('Export') : 'Export',
                iconCls: 'fa fa-download',
                handler: me.exportCsv,
                scope: me
            }
        ];

        /* -- Bind to shared store or create default -------------------- */
        if (!me.store) {
            var existing = Ext.data.StoreManager.lookup('indoorDevicesStore');
            if (existing) {
                me.store = existing;
            } else {
                me.store = Ext.create('Ext.data.Store', {
                    storeId: 'indoorDevicesStore',
                    fields: [
                        'id', 'serial', 'name', 'type', 'category',
                        'hardware', 'model', 'online', 'battery', 'batteryCharging',
                        'usbPower', 'lat', 'lng', 'accuracy', 'locationType',
                        'floorId', 'locationTime', 'temperature', 'humidity', 'rssi',
                        'installQuality', 'gatewayId', 'siteId', 'appVersion',
                        'heartbeat', 'lastUpdate', 'assetId', 'assetName', 'assetGroup',
                        'status', 'isMoving', 'x', 'y', 'floor', 'zone', 'confidence'
                    ],
                    proxy: {
                        type: 'ajax',
                        url: me.storeUrl || '/ax/indoor/devices.php',
                        reader: { type: 'json', rootProperty: 'data' }
                    },
                    autoLoad: true
                });
            }
        }

        /* -- Listeners ------------------------------------------------- */
        me.listeners = {
            itemclick: me.onRowClick,
            itemcontextmenu: me.onRowContextMenu,
            scope: me
        };

        me.callParent();

        /* -- Update footer counts when store changes ------------------- */
        var store = me.getStore();
        if (store) {
            store.on('datachanged', me.updateFooterCounts, me);
            store.on('load', me.updateFooterCounts, me);
            store.on('filterchange', me.updateFooterCounts, me);
        }

        /* -- Auto-refresh ---------------------------------------------- */
        if (me.autoRefreshInterval > 0 && me.getStore()) {
            me.startAutoRefresh();
        }
    },

    /* ------------------------------------------------------------------ */
    /*  Row click -> select device + center map                           */
    /* ------------------------------------------------------------------ */

    onRowClick: function (view, record) {
        var me = this;
        me.fireEvent('deviceselect', me, record);

        var mapPanel = me.mapPanel || me.up('indoor-floorplanview');
        if (!mapPanel || !mapPanel.setMapCenter) return;
        var x = record.get('x');
        var y = record.get('y');
        if (x !== undefined && x !== null && y !== undefined && y !== null) {
            mapPanel.setMapCenter(x, y, 3);
        }
    },

    /* ------------------------------------------------------------------ */
    /*  Context menu                                                      */
    /* ------------------------------------------------------------------ */

    onRowContextMenu: function (view, record, item, index, e) {
        var me = this;
        e.stopEvent();

        var menu = Ext.create('Ext.menu.Menu', {
            items: [
                {
                    text: (typeof l === 'function') ? l('Locate on Map') : 'Locate on Map',
                    iconCls: 'fa fa-crosshairs',
                    handler: function () {
                        me.onRowClick(view, record);
                    }
                },
                {
                    text: (typeof l === 'function') ? l('View Details') : 'View Details',
                    iconCls: 'fa fa-info-circle',
                    handler: function () {
                        me.showDeviceDetails(record);
                    }
                },
                '-',
                {
                    text: (typeof l === 'function') ? l('Copy Serial') : 'Copy Serial',
                    iconCls: 'fa fa-copy',
                    handler: function () {
                        var serial = record.get('serial') || record.get('id') || '';
                        if (navigator.clipboard && navigator.clipboard.writeText) {
                            navigator.clipboard.writeText(serial);
                        } else {
                            // Fallback for older browsers
                            var ta = document.createElement('textarea');
                            ta.value = serial;
                            ta.style.position = 'fixed';
                            ta.style.left = '-9999px';
                            document.body.appendChild(ta);
                            ta.select();
                            try { document.execCommand('copy'); } catch (err) {}
                            document.body.removeChild(ta);
                        }
                        if (typeof Ext.toast === 'function') {
                            Ext.toast({ html: 'Serial copied: ' + Ext.String.htmlEncode(serial), align: 'br', slideDuration: 300 });
                        }
                    }
                }
            ]
        });

        menu.showAt(e.getXY());
    },

    /**
     * Show a floating window with full device details.
     *
     * @param {Ext.data.Model} record
     */
    showDeviceDetails: function (record) {
        var fields = [
            { label: 'Name',        value: record.get('name') || record.get('assetName') || '' },
            { label: 'Serial',      value: record.get('serial') || '' },
            { label: 'ID',          value: record.get('id') || '' },
            { label: 'Type',        value: record.get('type') || '' },
            { label: 'Model',       value: record.get('model') || record.get('hardware') || '' },
            { label: 'Group',       value: record.get('assetGroup') || '' },
            { label: 'Status',      value: record.get('online') ? 'Online' : 'Offline' },
            { label: 'Battery',     value: record.get('battery') != null ? record.get('battery') + '%' : '--' },
            { label: 'Temperature', value: record.get('temperature') != null ? record.get('temperature') + ' C' : '--' },
            { label: 'Humidity',    value: record.get('humidity') != null ? record.get('humidity') + '%' : '--' },
            { label: 'Location',    value: record.get('locationType') || '--' },
            { label: 'Accuracy',    value: record.get('accuracy') != null ? record.get('accuracy') + ' m' : '--' },
            { label: 'RSSI',        value: record.get('rssi') != null ? record.get('rssi') + ' dBm' : '--' },
            { label: 'Zone',        value: record.get('zone') || '--' },
            { label: 'Floor',       value: record.get('floorId') || record.get('floor') || '--' },
            { label: 'Site',        value: record.get('siteId') || '--' },
            { label: 'Gateway',     value: record.get('gatewayId') || '--' },
            { label: 'Firmware',    value: record.get('appVersion') || '--' }
        ];

        var html = '<table class="indoor-detail-table" style="width:100%;border-collapse:collapse">';
        for (var i = 0; i < fields.length; i++) {
            html += '<tr>' +
                '<td style="padding:4px 8px;font-weight:600;white-space:nowrap;color:var(--indoor-text-muted,#64748b)">' +
                Ext.String.htmlEncode(fields[i].label) + '</td>' +
                '<td style="padding:4px 8px">' + Ext.String.htmlEncode(fields[i].value) + '</td>' +
                '</tr>';
        }
        html += '</table>';

        Ext.create('Ext.window.Window', {
            title: (typeof l === 'function') ? l('Device Details') : 'Device Details',
            width: 380,
            height: 420,
            layout: 'fit',
            modal: false,
            autoScroll: true,
            html: html
        }).show();
    },

    /* ------------------------------------------------------------------ */
    /*  Search filtering                                                  */
    /* ------------------------------------------------------------------ */

    /**
     * Filter the grid by search text. Called externally by Module.js
     * toolbar search field or other components.
     *
     * @param {string} text
     */
    filterBySearch: function (text) {
        var me = this;
        var store = me.getStore();
        if (!store) return;

        var v = (text || '').toLowerCase().trim();
        if (!v) {
            store.clearFilter();
            return;
        }
        store.filterBy(function (rec) {
            var name = (rec.get('name') || '').toLowerCase();
            var serial = (rec.get('serial') || '').toLowerCase();
            var assetName = (rec.get('assetName') || '').toLowerCase();
            var model = (rec.get('model') || '').toLowerCase();
            var group = (rec.get('assetGroup') || '').toLowerCase();
            return name.indexOf(v) !== -1 ||
                   serial.indexOf(v) !== -1 ||
                   assetName.indexOf(v) !== -1 ||
                   model.indexOf(v) !== -1 ||
                   group.indexOf(v) !== -1;
        });
    },

    /* ------------------------------------------------------------------ */
    /*  Footer counts                                                     */
    /* ------------------------------------------------------------------ */

    /**
     * Update the footer toolbar with device count summary.
     */
    updateFooterCounts: function () {
        var me = this;
        var store = me.getStore();
        if (!store) return;

        var total = store.getCount();
        var online = 0;
        store.each(function (rec) {
            if (rec.get('online') === true || rec.get('status') === 'online') {
                online++;
            }
        });

        var summary = total + ' device' + (total !== 1 ? 's' : '');
        summary += ' (' + online + ' online, ' + (total - online) + ' offline)';

        var el = me.down('#deviceCountSummary');
        if (el) {
            el.setHtml(summary);
        }
    },

    /* ------------------------------------------------------------------ */
    /*  Restricted zones (v3 compat)                                      */
    /* ------------------------------------------------------------------ */

    /**
     * Set restricted zone names for badge rendering in Zone column.
     * Called by Module.js when zone data arrives from engine.
     *
     * @param {Object} names - Hash of restricted zone names: {name: true, ...}
     */
    setRestrictedZones: function (names) {
        this._restrictedZoneNames = names || {};
        this.getView().refresh();
    },

    /* ------------------------------------------------------------------ */
    /*  Device alert indicators                                           */
    /* ------------------------------------------------------------------ */

    /**
     * Set an alert for a device (shown as icon overlay).
     * Called by Module.js when WebSocket alert event arrives.
     *
     * @param {string} deviceId
     * @param {string} severity - 'critical', 'warning', or 'info'
     */
    setDeviceAlert: function (deviceId, severity) {
        var me = this;
        me._deviceAlerts[deviceId] = severity;
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

    /* ------------------------------------------------------------------ */
    /*  WebSocket status                                                  */
    /* ------------------------------------------------------------------ */

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

    /* ------------------------------------------------------------------ */
    /*  CSV export                                                        */
    /* ------------------------------------------------------------------ */

    exportCsv: function () {
        var me = this;
        var store = me.getStore();
        if (!store) return;

        var cols = [
            'name', 'serial', 'type', 'model', 'assetGroup', 'battery',
            'temperature', 'humidity', 'locationType', 'accuracy',
            'lastUpdate', 'rssi', 'status', 'zone'
        ];
        var headers = [
            'Name', 'Serial', 'Type', 'Model', 'Group', 'Battery',
            'Temperature', 'Humidity', 'Location', 'Accuracy',
            'Last Update', 'RSSI', 'Status', 'Zone'
        ];

        var headerLine = headers.join(',');
        var rows = store.getData().getRange().map(function (r) {
            return cols.map(function (c) {
                var v = r.get(c);
                if (v === undefined || v === null) return '';
                var s = String(v);
                if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
                    return '"' + s.replace(/"/g, '""') + '"';
                }
                return s;
            }).join(',');
        });

        var csv = [headerLine].concat(rows).join('\n');
        var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'indoor-devices-' + Ext.Date.format(new Date(), 'Y-m-d-Hi') + '.csv';
        a.click();
        URL.revokeObjectURL(a.href);
    },

    /* ------------------------------------------------------------------ */
    /*  Auto-refresh                                                      */
    /* ------------------------------------------------------------------ */

    startAutoRefresh: function () {
        var me = this;
        if (me.autoRefreshInterval > 0) {
            me.refreshTask = Ext.interval(function () {
                if (me.store && !me.store.isLoading()) {
                    me.store.load();
                }
            }, me.autoRefreshInterval);
            me.updateAutoRefreshIndicator(true);
        }
    },

    /**
     * Stop HTTP polling auto-refresh. Called by Module.js when WebSocket
     * connects to prevent redundant HTTP requests.
     */
    stopAutoRefresh: function () {
        var me = this;
        if (me.refreshTask) {
            clearInterval(me.refreshTask);
            me.refreshTask = null;
        }
        me.updateAutoRefreshIndicator(false);
    },

    /**
     * Update the auto-refresh indicator in the toolbar.
     *
     * @param {boolean} active
     */
    updateAutoRefreshIndicator: function (active) {
        var me = this;
        var indicator = me.down('#autoRefreshIndicator');
        if (indicator) {
            if (active) {
                indicator.setHtml(
                    '<span style="font-size:10px;color:var(--indoor-text-muted,#94a3b8)">' +
                    '<i class="fa fa-sync-alt" style="margin-right:3px"></i>' +
                    Math.round(me.autoRefreshInterval / 1000) + 's' +
                    '</span>'
                );
            } else {
                indicator.setHtml('');
            }
        }
    },

    /* ------------------------------------------------------------------ */
    /*  Cleanup                                                           */
    /* ------------------------------------------------------------------ */

    onDestroy: function () {
        var me = this;
        if (me.refreshTask) {
            clearInterval(me.refreshTask);
        }
        var store = me.getStore();
        if (store) {
            store.un('datachanged', me.updateFooterCounts, me);
            store.un('load', me.updateFooterCounts, me);
            store.un('filterchange', me.updateFooterCounts, me);
        }
        me.callParent(arguments);
    }
});
