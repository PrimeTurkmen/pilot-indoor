/**
 * PILOT RTA · Salik extension
 * Store.rta_salik.Module — RTA traffic fines + Salik tolls dashboard for a
 * car-rental / fleet operator, running inside the logged-in Pilot session.
 *
 * Sections:
 *   Fines & Tolls — RTA fines + Salik toll charges per vehicle
 *   Trips          — per-vehicle trip breakdown for a chosen period
 *   Fleet          — vehicles (plate, model, mileage, status)
 *   AI             — natural-language assistant (DeepSeek)
 *
 * Data sources (same-origin, session cookie):
 *   GET  /api/v3/vehicles                 — fleet
 *   POST /backend/ax/tracks_get_history.php — trip/parking segments
 *   AI backend (config.aiServerUrl)       — /rta-fines, /salik, /ask
 *
 * Linking: a "Linking" form maps a Pilot agent (or a manual plate) to its
 * RTA plate format ("DXB K 62968" / "SHJ 3 18894") and Salik plate. Links
 * persist in localStorage per user.
 *
 * NOTE: inside a /store/ extension use native fetch() with absolute
 * same-origin paths (/api/...). Ext.Ajax rewrites them through the
 * /store/<ext>/ proxy → 404.
 */
Ext.define('Store.rta_salik.Module', {
    extend: 'Ext.Component',
    extensionName: 'rta_salik',
    version: '0.2.0',
    moduleBuild: '2026-10-25',

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
        this.tripsStore = this.buildTripsStore();

        var items = [this.buildFinesPanel(), this.buildSalikPanel(), this.buildTripsPanel()];

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
                items: items,
                listeners: {
                    tabchange: function (tp, card) {
                        if (card && card.itemId === 'rsTripsPanel') { me.loadTrips(); }
                    }
                }
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
                { xtype: 'tbseparator' },
                { xtype: 'datefield', itemId: 'rsFrom', width: 110, format: 'd.m.Y',
                  emptyText: 'From date', listeners: { change: function () { me.applyFilters(); } } },
                { xtype: 'tbtext', html: '–' },
                { xtype: 'datefield', itemId: 'rsTo', width: 110, format: 'd.m.Y',
                  emptyText: 'To date', listeners: { change: function () { me.applyFilters(); } } },
                { xtype: 'checkbox', itemId: 'rsRentalOnly', boxLabel: 'Rental only',
                  listeners: { change: function () { me.applyFilters(); } } },
                { xtype: 'tbseparator' },
                {
                    xtype: 'button', text: 'Linking', iconCls: 'fa fa-link',
                    tooltip: 'Link Pilot agents to RTA/Salik plates',
                    handler: function () { me.showLinking(); }
                },
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
            fields: [
                { name: 'id', type: 'string' },
                { name: 'plate', type: 'string' },
                { name: 'plateRaw', type: 'string' },
                { name: 'name', type: 'string' },
                { name: 'type', type: 'string' },
                { name: 'date', type: 'string' },
                { name: 'dateTs', type: 'float' },
                { name: 'amount', type: 'float' },
                { name: 'paid', type: 'string' },
                { name: 'source', type: 'string' },
                { name: 'agentid', type: 'string' },
                { name: 'vehId', type: 'string' }
            ],
            data: [],
            sorters: [{ property: 'dateTs', direction: 'DESC' }]
        });
    },

    buildFleetStore: function () {
        return Ext.create('Ext.data.Store', {
            storeId: 'rsFleetStore',
            fields: ['agentid', 'vehId', 'plate', 'plateRaw', 'name', 'model', 'folder', 'mileage', 'status', 'label'],
            data: []
        });
    },

    buildSalikStore: function () {
        return Ext.create('Ext.data.Store', {
            storeId: 'rsSalikStore',
            fields: [
                { name: 'plate', type: 'string' },
                { name: 'plateRaw', type: 'string' },
                { name: 'name', type: 'string' },
                { name: 'trips', type: 'int' },
                { name: 'total', type: 'float' },
                { name: 'agentid', type: 'string' },
                { name: 'vehId', type: 'string' },
                { name: 'lastTripDate', type: 'string' },
                { name: 'lastTripTs', type: 'float' },
                { name: 'tolls' }
            ],
            data: [],
            sorters: [{ property: 'lastTripTs', direction: 'DESC' }]
        });
    },

    buildTripsStore: function () {
        return Ext.create('Ext.data.Store', {
            storeId: 'rsTripsStore',
            fields: [
                { name: 'vehName', type: 'string' },
                { name: 'agentid', type: 'string' },
                { name: 'vehId', type: 'string' },
                { name: 'type', type: 'string' },
                { name: 'start', type: 'string' },
                { name: 'startTs', type: 'float' },
                { name: 'end', type: 'string' },
                { name: 'endTs', type: 'float' },
                { name: 'dur', type: 'float' },
                { name: 'length', type: 'float' },
                { name: 'avgspeed', type: 'float' },
                { name: 'lat', type: 'float' },
                { name: 'lon', type: 'float' }
            ],
            data: [],
            sorters: [{ property: 'startTs', direction: 'DESC' }]
        });
    },

    /* ------------------------------------------------------------------ */
    /*  Panels                                                            */
    /* ------------------------------------------------------------------ */

    buildFinesPanel: function () {
        var me = this;
        return {
            title: 'RTA Fines',
            itemId: 'rsFinesPanel',
            iconCls: 'fa fa-tags',
            layout: 'fit',
            items: [{
                xtype: 'grid',
                itemId: 'rsFinesGrid',
                store: this.finesStore,
                emptyText: 'No RTA fines for this fleet.',
                listeners: {
                    itemclick: function (grid, record) {
                        me.showOnMap(record.get('vehId') || record.get('agentid'), record.get('date'));
                    }
                },
                columns: [
                    { text: 'Plate', dataIndex: 'plate', flex: 1 },
                    { text: 'Vehicle', dataIndex: 'name', flex: 1.4 },
                    { text: 'Agent ID', dataIndex: 'agentid', width: 90 },
                    { text: 'Type', dataIndex: 'type', flex: 1 },
                    { text: 'Source', dataIndex: 'source', width: 90 },
                    { text: 'Date', dataIndex: 'dateTs', width: 130,
                      renderer: function (v, meta, rec) { return rec.get('date'); } },
                    { text: 'Amount', dataIndex: 'amount', width: 100, align: 'right',
                      renderer: function (v) { return v != null ? Ext.util.Format.number(v, '0,000.00') : '—'; } },
                    { text: 'Paid', dataIndex: 'paid', width: 70 }
                ]
            }]
        };
    },

    buildSalikPanel: function () {
        var me = this;
        return {
            title: 'Salik Tolls',
            itemId: 'rsSalikPanel',
            iconCls: 'fa fa-tag',
            layout: 'fit',
            items: [{
                xtype: 'grid',
                itemId: 'rsSalikGrid',
                store: this.salikStore,
                emptyText: 'No Salik tolls for this fleet. Click a row for the trip breakdown.',
                listeners: {
                    itemclick: function (grid, record) {
                        me.showSalikTrips(record);
                    }
                },
                columns: [
                    { text: 'Plate', dataIndex: 'plate', flex: 1 },
                    { text: 'Vehicle', dataIndex: 'name', flex: 1.4 },
                    { text: 'Agent ID', dataIndex: 'agentid', width: 90 },
                    { text: 'Trips (30d)', dataIndex: 'trips', width: 100, align: 'right' },
                    { text: 'Last trip', dataIndex: 'lastTripTs', width: 130,
                      renderer: function (v, meta, rec) { return rec.get('lastTripDate') || '—'; } },
                    { text: 'Total (AED)', dataIndex: 'total', width: 120, align: 'right',
                      renderer: function (v) { return v != null ? Ext.util.Format.number(v, '0,000.00') : '—'; } }
                ]
            }]
        };
    },

    buildTripsPanel: function () {
        var me = this;
        return {
            title: 'Trips',
            itemId: 'rsTripsPanel',
            iconCls: 'fa fa-route',
            layout: 'fit',
            tbar: {
                cls: 'transparent_buttons',
                items: [
                    { xtype: 'tbtext', html: 'Trip breakdown — uses the From/To dates above' },
                    '->',
                    { xtype: 'button', iconCls: 'fa fa-rotate', text: 'Load trips',
                      handler: function () { me.loadTrips(); } }
                ]
            },
            items: [{
                xtype: 'grid',
                itemId: 'rsTripsGrid',
                store: this.tripsStore,
                emptyText: 'Pick From/To dates, then Load trips.',
                listeners: {
                    itemclick: function (grid, record) {
                        me.panTo(record.get('lat'), record.get('lon'),
                            record.get('vehName') + ' @ ' + record.get('start'));
                    }
                },
                columns: [
                    { text: 'Vehicle', dataIndex: 'vehName', flex: 1.4 },
                    { text: 'Type', dataIndex: 'type', width: 80 },
                    { text: 'Start', dataIndex: 'start', width: 150 },
                    { text: 'End', dataIndex: 'end', width: 150 },
                    { text: 'Duration', dataIndex: 'dur', width: 100, align: 'right',
                      renderer: me.renderDuration },
                    { text: 'Distance (km)', dataIndex: 'length', width: 110, align: 'right',
                      renderer: function (v) { return v != null ? Ext.util.Format.number(v, '0,000.00') : '—'; } },
                    { text: 'Avg (km/h)', dataIndex: 'avgspeed', width: 100, align: 'right',
                      renderer: function (v) { return v != null ? Math.round(v) : '—'; } }
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
                    { text: 'Vehicle', dataIndex: 'name', flex: 1.2 },
                    { text: 'Agent ID', dataIndex: 'agentid', width: 90 },
                    { text: 'Model', dataIndex: 'model', flex: 1.2 },
                    { text: 'Folder', dataIndex: 'folder', flex: 1 },
                    { text: 'Mileage (km)', dataIndex: 'mileage', width: 110, align: 'right',
                      renderer: function (v) { return v != null ? Ext.util.Format.number(v, '0,000') : '—'; } },
                    { text: 'Status', dataIndex: 'status', width: 90 }
                ]
            }]
        };
    },

    renderDuration: function (v) {
        if (v == null || !v) { return '—'; }
        var s = Math.round(Number(v));
        var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
        if (h > 0) { return h + 'h ' + m + 'm'; }
        return m + 'm ' + (s % 60) + 's';
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
        this.loadLinks();
        this.loadContracts();
        this.loadFleet(function () { me.loadFines(); me.loadSalik(); });
    },

    loadSalik: function () {
        var me = this;
        fetch((this.config.aiServerUrl || '').replace(/\/+$/, '') + '/salik')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                var data = (d && d.data) || {};
                var rows = [];
                var seen = {};
                me.fleetStore.each(function (r) {
                    var raw = (r.get('plateRaw') || '').trim();
                    var e = data[raw];
                    if (e && !e.error) {
                        seen[raw] = true;
                        rows.push(me.salikRowFromEntry(raw, e, r.get('agentid'), r.get('vehId'), r.get('name')));
                    }
                });
                // linked plates (manual or renamed Salik keys)
                (me._links || []).forEach(function (lk) {
                    var key = me.findSalikKey(data, lk.salikPlate);
                    if (!key || seen[key]) { return; }
                    seen[key] = true;
                    var e = data[key];
                    if (!e || e.error) { return; }
                    rows.push(me.salikRowFromEntry(key, e, lk.agentid, lk.vehId, lk.vehicleLabel));
                });
                me.salikData = rows;
                me.applyFilters();
            })
            .catch(function () { /* no salik data */ });
    },

    salikRowFromEntry: function (raw, e, agentid, vehId, name) {
        var me = this;
        var tolls = e.tolls || [];
        var lastTrip = tolls.length ? tolls[tolls.length - 1].date : '';
        return {
            plateRaw: raw,
            plate: raw,
            name: name || '',
            trips: e.tripCount || 0,
            total: e.totalTolls || 0,
            agentid: agentid || '',
            vehId: vehId || '',
            lastTripDate: lastTrip,
            lastTripTs: me.parseDate(lastTrip) || 0,
            tolls: tolls
        };
    },

    findSalikKey: function (data, salikPlate) {
        if (!salikPlate) { return null; }
        var n = this.normalizePlate(salikPlate);
        if (!n) { return null; }
        if (data[salikPlate]) { return salikPlate; }
        var keys = Object.keys(data);
        for (var i = 0; i < keys.length; i++) {
            if (this.normalizePlate(keys[i]).indexOf(n) === 0) { return keys[i]; }
        }
        return null;
    },

    loadFines: function () {
        var me = this;
        var plates = [];
        var cleanByRaw = {};
        var agentidByRaw = {};
        var vehIdByRaw = {};
        var nameByRaw = {};
        this.fleetStore.each(function (r) {
            var raw = (r.get('plateRaw') || '').trim();
            if (raw && plates.indexOf(raw) < 0) { plates.push(raw); }
            cleanByRaw[raw] = r.get('plate');
            agentidByRaw[raw] = r.get('agentid');
            vehIdByRaw[raw] = r.get('vehId');
            nameByRaw[raw] = r.get('name');
        });
        // linked plates (manual entry / RTA format)
        (me._links || []).forEach(function (lk) {
            var raw = (lk.rtaPlate || '').trim();
            if (!raw) { return; }
            if (plates.indexOf(raw) < 0) { plates.push(raw); }
            cleanByRaw[raw] = raw;
            agentidByRaw[raw] = lk.agentid || '';
            vehIdByRaw[raw] = lk.vehId || '';
            nameByRaw[raw] = lk.vehicleLabel || '';
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
                            plateRaw: raw,
                            name: nameByRaw[raw] || '',
                            type: f.description || f.source || '',
                            source: f.source || 'RTA',
                            date: f.ticketDate || '',
                            dateTs: me.parseDate(f.ticketDate) || 0,
                            amount: f.amount || 0,
                            paid: 'No',
                            agentid: agentidByRaw[raw] || '',
                            vehId: vehIdByRaw[raw] || ''
                        });
                    });
                });
                me.finesData = rows;
                me.applyFilters();
            })
            .catch(function () { /* backend unreachable */ });
    },

    loadTrips: function () {
        var me = this;
        var fromField = me.tab.down('#rsFrom');
        var toField = me.tab.down('#rsTo');
        var vehs = [];
        this.fleetStore.each(function (r) {
            var v = r.get('vehId') || r.get('agentid');
            if (v) { vehs.push(String(v)); }
        });
        if (!vehs.length) { return; }

        var toMs = (toField && toField.getValue()) ? toField.getValue().getTime() + 86399999 : Date.now();
        var fromMs = (fromField && fromField.getValue()) ? fromField.getValue().getTime() : (toMs - 7 * 86400000);

        var body = 'start=' + encodeURIComponent(me.fmtLocal(fromMs))
            + '&end=' + encodeURIComponent(me.fmtLocal(toMs))
            + '&vehs=' + encodeURIComponent(vehs.join(','))
            + '&weekdays=true&weekend=true&parkings=true&sort_by_date=true';
        fetch('/backend/ax/tracks_get_history.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body,
            credentials: 'include'
        })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (segments) {
                var rows = [];
                var nameByVeh = {};
                me.fleetStore.each(function (r) {
                    var v = String(r.get('vehId') || r.get('agentid'));
                    if (v) { nameByVeh[v] = r.get('name') || r.get('plate'); }
                });
                (segments || []).forEach(function (seg) {
                    var isParking = seg.type === 'parking';
                    var lat = parseFloat(isParking ? seg.lat : seg.startlat);
                    var lon = parseFloat(isParking ? seg.lon : seg.startlon);
                    var vehId = String(seg.veh_id != null ? seg.veh_id : seg.agent_id);
                    rows.push({
                        vehName: seg.veh_name || nameByVeh[vehId] || vehId,
                        agentid: seg.agent_id != null ? String(seg.agent_id) : vehId,
                        vehId: vehId,
                        type: isParking ? 'Parking' : 'Trip',
                        start: seg.start || me.fmtLocal(Number(seg.start_unixtimestamp) * 1000),
                        startTs: Number(seg.start_unixtimestamp) * 1000,
                        end: seg.end || me.fmtLocal(Number(seg.end_unixtimestamp) * 1000),
                        endTs: Number(seg.end_unixtimestamp) * 1000,
                        dur: Number(seg.dur) || 0,
                        length: Number(seg.length) || 0,
                        avgspeed: Number(seg.avgspeed) || 0,
                        lat: lat,
                        lon: lon
                    });
                });
                me.tripsStore.loadData(rows);
                me.updateTripsCount(rows.length);
            })
            .catch(function () { me.updateTripsCount(-1); });
    },

    updateTripsCount: function (n) {
        var el = this.tab && this.tab.down('#rsTripsPanel');
        if (!el) { return; }
        var grid = el.down('#rsTripsGrid');
        if (grid && n < 0) {
            grid.setEmptyText ? grid.setEmptyText('Could not load trips (history API unreachable).') : null;
            return;
        }
        if (grid && n === 0) {
            grid.setEmptyText ? grid.setEmptyText('No trips in the selected period.') : null;
        }
    },

    fmtLocal: function (ms) {
        var d = new Date(ms);
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear()
            + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    },

    showOnMap: function (agentid, dateStr) {
        var me = this;
        var sk = (this.main && this.main.skeleton) || window.skeleton;
        var mapframe = sk && sk.mapframe;
        if (!mapframe || !agentid || !dateStr) { return; }
        var ts = new Date(dateStr).getTime() / 1000;
        if (!ts || isNaN(ts)) { return; }
        var body = 'start=' + encodeURIComponent(me.fmtLocal((ts - 1800) * 1000))
            + '&end=' + encodeURIComponent(me.fmtLocal((ts + 1800) * 1000))
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
                var lat = parseFloat(best.lat != null ? best.lat : best.startlat);
                var lon = parseFloat(best.lon != null ? best.lon : best.startlon);
                if (!lat || !lon) { return; }
                me.panTo(lat, lon, (best.veh_name || '') + ' @ ' + (best.start || ''));
            })
            .catch(function () {});
    },

    panTo: function (lat, lon, label) {
        var sk = (this.main && this.main.skeleton) || window.skeleton;
        var mapframe = sk && sk.mapframe;
        if (!mapframe || !lat || !lon) { return; }
        var mp = mapframe.getMap ? mapframe.getMap() : mapframe.map;
        if (mp && mp.setView) { mp.setView([lat, lon], 15); }
        if (mapframe.addMarker) {
            mapframe.addMarker({ lat: lat, lon: lon, size: 'medium', poupContent: label || '' });
        }
    },

    /* ------------------------------------------------------------------ */
    /*  Salik trip breakdown                                              */
    /* ------------------------------------------------------------------ */

    showSalikTrips: function (record) {
        var me = this;
        var tolls = record.tolls || [];
        if (!tolls.length) {
            me.showOnMap(record.get('vehId') || record.get('agentid'), record.get('lastTripDate'));
            return;
        }
        var store = Ext.create('Ext.data.Store', {
            storeId: 'rsSalikTripsStore',
            fields: [
                { name: 'date', type: 'string' },
                { name: 'dateTs', type: 'float' },
                { name: 'gate', type: 'string' },
                { name: 'amount', type: 'float' }
            ],
            data: [],
            sorters: [{ property: 'dateTs', direction: 'DESC' }]
        });
        var rows = [];
        tolls.forEach(function (t) {
            rows.push({
                date: t.date || '',
                dateTs: me.parseDate(t.date) || 0,
                gate: t.gate || '',
                amount: t.amount || 0
            });
        });
        store.loadData(rows);

        var win = Ext.create('Ext.window.Window', {
            title: 'Salik trips — ' + (record.get('plate') || ''),
            width: 640, height: 480, layout: 'fit', closable: true, modal: false,
            items: [{
                xtype: 'grid',
                store: store,
                emptyText: 'No trips.',
                listeners: {
                    itemclick: function (g, r) {
                        me.showOnMap(record.get('vehId') || record.get('agentid'), r.get('date'));
                    }
                },
                columns: [
                    { text: 'Date', dataIndex: 'date', width: 160 },
                    { text: 'Gate', dataIndex: 'gate', flex: 1 },
                    { text: 'Amount (AED)', dataIndex: 'amount', width: 110, align: 'right',
                      renderer: function (v) { return v != null ? Ext.util.Format.number(v, '0,000.00') : '—'; } }
                ]
            }]
        });
        win.show();
    },

    /* ------------------------------------------------------------------ */
    /*  Linking form                                                      */
    /* ------------------------------------------------------------------ */

    loadLinks: function () {
        var me = this;
        me._links = [];
        try {
            var raw = localStorage.getItem('rta_salik_links_v1');
            if (raw) { me._links = JSON.parse(raw) || []; }
        } catch (e) { me._links = []; }
    },

    saveLinks: function () {
        try {
            localStorage.setItem('rta_salik_links_v1', JSON.stringify(this._links || []));
        } catch (e) { /* storage full / blocked */ }
    },

    showLinking: function () {
        var me = this;
        var store = Ext.create('Ext.data.Store', {
            storeId: 'rsLinksStore',
            fields: ['id', 'agentid', 'vehId', 'vehicleLabel', 'rtaPlate', 'salikPlate'],
            data: (me._links || []).slice()
        });

        var vehCombo = Ext.create('Ext.form.field.ComboBox', {
            fieldLabel: 'Pilot vehicle',
            width: 320,
            store: this.fleetStore,
            queryMode: 'local',
            displayField: 'label',
            valueField: 'agentid',
            emptyText: 'Select vehicle (or leave empty for manual plate)',
            listConfig: { minWidth: 340 }
        });

        var rtaField = Ext.create('Ext.form.field.Text', {
            fieldLabel: 'RTA plate', width: 320,
            emptyText: 'RTA format, e.g. DXB K 62968 or SHJ 3 18894'
        });
        var salikField = Ext.create('Ext.form.field.Text', {
            fieldLabel: 'Salik plate', width: 320,
            emptyText: 'Salik account plate, e.g. AA35668'
        });

        var grid = Ext.create('Ext.grid.Panel', {
            itemId: 'rsLinksGrid',
            store: store,
            flex: 1,
            emptyText: 'No links yet. Link a Pilot vehicle to its RTA/Salik plates, or add a manual plate.',
            columns: [
                { text: 'Pilot vehicle', dataIndex: 'vehicleLabel', flex: 1.2 },
                { text: 'Agent ID', dataIndex: 'agentid', width: 90 },
                { text: 'RTA plate', dataIndex: 'rtaPlate', flex: 1 },
                { text: 'Salik plate', dataIndex: 'salikPlate', flex: 1 }
            ]
        });

        var addBtn = Ext.create('Ext.button.Button', {
            text: 'Add link', iconCls: 'fa fa-plus',
            handler: function () {
                var label = vehCombo.getRawValue() || '';
                var agentid = vehCombo.getValue() || '';
                var fleet = agentid ? vehCombo.findRecordByValue(agentid) : null;
                var vehId = fleet ? (fleet.get('vehId') || '') : '';
                if (!label && fleet) { label = fleet.get('label') || ''; }
                var rta = (rtaField.getValue() || '').trim();
                var salik = (salikField.getValue() || '').trim();
                if (!agentid && !rta && !salik) {
                    Ext.Msg.alert('Linking', 'Pick a vehicle or enter at least one plate.');
                    return;
                }
                var link = {
                    id: 'lk' + Date.now(),
                    agentid: agentid,
                    vehId: vehId,
                    vehicleLabel: label || 'Manual plate',
                    rtaPlate: rta,
                    salikPlate: salik
                };
                me._links = me._links || [];
                me._links.push(link);
                store.add(link);
                me.saveLinks();
                rtaField.setValue('');
                salikField.setValue('');
                if (fleet) { vehCombo.setValue(null); vehCombo.reset(); }
            }
        });

        var delBtn = Ext.create('Ext.button.Button', {
            text: 'Remove selected', iconCls: 'fa fa-trash',
            handler: function () {
                var sel = grid.getSelectionModel().getSelection();
                sel.forEach(function (rec) {
                    me._links = (me._links || []).filter(function (l) { return l.id !== rec.get('id'); });
                    store.remove(rec);
                });
                me.saveLinks();
            }
        });

        var win = Ext.create('Ext.window.Window', {
            title: 'Linking — Pilot agents ↔ RTA / Salik plates',
            width: 860, height: 520, layout: 'fit', closable: true, modal: true,
            tbar: [addBtn, delBtn, '->',
                { xtype: 'button', text: 'Reload data',
                  handler: function () { me.loadLinks(); me.loadFines(); me.loadSalik(); } }],
            items: [{
                xtype: 'panel',
                layout: { type: 'vbox', align: 'stretch' },
                bodyPadding: 8,
                items: [
                    {
                        xtype: 'fieldset',
                        title: 'Add link',
                        layout: { type: 'hbox', align: 'stretch' },
                        defaults: { labelWidth: 110 },
                        items: [
                            vehCombo,
                            { xtype: 'container', width: 12 },
                            rtaField,
                            { xtype: 'container', width: 12 },
                            salikField
                        ]
                    },
                    grid
                ]
            }]
        });
        win.show();
    },

    /* ------------------------------------------------------------------ */
    /*  Fleet + helpers                                                   */
    /* ------------------------------------------------------------------ */

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
                    var agentid = String(v.agentid != null ? v.agentid : v.veh_id || '');
                    var vehId = String(v.veh_id != null ? v.veh_id : v.agentid || '');
                    var name = v.name || v.veh_name || v.model || '';
                    rows.push({
                        agentid: agentid,
                        vehId: vehId,
                        plate: p.clean,
                        plateRaw: v.vehiclenumber,
                        name: name,
                        model: v.model,
                        folder: v.folder,
                        mileage: v.current_mileage,
                        status: statusText,
                        label: p.clean + ' · ' + name + ' (' + agentid + ')'
                    });
                });
                me.fleetStore.loadData(rows);
                if (cb) { cb(); }
            })
            .catch(function () { if (cb) { cb(); } });
    },

    parseDate: function (s) {
        if (!s) { return null; }
        var d = new Date(s);
        if (!isNaN(d.getTime())) { return d.getTime(); }
        var m = String(s).match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/);
        if (m) {
            var y = parseInt(m[3], 10); if (y < 100) { y += 2000; }
            return new Date(y, parseInt(m[2], 10) - 1, parseInt(m[1], 10)).getTime();
        }
        return null;
    },

    normalizePlate: function (s) {
        return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    },

    loadContracts: function () {
        var me = this;
        fetch('/api/v3/rentcar/contracts?status=open,booked,closed', { credentials: 'include' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                var list = (d && (d.list || d.data)) || [];
                var windows = {};
                list.forEach(function (c) {
                    var raw = c.vehnum || c.vehiclenumber || c.veh_id || '';
                    if (!raw) { return; }
                    var key = me.normalizePlate(raw);
                    var start = me.parseDate(c.date_start || c.start);
                    var end = me.parseDate(c.date_end || c.end);
                    if (!windows[key] || (start != null && start < windows[key][0])) {
                        windows[key] = [start == null ? -Infinity : start, end == null ? Infinity : end];
                    }
                });
                me._rentalWindows = windows;
                me.applyFilters();
            })
            .catch(function () { me._rentalWindows = {}; });
    },

    applyFilters: function () {
        var me = this;
        if (!me.tab) { return; }
        var fromField = me.tab.down('#rsFrom');
        var toField = me.tab.down('#rsTo');
        var rentalField = me.tab.down('#rsRentalOnly');
        var from = fromField ? fromField.getValue() : null;
        var to = toField ? toField.getValue() : null;
        var rentalOnly = rentalField ? !!rentalField.getValue() : false;
        var fromTs = from ? from.getTime() : null;
        var toTs = to ? to.getTime() + 86399999 : null;  // inclusive end-of-day
        var windows = me._rentalWindows || {};
        var hasWindows = false;
        for (var k in windows) { hasWindows = true; break; }

        var inRental = function (plateRaw, ts) {
            if (!hasWindows) { return true; }  // contracts not loaded yet — don't hide everything
            var w = windows[me.normalizePlate(plateRaw)];
            if (!w) { return false; }
            return ts >= w[0] && ts <= w[1];
        };
        var pass = function (plateRaw, ts) {
            if (fromTs != null && ts < fromTs) { return false; }
            if (toTs != null && ts > toTs) { return false; }
            if (rentalOnly && !inRental(plateRaw, ts)) { return false; }
            return true;
        };

        var fines = (me.finesData || []).filter(function (f) { return pass(f.plateRaw, f.dateTs); });
        var salik = (me.salikData || []).filter(function (s) { return pass(s.plateRaw, s.lastTripTs); });

        me.finesStore.loadData(fines);
        me.salikStore.loadData(salik);
        me.updateCounts(fines);
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
                            vehicles.push({ plate: p.clean, name: v.name || v.model || '', model: v.model, agentId: v.agentid, odometerKm: v.current_mileage });
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
                (me._links || []).forEach(function (lk) {
                    if (lk.rtaPlate && plates.indexOf(lk.rtaPlate) < 0) { plates.push(lk.rtaPlate); }
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
