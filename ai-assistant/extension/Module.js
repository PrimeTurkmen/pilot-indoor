/**
 * PILOT AI Assistant extension — v2
 * Store.ai_assistant.Module — header button + floating chat.
 *
 * v2: gathers a RICH account snapshot (vehicles + current-month km per vehicle
 * vs the mileage limit, traffic fines, rental contracts) client-side through
 * the logged-in session, and sends it to the AI server. The server is a
 * strict read-only reporter: it answers only with these real numbers.
 *
 * NOTE: inside a /store/ extension you MUST use native fetch() with absolute
 * same-origin paths (/api/...). Ext.Ajax.request rewrites them through the
 * /store/<ext>/ proxy and 404s.
 */
Ext.define('Store.ai_assistant.Module', {
    extend: 'Ext.Component',
    extensionName: 'ai_assistant',
    version: '0.2.0',
    moduleBuild: '2026-10-23',

    DEFAULT_CONFIG: {
        serverUrl: 'https://pilot-ai.zamtek.ae',
        model: 'deepseek-chat',
        contextMaxVehicles: 300,
        mileageLimitKm: 4500,        // free km/month, rest billed
        gatherVehicles: true,
        gatherFines: true,
        gatherContracts: true,
        gatherTrips: true            // current-month km per vehicle
    },

    initModule: function (main, online) {
        this.main = main;
        this.config = Ext.apply({}, this.DEFAULT_CONFIG);
        this._blocked = {};
        this.loadConfig();
        this.loadStyles();
        this.buildButton();
        this.buildChatWindow();
    },

    loadConfig: function () {
        var me = this;
        fetch('/store/ai_assistant/config.json', { credentials: 'include', cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (c) { if (c && typeof c === 'object') { me.config = Ext.apply(me.config, c); } })
            .catch(function () { /* keep defaults */ });
    },

    loadStyles: function () {
        var l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = '/store/ai_assistant/styles.css';
        document.head.appendChild(l);
    },

    buildButton: function () {
        var me = this;
        var sk = (this.main && this.main.skeleton) || window.skeleton;
        if (!sk || !sk.header || typeof sk.header.insert !== 'function') { return; }
        this.btn = Ext.create('Ext.Button', {
            iconCls: 'fa fa-brain-circuit',
            tooltip: (typeof l === 'function') ? l('AI Assistant') : 'AI Assistant',
            handler: function () { me.toggleChat(); }
        });
        sk.header.insert(2, this.btn);
    },

    buildChatWindow: function () {
        var me = this;
        this.history = [];
        this.historyEl = null;

        this.win = Ext.create('Ext.window.Window', {
            title: 'AI Assistant',
            width: 460,
            height: 580,
            layout: 'fit',
            closable: true,
            closeAction: 'hide',
            items: [{
                xtype: 'panel',
                layout: { type: 'vbox', align: 'stretch' },
                bodyPadding: 10,
                items: [
                    {
                        xtype: 'container',
                        itemId: 'history',
                        flex: 1,
                        autoScroll: true,
                        html: '<div class="ai-chat-history"></div>'
                    },
                    {
                        xtype: 'textarea',
                        itemId: 'input',
                        height: 72,
                        emptyText: 'Ask: how many vehicles? who exceeded 4500 km? who has fines?',
                        enableKeyEvents: true,
                        listeners: {
                            specialkey: function (f, e) {
                                if (e.getKey() === e.ENTER && !e.shiftKey) {
                                    e.stopEvent();
                                    me.ask();
                                }
                            }
                        }
                    },
                    {
                        xtype: 'container',
                        layout: { type: 'hbox', align: 'stretch' },
                        margin: '8 0 0 0',
                        items: [
                            { xtype: 'button', text: 'Send', flex: 1, handler: function () { me.ask(); } },
                            { xtype: 'button', text: 'Email report', flex: 1, margin: '0 0 0 8', handler: function () { me.emailReport(); } }
                        ]
                    }
                ]
            }],
            listeners: {
                afterrender: function () {
                    me.historyEl = me.win.down('#history').getEl();
                    me.renderHistory();
                }
            }
        });
    },

    emailReport: function () {
        var me = this;
        Ext.Msg.prompt('Email report', 'Send the fleet report to email:', function (btn, val) {
            if (btn !== 'ok' || !val) { return; }
            me.gatherContext(function (ctx) {
                me.history.push({ who: 'ai', text: '⏳ Generating and sending the report…' });
                me.renderHistory();
                fetch(me.config.serverUrl.replace(/\/+$/, '') + '/report', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ context: ctx, email: val.trim(), subject: 'Pilot Fleet Report' })
                })
                    .then(function (r) { return r.json(); })
                    .then(function (d) {
                        var msg = d.status === 'sent'
                            ? ('✅ Report sent to ' + d.email)
                            : ('❌ ' + (d.error || d.status || 'error'));
                        me.history.push({ who: 'ai', text: msg });
                        me.renderHistory();
                    })
                    .catch(function (e) {
                        me.history.push({ who: 'ai', text: '❌ Send error: ' + e.message });
                        me.renderHistory();
                    });
            });
        });
    },

    toggleChat: function () {
        if (this.win.isVisible()) {
            this.win.hide();
        } else {
            this.win.show();
            this.win.down('#input').focus();
        }
    },

    ask: function () {
        var me = this;
        var input = this.win.down('#input');
        var q = (input.getValue() || '').trim();
        if (!q) { return; }
        input.setValue('');
        this.appendMessage('user', q);
        this.appendMessage('ai', '…собираю данные по аккаунту…');

        this.gatherContext(function (ctx) {
            me.postToServer(q, ctx, function (answer) {
                me.replaceLast('ai', answer);
            });
        });
    },

    /* ------------------------------------------------------------------ */
    /*  Context gathering (all via session cookie, same-origin)           */
    /* ------------------------------------------------------------------ */

    extractPlate: function (raw) {
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

    gatherContext: function (cb) {
        var me = this;
        var out = {
            mileageLimitKm: this.config.mileageLimitKm,
            gatheredAt: new Date().toISOString()
        };

        function gatherVehicles() {
            return new Promise(function (res) {
                if (me.config.gatherVehicles === false) { res(); return; }
                fetch('/api/v3/vehicles', { credentials: 'include' })
                    .then(function (r) { return r.ok ? r.json() : null; })
                    .then(function (d) {
                        var list = (d && d.data) || [];
                        var cap = me.config.contextMaxVehicles || 300;
                        var vehicles = [];
                        list.forEach(function (v) {
                            var p = me.extractPlate(v.vehiclenumber);
                            if (!p) { return; }
                            vehicles.push({
                                agentid: v.agentid || v.veh_id || v.imei,
                                plate: p.clean,
                                plateRaw: v.vehiclenumber,
                                folder: v.folder,
                                model: v.model,
                                odometerKm: v.current_mileage,
                                type: v.type
                            });
                        });
                        out.vehicleCount = vehicles.length;
                        out.vehicles = vehicles.slice(0, cap);
                        res();
                    })
                    .catch(function () { out.vehicles = []; res(); });
            });
        }

        function gatherFines() {
            return new Promise(function (res) {
                if (me.config.gatherFines === false) { res(); return; }
                var plates = (out.vehicles || []).map(function (v) { return v.plateRaw; });
                if (!plates.length) { out.fines = []; res(); return; }
                fetch(me.config.serverUrl.replace(/\/+$/, '') + '/rta-fines', {
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
                                    type: f.description || f.source || '',
                                    amount: f.amount || 0,
                                    paid: false,
                                    date: f.ticketDate || ''
                                });
                            });
                        });
                        out.fines = fines;
                        res();
                    })
                    .catch(function () { out.fines = []; res(); });
            });
        }

        function gatherContracts() {
            return new Promise(function (res) {
                if (me.config.gatherContracts === false) { res(); return; }
                fetch('/api/v3/rentcar/contracts?status=open,booked,closed', { credentials: 'include' })
                    .then(function (r) { return r.ok ? r.json() : null; })
                    .then(function (d) { out.contracts = (d && (d.list || d.data)) || []; res(); })
                    .catch(function () { out.contracts = []; res(); });
            });
        }

        function gatherSalik() {
            return new Promise(function (res) {
                fetch(me.config.serverUrl.replace(/\/+$/, '') + '/salik')
                    .then(function (r) { return r.ok ? r.json() : null; })
                    .then(function (d) {
                        var data = (d && d.data) || {};
                        var salik = [];
                        var connected = 0;
                        (out.vehicles || []).forEach(function (v) {
                            var e = data[v.plateRaw] || {};
                            if (e.totalTolls || (e.tolls && e.tolls.length)) {
                                v.salikConnected = true;
                                v.salikTolls = e.totalTolls || 0;
                                connected++;
                                (e.tolls || []).forEach(function (t) {
                                    salik.push({ plate: v.plate, date: t.date, amount: t.amount, gate: t.gate });
                                });
                            }
                        });
                        out.salik = salik;
                        out.salikConnected = connected;
                        res();
                    })
                    .catch(function () { out.salik = []; out.salikConnected = 0; res(); });
            });
        }

        gatherVehicles().then(gatherFines).then(gatherSalik).then(gatherContracts).then(function () {
            if (me.config.gatherTrips !== false && out.vehicles && out.vehicles.length) {
                me.gatherMonthlyKm(out, cb);
            } else {
                cb(out);
            }
        });
    },

    /* Sum current-month km per vehicle (1 request/vehicle, concurrency-capped).
       Used for the 4500 km/month limit: overLimit = monthlyKm > limit. */
    gatherMonthlyKm: function (out, cb) {
        var me = this;
        var now = new Date();
        var monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        var ts = Math.floor(monthStart.getTime() / 1000);
        var te = Math.floor(now.getTime() / 1000);
        var limit = this.config.mileageLimitKm || 0;
        var vehicles = out.vehicles;

        function sumKm(data) {
            var total = 0;
            var list = (data && (data.data || data.list)) || [];
            if (!Array.isArray(list)) { return 0; }
            list.forEach(function (seg) {
                var km = seg.gps != null ? seg.gps
                    : seg.can != null ? seg.can
                    : seg.km != null ? seg.km
                    : seg.mileage != null ? seg.mileage
                    : seg.distance != null ? seg.distance : 0;
                total += parseFloat(km) || 0;
            });
            return Math.round(total);
        }

        function fetchOne(v) {
            var url = '/api/v3/vehicles/trips?agent_id=' + encodeURIComponent(v.agentid)
                + '&ts=' + ts + '&te=' + te;
            return fetch(url, { credentials: 'include' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (d) {
                    v.monthlyKm = sumKm(d);
                    v.overLimit = (limit > 0) ? (v.monthlyKm > limit) : false;
                })
                .catch(function () { v.monthlyKm = null; });
        }

        var queue = vehicles.slice();
        function worker() {
            if (!queue.length) { return Promise.resolve(); }
            return fetchOne(queue.shift()).then(worker);
        }
        var n = Math.min(5, vehicles.length);
        var workers = [];
        for (var i = 0; i < n; i++) { workers.push(worker()); }

        Promise.all(workers).then(function () {
            out.overLimitVehicles = vehicles.filter(function (v) { return v.overLimit; })
                .map(function (v) { return v.plate; });
            out.overLimitCount = out.overLimitVehicles.length;
            cb(out);
        });
    },

    postToServer: function (q, ctx, cb) {
        fetch(this.config.serverUrl.replace(/\/+$/, '') + '/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: q, context: ctx })
        })
            .then(function (r) { return r.json(); })
            .then(function (d) { cb((d && (d.answer || d.error)) || 'Нет ответа.'); })
            .catch(function (e) { cb('Ошибка соединения с AI-сервером: ' + e.message); });
    },

    appendMessage: function (who, text) {
        this.history.push({ who: who, text: text });
        this.renderHistory();
    },

    replaceLast: function (who, text) {
        var last = this.history[this.history.length - 1];
        if (last && last.who === who) { last.text = text; }
        this.renderHistory();
    },

    renderHistory: function () {
        if (!this.historyEl) { return; }
        var html = this.history.map(function (m) {
            var cls = m.who === 'user' ? 'ai-msg-user' : 'ai-msg-ai';
            var body = Ext.htmlEncode(m.text).replace(/\n/g, '<br>');
            return '<div class="' + cls + '">' + body + '</div>';
        }).join('');
        this.historyEl.update('<div class="ai-chat-history">' + html + '</div>');
        this.historyEl.scroll('b', 100000, false);
    }
});
