/**
 * PILOT RTA · Salik extension
 * Store.rta_salik.Module — RTA traffic fines + Salik tolls dashboard for a
 * car-rental / fleet operator, running inside the logged-in Pilot session.
 *
 * Sections:
 *   Fines & Tolls — RTA fines + Salik toll charges per vehicle
 *   Fleet         — vehicles (plate, model, mileage, status)
 *   AI            — natural-language assistant (DeepSeek)
 *
 * Data sources (same-origin, session cookie):
 *   GET /api/v3/vehicles/fines   — traffic fines (RTA)
 *   GET /api/v3/vehicles         — fleet
 *   (Salik toll feed plugs in via the AI/backend once the TARS/Salik source
 *    is wired — see config.salikSourceUrl)
 *
 * NOTE: inside a /store/ extension use native fetch() with absolute
 * same-origin paths (/api/...). Ext.Ajax rewrites them through the
 * /store/<ext>/ proxy → 404.
 */
Ext.define('Store.rta_salik.Module', {
    extend: 'Ext.Component',
    extensionName: 'rta_salik',
    version: '0.1.0',
    moduleBuild: '2026-10-23',

    DEFAULT_CONFIG: {
        aiServerUrl: 'https://pilot-ai.zamtek.ae',
        refreshInterval: 30000,
        showFleet: true,
        showAI: true,
        contextMaxVehicles: 300,
        salikSourceUrl: '',            // optional Salik/TARS feed (server-side)
        salikNotice: 'Salik tolls — contact your admin to enable this feature.'
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
        fetch('/store/rta_salik/config.json', { credentials: 'include', cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (c) { if (c && typeof c === 'object') { me.config = Ext.apply(me.config, c); } })
            .catch(function () { /* defaults */ });
    },

    loadStyles: function () {
        var l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = '/store/rta_salik/styles.css';
        document.head.appendChild(l);
    },

    /* ------------------------------------------------------------------ */
    /*  UI                                                                */
    /* ------------------------------------------------------------------ */

    buildTab: function () {
        var me = this;
        var sk = (this.main && this.main.skeleton) || window.skeleton;

        this.finesStore = this.buildFinesStore();
        this.fleetStore = this.buildFleetStore();
        this.salikStore = this.buildSalikStore();

        var items = [this.buildFinesPanel(), this.buildSalikPanel()];

        this.tab = Ext.create('Ext.panel.Panel', {
            title: 'RTA Salik',
            iconCls: 'fa fa-tags',
            iconAlign: 'top',
            cls: 'rta-salik-tab',
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
                { xtype: 'tbtext', itemId: 'rsCounts', html: '<span class="rs-count">…</span>' },
                '->',
                this.config.showAI === false ? null : {
                    xtype: 'button', text: 'AI', iconCls: 'fa fa-brain-circuit',
                    handler: function () { me.toggleAI(); }
                },
                {
                    xtype: 'button', iconCls: 'fa fa-rotate', tooltip: 'Refresh',
                    handler: function () { me.refreshAll(); }
                }
            ]
        };
    },

    /* ------------------------------------------------------------------ */
    /*  Stores                                                            */
    /* ------------------------------------------------------------------ */

    buildFinesStore: function () {
        return Ext.create('Ext.data.Store', {
            storeId: 'rsFinesStore',
            fields: ['id', 'plate', 'type', 'date', 'amount', 'paid', 'source', 'agentid'],
            data: []
        });
    },

    buildFleetStore: function () {
        return Ext.create('Ext.data.Store', {
            storeId: 'rsFleetStore',
            fields: ['agentid', 'plate', 'plateRaw', 'model', 'folder', 'mileage', 'status'],
            data: []
        });
    },

    buildSalikStore: function () {
        return Ext.create('Ext.data.Store', {
            storeId: 'rsSalikStore',
            fields: ['plate', 'trips', 'total', 'agentid', 'lastTripDate'],
            data: []
        });
    },

    /* ------------------------------------------------------------------ */
    /*  Panels                                                            */
    /* ------------------------------------------------------------------ */

    buildFinesPanel: function () {
        return {
            title: 'RTA Fines',
            iconCls: 'fa fa-tags',
            layout: 'fit',
            items: [{
                xtype: 'grid',
                itemId: 'rsFinesGrid',
                store: this.finesStore,
                emptyText: 'No RTA fines for this fleet.',
                listeners: {
                    itemclick: function (grid, record) {
                        me.showOnMap(record.get('agentid'), record.get('date'));
                    }
                },
                columns: [
                    { text: 'Plate', dataIndex: 'plate', flex: 1 },
                    { text: 'Type', dataIndex: 'type', flex: 1 },
                    { text: 'Source', dataIndex: 'source', width: 90 },
                    { text: 'Date', dataIndex: 'date', width: 130 },
                    { text: 'Amount', dataIndex: 'amount', width: 100, align: 'right',
                      renderer: function (v) { return v != null ? Ext.util.Format.number(v, '0,000.00') : '—'; } },
                    { text: 'Paid', dataIndex: 'paid', width: 70 }
                ]
            }]
        };
    },

    buildSalikPanel: function () {
        return {
            title: 'Salik Tolls',
            iconCls: 'fa fa-tag',
            layout: 'fit',
            items: [{
                xtype: 'grid',
                itemId: 'rsSalikGrid',
                store: this.salikStore,
                emptyText: 'No Salik tolls for this fleet.',
                listeners: {
                    itemclick: function (grid, record) {
                        me.showOnMap(record.get('agentid'), record.get('lastTripDate'));
                    }
                },
                columns: [
                    { text: 'Plate', dataIndex: 'plate', flex: 1 },
                    { text: 'Trips (30d)', dataIndex: 'trips', width: 110, align: 'right' },
                    { text: 'Total (AED)', dataIndex: 'total', width: 130, align: 'right',
                      renderer: function (v) { return v != null ? Ext.util.Format.number(v, '0,000.00') : '—'; } }
                ]
            }]
        };
    },

    buildFleetPanel: function () {
        return {
            title: 'Fleet',
            iconCls: 'fa fa-car',
            layout: 'fit',
            items: [{
                xtype: 'grid',
                itemId: 'rsFleetGrid',
                store: this.fleetStore,
                columns: [
                    { text: 'Plate', dataIndex: 'plate', flex: 1 },
                    { text: 'Model', dataIndex: 'model', flex: 1.5 },
                    { text: 'Folder', dataIndex: 'folder', flex: 1 },
                    { text: 'Mileage (km)', dataIndex: 'mileage', width: 110, align: 'right',
                      renderer: function (v) { return v != null ? Ext.util.Format.number(v, '0,000') : '—'; } },
                    { text: 'Status', dataIndex: 'status', width: 90 }
                ]
            }]
        };
    },

    /* ------------------------------------------------------------------ */
    /*  Data loading                                                      */
    /* ------------------------------------------------------------------ */

    extractPlate: function (raw) {
        // Return {code, number, clean} for a real plate, or null for junk/test objects.
        if (!raw) { return null; }
        var s = String(raw).trim().toUpperCase();
        if (/^1\.|HEAD OFFICE|FOLDER/.test(s)) { return null; }
        if (/TEST|DEVICE|FMC|FTC|FMB|FMT/.test(s)) { return null; }
        var digits = s.match(/\d{1,5}/g);
        if (!digits || !digits.length) { return null; }
        var number = digits.slice().sort(function (a, b) { return b.length - a.length; })[0];
        var letters = s.match(/[A-Z]{1,2}/g) || [];
        if (!letters.length) { return null; }
        return { code: letters[0], number: number, clean: letters[0] + ' ' + number };
    },

    refreshAll: function () {
        var me = this;
        this.loadFleet(function () { me.loadFines(); me.loadSalik(); });
    },

    loadSalik: function () {
        var me = this;
        fetch((this.config.aiServerUrl || '').replace(/\/+$/, '') + '/salik')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                var data = (d && d.data) || {};
                var rows = [];
                me.fleetStore.each(function (r) {
                    var raw = (r.get('plateRaw') || '').trim();
                    var e = data[raw];
                    if (e && !e.error) {
                        var tolls = e.tolls || [];
                        var lastTrip = tolls.length ? tolls[tolls.length - 1].date : '';
                        rows.push({ plate: r.get('plate'), trips: e.tripCount || 0, total: e.totalTolls || 0,
                                    agentid: r.get('agentid'), lastTripDate: lastTrip });
                    }
                });
                me.salikStore.loadData(rows);
            })
            .catch(function () { /* no salik data */ });
    },

    loadFines: function () {
        var me = this;
        var plates = [];
        var cleanByRaw = {};
        var agentidByRaw = {};
        this.fleetStore.each(function (r) {
            var raw = (r.get('plateRaw') || '').trim();
            if (raw) { plates.push(raw); cleanByRaw[raw] = r.get('plate'); agentidByRaw[raw] = r.get('agentid'); }
        });
        if (!plates.length) { return; }
        var url = (this.config.aiServerUrl || '').replace(/\/+$/, '') + '/rta-fines';
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ plates: plates })
        })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                var rows = [];
                Object.keys(d || {}).forEach(function (raw) {
                    var entry = d[raw] || {};
                    var clean = cleanByRaw[raw] || raw;
                    (entry.fines || []).forEach(function (f) {
                        rows.push({
                            id: f.referenceNo || '',
                            plate: clean,
                            type: f.description || f.source || '',
                            source: f.source || 'RTA',
                            date: f.ticketDate || '',
                            amount: f.amount || 0,
                            paid: 'No',
                            agentid: agentidByRaw[raw] || ''
                        });
                    });
                });
                me.finesStore.loadData(rows);
                me.updateCounts(rows);
            })
            .catch(function () { /* backend unreachable */ });
    },

    showOnMap: function (agentid, dateStr) {
        var me = this;
        var sk = (this.main && this.main.skeleton) || window.skeleton;
        var mapframe = sk && sk.mapframe;
        if (!mapframe || !agentid || !dateStr) { return; }
        var ts = new Date(dateStr).getTime() / 1000;
        if (!ts || isNaN(ts)) { return; }
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        var fmt = function (ms) {
            var d = new Date(ms);
            return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
        };
        var body = 'start=' + encodeURIComponent(fmt((ts - 1800) * 1000))
            + '&end=' + encodeURIComponent(fmt((ts + 1800) * 1000))
            + '&vehs=' + encodeURIComponent(agentid)
            + '&weekdays=true&weekend=true&parkings=true';
        fetch('/backend/ax/tracks_get_history.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body,
            credentials: 'include'
        })
            .then(function (r) { return r.json(); })
            .then(function (segments) {
                var best = null, bestDist = Infinity;
                (segments || []).forEach(function (seg) {
                    var mid = (Number(seg.start_unixtimestamp) + Number(seg.end_unixtimestamp)) / 2;
                    var dist = Math.abs(mid - ts);
                    if (dist < bestDist) { bestDist = dist; best = seg; }
                });
                if (!best) { return; }
                var lat = Number(best.lat), lon = Number(best.lon);
                if (!lat || !lon) { return; }
                var mp = mapframe.getMap ? mapframe.getMap() : mapframe.map;
                if (mp && mp.setView) { mp.setView([lat, lon], 15); }
                if (mapframe.addMarker) {
                    mapframe.addMarker({ lat: lat, lon: lon, size: 'medium', poupContent: (best.veh_name || '') + ' @ ' + (best.start || '') });
                }
            })
            .catch(function () {});
    },

    loadFleet: function (cb) {
        var me = this;
        fetch('/api/v3/vehicles', { credentials: 'include' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                var list = (d && d.data) || [];
                var rows = [];
                list.forEach(function (v) {
                    var p = me.extractPlate(v.vehiclenumber);
                    if (!p) { return; }  // skip junk / test devices
                    var st = v.status;
                    var statusText = '—';
                    if (st) {
                        statusText = (st.moving || st.speed > 0) ? 'Moving'
                            : (st.lat && st.lon) ? 'Parked' : 'Offline';
                    }
                    rows.push({
                        agentid: v.agentid || v.veh_id,
                        plate: p.clean,
                        plateRaw: v.vehiclenumber,
                        model: v.model,
                        folder: v.folder,
                        mileage: v.current_mileage,
                        status: statusText
                    });
                });
                me.fleetStore.loadData(rows);
                if (cb) { cb(); }
            })
            .catch(function () { if (cb) { cb(); } });
    },

    updateCounts: function (fines) {
        var unpaid = fines.filter(function (f) { return f.paid === 'No'; }).length;
        var total = 0;
        fines.forEach(function (f) { total += (parseFloat(f.amount) || 0); });
        var el = this.tab && this.tab.down('#rsCounts');
        if (el) {
            el.setHtml('<span class="rs-count">' + fines.length + ' fines</span> · '
                + '<span class="rs-count rs-unpaid">' + unpaid + ' unpaid</span> · '
                + '<span class="rs-count rs-total">AED ' + Ext.util.Format.number(total, '0,000.00') + '</span>');
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
            title: 'RTA Salik AI',
            width: 460, height: 560, layout: 'fit', closable: true, closeAction: 'hide',
            items: [{
                xtype: 'panel',
                layout: { type: 'vbox', align: 'stretch' },
                bodyPadding: 10,
                items: [
                    { xtype: 'container', itemId: 'rsAiHistory', flex: 1, autoScroll: true, html: '<div class="rs-chat"></div>' },
                    {
                        xtype: 'textarea', itemId: 'rsAiInput', height: 72,
                        emptyText: 'Ask: who has fines? Salik this month?',
                        enableKeyEvents: true,
                        listeners: { specialkey: function (f, e) {
                            if (e.getKey() === e.ENTER && !e.shiftKey) { e.stopEvent(); me.askAI(); }
                        } }
                    },
                    { xtype: 'button', text: 'Ask', margin: '8 0 0 0', handler: function () { me.askAI(); } }
                ]
            }],
            listeners: { afterrender: function () { me.aiHistoryEl = me.aiWin.down('#rsAiHistory').getEl(); } }
        });
    },

    toggleAI: function () {
        if (this.aiWin.isVisible()) { this.aiWin.hide(); }
        else { this.aiWin.show(); this.aiWin.down('#rsAiInput').focus(); }
    },

    askAI: function () {
        var me = this;
        var input = this.aiWin.down('#rsAiInput');
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
        var ctx = {};
        var jobs = [
            new Promise(function (res) {
                fetch('/api/v3/vehicles', { credentials: 'include' })
                    .then(function (r) { return r.ok ? r.json() : null; })
                    .then(function (d) {
                        var list = (d && d.data) || [];
                        var vehicles = [];
                        list.forEach(function (v) {
                            var p = me.extractPlate(v.vehiclenumber);
                            if (!p) { return; }
                            vehicles.push({ plate: p.clean, model: v.model, odometerKm: v.current_mileage });
                        });
                        ctx.vehicles = vehicles.slice(0, me.config.contextMaxVehicles);
                        ctx.vehicleCount = vehicles.length;
                        res();
                    }).catch(function () { ctx.vehicles = []; res(); });
            }),
            new Promise(function (res) {
                var plates = [];
                me.fleetStore.each(function (r) {
                    var raw = (r.get('plateRaw') || '').trim();
                    if (raw) { plates.push(raw); }
                });
                if (!plates.length) { ctx.fines = []; res(); return; }
                fetch(me.config.aiServerUrl.replace(/\/+$/, '') + '/rta-fines', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ plates: plates })
                })
                    .then(function (r) { return r.json(); })
                    .then(function (d) {
                        var fines = [];
                        Object.keys(d || {}).forEach(function (raw) {
                            var entry = d[raw] || {};
                            var p = me.extractPlate(raw);
                            var clean = p ? p.clean : raw;
                            (entry.fines || []).forEach(function (f) {
                                fines.push({
                                    plate: clean,
                                    amount: f.amount,
                                    description: f.description,
                                    ticketDate: f.ticketDate
                                });
                            });
                        });
                        ctx.fines = fines;
                        res();
                    })
                    .catch(function () { ctx.fines = []; res(); });
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
            var cls = m.who === 'user' ? 'rs-msg-user' : 'rs-msg-ai';
            return '<div class="' + cls + '">' + Ext.htmlEncode(m.text).replace(/\n/g, '<br>') + '</div>';
        }).join('');
        this.aiHistoryEl.update('<div class="rs-chat">' + html + '</div>');
        this.aiHistoryEl.scroll('b', 100000, false);
    }
});
