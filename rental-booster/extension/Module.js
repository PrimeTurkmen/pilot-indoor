/**
 * PILOT Rental Booster extension
 * Store.rental_booster.Module — a rental-operations dashboard for car rental
 * fleets, running inside the logged-in Pilot session (same-origin fetch).
 *
 * Sections:
 *   Fleet      — vehicles, mileage, status, driver (GET /api/v3/vehicles)
 *   Contracts  — rental contracts (GET /api/v3/rentcar/contracts)
 *   Fines      — traffic fines / tolls (GET /api/v3/vehicles/fines)
 *   AI         — natural-language assistant (DeepSeek, configurable server)
 *
 * Reusable across accounts: everything is config-driven (config.json), the
 * mileage-limit rule is a setting, nothing is hardcoded to one client.
 *
 * NOTE (from Promatic extension, confirmed): inside a /store/ extension use
 * native fetch() with absolute same-origin paths (/api/..., /backend/...).
 * Ext.Ajax rewrites relative paths through the /store/<ext>/ proxy → 404.
 */
Ext.define('Store.rental_booster.Module', {
    extend: 'Ext.Component',
    extensionName: 'rental_booster',
    version: '0.1.0',
    moduleBuild: '2026-10-23',

    DEFAULT_CONFIG: {
        aiServerUrl: 'https://apiport.ae/pilot-ai',
        refreshInterval: 30000,
        mileageLimitKm: 4500,          // free km per month, rest is billed
        mileageField: 'current_mileage',
        showFines: true,
        showContracts: true,
        showAI: true,
        contextMaxVehicles: 300
    },

    initModule: function (main, online) {
        this.main = main;
        this.config = Ext.apply({}, this.DEFAULT_CONFIG);
        this.loadConfig();
        this.loadStyles();
        this.buildTab();
    },

    loadConfig: function () {
        var me = this;
        fetch('/store/rental_booster/config.json', { credentials: 'include', cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (c) { if (c && typeof c === 'object') { me.config = Ext.apply(me.config, c); } })
            .catch(function () { /* keep defaults */ });
    },

    loadStyles: function () {
        var l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = '/store/rental_booster/styles.css';
        document.head.appendChild(l);
    },

    /* ------------------------------------------------------------------ */
    /*  UI                                                                */
    /* ------------------------------------------------------------------ */

    buildTab: function () {
        var me = this;
        var sk = (this.main && this.main.skeleton) || window.skeleton;

        this.fleetStore = this.buildFleetStore();
        this.contractStore = this.buildContractStore();
        this.finesStore = this.buildFinesStore();

        var items = [this.buildFleetPanel()];

        if (this.config.showContracts !== false) { items.push(this.buildContractsPanel()); }
        if (this.config.showFines !== false) { items.push(this.buildFinesPanel()); }

        this.tab = Ext.create('Ext.panel.Panel', {
            title: 'Rental Booster',
            iconCls: 'fa fa-key',
            iconAlign: 'top',
            cls: 'rental-booster-tab',
            layout: 'fit',
            tbar: this.buildToolbar(),
            items: [{
                xtype: 'tabpanel',
                layout: 'fit',
                items: items
            }]
        });

        if (sk && sk.navigation && typeof sk.navigation.add === 'function') {
            sk.navigation.add(this.tab);
        }

        this.tab.on('afterrender', function () {
            me.refreshAll();
            if (me.config.refreshInterval) {
                me._timer = setInterval(function () { me.refreshAll(); }, me.config.refreshInterval);
            }
        });

        if (this.config.showAI !== false) { this.buildAIWindow(); }
    },

    buildToolbar: function () {
        var me = this;
        return {
            cls: 'transparent_buttons',
            items: [
                {
                    xtype: 'tbtext',
                    itemId: 'rbCounts',
                    html: '<span class="rb-count">…</span>'
                },
                '->',
                this.config.showAI === false ? null : {
                    xtype: 'button',
                    text: 'AI',
                    iconCls: 'fa fa-brain-circuit',
                    handler: function () { me.toggleAI(); }
                },
                {
                    xtype: 'button',
                    iconCls: 'fa fa-rotate',
                    tooltip: 'Refresh',
                    handler: function () { me.refreshAll(); }
                }
            ]
        };
    },

    /* ------------------------------------------------------------------ */
    /*  Stores (native fetch → Ext.data.Store)                            */
    /* ------------------------------------------------------------------ */

    buildFleetStore: function () {
        return Ext.create('Ext.data.Store', {
            storeId: 'rbFleetStore',
            fields: ['agentid', 'plate', 'model', 'folder', 'mileage', 'type', 'status', 'driver'],
            data: []
        });
    },

    buildContractStore: function () {
        return Ext.create('Ext.data.Store', {
            storeId: 'rbContractStore',
            fields: ['id', 'vehnum', 'driver', 'status', 'date_start', 'date_end', 'km_limit', 'km_used'],
            data: []
        });
    },

    buildFinesStore: function () {
        return Ext.create('Ext.data.Store', {
            storeId: 'rbFinesStore',
            fields: ['id', 'plate', 'date', 'amount', 'type', 'paid'],
            data: []
        });
    },

    /* ------------------------------------------------------------------ */
    /*  Panels                                                            */
    /* ------------------------------------------------------------------ */

    buildFleetPanel: function () {
        var me = this;
        return {
            title: 'Fleet',
            iconCls: 'fa fa-car',
            layout: 'fit',
            items: [{
                xtype: 'grid',
                itemId: 'rbFleetGrid',
                store: this.fleetStore,
                columns: [
                    { text: 'Plate', dataIndex: 'plate', flex: 1 },
                    { text: 'Model', dataIndex: 'model', flex: 1.5 },
                    { text: 'Folder', dataIndex: 'folder', flex: 1 },
                    { text: 'Mileage (km)', dataIndex: 'mileage', width: 110, align: 'right',
                      renderer: function (v) { return v != null ? Ext.util.Format.number(v, '0,000') : '—'; } },
                    { text: 'Status', dataIndex: 'status', width: 90 },
                    { text: 'Driver', dataIndex: 'driver', flex: 1 }
                ]
            }]
        };
    },

    buildContractsPanel: function () {
        var me = this;
        return {
            title: 'Contracts',
            iconCls: 'fa fa-file-signature',
            layout: 'fit',
            items: [{
                xtype: 'grid',
                itemId: 'rbContractGrid',
                store: this.contractStore,
                columns: [
                    { text: 'Vehicle', dataIndex: 'vehnum', flex: 1 },
                    { text: 'Driver', dataIndex: 'driver', flex: 1 },
                    { text: 'Status', dataIndex: 'status', width: 100 },
                    { text: 'Start', dataIndex: 'date_start', width: 130 },
                    { text: 'End', dataIndex: 'date_end', width: 130 },
                    { text: 'Km limit', dataIndex: 'km_limit', width: 90, align: 'right' },
                    { text: 'Km used', dataIndex: 'km_used', width: 90, align: 'right' }
                ]
            }]
        };
    },

    buildFinesPanel: function () {
        var me = this;
        return {
            title: 'Fines / Tolls',
            iconCls: 'fa fa-exclamation-triangle',
            layout: 'fit',
            items: [{
                xtype: 'grid',
                itemId: 'rbFinesGrid',
                store: this.finesStore,
                columns: [
                    { text: 'Plate', dataIndex: 'plate', flex: 1 },
                    { text: 'Type', dataIndex: 'type', flex: 1 },
                    { text: 'Date', dataIndex: 'date', width: 130 },
                    { text: 'Amount', dataIndex: 'amount', width: 100, align: 'right' },
                    { text: 'Paid', dataIndex: 'paid', width: 70 }
                ]
            }]
        };
    },

    /* ------------------------------------------------------------------ */
    /*  Data loading                                                      */
    /* ------------------------------------------------------------------ */

    refreshAll: function () {
        this.loadFleet();
        this.loadContracts();
        this.loadFines();
    },

    loadFleet: function () {
        var me = this;
        fetch('/api/v3/vehicles', { credentials: 'include' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                var list = (d && d.data) || [];
                var rows = list.map(function (v) {
                    var st = v.status;
                    var statusText = '—';
                    if (st) {
                        statusText = (st.moving || st.speed > 0) ? 'Moving'
                            : (st.lat && st.lon) ? 'Parked' : 'Offline';
                    }
                    return {
                        agentid: v.agentid || v.veh_id,
                        plate: v.vehiclenumber,
                        model: v.model,
                        folder: v.folder,
                        mileage: v.current_mileage,
                        type: v.type,
                        status: statusText,
                        driver: v.driver_name || ''
                    };
                });
                me.fleetStore.loadData(rows);
                me.updateCounts(list.length, rows);
            })
            .catch(function () { /* offline / error */ });
    },

    loadContracts: function () {
        var me = this;
        fetch('/api/v3/rentcar/contracts?status=open,booked,closed', { credentials: 'include' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                var list = (d && d.list) || (d && d.data) || [];
                var rows = list.map(function (c) {
                    return {
                        id: c.id,
                        vehnum: c.vehnum || c.vehiclenumber || c.veh_id || '',
                        driver: c.driver || c.driver_name || '',
                        status: c.status || '',
                        date_start: c.date_start || c.start || '',
                        date_end: c.date_end || c.end || '',
                        km_limit: c.km_limit || c.limit_km || '',
                        km_used: c.km_used || ''
                    };
                });
                me.contractStore.loadData(rows);
            })
            .catch(function () { /* contracts module may be off */ });
    },

    loadFines: function () {
        var me = this;
        fetch('/api/v3/vehicles/fines', { credentials: 'include' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                var list = (d && d.data) || (d && d.list) || [];
                var rows = list.map(function (f) {
                    return {
                        id: f.id,
                        plate: f.vehiclenumber || f.plate || '',
                        date: f.date || f.dt || '',
                        amount: f.amount || f.sum || f.cost || '',
                        type: f.type || f.name || '',
                        paid: f.paid ? 'Yes' : 'No'
                    };
                });
                me.finesStore.loadData(rows);
            })
            .catch(function () { /* fines module may be off — leave empty */ });
    },

    updateCounts: function (total, rows) {
        var moving = rows.filter(function (r) { return r.status === 'Moving'; }).length;
        var parked = rows.filter(function (r) { return r.status === 'Parked'; }).length;
        var el = this.tab && this.tab.down('#rbCounts');
        if (el) {
            el.setHtml('<span class="rb-count">' + total + ' vehicles</span> · '
                + '<span class="rb-count rb-moving">' + moving + ' moving</span> · '
                + '<span class="rb-count rb-parked">' + parked + ' parked</span>');
        }
    },

    /* ------------------------------------------------------------------ */
    /*  AI chat                                                           */
    /* ------------------------------------------------------------------ */

    buildAIWindow: function () {
        var me = this;
        this.aiHistory = [];
        this.aiHistoryEl = null;

        this.aiWin = Ext.create('Ext.window.Window', {
            title: 'Rental AI',
            width: 460,
            height: 560,
            layout: 'fit',
            closable: true,
            closeAction: 'hide',
            items: [{
                xtype: 'panel',
                layout: { type: 'vbox', align: 'stretch' },
                bodyPadding: 10,
                items: [
                    { xtype: 'container', itemId: 'rbAiHistory', flex: 1, autoScroll: true, html: '<div class="rb-chat"></div>' },
                    {
                        xtype: 'textarea', itemId: 'rbAiInput', height: 72,
                        emptyText: 'Спроси: сколько свободных машин? кто превысил лимит 4500 км? штрафы?',
                        enableKeyEvents: true,
                        listeners: { specialkey: function (f, e) {
                            if (e.getKey() === e.ENTER && !e.shiftKey) { e.stopEvent(); me.askAI(); }
                        } }
                    },
                    { xtype: 'button', text: 'Ask', margin: '8 0 0 0', handler: function () { me.askAI(); } }
                ]
            }],
            listeners: { afterrender: function () {
                me.aiHistoryEl = me.aiWin.down('#rbAiHistory').getEl();
            } }
        });
    },

    toggleAI: function () {
        if (this.aiWin.isVisible()) { this.aiWin.hide(); }
        else { this.aiWin.show(); this.aiWin.down('#rbAiInput').focus(); }
    },

    askAI: function () {
        var me = this;
        var input = this.aiWin.down('#rbAiInput');
        var q = (input.getValue() || '').trim();
        if (!q) { return; }
        input.setValue('');
        this.aiAppend('user', q);
        this.aiAppend('ai', '…');
        this.gatherAIContext(function (ctx) {
            me.postAI(q, ctx, function (answer) { me.aiReplaceLast(answer); });
        });
    },

    gatherAIContext: function (cb) {
        var me = this;
        var ctx = { mileageLimitKm: this.config.mileageLimitKm };
        var jobs = [
            new Promise(function (res) {
                fetch('/api/v3/vehicles', { credentials: 'include' })
                    .then(function (r) { return r.ok ? r.json() : null; })
                    .then(function (d) {
                        var list = (d && d.data) || [];
                        ctx.vehicles = list.slice(0, me.config.contextMaxVehicles).map(function (v) {
                            return { plate: v.vehiclenumber, model: v.model, odometerKm: v.current_mileage, folder: v.folder };
                        });
                        ctx.vehicleCount = list.length;
                        res();
                    }).catch(function () { ctx.vehicles = []; res(); });
            }),
            new Promise(function (res) {
                fetch('/api/v3/rentcar/contracts?status=open,booked,closed', { credentials: 'include' })
                    .then(function (r) { return r.ok ? r.json() : null; })
                    .then(function (d) { ctx.contracts = (d && (d.list || d.data)) || []; res(); })
                    .catch(function () { ctx.contracts = []; res(); });
            })
        ];
        Promise.all(jobs).then(function () { cb(ctx); });
    },

    postAI: function (q, ctx, cb) {
        fetch(this.config.aiServerUrl.replace(/\/+$/, '') + '/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: q, context: ctx })
        })
            .then(function (r) { return r.json(); })
            .then(function (d) { cb((d && (d.answer || d.error)) || 'No answer.'); })
            .catch(function (e) { cb('AI server error: ' + e.message); });
    },

    aiAppend: function (who, text) {
        this.aiHistory.push({ who: who, text: text });
        this.aiRender();
    },

    aiReplaceLast: function (text) {
        var last = this.aiHistory[this.aiHistory.length - 1];
        if (last && last.who === 'ai') { last.text = text; }
        this.aiRender();
    },

    aiRender: function () {
        if (!this.aiHistoryEl) { return; }
        var html = this.aiHistory.map(function (m) {
            var cls = m.who === 'user' ? 'rb-msg-user' : 'rb-msg-ai';
            return '<div class="' + cls + '">' + Ext.htmlEncode(m.text).replace(/\n/g, '<br>') + '</div>';
        }).join('');
        this.aiHistoryEl.update('<div class="rb-chat">' + html + '</div>');
        this.aiHistoryEl.scroll('b', 100000, false);
    }
});
