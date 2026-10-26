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
    version: '0.4.0',
    moduleBuild: '2026-10-25',

    DEFAULT_CONFIG: {
        serverUrl: 'https://pilot-ai.zamtek.ae',
        model: 'deepseek-chat',
        contextMaxVehicles: 300,
        company: 'rma',               // key of the company profile MD on the server
        periodDays: 30,               // trips/salik reporting window
        gatherVehicles: true,
        gatherFines: true,
        gatherContracts: true,
        gatherTrips: true,            // period km per vehicle
        ttsEnabled: false,            // Fish Audio voice read-out
        escalation: {
            whatsapp: '',             // operator WhatsApp number (digits)
            telegram: ''              // operator Telegram handle (with or without @)
        }
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
        this._audio = null;

        this.win = Ext.create('Ext.window.Window', {
            title: 'AI Assistant',
            width: 480,
            height: 660,
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
                        height: 64,
                        emptyText: 'Ask anything about the fleet…',
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
                        itemId: 'quickChips',
                        margin: '6 0 4 0',
                        html: '<div class="ai-chips">'
                            + '<button type="button" class="ai-chip" data-q="Fleet summary: totals, moving now, offline">Fleet summary</button>'
                            + '<button type="button" class="ai-chip" data-q="Who has RTA fines? List plates and amounts.">Who has fines?</button>'
                            + '<button type="button" class="ai-chip" data-q="Trips in the selected period: km and duration per vehicle.">Trips in period</button>'
                            + '<button type="button" class="ai-chip" data-q="Salik in the period: totals per vehicle and top gates.">Salik this period</button>'
                            + '</div>',
                        listeners: {
                            afterrender: function (c) {
                                c.getEl().on('click', function (e, t) {
                                    var chip = Ext.fly(t).findParent('.ai-chip', null, true);
                                    if (!chip) { return; }
                                    me.win.down('#input').setValue(chip.getAttribute('data-q'));
                                    me.ask();
                                });
                            }
                        }
                    },
                    {
                        xtype: 'container',
                        layout: { type: 'hbox', align: 'stretch' },
                        margin: '6 0 0 0',
                        items: [
                            { xtype: 'button', text: 'Send', flex: 1, handler: function () { me.ask(); } }
                        ]
                    },
                    /* --- report bar: email + ONE send button (bottom) --- */
                    {
                        xtype: 'container',
                        layout: { type: 'hbox', align: 'stretch' },
                        margin: '10 0 0 0',
                        items: [
                            { xtype: 'textfield', itemId: 'emailField', flex: 1,
                              emptyText: 'Email to receive the full report', value: me.getVerifiedEmail(),
                              listeners: { change: function (f, v) { me.emailChanged(v); } } },
                            { xtype: 'button', itemId: 'emailConfirmBtn', text: 'Confirm', width: 70, margin: '0 0 0 8',
                              handler: function () { me.confirmEmail(); } },
                            { xtype: 'button', itemId: 'sendReportBtn', text: 'Send report', width: 92, margin: '0 0 0 8',
                              handler: function () { me.sendReport(); } }
                        ]
                    },
                    /* --- escalation bar --- */
                    {
                        xtype: 'container',
                        layout: { type: 'hbox', align: 'stretch' },
                        margin: '8 0 0 0',
                        items: [
                            { xtype: 'button', text: 'Escalate — WhatsApp', iconCls: 'fa fa-whatsapp',
                              margin: '0 8 0 0', handler: function () { me.escalate('whatsapp'); } },
                            { xtype: 'button', text: 'Escalate — Telegram', iconCls: 'fa fa-telegram',
                              handler: function () { me.escalate('telegram'); } },
                            '->',
                            { xtype: 'button', text: 'Admin', width: 64,
                              handler: function () { me.openAdmin(); } }
                        ]
                    }
                ]
            }],
            listeners: {
                afterrender: function () {
                    me.historyEl = me.win.down('#history').getEl();
                    me.renderHistory();
                    me.emailChanged(me.getVerifiedEmail());
                    if (!me.getVerifiedEmail()) {
                        me.appendMessage('ai', '⚠️ To start, enter your email below and press Confirm — '
                            + 'a one-time code will be sent to it. After that I can help you with everything.');
                    }
                }
            }
        });
    },

    /* Verified email (one-time confirmation via emailed code). Only this
       address receives reports/answers — never a typed-but-unverified one. */
    getVerifiedEmail: function () {
        try { return localStorage.getItem('ai_assistant_email_verified') || ''; } catch (e) { return ''; }
    },

    setVerifiedEmail: function (email) {
        try {
            if (email && email.trim()) {
                localStorage.setItem('ai_assistant_email_verified', email.trim().toLowerCase());
            }
        } catch (e) { /* storage blocked */ }
    },

    /* Field changed: reflect verified/unverified state on the Confirm button. */
    emailChanged: function (v) {
        var me = this;
        var btn = me.win && me.win.down('#emailConfirmBtn');
        if (!btn) { return; }
        var cur = (v || '').trim().toLowerCase();
        if (cur && cur === me.getVerifiedEmail()) {
            btn.setText('✓ Confirmed');
            btn.setIconCls ? btn.setIconCls('fa fa-check') : null;
            btn.disable();
        } else {
            btn.setText('Confirm');
            if (btn.setIconCls) { btn.setIconCls(''); }
            btn.enable();
        }
    },

    /* Request code → prompt → verify. cb(email) fires only on success. */
    confirmEmail: function (cb) {
        var me = this;
        var field = me.win && me.win.down('#emailField');
        var email = field ? (field.getValue() || '').trim().toLowerCase() : '';
        if (!email || email.indexOf('@') < 0) {
            Ext.Msg.alert('Email', 'Enter a valid email first.');
            return;
        }
        if (email === me.getVerifiedEmail()) {
            if (cb) { cb(email); }
            return;
        }
        var api = function (path, body) {
            return fetch(me.config.serverUrl.replace(/\/+$/, '') + path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }).then(function (r) { return r.json(); });
        };
        me.appendMessage('ai', '⏳ Sending confirmation code to ' + email + '…');
        api('/email/request-code', { email: email })
            .then(function (d) {
                if (!d || d.status !== 'sent') {
                    me.appendMessage('ai', '❌ Could not send code: ' + ((d && d.error) || 'unknown'));
                    return;
                }
                Ext.Msg.prompt('Email confirmation',
                    'Code sent to ' + email + '. Enter the 6-digit code:', function (btn, val) {
                        if (btn !== 'ok' || !val) { return; }
                        api('/email/confirm', { email: email, code: val.trim() })
                            .then(function (r2) {
                                if (r2 && r2.ok) {
                                    me.setVerifiedEmail(email);
                                    me.emailChanged(field.getValue());
                                    me.appendMessage('ai', '✅ Email confirmed: ' + email + '. Reports will go here.');
                                    if (cb) { cb(email); }
                                } else {
                                    me.appendMessage('ai', '❌ ' + ((r2 && r2.error) || 'wrong code'));
                                }
                            })
                            .catch(function (e) { me.appendMessage('ai', '❌ Verify error: ' + e.message); });
                    });
            })
            .catch(function (e) { me.appendMessage('ai', '❌ Code send error: ' + e.message); });
    },

    /* Get the address to actually send to — verified only. cb(email|null). */
    requireVerifiedEmail: function (cb) {
        var me = this;
        var field = me.win && me.win.down('#emailField');
        var typed = field ? (field.getValue() || '').trim().toLowerCase() : '';
        var verified = me.getVerifiedEmail();
        if (typed && typed === verified) { cb(verified); return; }
        if (typed && typed.indexOf('@') > 0) {
            // new address — confirm it first, then use it
            me.confirmEmail(function (v) { cb(v); });
            return;
        }
        Ext.Msg.prompt('Email', 'Enter the email to receive reports (confirmed once):',
            function (btn, val) {
                if (btn !== 'ok' || !val) { return; }
                if (field) { field.setValue(val.trim()); }
                me.confirmEmail(function (v) { cb(v); });
            });
    },

    /* Send the FULL report of the conversation to the confirmed email. */
    sendReport: function () {
        var me = this;
        me.requireVerifiedEmail(function (to) {
            if (!to) { return; }
            var conv = me.history
                .filter(function (m) { return m.text.indexOf('⏳') !== 0 && m.text.indexOf('⚠️') !== 0; })
                .map(function (m) { return { who: m.who, text: m.text }; });
            me.gatherContext(function (ctx) {
                me.history.push({ who: 'ai', text: '⏳ Generating the full report and sending it to ' + to + '…' });
                me.renderHistory();
                fetch(me.config.serverUrl.replace(/\/+$/, '') + '/report', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ context: ctx, email: to, subject: 'Pilot Fleet Report', conversation: conv })
                })
                    .then(function (r) { return r.json(); })
                    .then(function (d) {
                        var msg = d.status === 'sent'
                            ? ('✅ Full report sent to ' + d.email)
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

    /* Escalate the request straight to the operator via WhatsApp/Telegram.
       The chat's last user message rides along as prefilled text. */
    escalate: function (channel) {
        var me = this;
        var lastQ = '';
        for (var i = me.history.length - 1; i >= 0; i--) {
            if (me.history[i].who === 'user') { lastQ = me.history[i].text; break; }
        }
        var cfg = me.config.escalation || {};
        if (channel === 'whatsapp') {
            var wa = cfg.whatsapp || '';
            if (!wa) {
                me.appendMessage('ai', '❌ WhatsApp escalation is not configured. Ask the operator.');
                return;
            }
            window.open('https://wa.me/' + wa.replace(/[^0-9]/g, '')
                + '?text=' + encodeURIComponent('Support request from Pilot AI: ' + lastQ), '_blank');
        } else {
            var tg = cfg.telegram || '';
            if (!tg) {
                me.appendMessage('ai', '❌ Telegram escalation is not configured. Ask the operator.');
                return;
            }
            window.open('https://t.me/' + tg.replace(/^@/, '')
                + '?text=' + encodeURIComponent('Support request from Pilot AI: ' + lastQ), '_blank');
        }
        me.appendMessage('ai', '📨 Escalated via ' + (channel === 'whatsapp' ? 'WhatsApp' : 'Telegram')
            + '. The operator will answer you there.');
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
        // Gate: the AI only helps after the email is confirmed once.
        if (!me.getVerifiedEmail()) {
            me.appendMessage('ai', '⚠️ Confirm your email first — enter it in the field below '
                + 'and press Confirm. It is a one-time step.');
            return;
        }
        input.setValue('');
        this.appendMessage('user', q);
        this.appendMessage('ai', '…gathering account data…');

        this.gatherContext(function (ctx) {
            me.postToServer(q, ctx, function (res) {
                var msg = me.history[me.history.length - 1];
                if (msg && msg.who === 'ai') {
                    msg.text = res.answer;
                    msg.actions = res.actions || [];
                    me.renderHistory();
                }
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
            company: this.config.company || '',
            periodDays: this.config.periodDays || 30,
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
                            var st = v.status;
                            var statusText = 'offline';
                            if (st) {
                                statusText = (st.moving || st.speed > 0) ? 'moving'
                                    : (st.lat && st.lon) ? 'parked' : 'offline';
                            }
                            vehicles.push({
                                agentid: v.agentid || v.veh_id || v.imei,
                                plate: p.clean,
                                plateRaw: v.vehiclenumber,
                                name: v.name || v.model || '',
                                folder: v.folder,
                                model: v.model,
                                odometerKm: v.current_mileage,
                                status: statusText,
                                type: v.type
                            });
                        });
                        out.vehicleCount = vehicles.length;
                        var moving = vehicles.filter(function (x) { return x.status === 'moving'; }).length;
                        var parked = vehicles.filter(function (x) { return x.status === 'parked'; }).length;
                        var offline = vehicles.filter(function (x) { return x.status === 'offline'; }).length;
                        out.liveStatus = { moving: moving, parked: parked, offline: offline };
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
                me.gatherPeriodKm(out, cb);
            } else {
                cb(out);
            }
        });
    },

    /* Sum period km per vehicle (1 request/vehicle, concurrency-capped).
       Period = last 30 days by default. No invented limits — just the numbers. */
    gatherPeriodKm: function (out, cb) {
        var me = this;
        var now = new Date();
        var periodDays = this.config.periodDays || 30;
        var ts = Math.floor((now.getTime() - periodDays * 86400000) / 1000);
        var te = Math.floor(now.getTime() / 1000);
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
                    v.periodKm = sumKm(d);
                })
                .catch(function () { v.periodKm = null; });
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
            out.periodDays = periodDays;
            cb(out);
        });
    },

    postToServer: function (q, ctx, cb) {
        var payload = { question: q, context: ctx };
        // Admin mode: let the AI use the server-side admin tools.
        if (this.adminSid) { payload.sid = this.adminSid; payload.admin = true; }
        fetch(this.config.serverUrl.replace(/\/+$/, '') + '/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d && d.error) { cb({ answer: d.error, actions: [] }); return; }
                cb({ answer: (d && d.answer) || 'No answer.', actions: (d && d.actions) || [] });
            })
            .catch(function (e) { cb({ answer: 'AI server connection error: ' + e.message, actions: [] }); });
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
        var me = this;
        var html = this.history.map(function (m, mi) {
            var cls = m.who === 'user' ? 'ai-msg-user' : 'ai-msg-ai';
            var body = Ext.htmlEncode(m.text).replace(/\n/g, '<br>');
            var actionsHtml = '';
            if (m.who === 'ai' && me.config.ttsEnabled && m.text.indexOf('⏳') !== 0
                && m.text.indexOf('⚠️') !== 0 && m.text.length < 800) {
                actionsHtml += ' <button type="button" class="ai-act-btn ai-speak-btn"'
                    + ' data-mi="' + mi + '">🔊</button>';
            }
            (m.actions || []).forEach(function (a, ai) {
                if (a.type && a.type.indexOf('admin_') === 0) { return; } // server-executed
                var label = Ext.htmlEncode(a.label || a.type);
                actionsHtml += ' <button type="button" class="ai-act-btn"'
                    + ' data-mi="' + mi + '" data-ai="' + ai + '">⚡ ' + label + '</button>';
            });
            return '<div class="' + cls + '">' + body + actionsHtml + '</div>';
        }).join('');
        this.historyEl.update('<div class="ai-chat-history">' + html + '</div>');
        this.historyEl.scroll('b', 100000, false);
        if (!this._clickBound) {
            this._clickBound = true;
            this.historyEl.on('click', function (e, t) {
                var spk = Ext.fly(t).findParent('.ai-speak-btn', null, true);
                if (spk) {
                    var smi = parseInt(spk.getAttribute('data-mi'), 10);
                    me.speak(me.history[smi] && me.history[smi].text);
                    return;
                }
                var btn = Ext.fly(t).findParent('.ai-act-btn', null, true);
                if (!btn) { return; }
                var mi = parseInt(btn.getAttribute('data-mi'), 10);
                var ai = parseInt(btn.getAttribute('data-ai'), 10);
                var msg = me.history[mi];
                if (!msg || !msg.actions || !msg.actions[ai]) { return; }
                btn.disabled = true;
                me.executeAction(msg.actions[ai], function (result) {
                    btn.disabled = false;
                    me.appendMessage('ai', result);
                });
            });
        }
    },

    /* Voice read-out of an AI answer (Fish Audio via the backend /tts). */
    speak: function (text) {
        var me = this;
        if (!text) { return; }
        if (me._audio) { try { me._audio.pause(); } catch (e) {} }
        fetch(me.config.serverUrl.replace(/\/+$/, '') + '/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: text })
        })
            .then(function (r) {
                if (!r.ok) {
                    return r.json().then(function (d) {
                        throw new Error((d && d.error) || ('HTTP ' + r.status));
                    });
                }
                return r.blob();
            })
            .then(function (blob) {
                var url = URL.createObjectURL(blob);
                me._audio = new Audio(url);
                me._audio.onended = function () { URL.revokeObjectURL(url); };
                me._audio.play().catch(function () {});
            })
            .catch(function (e) { me.appendMessage('ai', '🔊 TTS error: ' + e.message); });
    },

    /* Run a proposed action against Pilot API v3 (same-origin, session cookie). */
    executeAction: function (a, cb) {
        var me = this;
        var base = '/api/v3';
        var qs = function (obj) {
            var parts = [];
            Object.keys(obj || {}).forEach(function (k) {
                if (obj[k] != null && obj[k] !== '') {
                    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]));
                }
            });
            return parts.length ? '?' + parts.join('&') : '';
        };
        var key = a.agent_id ? { agent_id: a.agent_id } : { imei: a.imei };

        var done = function (okText, failText) {
            return function (r) {
                r.json().then(function (d) {
                    cb(r.ok
                        ? (okText + ((d && d.error) ? ' (' + d.error + ')' : ''))
                        : (failText + ' HTTP ' + r.status + (d && d.error ? ' — ' + d.error : '')));
                }).catch(function () {
                    cb(r.ok ? okText : (failText + ' HTTP ' + r.status));
                });
            };
        };

        try {
            if (a.type === 'send_command') {
                fetch(base + '/vehicles/commands' + qs(key), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ template_name: a.template_name, params: a.params || {} })
                }).then(done('✅ Command sent.', '❌ Command failed:'));
            } else if (a.type === 'share_link') {
                var sq = Ext.apply({}, key, { max_duration: a.max_duration });
                fetch(base + '/vehicles/share-link' + qs(sq), { credentials: 'include' })
                    .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
                    .then(function (res) {
                        var link = (res.d && (res.d.data || res.d).link) || (res.d && res.d.link) || null;
                        if (res.ok && link) {
                            var win = Ext.create('Ext.window.Window', {
                                title: 'Tracking link', width: 460, autoHeight: true,
                                modal: true, closable: true,
                                html: '<div style="padding:12px;font-size:12px;">'
                                    + '<b>Tracking link:</b><br>'
                                    + '<input type="text" style="width:100%" value="' + Ext.htmlEncode(link) + '" onclick="this.select()">'
                                    + '<br><br><i>The link expires after the set duration.</i></div>'
                            });
                            win.show();
                            cb('✅ Link created.');
                        } else {
                            cb('❌ Link failed: ' + JSON.stringify(res.d));
                        }
                    })
                    .catch(function (e) { cb('❌ Link failed: ' + e.message); });
            } else if (a.type === 'add_fuel') {
                var body = {
                    card_num: a.card_num, operation: a.operation, unixtimestamp: a.unixtimestamp,
                    place: a.place, azs: a.azs, liters: a.liters, fuel: a.fuel,
                    price: a.price, sum: a.sum
                };
                Object.keys(a).forEach(function (k) {
                    if (['type', 'label', 'card_num', 'operation', 'unixtimestamp', 'place', 'azs', 'liters', 'fuel', 'price', 'sum'].indexOf(k) === -1) {
                        body[k] = a[k];
                    }
                });
                fetch(base + '/fuel/transactions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify(body)
                }).then(done('✅ Fuel transaction saved.', '❌ Fuel transaction failed:'));
            } else if (a.type === 'driver_bind') {
                var bq = Ext.apply({}, key, { driver_id: a.driver_id, ibutton: a.ibutton });
                fetch(base + '/vehicles/driver-bind' + qs(bq), { method: 'POST', credentials: 'include' })
                    .then(done('✅ Driver bound.', '❌ Driver bind failed:'));
            } else {
                cb('❌ Unknown action type: ' + a.type);
            }
        } catch (err) {
            cb('❌ Action error: ' + err.message);
        }
    },

    /* ------------------------------------------------------------------ admin */

    openAdmin: function () {
        var me = this;
        if (me.adminWin) { me.adminWin.show(); return; }

        var status = Ext.create('Ext.form.Label', { itemId: 'adminStatus', text: ' ', margin: '4 0 0 0' });
        var searchField = Ext.create('Ext.form.field.Text', {
            itemId: 'adminSearch', flex: 1, emptyText: 'Search login / company',
            enableKeyEvents: true,
            listeners: {
                specialkey: function (f, e) { if (e.getKey() === e.ENTER) { me.adminSearch(); } }
            }
        });
        var searchBtn = Ext.create('Ext.button.Button', {
            text: 'Search', width: 70, margin: '0 0 0 8',
            handler: function () { me.adminSearch(); }
        });
        var loginField = Ext.create('Ext.form.field.Text', {
            itemId: 'adminLogin', fieldLabel: 'Admin login', labelWidth: 90, margin: '6 0 0 0'
        });
        var passField = Ext.create('Ext.form.field.Text', {
            itemId: 'adminPass', fieldLabel: 'Password', labelWidth: 90, inputType: 'password', margin: '6 0 0 0'
        });
        var loginBtn = Ext.create('Ext.button.Button', {
            text: 'Login', margin: '8 0 0 0',
            handler: function () { me.adminLogin(loginField.getValue(), passField.getValue()); }
        });

        var searchBar = Ext.create('Ext.container.Container', {
            itemId: 'searchBar', layout: { type: 'hbox', align: 'stretch' },
            items: [searchField, searchBtn], margin: '0 0 6 0', hidden: true
        });
        var loginPanel = Ext.create('Ext.container.Container', {
            itemId: 'loginPanel', items: [loginField, passField, loginBtn], hidden: true
        });
        var body = Ext.create('Ext.container.Container', {
            itemId: 'adminBody', autoScroll: true, style: { overflowY: 'auto' }
        });

        me.adminWin = Ext.create('Ext.window.Window', {
            title: 'Admin — accounts (master travel)',
            width: 640, height: 520, modal: true, closable: true, layout: 'fit',
            items: [{
                xtype: 'container',
                padding: 10,
                layout: { type: 'vbox', align: 'stretch' },
                items: [searchBar, loginPanel, status, body]
            }],
            listeners: {
                destroy: function () { me.adminWin = null; me.adminSid = null; }
            }
        });
        me.adminWin.show();

        body.on('click', function (e, t) {
            var btn = Ext.fly(t).findParent('.ai-admin-travel', null, true);
            if (!btn) { return; }
            var idx = parseInt(btn.getAttribute('data-idx'), 10);
            var row = (me.adminRows || [])[idx];
            if (!row) { return; }
            btn.disabled = true;
            me.adminTravel(row, function (msg) {
                btn.disabled = false;
                status.setText(msg, false);
            });
        });

        me.adminCheckSession();
    },

    adminCheckSession: function () {
        var me = this;
        if (!me.adminSid) {
            me.adminTryLogin('', '', function () {
                if (me.adminSid) { me.adminLoadAccounts(); }
            });
        } else {
            me.adminLoadAccounts();
        }
    },

    adminTryLogin: function (username, password, done) {
        var me = this;
        var loginPanel = me.adminWin.down('#loginPanel');
        var searchBar = me.adminWin.down('#searchBar');
        var status = me.adminWin.down('#adminStatus');

        fetch(this.config.serverUrl.replace(/\/+$/, '') + '/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username, password: password })
        })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d && d.ok && d.sid) {
                    me.adminSid = d.sid;
                    loginPanel.hide();
                    searchBar.show();
                    status.setText('Logged in as admin.', false);
                    me.adminLoadAccounts();
                } else {
                    me.adminSid = null;
                    status.setText((d && d.error) ? 'Login failed: ' + d.error : 'Login required (server has no admin creds).', false);
                    loginPanel.show();
                    searchBar.hide();
                }
                if (done) { done(); }
            })
            .catch(function (e) {
                status.setText('Server error: ' + e.message, false);
                loginPanel.show();
                if (done) { done(); }
            });
    },

    adminLogin: function (username, password) {
        this.adminTryLogin(username, password);
    },

    adminSearch: function () {
        this.adminLoadAccounts(this.adminWin.down('#adminSearch').getValue());
    },

    adminLoadAccounts: function (search) {
        var me = this;
        var status = me.adminWin.down('#adminStatus');
        var body = me.adminWin.down('#adminBody');
        if (!me.adminSid) { return; }
        status.setText('Loading accounts…', false);
        fetch(this.config.serverUrl.replace(/\/+$/, '') + '/admin/accounts?sid=' + encodeURIComponent(me.adminSid) + '&search=' + encodeURIComponent(search || ''))
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (!d || !d.ok) {
                    status.setText((d && d.error) || 'Accounts load failed.', false);
                    return;
                }
                me.adminRows = d.rows || [];
                var rowsHtml = (d.rows || []).map(function (row, i) {
                    var name = row.login || row.username || row.email || ('#' + (row.id || i));
                    var org = row.org_name || row.organization || row.company || row.name || '';
                    var extra = row.email && row.email !== name ? ' · ' + Ext.htmlEncode(row.email) : '';
                    return '<div class="ai-admin-row">'
                        + '<button type="button" class="ai-admin-travel" data-idx="' + i + '">Travel</button>'
                        + '<b>' + Ext.htmlEncode(name) + '</b>'
                        + (org ? '<br>' + Ext.htmlEncode(org) : '')
                        + extra
                        + '</div>';
                }).join('');
                body.update(rowsHtml || '<div style="padding:12px;color:#64748b;">No accounts found.</div>');
                status.setText('Accounts: ' + (d.total != null ? d.total : (d.rows || []).length) + ' total, showing ' + (d.rows || []).length + '.', false);
            })
            .catch(function (e) {
                status.setText('Server error: ' + e.message, false);
            });
    },

    adminTravel: function (row, done) {
        var me = this;
        var status = me.adminWin.down('#adminStatus');
        var id = row.id;
        status.setText('Traveling into account…', false);
        fetch(this.config.serverUrl.replace(/\/+$/, '') + '/admin/travel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sid: me.adminSid, account_id: id })
        })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (!d || !d.ok) {
                    status.setText((d && d.error) || 'Travel failed.', false);
                    if (done) { done('❌ ' + ((d && d.error) || 'Travel failed.')); }
                    return;
                }
                // Open the account UI in a new tab via the admin panel's own form.
                if (d.form && d.form.url) {
                    var f = d.form;
                    var form = document.createElement('form');
                    form.method = 'POST';
                    form.action = f.url;
                    form.target = '_blank';
                    var add = function (k, v) {
                        var inp = document.createElement('input');
                        inp.type = 'hidden';
                        inp.name = k;
                        inp.value = v == null ? '' : String(v);
                        form.appendChild(inp);
                    };
                    add('username', f.username);
                    add('role', f.role);
                    add('id', f.id);
                    add('token', f.token);
                    add('sec_token', f.sec_token);
                    document.body.appendChild(form);
                    form.submit();
                    form.remove();
                }
                me.adminTraveled = { username: d.username, account_id: id };
                status.setText('Traveled as ' + d.username + ' (#' + id + '). AI can now read this account\'s data.', false);
                if (done) { done('✅ Traveled as ' + d.username + ' — ask the AI about this account.'); }
            })
            .catch(function (e) {
                status.setText('Server error: ' + e.message, false);
                if (done) { done('❌ ' + e.message); }
            });
    },
});
