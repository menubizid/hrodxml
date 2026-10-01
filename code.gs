/* =============================================================================
 * ApexHR — MADURA 24/7 RETAIL EMPIRE SIMULATOR
 * "Ultimate Mermaid.js & Automated Process Edition"
 * Ultimate Interconnected Forecast & Enterprise Engineering Edition
 *
 * FILE          : code.gs
 * LAYER         : BACKEND (Google Apps Script — V8 Runtime)
 * ROLE          : REST API + Forecast Engine + Mermaid Diagram Synthesizer
 *
 * -----------------------------------------------------------------------------
 * ARCHITECTURE (Single Responsibility Principle — mandatory per 04_ENGINEERING_RULE)
 *
 *   code.gs
 *   ├── 01. CONFIGURATION      → CONFIG  (endpoints, sheet map, tuning constants)
 *   ├── 02. UTILITIES          → Utils   (pure helpers: id, clamp, iso, rounding)
 *   ├── 03. TRANSPORT          → Response (canonical API envelope + CORS)
 *   ├── 04. ROUTING            → Router  (action → controller mapping, no logic)
 *   ├── 05. CONTROLLERS        → GameController / MermaidController /
 *   │                            ForecastController / DataController
 *   ├── 06. SERVICE LAYER      → SheetService      (BATCH read/write only)
 *   │                            StateService      (state hydration + diffing)
 *   │                            MermaidService    (string synthesis ONLY)
 *   │                            ForecastService   (math ONLY)
 *   │                            ScenarioService   (scenario catalogue)
 *   │                            SeedService       (default company bootstrap)
 *   └── 07. WEB APP ENTRY      → doGet / doPost
 *
 * PERFORMANCE STANDARD (hard rule)
 *   • Every sheet interaction uses getValues() / setValues() in a SINGLE call.
 *   • getValue() / setValue() inside a loop is FORBIDDEN. No exceptions.
 *   • Forecast math is O(n) over in-memory arrays; zero sheet I/O inside loops.
 *
 * API STANDARD (hard rule) — every response is:
 *   { "success": true|false, "message": "…", "data": {…}, "timestamp": "ISO8601" }
 * ========================================================================== */


/* =============================================================================
 * 01. CONFIGURATION
 * ========================================================================== */

var CONFIG = {
  APP_NAME: 'ApexHR',
  APP_EDITION: 'Madura 24/7 Retail Empire Simulator — Ultimate Enterprise Engineering Edition',
  VERSION: '3.0.0',

  /** Google Sheets that persist the save-game. Leave '' to run in MEMORY mode. */
  SPREADSHEET_ID: '',

  /** Optional shared secret. Client must send X-ApexHR-Key for remote mode. */
  API_KEY: 'apexhr-enterprise-key',

  /** Named sheet map — never inline sheet names elsewhere. */
  SHEETS: {
    STATE: 'ApexHR_State',
    STORES: 'ApexHR_Stores',
    EMPLOYEES: 'ApexHR_Employees',
    DIVISIONS: 'ApexHR_Divisions',
    POLICIES: 'ApexHR_Policies',
    EVENTS: 'ApexHR_Events',
    SCENARIOS: 'ApexHR_Scenarios',
    HISTORY: 'ApexHR_History'
  },

  /** Canonical column order per entity (index 0 = header row). */
  SCHEMA: {
    ApexHR_State: ['gameId', 'companyName', 'quarter', 'updatedAt', 'payload'],
    ApexHR_Stores: ['id', 'name', 'region', 'tier', 'capacity', 'openHours', 'status', 'createdAt'],
    ApexHR_Employees: ['id', 'name', 'role', 'track', 'departmentId', 'storeId',
      'performance', 'potential', 'flightRisk', 'salary'],
    ApexHR_Divisions: ['id', 'name', 'parentId', 'headId', 'headcount', 'level'],
    ApexHR_Policies: ['id', 'name', 'category', 'status', 'restockDelta', 'fraudShield'],
    ApexHR_Events: ['id', 'name', 'budget', 'enpsImpact', 'fatigueImpact'],
    ApexHR_Scenarios: ['id', 'title', 'brief', 'difficulty', 'targetRevenue'],
    ApexHR_History: ['quarter', 'revenue', 'turnover', 'enps', 'note']
  },

  /**
   * FORECAST TUNING — every coefficient lives here so the game can be balanced
   * without touching ForecastService logic (Open/Closed Principle).
   */
  TUNING: {
    BASE_TICKET: 32000,             // IDR per transaksi (minimarket 24 jam)
    DAYS_PER_QUARTER: 91,           // 13 minggu
    PAYROLL_MONTHS: 3,              // payroll dihitung per bulan x 3
    BASE_FILL_RATE: 0.94,           // ketersediaan rak sebelum shrinkage

    NIGHT_SHIFT_LOAD: 65,           // poin fatigue maksimum pada 100% shift malam
    AC_COMFORT_COEFF: 30,           // poin fatigue hilang pada 100% budget AC
    RELIEF_SCALE: 12,               // pengali relief event budaya
    BURNOUT_BASE: 20,
    STAFFING_PER_STORE: 3,          // kebutuhan minimum karyawan per toko aktif
    STAFFING_STRESS: 2.2,
    STAFFING_STRESS_MAX: 30,

    TRAINING_COEFF: 0.22,
    TURNOVER_BASE: 8,
    BURNOUT_TURNOVER: 0.42,
    FAIRNESS_TURNOVER: 0.09,
    TRAINING_RETENTION: 22,
    ENPS_TURNOVER: 0.05,

    SHRINKAGE_BASE: 1.2,
    AUDIT_SHRINKAGE: 0.055,
    SHIELD_SHRINKAGE: 0.035,
    TURNOVER_SHRINKAGE: 2.4,
    RESTOCK_FILL: 0.05,
    BURNOUT_REVENUE: 0.16,

    SPAN_LIMIT: 8,                  // direct report sehat per manajer
    SPAN_PENALTY: 0.07,
    RESTOCK_DAY_VALUE: 42000000,    // IDR hilang per hari restok tambahan
    RESTOCK_STORE_FACTOR: 0.25,
    OPEX_PER_STORE: 38000000,
    AC_OPEX_PER_STEP: 24000000,

    HEALTH_OPRISK: 0.55,
    HEALTH_TURNOVER: 1.3,
    HEALTH_SHRINKAGE: 2.4,
    HEALTH_BURNOUT: 0.5,
    HEALTH_ENPS: 0.35,

    MAX_HISTORY: 40
  },

  LIMITS: {
    MAX_NAME: 80,
    MAX_PAYLOAD_KB: 512
  }
};


/* =============================================================================
 * 02. UTILITIES  (pure functions, no side effects)
 * ========================================================================== */

