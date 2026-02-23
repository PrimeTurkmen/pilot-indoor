/**
 * PILOT Extension -- Indoor Positioning v4.0
 * Floating asset sidebar panel showing grouped asset details.
 *
 * Displays assets from the shared assetStore (storeId: 'indoorAssetsStore')
 * grouped by category (Staff, Equipment, Vehicles, etc.).
 * Each asset card shows: name, online status dot, battery icon, last location time.
 *
 * Interactions:
 *   - Click asset card -> select corresponding device in DeviceGrid + center map.
 *   - Toggle show/hide from Module toolbar button.
 *   - Collapsible, positioned on the east side of the layout.
 *
 * Binds to:
 *   - assetStore (indoorAssetsStore) for asset list and grouping.
 *   - deviceStore (indoorDevicesStore) for online status, battery, and last update.
 *
 * @see Module.js -- createStores(), assetStore / deviceStore field lists
 */

Ext.define('Store.indoor-positioning.AssetPanel', {
    extend: 'Ext.panel.Panel',
    xtype: 'indoor-assetpanel',

    cls: 'indoor-asset-panel',
    title: (typeof l === 'function') ? l('Assets') : 'Assets',
    iconCls: 'fa fa-tags',
    width: 280,
    collapsible: true,
    collapseDirection: 'right',
    animCollapse: false,
    autoScroll: true,
    bodyPadding: 0,

    /* ------------------------------------------------------------------ */
    /*  Init                                                              */
    /* ------------------------------------------------------------------ */

    initComponent: function () {
        var me = this;

        me.tbar = [
            {
                xtype: 'textfield',
                itemId: 'assetSearchField',
                emptyText: (typeof l === 'function') ? l('Search assets...') : 'Search assets...',
                flex: 1,
                listeners: {
                    change: { fn: me.onSearchChange, scope: me, buffer: 300 }
                }
            },
            {
                iconCls: 'fa fa-rotate',
                tooltip: (typeof l === 'function') ? l('Refresh') : 'Refresh',
                handler: function () {
                    me.refreshAssetList();
                }
            }
        ];

        me.bbar = [
            {
                xtype: 'tbtext',
                itemId: 'assetCountLabel',
                html: '0 assets'
            }
        ];

        me.callParent();

        /* -- Bind to stores when available ----------------------------- */
        me.on('afterrender', function () {
            me.bindStores();
            me.refreshAssetList();
        }, me, { single: true });
    },

    /* ------------------------------------------------------------------ */
    /*  Store binding                                                     */
    /* ------------------------------------------------------------------ */

    /**
     * Locate the shared assetStore and deviceStore from the StoreManager.
     * If provided directly via config, use those instead.
     */
    bindStores: function () {
        var me = this;

        if (!me.assetStore) {
            me.assetStore = Ext.data.StoreManager.lookup('indoorAssetsStore') || null;
        }
        if (!me.deviceStore) {
            me.deviceStore = Ext.data.StoreManager.lookup('indoorDevicesStore') || null;
        }

        // Listen for store changes to auto-refresh the card list
        if (me.assetStore) {
            me.assetStore.on('load', me.refreshAssetList, me);
            me.assetStore.on('datachanged', me.refreshAssetList, me);
        }
        if (me.deviceStore) {
            me.deviceStore.on('load', me.refreshAssetList, me);
            me.deviceStore.on('datachanged', me.refreshAssetList, me);
        }
    },

    /* ------------------------------------------------------------------ */
    /*  Rendering                                                         */
    /* ------------------------------------------------------------------ */

    /**
     * Rebuild the entire asset card list, grouped by category.
     * Groups: Staff, Equipment, Vehicles, and any other group found in data.
     */
    refreshAssetList: function () {
        var me = this;
        var assetStore = me.assetStore;
        var deviceStore = me.deviceStore;

        if (!me.rendered || !me.body) return;

        // Build asset data enriched with device info
        var assets = [];
        var searchText = me._searchText || '';

        if (assetStore) {
            assetStore.each(function (assetRec) {
                var name = assetRec.get('name') || '';
                var group = assetRec.get('group') || ((typeof l === 'function') ? l('Ungrouped') : 'Ungrouped');
                var deviceId = assetRec.get('deviceId') || '';
                var assetId = assetRec.get('id') || '';

                // Search filter
                if (searchText && name.toLowerCase().indexOf(searchText) === -1 &&
                    group.toLowerCase().indexOf(searchText) === -1) {
                    return;
                }

                // Look up device record for live status
                var deviceRec = null;
                if (deviceId && deviceStore) {
                    deviceRec = deviceStore.getById(deviceId);
                }
                // Also try matching by assetId on device records
                if (!deviceRec && deviceStore) {
                    deviceStore.each(function (dRec) {
                        if (dRec.get('assetId') === assetId) {
                            deviceRec = dRec;
                            return false; // break
                        }
                    });
                }

                var online = false;
                var battery = null;
                var lastUpdate = null;
                var locationType = '';

                if (deviceRec) {
                    online = deviceRec.get('online') === true || deviceRec.get('status') === 'online';
                    battery = deviceRec.get('battery');
                    lastUpdate = deviceRec.get('lastUpdate') || deviceRec.get('locationTime');
                    locationType = deviceRec.get('locationType') || '';
                    if (!deviceId) deviceId = deviceRec.get('id');
                }

                assets.push({
                    assetId:      assetId,
                    name:         name,
                    group:        group,
                    deviceId:     deviceId,
                    online:       online,
                    battery:      battery,
                    lastUpdate:   lastUpdate,
                    locationType: locationType
                });
            });
        } else if (deviceStore) {
            // Fallback: no assetStore loaded yet, show devices with asset names
            deviceStore.each(function (dRec) {
                var name = dRec.get('assetName') || dRec.get('name') || '';
                var group = dRec.get('assetGroup') || dRec.get('type') || ((typeof l === 'function') ? l('Ungrouped') : 'Ungrouped');

                if (searchText && name.toLowerCase().indexOf(searchText) === -1 &&
                    group.toLowerCase().indexOf(searchText) === -1) {
                    return;
                }

                assets.push({
                    assetId:      dRec.get('assetId') || dRec.get('id'),
                    name:         name,
                    group:        group,
                    deviceId:     dRec.get('id'),
                    online:       dRec.get('online') === true || dRec.get('status') === 'online',
                    battery:      dRec.get('battery'),
                    lastUpdate:   dRec.get('lastUpdate') || dRec.get('locationTime'),
                    locationType: dRec.get('locationType') || ''
                });
            });
        }

        // Group assets by category
        var groups = {};
        var groupOrder = [];
        for (var i = 0; i < assets.length; i++) {
            var g = assets[i].group;
            if (!groups[g]) {
                groups[g] = [];
                groupOrder.push(g);
            }
            groups[g].push(assets[i]);
        }

        // Sort group order: Staff first, then Equipment, Vehicles, then alpha
        var priorityGroups = { 'Staff': 0, 'Equipment': 1, 'Vehicles': 2 };
        groupOrder.sort(function (a, b) {
            var pa = priorityGroups[a] !== undefined ? priorityGroups[a] : 99;
            var pb = priorityGroups[b] !== undefined ? priorityGroups[b] : 99;
            if (pa !== pb) return pa - pb;
            return a.localeCompare(b);
        });

        // Render HTML
        var html = '';
        for (var gi = 0; gi < groupOrder.length; gi++) {
            var groupName = groupOrder[gi];
            var groupAssets = groups[groupName];

            html += '<div class="indoor-asset-group">';
            html += '<div class="indoor-asset-group-header" style="' +
                    'padding:8px 12px;font-size:11px;font-weight:700;text-transform:uppercase;' +
                    'letter-spacing:0.5px;color:var(--indoor-text-muted,#64748b);' +
                    'background:var(--indoor-bg-alt,#f8fafc);border-bottom:1px solid var(--indoor-border,#e2e8f0)">' +
                    Ext.String.htmlEncode(groupName) +
                    ' <span style="font-weight:400;color:var(--indoor-text-muted,#94a3b8)">(' + groupAssets.length + ')</span>' +
                    '</div>';

            for (var ai = 0; ai < groupAssets.length; ai++) {
                var asset = groupAssets[ai];
                html += me.renderAssetCard(asset);
            }

            html += '</div>';
        }

        if (!html) {
            html = '<div style="padding:20px;text-align:center;color:var(--indoor-text-muted,#94a3b8)">' +
                   '<i class="fa fa-tags" style="font-size:24px;margin-bottom:8px;display:block"></i>' +
                   ((typeof l === 'function') ? l('No assets found') : 'No assets found') +
                   '</div>';
        }

        me.body.setHtml(html);

        // Update footer count
        var countLabel = me.down('#assetCountLabel');
        if (countLabel) {
            var totalAssets = assets.length;
            var onlineCount = 0;
            for (var c = 0; c < assets.length; c++) {
                if (assets[c].online) onlineCount++;
            }
            countLabel.setHtml(totalAssets + ' asset' + (totalAssets !== 1 ? 's' : '') +
                               ' (' + onlineCount + ' online)');
        }

        // Attach click handlers to cards
        me.bindCardClicks();
    },

    /**
     * Render a single asset card as HTML.
     *
     * @param {Object} asset
     * @returns {string}
     */
    renderAssetCard: function (asset) {
        // Status dot
        var dotColor = asset.online ? '#059669' : '#94a3b8';
        var dotTitle = asset.online ? 'Online' : 'Offline';

        // Battery icon
        var batteryHtml = '';
        if (asset.battery !== null && asset.battery !== undefined) {
            var pct = parseInt(asset.battery, 10);
            if (!isNaN(pct)) {
                var batIcon, batColor;
                if (pct > 75) {
                    batIcon = 'fa-battery-full'; batColor = '#059669';
                } else if (pct > 50) {
                    batIcon = 'fa-battery-three-quarters'; batColor = '#059669';
                } else if (pct > 25) {
                    batIcon = 'fa-battery-half'; batColor = '#f59e0b';
                } else if (pct > 10) {
                    batIcon = 'fa-battery-quarter'; batColor = '#f59e0b';
                } else {
                    batIcon = 'fa-battery-empty'; batColor = '#ef4444';
                }
                batteryHtml = '<span style="color:' + batColor + ';font-size:11px" title="' + pct + '%">' +
                              '<i class="fa ' + batIcon + '"></i> ' + pct + '%</span>';
            }
        }

        // Last update relative time
        var timeHtml = '';
        if (asset.lastUpdate) {
            var d;
            if (typeof asset.lastUpdate === 'number') {
                d = asset.lastUpdate > 1e12 ? new Date(asset.lastUpdate) : new Date(asset.lastUpdate * 1000);
            } else {
                d = new Date(asset.lastUpdate);
            }
            if (!isNaN(d.getTime())) {
                var now = new Date();
                var diffSec = Math.floor((now.getTime() - d.getTime()) / 1000);
                var relTime;
                if (diffSec < 0) { relTime = 'just now'; }
                else if (diffSec < 60) { relTime = diffSec + 's ago'; }
                else if (diffSec < 3600) { relTime = Math.floor(diffSec / 60) + 'm ago'; }
                else if (diffSec < 86400) { relTime = Math.floor(diffSec / 3600) + 'h ago'; }
                else { relTime = Math.floor(diffSec / 86400) + 'd ago'; }
                timeHtml = '<span style="font-size:10px;color:var(--indoor-text-muted,#94a3b8)">' +
                           relTime + '</span>';
            }
        }

        return '<div class="indoor-asset-card" data-device-id="' + Ext.String.htmlEncode(asset.deviceId || '') + '"' +
               ' data-asset-id="' + Ext.String.htmlEncode(asset.assetId || '') + '"' +
               ' style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--indoor-border,#e2e8f0);' +
               'transition:background 0.15s"' +
               ' onmouseover="this.style.background=\'var(--indoor-bg-hover,#f1f5f9)\'"' +
               ' onmouseout="this.style.background=\'transparent\'">' +
               '<div style="display:flex;align-items:center;gap:8px">' +
               '  <span style="display:inline-block;width:8px;height:8px;border-radius:50%;' +
               'background:' + dotColor + ';flex-shrink:0" title="' + dotTitle + '"></span>' +
               '  <span style="flex:1;font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
               Ext.String.htmlEncode(asset.name || '--') + '</span>' +
               (batteryHtml ? '  ' + batteryHtml : '') +
               '</div>' +
               (timeHtml ? '<div style="margin-left:16px;margin-top:2px">' + timeHtml + '</div>' : '') +
               '</div>';
    },

    /* ------------------------------------------------------------------ */
    /*  Card click handler                                                */
    /* ------------------------------------------------------------------ */

    /**
     * Attach click event listeners to all rendered asset cards.
     * On click: select device in DeviceGrid + center map.
     */
    bindCardClicks: function () {
        var me = this;
        if (!me.body || !me.body.dom) return;

        var cards = me.body.dom.querySelectorAll('.indoor-asset-card');
        for (var i = 0; i < cards.length; i++) {
            (function (card) {
                card.addEventListener('click', function () {
                    var deviceId = card.getAttribute('data-device-id');
                    if (deviceId) {
                        me.onAssetCardClick(deviceId);
                    }
                });
            })(cards[i]);
        }
    },

    /**
     * Handle asset card click: select device in grid + center on map.
     *
     * @param {string} deviceId
     */
    onAssetCardClick: function (deviceId) {
        var me = this;
        if (!deviceId) return;

        var deviceStore = me.deviceStore || Ext.data.StoreManager.lookup('indoorDevicesStore');
        if (!deviceStore) return;

        var record = deviceStore.getById(deviceId);
        if (!record) return;

        // Fire event for external listeners
        me.fireEvent('assetselect', me, record);

        // Select in device grid if accessible
        var grid = Ext.ComponentQuery.query('indoor-devicegrid')[0];
        if (grid) {
            var gridStore = grid.getStore();
            if (gridStore) {
                var gridRecord = gridStore.getById(deviceId);
                if (gridRecord) {
                    grid.getSelectionModel().select(gridRecord);
                    // Scroll grid row into view
                    var idx = gridStore.indexOf(gridRecord);
                    if (idx >= 0 && grid.getView().focusRow) {
                        grid.getView().focusRow(idx);
                    }
                }
            }
        }

        // Center map on device
        var mapPanel = Ext.ComponentQuery.query('indoor-floorplanview')[0];
        if (mapPanel && mapPanel.setMapCenter) {
            var x = record.get('x');
            var y = record.get('y');
            if (x !== undefined && x !== null && y !== undefined && y !== null) {
                mapPanel.setMapCenter(x, y, 3);
            }
        }
    },

    /* ------------------------------------------------------------------ */
    /*  Search                                                            */
    /* ------------------------------------------------------------------ */

    /**
     * Handle search field change -- filter asset cards.
     *
     * @param {Ext.form.field.Text} field
     * @param {string} value
     */
    onSearchChange: function (field, value) {
        var me = this;
        me._searchText = (value || '').toLowerCase().trim();
        me.refreshAssetList();
    },

    /* ------------------------------------------------------------------ */
    /*  Toggle visibility                                                 */
    /* ------------------------------------------------------------------ */

    /**
     * Toggle panel visibility. Called from Module toolbar toggle button.
     */
    toggleVisibility: function () {
        var me = this;
        if (me.isVisible()) {
            me.hide();
        } else {
            me.show();
        }
    },

    /* ------------------------------------------------------------------ */
    /*  Cleanup                                                           */
    /* ------------------------------------------------------------------ */

    onDestroy: function () {
        var me = this;

        if (me.assetStore) {
            me.assetStore.un('load', me.refreshAssetList, me);
            me.assetStore.un('datachanged', me.refreshAssetList, me);
        }
        if (me.deviceStore) {
            me.deviceStore.un('load', me.refreshAssetList, me);
            me.deviceStore.un('datachanged', me.refreshAssetList, me);
        }

        me.callParent(arguments);
    }
});