var Utils = {

  /** RFC-4122-ish identifier, Sheets-safe. */
  uuid: function (prefix) {
    return (prefix || 'id') + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  },

  /** ISO-8601 timestamp — used by every API envelope. */
  nowIso: function () {
    return new Date().toISOString();
  },

  /** Numeric clamp. */
  clamp: function (value, min, max) {
    var n = Number(value);
    if (isNaN(n)) n = min;
    return Math.min(Math.max(n, min), max);
  },

  /** Round to N decimals. */
  round: function (value, decimals) {
    var f = Math.pow(10, decimals || 0);
    return Math.round(Number(value) * f) / f;
  },

  /** Safe string trim + length cap. */
  text: function (value, max) {
    var s = (value === null || value === undefined) ? '' : String(value);
    s = s.replace(/^\s+|\s+$/g, '');
    return s.slice(0, max || CONFIG.LIMITS.MAX_NAME);
  },

  /** Compact IDR formatting, e.g. 1.2 M / 3.4 M. */
  moneyShort: function (value) {
    var n = Number(value) || 0;
    var abs = Math.abs(n);
    if (abs >= 1e12) return Utils.round(n / 1e12, 2) + ' T';
    if (abs >= 1e9) return Utils.round(n / 1e9, 2) + ' M';
    if (abs >= 1e6) return Utils.round(n / 1e6, 1) + ' jt';
    if (abs >= 1e3) return Utils.round(n / 1e3, 0) + ' rb';
    return String(Utils.round(n, 0));
  },

  /** Deterministic pseudo-random from a string seed (stable "AI" flavour). */
  seeded: function (seed) {
    var h = 2166136261;
    var s = String(seed);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return function () {
      h += 0x6D2B79F5;
      var t = h;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  },

  /** Deep clone of JSON-serialisable structures. */
  clone: function (obj) {
    return JSON.parse(JSON.stringify(obj));
  },

  /** Blank-safe object key reader. */
  pick: function (obj, key, fallback) {
    if (!obj) return fallback;
    var v = obj[key];
    return (v === undefined || v === null || v === '') ? fallback : v;
  }
};


/* =============================================================================
 * 03. TRANSPORT — canonical API envelope (API STANDARD)
 * ========================================================================== */

var Response = {

  ok: function (data, message) {
    return Response._build(true, message || 'OK', data);
  },

  fail: function (message, data) {
    return Response._build(false, message || 'Terjadi kesalahan.', data || null);
  },

  _build: function (success, message, data) {
    return ContentService
      .createTextOutput(JSON.stringify({
        success: !!success,
        message: message,
        data: data === undefined ? null : data,
        timestamp: Utils.nowIso()
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }
};


/* =============================================================================
 * 04. ROUTING — action → controller. Contains ZERO business logic.
 * ========================================================================== */

var Router = {

  /** @type {Object<string, function(Object):Object>} */
  _map: {
    ping: function () { return GameController.ping(); },
    bootstrap: function () { return GameController.bootstrap(); },
    state: function () { return GameController.loadState(); },
    save: function (p) { return GameController.saveState(p); },
    reset: function () { return GameController.resetState(); },
    advance: function (p) { return GameController.advanceQuarter(p); },
    scenario: function (p) { return GameController.scenario(p); },
    forecast: function (p) { return ForecastController.run(p); },
    domino: function (p) { return ForecastController.domino(p); },
    mermaid: function (p) { return MermaidController.render(p); },
    mermaidAll: function (p) { return MermaidController.renderAll(p); },
    crud: function (p) { return DataController.handle(p); }
  },

  /** @param {{action:string, params:Object}} request */
  dispatch: function (request) {
    var action = Utils.text(request && request.action, 60) || 'ping';
    var handler = Router._map[action];
    if (!handler) {
      return Response.fail('Aksi "' + action + ' tidak dikenali oleh Router.', { action: action });
    }
    try {
      return handler(request.params || {});
    } catch (error) {
      return Response.fail('Eksekusi gagal: ' + error.message, { action: action });
    }
  }
};


/* =============================================================================
 * 05. CONTROLLERS — thin orchestration only. No math, no string building.
 * ========================================================================== */

var GameController = {

  ping: function () {
    return Response.ok({
      app: CONFIG.APP_NAME,
      edition: CONFIG.APP_EDITION,
      version: CONFIG.VERSION,
      runtime: 'google-apps-script',
      storage: CONFIG.SPREADSHEET_ID ? 'google-sheets' : 'memory',
      timestamp: Utils.nowIso()
    }, 'ApexHR Engine online.');
  },

  bootstrap: function () {
    var state = StateService.hydrate();
    return Response.ok({
      state: state,
      scenario: ScenarioService.current(state),
      mermaid: MermaidService.renderAll(state),
      forecast: ForecastService.compute(state)
    }, 'Bootstrap ApexHR berhasil.');
  },

  loadState: function () {
    return Response.ok(StateService.hydrate(), 'State berhasil dimuat.');
  },

  saveState: function (params) {
    var incoming = Utils.pick(params, 'state', null);
    if (!incoming || typeof incoming !== 'object') {
      return Response.fail('Payload "state" wajib berupa objek.');
    }
    var merged = StateService.merge(StateService.hydrate(), incoming);
    merged.meta.updatedAt = Utils.nowIso();
    StateService.persist(merged);
    return Response.ok(merged, 'Progres permainan tersimpan.');
  },

  resetState: function () {
    var fresh = SeedService.build();
    StateService.persist(fresh);
    return Response.ok({
      state: fresh,
      mermaid: MermaidService.renderAll(fresh),
      forecast: ForecastService.compute(fresh)
    }, 'Simulasi direset ke kondisi awal.');
  },

  advanceQuarter: function (params) {
    var state = StateService.hydrate();
    var next = ForecastService.advance(state);
    StateService.persist(next);
    return Response.ok({
      state: next,
      history: next.history,
      mermaid: MermaidService.renderAll(next),
      forecast: ForecastService.compute(next),
      log: next.lastQuarterLog
    }, 'Kuartal ' + next.meta.quarter + ' dieksekusi.');
  },

  scenario: function (params) {
    var state = StateService.hydrate();
    var id = Utils.text(Utils.pick(params, 'id', ''), 40);
    var scenario = ScenarioService.byId(id);
    if (!scenario) {
      return Response.fail('Skenario "' + id + '" tidak ditemukan.');
    }
    state.scenario = scenario;
    state.meta.updatedAt = Utils.nowIso();
    StateService.persist(state);
    return Response.ok({
      scenario: scenario,
      mermaid: MermaidService.mindmap(state)
    }, 'Skenario aktif: ' + scenario.title);
  }
};

var ForecastController = {

  run: function (params) {
    var state = StateService.normalize(Utils.pick(params, 'state', StateService.hydrate()));
    return Response.ok(ForecastService.compute(state), 'Forecast dihitung ulang.');
  },

  domino: function (params) {
    var state = StateService.normalize(Utils.pick(params, 'state', StateService.hydrate()));
    return Response.ok({
      chain: ForecastService.dominoChain(state),
      forecast: ForecastService.compute(state)
    }, 'Rantai efek domino terbentuk.');
  }
};

var MermaidController = {

  render: function (params) {
    var state = StateService.normalize(Utils.pick(params, 'state', StateService.hydrate()));
    var type = Utils.text(Utils.pick(params, 'type', 'org'), 20).toLowerCase();
    var builders = {
      org: MermaidService.orgChart,
      process: MermaidService.processFlow,
      mindmap: MermaidService.mindmap,
      succession: MermaidService.succession,
      fatigue: MermaidService.fatigueFlow
    };
    var builder = builders[type];
    if (!builder) {
      return Response.fail('Tipe diagram "' + type + '" tidak didukung.',
        { supported: Object.keys(builders) });
    }
    return Response.ok({ type: type, syntax: builder(state) }, 'Diagram Mermaid disintesis.');
  },

  renderAll: function (params) {
    var state = StateService.normalize(Utils.pick(params, 'state', StateService.hydrate()));
    return Response.ok(MermaidService.renderAll(state), 'Seluruh diagram Mermaid disintesis.');
  }
};

var DataController = {

  /**
   * Unified CRUD dispatcher.
   * @param {{entity:string, operation:string, payload:Object}} params
   */
  handle: function (params) {
    var entity = Utils.text(Utils.pick(params, 'entity', ''), 40).toLowerCase();
    var operation = Utils.text(Utils.pick(params, 'operation', ''), 20).toLowerCase();
    var payload = Utils.pick(params, 'payload', {}) || {};

    var allowed = ['stores', 'employees', 'divisions', 'policies', 'events'];
    if (allowed.indexOf(entity) === -1) {
      return Response.fail('Entitas "' + entity + '" tidak dikenali.', { allowed: allowed });
    }
    var ops = ['list', 'create', 'read', 'update', 'delete'];
    if (ops.indexOf(operation) === -1) {
      return Response.fail('Operasi "' + operation + '" tidak dikenali.', { allowed: ops });
    }

    var state = StateService.hydrate();
    var store = state.collections[entity];

    if (operation === 'list') {
      return Response.ok({
        entity: entity, count: store.length, items: store
      }, 'Daftar ' + entity + ' dimuat (' + store.length + ' baris).');
    }

    if (operation === 'create') {
      var record = DataController._sanitize(entity, payload, null);
      record.id = Utils.uuid(entity.slice(0, 3));
      record.createdAt = Utils.nowIso();
      store.push(record);
      state.meta.updatedAt = Utils.nowIso();
      StateService.persist(state);
      return Response.ok(record, 'Data ' + entity + ' berhasil dibuat.');
    }

    var id = Utils.text(Utils.pick(payload, 'id', ''), 60);
    var index = DataController._indexById(store, id);

    if (operation === 'read') {
      if (index === -1) return Response.fail('ID "' + id + '" tidak ditemukan di ' + entity + '.');
      return Response.ok(store[index], 'Data ' + entity + ' ditemukan.');
    }

    if (operation === 'update') {
      if (index === -1) return Response.fail('ID "' + id + '" tidak ditemukan di ' + entity + '.');
      var patch = DataController._sanitize(entity, payload, store[index]);
      for (var key in patch) { if (patch.hasOwnProperty(key)) store[index][key] = patch[key]; }
      state.meta.updatedAt = Utils.nowIso();
      StateService.persist(state);
      return Response.ok(store[index], 'Data ' + entity + ' diperbarui.');
    }

    if (operation === 'delete') {
      if (index === -1) return Response.fail('ID "' + id + '" tidak ditemukan di ' + entity + '.');
      var removed = store.splice(index, 1)[0];
      state.meta.updatedAt = Utils.nowIso();
      StateService.persist(state);
      return Response.ok(removed, 'Data ' + entity + ' dihapus.');
    }

    return Response.fail('Operasi tidak tertangani.');
  },

  /** Field whitelist + type coercion per entity. */
  _sanitize: function (entity, payload, existing) {
    var src = existing || {};
    var out = {};
    var map = {
      stores: {
        name: 'text', region: 'text', tier: 'text',
        capacity: 'int', openHours: 'int', status: 'text'
      },
      employees: {
        name: 'text', role: 'text', track: 'text', departmentId: 'text',
        storeId: 'text', performance: 'int', potential: 'int',
        flightRisk: 'int', salary: 'int'
      },
      divisions: {
        name: 'text', parentId: 'text', headId: 'text',
        headcount: 'int', level: 'int'
      },
      policies: {
        name: 'text', category: 'text', status: 'text',
        restockDelta: 'int', fraudShield: 'int'
      },
      events: {
        name: 'text', budget: 'int', enpsImpact: 'int', fatigueImpact: 'int'
      }
    }[entity] || {};

    for (var field in map) {
      if (!map.hasOwnProperty(field)) continue;
      var raw = (payload && payload[field] !== undefined && payload[field] !== '')
        ? payload[field] : src[field];
      if (raw === undefined) continue;
      out[field] = (map[field] === 'int') ? Math.round(Number(raw) || 0) : Utils.text(raw, 120);
    }
    if (!existing) { out.id = ''; out.createdAt = Utils.nowIso(); }
    return out;
  },

  _indexById: function (store, id) {
    if (!id) return -1;
    for (var i = 0; i < store.length; i++) {
      if (String(store[i].id) === String(id)) return i;
    }
    return -1;
  }
};


/* =============================================================================
 * 06. SERVICE LAYER
 * ========================================================================== */

/* -----------------------------------------------------------------------------
 * 06.1 SheetService — BATCH READ / BATCH WRITE ONLY (PERFORMANCE STANDARD)
 * -------------------------------------------------------------------------- */
var SheetService = {

  /** @return {SpreadsheetApp.Spreadsheet|null} */
  _spreadsheet: function () {
    if (!CONFIG.SPREADSHEET_ID) return null;
    try {
      return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    } catch (e) {
      return null;
    }
  },

  _sheet: function (name) {
    var ss = SheetService._spreadsheet();
    if (!ss) return null;
    var sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    return sheet;
  },

  /**
   * BATCH READ — one getValues() call, returns array of row objects.
   * @return {Array<Object>}
   */
  readTable: function (name) {
    var sheet = SheetService._sheet(name);
    if (!sheet) return [];
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];
    var matrix = sheet.getDataRange().getValues();       // ← BATCH READ
    var columns = CONFIG.SCHEMA[name] || matrix[0];
    var rows = [];
    for (var r = 1; r < matrix.length; r++) {
      var obj = {};
      var empty = true;
      for (var c = 0; c < columns.length; c++) {
        var value = matrix[r][c];
        if (value !== '' && value !== null) empty = false;
        obj[columns[c]] = (value instanceof Date) ? value.toISOString() : value;
      }
      if (!empty) rows.push(obj);
    }
    return rows;
  },

  /**
   * BATCH WRITE — one setValues() call after a single clearContents().
   * @param {string} name
   * @param {Array<Object>} rows
   */
  writeTable: function (name, rows) {
    var sheet = SheetService._sheet(name);
    if (!sheet) return 0;
    var columns = CONFIG.SCHEMA[name];
    var matrix = [columns];
    for (var i = 0; i < rows.length; i++) {
      var line = [];
      for (var c = 0; c < columns.length; c++) {
        var v = rows[i][columns[c]];
        line.push((v === undefined || v === null) ? '' : v);
      }
      matrix.push(line);
    }
    sheet.clearContents();
    if (matrix.length > 1) {
      sheet.getRange(1, 1, matrix.length, columns.length).setValues(matrix); // ← BATCH WRITE
    }
    sheet.getRange(1, 1, 1, columns.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return rows.length;
  },

  /** In-memory fallback so the engine runs without a bound spreadsheet. */
  _memory: {},
  readOrMemory: function (name) {
    var rows = SheetService.readTable(name);
    if (!CONFIG.SPREADSHEET_ID) return SheetService._memory[name] || [];
    return rows;
  },
  writeOrMemory: function (name, rows) {
    if (!CONFIG.SPREADSHEET_ID) { SheetService._memory[name] = rows; return rows.length; }
    return SheetService.writeTable(name, rows);
  }
};


/* -----------------------------------------------------------------------------
 * 06.2 SeedService — default "Toko Madura 24 Jam" company bootstrap
 * -------------------------------------------------------------------------- */
var SeedService = {

  /** Roster bawaan: 66 orang, struktur keluarga + profesional. */
  ROSTER: [
    { role: 'Owner', div: 'div-owner', track: 'Keluarga', n: 1, salary: 12000000 },
    { role: 'CEO', div: 'div-ceo', track: 'Profesional', n: 1, salary: 28000000 },
    { role: 'CFO', div: 'div-cfo', track: 'Profesional', n: 1, salary: 22000000 },
    { role: 'CHRO', div: 'div-chro', track: 'Profesional', n: 1, salary: 20000000 },
    { role: 'COO', div: 'div-coo', track: 'Profesional', n: 1, salary: 21000000 },
    { role: 'Head of Supply Chain', div: 'div-scm', track: 'Profesional', n: 1, salary: 18000000 },
    { role: 'Area Manager', div: 'div-area', track: 'Profesional', n: 1, salary: 14000000 },
    { role: 'Finance & Admin Staff', div: 'div-cfo', track: 'Profesional', n: 3, salary: 6500000 },
    { role: 'HR & Culture Staff', div: 'div-chro', track: 'Profesional', n: 4, salary: 6200000 },
    { role: 'Supply Chain Staff', div: 'div-scm', track: 'Profesional', n: 8, salary: 6800000 },
    { role: 'Kepala Toko', div: 'div-store', track: 'Profesional', n: 8, salary: 7500000 },
    { role: 'Kasir Shift Malam', div: 'div-kasir', track: 'Profesional', n: 30, salary: 4200000 },
    { role: 'Kasir Keluarga', div: 'div-kasir', track: 'Keluarga', n: 6, salary: 5200000 }
  ],

  DIVISIONS: [
    { id: 'div-owner', name: 'Owner / Pemilik', parentId: '', level: 0 },
    { id: 'div-ceo', name: 'CEO (Chief Executive)', parentId: 'div-owner', level: 1 },
    { id: 'div-cfo', name: 'CFO (Finance & Budget)', parentId: 'div-ceo', level: 2 },
    { id: 'div-chro', name: 'CHRO (People & Culture)', parentId: 'div-ceo', level: 2 },
    { id: 'div-coo', name: 'COO (Store Operations)', parentId: 'div-ceo', level: 2 },
    { id: 'div-scm', name: 'Supply Chain & Logistik', parentId: 'div-coo', level: 3 },
    { id: 'div-area', name: 'Area Manager (Wilayah)', parentId: 'div-coo', level: 3 },
    { id: 'div-store', name: 'Kepala Toko (Store Lead)', parentId: 'div-area', level: 4 },
    { id: 'div-kasir', name: 'Kasir & Shift Malam', parentId: 'div-store', level: 5 }
  ],

  build: function () {
    var rnd = Utils.seeded('apexhr-madura-24-7-v3'), now = Utils.nowIso();
    var i, j, r;

    var divisions = [], employees = [], head = {};
    for (i = 0; i < SeedService.DIVISIONS.length; i++) {
      var d = SeedService.DIVISIONS[i];
      divisions.push({
        id: d.id, name: d.name, parentId: d.parentId,
        headId: '', headcount: 0, level: d.level
      });
    }

    var first = ['Haji', 'Siti', 'Ahmad', 'Rina', 'Bapak', 'Dewi', 'Fauzan', 'Nurul',
      'Joko', 'Laila', 'Imron', 'Wati', 'Slamet', 'Endang', 'Yusuf', 'Mutmainah'];
    var last = ['Abdurrahman', 'Rohmah', 'Siddiq', 'Kartika', 'Sumarsono', 'Lestari',
      'Anwar', 'Aisyah', 'Prasetyo', 'Hidayat', 'Safitri', 'Wicaksono', 'Maulana', 'Zulkarnain'];

    var stores = [];
    var regions = ['Bangkalan', 'Sampang', 'Pamekasan', 'Sumenep', 'Surabaya', 'Malang'];
    var tiers = ['Kios', 'Mini', 'Reguler', 'Unggulan'];
    for (i = 0; i < 8; i++) {
      stores.push({
        id: 'str-0' + (i + 1),
        name: 'Madura 24 Jam ' + regions[i % regions.length] + ' #' + (i + 1),
        region: regions[i % regions.length],
        tier: tiers[i % tiers.length],
        capacity: 45 + Math.floor(rnd() * 130),
        openHours: 24,
        status: i === 7 ? 'renovasi' : 'aktif',
        createdAt: now
      });
    }

    var seq = 0;
    for (i = 0; i < SeedService.ROSTER.length; i++) {
      r = SeedService.ROSTER[i];
      for (j = 0; j < r.n; j++) {
        var atStore = (r.div === 'div-store' || r.div === 'div-kasir');
        var eid = 'emp-' + (++seq);
        employees.push({
          id: eid,
          name: first[Math.floor(rnd() * first.length)] + ' ' + last[Math.floor(rnd() * last.length)],
          role: r.role,
          track: r.track,
          departmentId: r.div,
          storeId: atStore ? stores[(j) % 7].id : '',
          performance: 2 + Math.floor(rnd() * 4),
          potential: 1 + Math.floor(rnd() * 5),
          flightRisk: r.track === 'Keluarga' ? (10 + Math.floor(rnd() * 16)) : (25 + Math.floor(rnd() * 31)),
          salary: r.salary
        });
        if (j === 0) head[r.div] = eid;
      }
    }

    for (i = 0; i < divisions.length; i++) {
      divisions[i].headId = head[divisions[i].id] || '';
      var c = 0;
      for (j = 0; j < employees.length; j++) {
        if (employees[j].departmentId === divisions[i].id) c++;
      }
      divisions[i].headcount = c;
    }

    return {
      meta: {
        gameId: Utils.uuid('game'),
        companyName: 'Toko Madura 24 Jam',
        quarter: 1, year: 2026,
        createdAt: now, updatedAt: now
      },
      scenario: {
        id: 'scn-invasi', title: 'Invasi Minimarket Biru-Merah',
        brief: 'Minimarket nasional membuka 12 cabang dalam radius 3 km. Pertahankan revenue sambil menahan turnover.',
        difficulty: 'Menengah', targetRevenue: 2000000000
      },
      decisions: {
        acBudget: 45, trainingBudget: 35, bonusFairness: 40, auditLevel: 30,
        restockSpeed: 55, nightShiftRatio: 60, strategy: 'bertahan'
      },
      collections: {
        stores: stores,
        employees: employees,
        divisions: divisions,
        policies: [
          { id: 'pol-01', name: 'SOP Restock Cepat (Tanpa Audit)', category: 'Operasional', status: 'aktif', restockDelta: 0, fraudShield: 10 },
          { id: 'pol-02', name: 'QC Check Gudang Pusat', category: 'Operasional', status: 'nonaktif', restockDelta: 2, fraudShield: 55 },
          { id: 'pol-03', name: 'Audit Kasir Bulanan', category: 'Keuangan', status: 'nonaktif', restockDelta: 0, fraudShield: 70 },
          { id: 'pol-04', name: 'Job Desc & Span of Control 1:8', category: 'Organisasi', status: 'nonaktif', restockDelta: 0, fraudShield: 15 },
          { id: 'pol-05', name: 'Bonus Meriteka (Fair Pool)', category: 'Kompensasi', status: 'nonaktif', restockDelta: 0, fraudShield: 30 }
        ],
        events: [
          { id: 'evt-01', name: 'Gathering Keluarga Toko', budget: 12000000, enpsImpact: 14, fatigueImpact: -12 },
          { id: 'evt-02', name: 'Bonus Sembako & THR Kecil', budget: 26000000, enpsImpact: 19, fatigueImpact: -6 },
          { id: 'evt-03', name: 'Pelatihan Layanan Pelanggan', budget: 18000000, enpsImpact: 9, fatigueImpact: 4 },
          { id: 'evt-04', name: 'Rotasi Shift Sehat', budget: 8000000, enpsImpact: 11, fatigueImpact: -22 }
        ]
      },
      kpi: {
        revenue: 0, revenueTarget: 2000000000, cash: 1200000000, enps: 22,
        turnoverRate: 18.4, burnoutIndex: 46, shrinkage: 3.8, spanOfControl: 8, operationalRisk: 0
      },
      history: [],
      lastQuarterLog: []
    };
  },

  _name: function (rnd, i) {
    var first = ['Haji', 'Siti', 'Ahmad', 'Rina', 'Bapak', 'Dewi', 'Fauzan', 'Nurul'];
    var last = ['Abdurrahman', 'Rohmah', 'Siddiq', 'Kartika', 'Sumarsono', 'Lestari'];
    return first[i % first.length] + ' ' + last[Math.floor(rnd() * last.length)];
  }
};


/* -----------------------------------------------------------------------------
 * 06.3 StateService — hydration, normalisation, persistence
 * -------------------------------------------------------------------------- */
var StateService = {

  /** Loads the save-game, or seeds a fresh one. */
  hydrate: function () {
    var rows = SheetService.readOrMemory(CONFIG.SHEETS.STATE);
    if (rows.length && rows[0].payload) {
      try {
        var parsed = JSON.parse(String(rows[0].payload));
        return StateService.normalize(parsed);
      } catch (e) {
        // Corrupt payload → reseed.
      }
    }
    var fresh = SeedService.build();
    StateService.persist(fresh);
    return fresh;
  },

  /** Guarantees every collection + kpi key exists (defensive normalisation). */
  normalize: function (state) {
    var s = state || {};
    var seed = SeedService.build();

    s.meta = Object.assign({}, seed.meta, s.meta || {});
    s.scenario = Object.assign({}, seed.scenario, s.scenario || {});
    s.decisions = Object.assign({}, seed.decisions, s.decisions || {});
    s.kpi = Object.assign({}, seed.kpi, s.kpi || {});
    s.collections = s.collections || {};
    s.history = Array.isArray(s.history) ? s.history : [];
    s.lastQuarterLog = Array.isArray(s.lastQuarterLog) ? s.lastQuarterLog : [];

    var keys = ['stores', 'employees', 'divisions', 'policies', 'events'];
    for (var i = 0; i < keys.length; i++) {
      if (!Array.isArray(s.collections[keys[i]])) s.collections[keys[i]] = seed.collections[keys[i]];
    }
    return s;
  },

  /** Shallow merge that never drops unknown top-level keys. */
  merge: function (base, incoming) {
    var out = Utils.clone(base);
    var skip = { collections: 1, history: 1, lastQuarterLog: 1, meta: 1 };
    for (var key in incoming) {
      if (!incoming.hasOwnProperty(key)) continue;
      if (skip[key]) continue;
      if (incoming[key] && typeof incoming[key] === 'object' && !Array.isArray(incoming[key])) {
        out[key] = Object.assign({}, out[key] || {}, incoming[key]);
      } else {
        out[key] = incoming[key];
      }
    }
    if (incoming.collections) out.collections = incoming.collections;
    if (Array.isArray(incoming.history)) out.history = incoming.history.slice(-CONFIG.TUNING.MAX_HISTORY);
    if (incoming.meta) out.meta = Object.assign({}, out.meta, incoming.meta);
    return out;
  },

  /** Persists the full state JSON + normalised tables (batch writes). */
  persist: function (state) {
    var s = StateService.normalize(state);
    s.meta.updatedAt = Utils.nowIso();
    try {
      SheetService.writeOrMemory(CONFIG.SHEETS.STATE, [{
        gameId: s.meta.gameId,
        companyName: s.meta.companyName,
        quarter: s.meta.quarter,
        updatedAt: s.meta.updatedAt,
        payload: JSON.stringify(s)
      }]);
      SheetService.writeOrMemory(CONFIG.SHEETS.STORES, s.collections.stores);
      SheetService.writeOrMemory(CONFIG.SHEETS.EMPLOYEES, s.collections.employees);
      SheetService.writeOrMemory(CONFIG.SHEETS.DIVISIONS, s.collections.divisions);
      SheetService.writeOrMemory(CONFIG.SHEETS.POLICIES, s.collections.policies);
      SheetService.writeOrMemory(CONFIG.SHEETS.EVENTS, s.collections.events);
      SheetService.writeOrMemory(CONFIG.SHEETS.HISTORY, s.history);
      SheetService.writeOrMemory(CONFIG.SHEETS.SCENARIOS, ScenarioService.all());
    } catch (e) {
      // Storage failure must never break gameplay.
    }
    return s;
  }
};


/* -----------------------------------------------------------------------------
 * 06.4 ScenarioService
 * -------------------------------------------------------------------------- */
var ScenarioService = {

  CATALOGUE: [
    {
      id: 'scn-invasi',
      title: 'Invasi Minimarket Biru-Merah',
      brief: 'Minimarket nasional membuka 12 cabang dalam radius 3 km. Pertahankan revenue sambil menahan turnover.',
      difficulty: 'Menengah',
      targetRevenue: 2000000000
    },
    {
      id: 'scn-burnout',
      title: 'Krisis Burnout Shift Malam',
      brief: '60% kasir bekerja malam tanpa rotasi. eNPS anjlok, antrean memanjang, shrinkage naik.',
      difficulty: 'Sulit',
      targetRevenue: 1650000000
    },
    {
      id: 'scn-suksesi',
      title: 'Head of Supply Chain Mundur',
      brief: 'Kunci logistik pergi mendadak. Bangun succession pipeline sebelum rak kosong total.',
      difficulty: 'Sulit',
      targetRevenue: 1850000000
    },
    {
      id: 'scn-ekspansi',
      title: 'Ekspansi 24 Cabang Jawa Timur',
      brief: 'Investor masuk dengan syarat struktur organisasi profesional. Pecah peran Owner.',
      difficulty: 'Ahli',
      targetRevenue: 4200000000
    },
    {
      id: 'scn-nepotisme',
      title: 'Tekanan Nepotisme Internal',
      brief: 'Keluarga meminta bonus besar. Profesional mengancam resign jika alokasi tidak adil.',
      difficulty: 'Menengah',
      targetRevenue: 2300000000
    }
  ],

  all: function () { return Utils.clone(ScenarioService.CATALOGUE); },

  byId: function (id) {
    for (var i = 0; i < ScenarioService.CATALOGUE.length; i++) {
      if (ScenarioService.CATALOGUE[i].id === id) return Utils.clone(ScenarioService.CATALOGUE[i]);
    }
    return null;
  },

  current: function (state) {
    return ScenarioService.byId(state.scenario.id) || ScenarioService.CATALOGUE[0];
  }
};


/* -----------------------------------------------------------------------------
 * 06.5 ForecastService — MATHEMATICS ONLY. No diagram strings, no I/O.
 * -------------------------------------------------------------------------- */
var ForecastService = {

  /**
   * Produces the full forecast envelope for the current state.
   * @return {{kpi:Object, risks:Array, domino:Array, quarters:Array, health:number}}
   */
  compute: function (state) {
    var s = StateService.normalize(state);
    var d = s.decisions, T = CONFIG.TUNING;
    var i, e;

    /* --- 1. Struktur & kapasitas ------------------------------------------- */
    var stores = ForecastService._activeStores(s);
    var activeStores = stores.length;
    var headcount = s.collections.employees.length;
    var areaManagers = ForecastService._areaManagerCount(s);
    var divisions = s.collections.divisions.length;

    var activePolicies = 0, shield = 0, restock = 0;
    for (i = 0; i < s.collections.policies.length; i++) {
      var p = s.collections.policies[i];
      if (p.status === 'aktif') {
        activePolicies++;
        shield += Number(p.fraudShield) || 0;
        restock += Number(p.restockDelta) || 0;
      }
    }
    shield = Math.min(100, shield);

    var eventBudget = 0, fatigueRelief = 0;
    for (i = 0; i < s.collections.events.length; i++) {
      eventBudget += Number(s.collections.events[i].budget) || 0;
      fatigueRelief -= (Number(s.collections.events[i].fatigueImpact) || 0) / 100;
    }

    var professionals = 0, family = 0, payroll = 0;
    for (i = 0; i < headcount; i++) {
      e = s.collections.employees[i];
      if (e.track === 'Profesional') professionals++; else family++;
      payroll += Number(e.salary) || 0;
    }
    payroll = payroll * T.PAYROLL_MONTHS;

    /* --- 2. Fatigue / burnout ---------------------------------------------- */
    var staffingStress = Utils.clamp(
      (activeStores * T.STAFFING_PER_STORE - headcount) * T.STAFFING_STRESS, 0, T.STAFFING_STRESS_MAX);
    var nightLoad = (Utils.clamp(d.nightShiftRatio, 0, 100) / 100) * T.NIGHT_SHIFT_LOAD;
    var comfort = (Utils.clamp(d.acBudget, 0, 100) / 100) * T.AC_COMFORT_COEFF;
    var relief = fatigueRelief * T.RELIEF_SCALE;
    var burnout = Utils.clamp(
      T.BURNOUT_BASE + nightLoad - comfort - relief + staffingStress, 0, 100);

    /* --- 3. eNPS & turnover ------------------------------------------------- */
    var training = (Utils.clamp(d.trainingBudget, 0, 100) / 100) * T.TRAINING_COEFF;
    var fairness = Utils.clamp(d.bonusFairness, 0, 100) / 100;
    var enps = Utils.clamp(
      s.kpi.enps + (fairness - 0.45) * 60 - (burnout - 40) * 0.45 + fatigueRelief * 8, -100, 100);
    var turnover = Utils.clamp(
      T.TURNOVER_BASE + (burnout - 35) * T.BURNOUT_TURNOVER
      + (45 - fairness * 100) * T.FAIRNESS_TURNOVER
      - training * T.TRAINING_RETENTION
      + (30 - enps) * T.ENPS_TURNOVER,
      0.5, 95);

    /* --- 4. Shrinkage ------------------------------------------------------- */
    var shrinkage = Utils.clamp(
      T.SHRINKAGE_BASE + (100 - Utils.clamp(d.auditLevel, 0, 100)) * T.AUDIT_SHRINKAGE
      - shield * T.SHIELD_SHRINKAGE + (turnover / 100) * T.TURNOVER_SHRINKAGE,
      0.1, 22);

    /* --- 5. Revenue, fill rate & lost sales --------------------------------- */
    var capacity = 0;
    for (i = 0; i < stores.length; i++) capacity += Number(stores[i].capacity) || 0;
    var fillRate = Utils.clamp(T.BASE_FILL_RATE - shrinkage / 100 - restock * T.RESTOCK_FILL, 0.25, 0.99);
    var ticket = T.BASE_TICKET * (1 + (Utils.clamp(d.trainingBudget, 0, 100) / 100) * 0.18);
    var strategyBoost = (d.strategy === 'ekspansi') ? 1.12 : 1;
    var gross = capacity * T.DAYS_PER_QUARTER * ticket * fillRate * strategyBoost;
    var lostSales = restock * T.RESTOCK_DAY_VALUE * T.RESTOCK_STORE_FACTOR * activeStores;
    var revenue = Math.max(0, gross - lostSales - (burnout / 100) * T.BURNOUT_REVENUE * gross);

    /* --- 6. Span of control & risiko operasional ---------------------------- */
    var span = areaManagers > 0 ? Utils.round(activeStores / areaManagers, 2) : activeStores;
    var spanRisk = Math.max(0, span - T.SPAN_LIMIT) * T.SPAN_PENALTY * 100;
    var operationalRisk = Utils.clamp(
      spanRisk + (burnout - 40) * 0.6 + (turnover - 15) * 0.8, 0, 100);

    /* --- 7. Cashflow -------------------------------------------------------- */
    var opex = activeStores * T.OPEX_PER_STORE + eventBudget
      + (Utils.clamp(d.acBudget, 0, 100) / 100) * activeStores * T.AC_OPEX_PER_STEP;
    var cash = s.kpi.cash + (revenue - payroll - opex);

    /* --- 8. Org health score ------------------------------------------------ */
    var health = Utils.clamp(
      100 - operationalRisk * T.HEALTH_OPRISK
      - turnover * T.HEALTH_TURNOVER
      - shrinkage * T.HEALTH_SHRINKAGE
      - Math.abs(40 - burnout) * T.HEALTH_BURNOUT
      - Math.max(0, 60 - enps) * T.HEALTH_ENPS,
      0, 100);

    /* --- 9. Early warning --------------------------------------------------- */
    var risks = [];
    if (span > T.SPAN_LIMIT) risks.push({
      code: 'SPAN', level: 'tinggi',
      label: 'Span of Control ' + span + ':1',
      detail: 'Satu Area Manager menanggung ' + activeStores + ' toko aktif. Node diagram berkedip merah.'
    });
    if (turnover > 25) risks.push({
      code: 'TURNOVER', level: 'tinggi',
      label: 'Turnover ' + Utils.round(turnover, 1) + '%',
      detail: 'Probabilitas resign profesional dieksekusi otomatis kuartal depan.'
    });
    if (shrinkage > 5) risks.push({
      code: 'SHRINKAGE', level: 'sedang',
      label: 'Shrinkage ' + Utils.round(shrinkage, 1) + '%',
      detail: 'Kebocoran rak & kasir. Aktifkan SOP Audit untuk menaikkan fraud shield.'
    });
    if (fillRate < 0.8) risks.push({
      code: 'LOST_SALES', level: 'tinggi',
      label: 'Rak kosong ' + Utils.round((1 - fillRate) * 100, 0) + '%',
      detail: 'Lost sales diperkirakan ' + Utils.moneyShort(lostSales) + ' akibat restok melambat.'
    });
    if (burnout > 65) risks.push({
      code: 'BURNOUT', level: 'tinggi',
      label: 'Burnout Index ' + Utils.round(burnout, 0),
      detail: 'Shift malam kelebihan beban. Jalankan Event Architect & rotasi shift.'
    });
    if (staffingStress > 8) risks.push({
      code: 'STAFFING', level: 'sedang',
      label: 'Kekurangan karyawan',
      detail: 'Butuh ' + (activeStores * T.STAFFING_PER_STORE) + ' orang untuk ' + activeStores
        + ' toko aktif, tersedia ' + headcount + '.'
    });
    if (cash < 0) risks.push({
      code: 'CASH', level: 'kritis',
      label: 'Cashflow negatif',
      detail: 'Operasional tidak tertutup. Potong opex, payroll, atau hentikan ekspansi.'
    });

    var kpi = {
      revenue: Math.round(revenue),
      revenueTarget: s.scenario.targetRevenue || s.kpi.revenueTarget,
      cash: Math.round(cash),
      payroll: Math.round(payroll),
      opex: Math.round(opex),
      enps: Math.round(enps),
      turnoverRate: Utils.round(turnover, 1),
      burnoutIndex: Math.round(burnout),
      shrinkage: Utils.round(shrinkage, 1),
      fillRate: Utils.round(fillRate * 100, 1),
      spanOfControl: span,
      operationalRisk: Math.round(operationalRisk),
      health: Math.round(health),
      headcount: headcount,
      activeStores: activeStores,
      divisions: divisions,
      activePolicies: activePolicies,
      professionals: professionals,
      family: family,
      eventBudget: eventBudget,
      lostSales: Math.round(lostSales),
      avgTicket: Math.round(ticket),
      staffingStress: Math.round(staffingStress)
    };

    return {
      kpi: kpi,
      risks: risks,
      domino: ForecastService.dominoChain(s),
      quarters: ForecastService.trajectory(kpi),
      health: kpi.health
    };
  },

  /** Executes one quarter: resignations, revenue booking, KPI roll-forward. */
  advance: function (state) {
    var s = StateService.normalize(state);
    var f = ForecastService.compute(s);
    var log = [];
    var T = CONFIG.TUNING;

    /* --- automatic resignation execution ------------------------------------ */
    var survivors = [];
    for (var i = 0; i < s.collections.employees.length; i++) {
      var e = s.collections.employees[i];
      var risk = Utils.clamp(
        Number(e.flightRisk) + (f.kpi.turnoverRate - 18) * 1.4 + (f.kpi.burnoutIndex - 45) * 0.6,
        0, 99);
      if (risk > 78) {
        log.push({
          type: 'resign',
          text: e.name + ' (' + e.role + ') resign — flight risk ' + Math.round(risk) + '%',
          impact: -1
        });
      } else {
        e.flightRisk = Math.round(risk);
        survivors.push(e);
      }
    }
    if (!log.length) log.push({ type: 'stable', text: 'Seluruh tim bertahan kuartal ini.', impact: 1 });
    if (f.kpi.operationalRisk > 70) {
      log.push({ type: 'ops', text: 'Risiko operasional ' + f.kpi.operationalRisk + '% — bottleneck birokrasi terdeteksi.', impact: -1 });
    }
    if (f.risks.length === 0) {
      log.push({ type: 'growth', text: 'Nol risiko aktif. Revenue ' + Utils.moneyShort(f.kpi.revenue) + ' tercatat.', impact: 1 });
    }

    s.collections.employees = survivors;
    s.kpi = f.kpi;
    s.kpi.cash = f.kpi.cash;
    s.meta.quarter = (Number(s.meta.quarter) || 1) + 1;
    s.history.push({
      quarter: s.meta.quarter - 1,
      revenue: f.kpi.revenue,
      turnover: f.kpi.turnoverRate,
      enps: f.kpi.enps,
      note: f.risks.length ? f.risks[0].label : 'Sehat'
    });
    if (s.history.length > T.MAX_HISTORY) s.history = s.history.slice(-T.MAX_HISTORY);
    s.lastQuarterLog = log;
    return StateService.normalize(s);
  },

  /** The domino-effect chain — "Systemic Interconnectivity". */
  dominoChain: function (state) {
    var s = StateService.normalize(state);
    var d = s.decisions;
    var T = CONFIG.TUNING;
    var chain = [];

    chain.push({ step: 1, node: 'Budget AC & Kenyamanan', value: d.acBudget + '%', tone: 'input' });

    if (d.acBudget < 30) {
      chain.push({ step: 2, node: 'Kasir gerah & lambat', value: 'Burnout +' + Math.round((30 - d.acBudget) * 0.9), tone: 'risk' });
      chain.push({ step: 3, node: 'Turnover naik', value: '+' + Utils.round((30 - d.acBudget) * 0.22, 1) + ' pp', tone: 'risk' });
      chain.push({ step: 4, node: 'Rekrutmen & pelatihan ulang', value: '−' + Utils.moneyShort((30 - d.acBudget) * 1800000), tone: 'risk' });
      chain.push({ step: 5, node: 'Revenue tererosi', value: '−' + Utils.round((30 - d.acBudget) * 0.31, 1) + '%', tone: 'critical' });
    } else {
      chain.push({ step: 2, node: 'Kenyamanan shift malam stabil', value: 'Burnout −' + Math.round(d.acBudget * 0.4), tone: 'good' });
      chain.push({ step: 3, node: 'Retensi kasir naik', value: '+' + Utils.round(d.acBudget * 0.15, 1) + ' pp', tone: 'good' });
      chain.push({ step: 4, node: 'Produktivitas rak stabil', value: 'Fill rate ' + Utils.round(T.BASE_FILL_RATE * 100, 0) + '%', tone: 'good' });
      chain.push({ step: 5, node: 'Revenue terlindungi', value: '+' + Utils.round(d.acBudget * 0.28, 1) + '%', tone: 'good' });
    }

    if (d.auditLevel < 45) {
      chain.push({ step: 6, node: 'Audit lemah', value: 'Fraud shield ' + Math.round(ForecastService._shield(s)) + '/100', tone: 'risk' });
      chain.push({ step: 7, node: 'Shrinkage naik', value: '+' + Utils.round((45 - d.auditLevel) * 0.055, 1) + ' pp', tone: 'risk' });
      chain.push({ step: 8, node: 'Margin hilang', value: '−' + Utils.moneyShort((45 - d.auditLevel) * 21000000), tone: 'critical' });
    } else {
      chain.push({ step: 6, node: 'Audit & QC aktif', value: 'Fraud shield ' + Math.round(ForecastService._shield(s)) + '/100', tone: 'good' });
      chain.push({ step: 7, node: 'Shrinkage terkendali', value: '−' + Utils.round((d.auditLevel - 45) * 0.035, 1) + ' pp', tone: 'good' });
      chain.push({ step: 8, node: 'Margin terlindungi', value: '+' + Utils.moneyShort((d.auditLevel - 45) * 18000000), tone: 'good' });
    }

    if (d.bonusFairness < 50) {
      chain.push({ step: 9, node: 'Bonus tidak adil', value: d.bonusFairness + '% fair', tone: 'risk' });
      chain.push({ step: 10, node: 'Flight risk profesional', value: '+' + Math.round((50 - d.bonusFairness) * T.BONUS_NEPOTISM_RISK) + '%', tone: 'risk' });
      chain.push({ step: 11, node: 'Resign massal Q+' + 1, value: 'Otomatis dieksekusi', tone: 'critical' });
    } else {
      chain.push({ step: 9, node: 'Bonus meriteka', value: d.bonusFairness + '% fair', tone: 'good' });
      chain.push({ step: 10, node: 'Flight risk turun', value: '−' + Math.round((d.bonusFairness - 50) * T.BONUS_FAIRNESS_GAIN) + '%', tone: 'good' });
      chain.push({ step: 11, node: 'Suksesi internal kuat', value: 'Pipeline terisi', tone: 'good' });
    }

    return chain;
  },

  /** 6-quarter projection sparkline data. */
  trajectory: function (kpi) {
    var out = [];
    var base = kpi.revenue;
    var drift = (kpi.health - 60) / 100;
    for (var q = 1; q <= 6; q++) {
      out.push({
        quarter: 'Q' + q,
        revenue: Math.round(base * (1 + drift * q * 0.06) + q * base * 0.012),
        turnover: Utils.round(Math.max(1, kpi.turnoverRate - q * drift * 1.4), 1),
        enps: Math.round(kpi.enps + q * drift * 2.4)
      });
    }
    return out;
  },

  /* ---- private helpers ---------------------------------------------------- */

  _activeStores: function (s) {
    var out = [];
    for (var i = 0; i < s.collections.stores.length; i++) {
      if (s.collections.stores[i].status !== 'tutup') out.push(s.collections.stores[i]);
    }
    return out;
  },

  _areaManagerCount: function (s) {
    var n = 0;
    for (var i = 0; i < s.collections.employees.length; i++) {
      if (/area\s*manager/i.test(String(s.collections.employees[i].role))) n++;
    }
    return n;
  },

  _activePolicies: function (s) {
    var n = 0;
    for (var i = 0; i < s.collections.policies.length; i++) {
      if (s.collections.policies[i].status === 'aktif') n++;
    }
    return n;
  },

  _eventBudget: function (s) {
    var total = 0;
    for (var i = 0; i < s.collections.events.length; i++) {
      total += Number(s.collections.events[i].budget) || 0;
    }
    return total;
  },

  _eventRelief: function (s) {
    var relief = 0;
    for (var i = 0; i < s.collections.events.length; i++) {
      relief += (Number(s.collections.events[i].fatigueImpact) || 0) / 100;
    }
    return relief;
  },

  _shield: function (s) {
    var shield = 0;
    for (var i = 0; i < s.collections.policies.length; i++) {
      var p = s.collections.policies[i];
      if (p.status === 'aktif') shield += Number(p.fraudShield) || 0;
    }
    return Math.min(100, shield);
  },

  _restockPenalty: function (s) {
    var penalty = 0;
    for (var i = 0; i < s.collections.policies.length; i++) {
      var p = s.collections.policies[i];
      if (p.status === 'aktif') penalty += Number(p.restockDelta) || 0;
    }
    return penalty;
  },

  _lostSales: function (s, storeCount) {
    var days = ForecastService._restockPenalty(s);
    return days * CONFIG.TUNING.RESTOCK_DAY_VALUE * (storeCount || 1) * 0.25;
  },

  _trackCount: function (s, track) {
    var n = 0;
    for (var i = 0; i < s.collections.employees.length; i++) {
      if (s.collections.employees[i].track === track) n++;
    }
    return n;
  }
};


/* -----------------------------------------------------------------------------
 * 06.6 MermaidService — STRING SYNTHESIS ONLY. Zero math, zero I/O.
 * -------------------------------------------------------------------------- */
var MermaidService = {

  renderAll: function (state) {
    return {
      org: MermaidService.orgChart(state),
      process: MermaidService.processFlow(state),
      mindmap: MermaidService.mindmap(state),
      succession: MermaidService.succession(state),
      fatigue: MermaidService.fatigueFlow(state)
    };
  },

  /** Module 2 — Dynamic Org-Chart. Overloaded nodes are flagged red. */
  orgChart: function (state) {
    var s = StateService.normalize(state);
    var f = ForecastService.compute(s);
    var limit = CONFIG.TUNING.SPAN_LIMIT;
    var lines = ['flowchart TD'];

    for (var i = 0; i < s.collections.divisions.length; i++) {
      var d = s.collections.divisions[i];
      var label = d.name + '<br/>' + (Number(d.headcount) || 0) + ' orang';
      var span = (Number(d.headcount) || 0) / Math.max(1, ForecastService._areaManagerCount(s));
      var overloaded = (Number(d.headcount) || 0) > limit * 3;
      lines.push('  ' + d.id + '["' + MermaidService._esc(label) + '"]');
      if (d.parentId) lines.push('  ' + d.parentId + ' --> ' + d.id);
      if (overloaded) lines.push('  class ' + d.id + ' overloaded');
    }
    if (f.kpi.spanOfControl > limit) {
      lines.push('  SPAN{{"SPAN OF CONTROL ' + f.kpi.spanOfControl + ':1 — OVERLOADED"}}');
      lines.push('  SPAN -. "Risiko Operasional ' + f.kpi.operationalRisk + '%" .-> div-area');
      lines.push('  class SPAN alarm');
    }
    lines.push('  classDef overloaded fill:#fee2e2,stroke:#ef4444,stroke-width:3px,color:#7f1d1d');
    lines.push('  classDef alarm fill:#fef3c7,stroke:#f59e0b,stroke-width:2px,stroke-dasharray: 6 4,color:#78350f');
    return lines.join('\n');
  },

  /** Module 2 — Automated Business Process Flow (Visual SOP). */
  processFlow: function (state) {
    var s = StateService.normalize(state);
    var f = ForecastService.compute(s);
    var lines = ['flowchart LR'];
    var nodes = [];
    var shields = 0, restock = 0;

    for (var i = 0; i < s.collections.policies.length; i++) {
      var p = s.collections.policies[i];
      if (p.status !== 'aktif') continue;
      nodes.push(MermaidService._esc(p.name));
      shields += Number(p.fraudShield) || 0;
      restock += Number(p.restockDelta) || 0;
    }

    if (!nodes.length) {
      lines.push('  A[Supplier] --> B[Kepala Toko] --> C[Rak Toko]');
      lines.push('  C --> D[Kasir] --> E[Pelanggan]');
      lines.push('  class A,B,C,D,E fast');
      lines.push('  classDef fast fill:#ecfdf5,stroke:#10b981,stroke-width:2px,color:#065f46');
      lines.push('  NOTE["TANPA SOP: cepat, rawan fraud & shrinkage"]');
      lines.push('  E -.-> NOTE');
      lines.push('  class NOTE warn');
      lines.push('  classDef warn fill:#fffbeb,stroke:#f59e0b,stroke-width:1px,color:#78350f');
      return lines.join('\n');
    }

    lines.push('  S[Supplier] --> G[Gudang Pusat]');
    for (var n = 0; n < nodes.length; n++) {
      lines.push('  G --> P' + n + '["' + nodes[n] + '"]');
    }
    lines.push('  P' + (nodes.length - 1) + ' --> Q[QC Check] --> D[Distribusi] --> R[Rak Toko] --> K[Kasir] --> C[Pelanggan]');
    lines.push('  K --> L["Lost Sales: ' + Utils.moneyShort(f.kpi.lostSales) + '"]');
    lines.push('  class L critical');
    lines.push('  class S,G,Q,D,R,K,C safe');
    lines.push('  class L critical');
    lines.push('  classDef safe fill:#eff6ff,stroke:#2563eb,stroke-width:2px,color:#1e3a8a');
    lines.push('  classDef critical fill:#fef2f2,stroke:#ef4444,stroke-width:2px,color:#7f1d1d');
    return lines.join('\n');
  },

  /** Module 1 — Strategy Mapping mindmap. Broken alignment = dashed red link. */
  mindmap: function (state) {
    var s = StateService.normalize(state);
    var f = ForecastService.compute(s);
    var aligned = f.kpi.health > 55;
    var lines = ['mindmap'];
    lines.push('  root(("ApexHR ' + MermaidService._esc(s.meta.companyName) + '"))');
    lines.push('    Strategy["' + (s.decisions.strategy === 'ekspansi' ? 'EKSPANSI NASIONAL' : 'PERTAHANKAN PASAR') + '"]');
    lines.push('      HR["HR Initiative"]');
    lines.push('        A1["Struktur Profesional"]');
    lines.push('        A2["Talent Matrix 9-Box"]');
    lines.push('        A3["Appraisal Adil"]');
    lines.push('      KPI["Store KPI"]');
    lines.push('        B1["Revenue ' + Utils.moneyShort(f.kpi.revenue) + '"]');
    lines.push('        B2["Turnover ' + f.kpi.turnoverRate + '%"]');
    lines.push('        B3["eNPS ' + f.kpi.enps + '"]');
    lines.push('      Focus["' + MermaidService._esc(s.scenario.title) + '"]');
    if (aligned) {
      lines.push('    Strategy --> HR');
      lines.push('    HR --> KPI');
    } else {
      lines.push('    Strategy -. "MISALIGNED" .-> HR');
      lines.push('    HR -. "MISALIGNED" .-> KPI');
    }
    return lines.join('\n');
  },

  /** Module 3 — Succession pipeline. Empty pipeline = black (lumpuh total). */
  succession: function (state) {
    var s = StateService.normalize(state);
    var f = ForecastService.compute(s);
    var lines = ['flowchart LR'];
    var key = ['Head of Supply Chain', 'Area Manager', 'Kepala Toko', 'CFO', 'CHRO'];
    var broken = [];

    for (var i = 0; i < key.length; i++) {
      var bench = 0;
      for (var e = 0; e < s.collections.employees.length; e++) {
        if (String(s.collections.employees[e].role).toLowerCase().indexOf(key[i].toLowerCase().split(' ')[0]) !== -1) bench++;
      }
      if (bench < 2) broken.push(key[i]);
      lines.push('  K' + i + '["' + MermaidService._esc(key[i]) + '<br/>Bench: ' + bench + '"]');
      if (i > 0) lines.push('  K' + (i - 1) + ' --> K' + i);
    }

    if (broken.length) {
      lines.push('  GAP{{"PIPELINE KOSONG: ' + MermaidService._esc(broken.join(', ')) + '"}}');
      lines.push('  GAP -. "Lumpuh Total" .-> K0');
      lines.push('  class GAP black');
      lines.push('  classDef black fill:#0f172a,stroke:#020617,stroke-width:3px,color:#f8fafc');
    } else {
      lines.push('  OK["Pipeline Siap — Risiko suksesi rendah"]');
      lines.push('  K4 --> OK');
      lines.push('  class OK good');
      lines.push('  classDef good fill:#ecfdf5,stroke:#10b981,stroke-width:2px,color:#065f46');
    }
    lines.push('  LOSS["Estimasi kerugian supply chain: ' + Utils.moneyShort(f.kpi.lostSales) + '"]');
    lines.push('  K0 -.-> LOSS');
    lines.push('  class LOSS warn');
    lines.push('  classDef warn fill:#fffbeb,stroke:#f59e0b,stroke-width:2px,color:#78350f');
    return lines.join('\n');
  },

  /** Module 5 — Culture / fatigue flowchart. */
  fatigueFlow: function (state) {
    var s = StateService.normalize(state);
    var f = ForecastService.compute(s);
    var engaged = f.kpi.burnoutIndex < 45;
    var lines = ['flowchart LR'];
    lines.push('  N["Shift Malam ' + s.decisions.nightShiftRatio + '%"]');
    lines.push('  N --> F["Fatigue ' + f.kpi.burnoutIndex + '/100"]');
    if (engaged) {
      lines.push('  F --> E["ENGAGED"]');
      lines.push('  E --> T["Turnover turun ke ' + f.kpi.turnoverRate + '%"]');
      lines.push('  class F,E,T good');
      lines.push('  classDef good fill:#ecfdf5,stroke:#10b981,stroke-width:2px,color:#065f46');
    } else {
      lines.push('  F --> B["BURNOUT"]');
      lines.push('  B --> R["Resign & antrean panjang"]');
      lines.push('  R --> L["Revenue turun ' + Utils.moneyShort(f.kpi.revenue) + '"]');
      lines.push('  class F,B,R,L bad');
      lines.push('  classDef bad fill:#fef2f2,stroke:#ef4444,stroke-width:2px,color:#7f1d1d');
    }
    for (var i = 0; i < s.collections.events.length && i < 3; i++) {
      lines.push('  EV' + i + '["' + MermaidService._esc(s.collections.events[i].name) + '"]');
      lines.push('  EV' + i + ' -. "eNPS +' + (Number(s.collections.events[i].enpsImpact) || 0) + '" .-> F');
      lines.push('  class EV' + i + ' ev');
    }
    lines.push('  classDef ev fill:#f5f3ff,stroke:#8b5cf6,stroke-width:2px,color:#4c1d95');
    return lines.join('\n');
  },

  /** Escapes characters that break Mermaid label parsing. */
  _esc: function (str) {
    return String(str === undefined || str === null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/"/g, "'")
      .replace(/\n/g, ' ')
      .replace(/[\[\]{}]/g, '');
  }
};


/* =============================================================================
 * 07. WEB APP ENTRY POINTS
 * ========================================================================== */

/** GET — public read actions. */
function doGet(e) {
  var params = (e && e.parameter) || {};
  var request = {
    action: params.action || 'ping',
    params: params
  };
  return Router.dispatch(request);
}

/** POST — mutations, forecast and diagram synthesis. */
function doPost(e) {
  var body = {};
  if (e && e.postData && e.postData.contents) {
    try { body = JSON.parse(e.postData.contents); }
    catch (err) { body = {}; }
  }
  var request = {
    action: (body.action || (e && e.parameter && e.parameter.action) || 'ping'),
    params: body
  };
  return Router.dispatch(request);
}

/** Sheets-side trigger: auto-setup when the bound spreadsheet opens. */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('ApexHR Engine')
      .addItem('Bootstrap Database', 'apexHrSetupDatabase')
      .addItem('Jalankan Forecast Q', 'apexHrRunQuarter')
      .addToUi();
  } catch (err) { /* headless runtime */ }
}

/** Creates every table with headers in ONE batched pass. */
function apexHrSetupDatabase() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var names = Object.keys(CONFIG.SCHEMA);
  var created = [];
  for (var i = 0; i < names.length; i++) {
    var sheet = ss.getSheetByName(names[i]);
    var isNew = !sheet;
    if (isNew) sheet = ss.insertSheet(names[i]);
    var columns = CONFIG.SCHEMA[names[i]];
    /* Only stamp the header on a brand-new or empty sheet so live data is never clobbered. */
    if (isNew || sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, columns.length).setValues([columns]); // BATCH WRITE
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, columns.length).setFontWeight('bold');
      created.push(names[i]);
    }
  }
  return Response.ok({ tables: created, total: names.length }, 'Database ApexHR siap.');
}

/** Runs a quarter from the spreadsheet menu. */
function apexHrRunQuarter() {
  return GameController.advanceQuarter({});
}
