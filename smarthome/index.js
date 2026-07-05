const express = require('express');
const bcrypt = require('bcrypt');
const mqtt = require('mqtt');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { HOLIDAY_CALENDAR } = require('./calendar_data.js');

// ── CONFIG — נטען מ-config.json מקומי (ואם לא קיים — מ-CONFIG_JSON env) ──

// ── DATA DIR — /share/smarthome-data במצב add-on, ./data במצב ידני ──
const DATA_DIR = fs.existsSync('/share') 
  ? '/share/smarthome-data' 
  : path.join(__dirname, 'data');
const CONFIG_FILE_LOCAL = path.join(DATA_DIR, 'config.json');

try { 
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); 
} catch(e) { console.error('⚠️ לא ניתן ליצור תיקיית data:', e.message); }

console.log(`💾 תיקיית data: ${DATA_DIR}`);
// config בסיסי — קרא מ-env או מ-config_base.json
let config = {};
try {
  if (process.env.CONFIG_JSON) {
    config = JSON.parse(process.env.CONFIG_JSON);
    console.log('📂 config בסיסי נטען מ-CONFIG_JSON env');
  } else if (fs.existsSync(path.join(__dirname, 'config_base.json'))) {
    config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config_base.json'), 'utf-8'));
    console.log('📂 config בסיסי נטען מ-config_base.json');
  }
  // אם CONTROLLERS חסר — נסה לטעון מ-/data/options.json (HA Add-on)
  if (!config.CONTROLLERS && fs.existsSync('/data/options.json')) {
    const opts = JSON.parse(fs.readFileSync('/data/options.json', 'utf-8'));
    if (opts.controllers) {
      config.CONTROLLERS = opts.controllers;
      config.MQTT_URL = config.MQTT_URL || opts.mqtt_url;
      config.MQTT_USER = config.MQTT_USER || opts.mqtt_user;
      config.MQTT_PASS = config.MQTT_PASS || opts.mqtt_pass;
      console.log(`📂 CONTROLLERS נטענו ישירות מ-/data/options.json (${opts.controllers.length} בקרים)`);
    }
  }
} catch(e) {
  console.error('❌ שגיאה בטעינת config בסיסי:', e.message);
}

// ── שמירה/טעינה מקומית (במקום GitHub) ──────────────────
let _saveTimeout = null;

function loadConfigLocal() {
  try {
    if (!fs.existsSync(CONFIG_FILE_LOCAL)) {
      console.log('⚠️ אין קובץ config מקומי — מתחיל ריק');
      return;
    }
    const raw = fs.readFileSync(CONFIG_FILE_LOCAL, 'utf-8');
    const cfg = JSON.parse(raw);
    if (cfg.programs)  { schedulerPrograms = cfg.programs; console.log(`📂 נטענו ${schedulerPrograms.length} תוכניות`); }
    if (cfg.activeModeId !== undefined) schedulerActiveModeId = cfg.activeModeId;
    if (cfg.scheduledModes) { scheduledModes = cfg.scheduledModes; console.log(`🕐 נטענו ${scheduledModes.length} תזמוני מצב`); }
    if (cfg.serverConfig) serverConfig = cfg.serverConfig;
    if (cfg.yemotPermissions) { yemotPermissions = cfg.yemotPermissions; console.log(`📞 נטענו הרשאות IVR ל-${Object.keys(yemotPermissions).length} מזהים`); }
    if (cfg.ivrPendingTimers) { ivrPendingTimers = cfg.ivrPendingTimers; console.log(`⏱️ נטענו ${ivrPendingTimers.length} טיימרים ממתינים`); }
    if (cfg.ivrTodayEvents) { ivrTodayEvents = cfg.ivrTodayEvents; }
    if (cfg.haDevices) { 
      haDevices = cfg.haDevices; 
      // תיקון מאוחר — relayId יוקצה ב-rebuildHaRelayNames אחרי שה-CONTROLLERS נטענו
      console.log(`🏠 נטענו ${haDevices.length} התקני HA`); 
    }
    if (cfg.haToken) { haToken = cfg.haToken; }
    if (cfg.haUrl) { haUrl = cfg.haUrl; }
    if (cfg.yemotPhoneMap) { yemotPhoneMap = cfg.yemotPhoneMap; }
    if (cfg.users) {
      runtimeUsers = cfg.users;
      let needsSave = false;
      runtimeUsers.forEach(u => {
        if (u.password && !u.password.startsWith('$2b$') && !u.password.startsWith('$2a$')) {
          u.password = bcrypt.hashSync(u.password, 10);
          console.log(`🔐 סיסמת "${u.name}" הוצפנה בטעינה`);
          needsSave = true;
        }
      });
      if (needsSave) saveConfigLocal();
    }
    console.log('✅ config נטען מקומית');
  } catch(e) {
    console.log(`❌ שגיאה בטעינת config: ${e.message}`);
  }
}

function saveConfigLocal() {
  clearTimeout(_saveTimeout);
  _saveTimeout = setTimeout(() => {
    try {
      const cfg = {
        programs: schedulerPrograms,
        activeModeId: schedulerActiveModeId,
        scheduledModes,
        serverConfig,
        users: runtimeUsers,
        yemotPermissions,
        yemotPhoneMap,
        ivrPendingTimers,
        ivrTodayEvents,
        haDevices,
        haToken,
        haUrl,
        savedAt: new Date().toISOString(),
      };
      fs.writeFileSync(CONFIG_FILE_LOCAL, JSON.stringify(cfg, null, 2), 'utf-8');
      console.log('💾 config נשמר מקומית');
    } catch(e) {
      console.error('❌ שגיאה בשמירת config:', e.message);
    }
  }, 2000);
}

// ── HOME ASSISTANT INTEGRATION ───────────────────────────
// התקני HA — רשימה שהמשתמש בחר להוסיף מ-/api/states
let haDevices = []; // [{ entity_id, friendly_name, domain, relayId }]
let haToken = ''; // Long-Lived Access Token של HA
let haUrl = 'http://homeassistant.local:8123'; // כתובת HA המקומית

// שליחת פקודה ל-HA (POST /api/services/switch/turn_on וכו')
async function haCallService(domain, service, entityId) {
  if (!haToken) throw new Error('לא הוגדר HA Token');
  const url = `${haUrl}/api/services/${domain}/${service}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${haToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ entity_id: entityId }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HA API שגיאה ${res.status}: ${txt}`);
  }
  return res.json();
}

// קריאת מצב התקן מ-HA
async function haGetState(entityId) {
  if (!haToken) throw new Error('לא הוגדר HA Token');
  const res = await fetch(`${haUrl}/api/states/${entityId}`, {
    headers: { 'Authorization': `Bearer ${haToken}` }
  });
  if (!res.ok) throw new Error(`HA API שגיאה ${res.status}`);
  return res.json();
}

// רשימת כל ה-entities הניתנות לשליטה (switch.*, light.*, input_boolean.*, fan.*)
async function haFetchAllStates() {
  if (!haToken) throw new Error('לא הוגדר HA Token — הגדר בכרטיסיית התקנים');
  const res = await fetch(`${haUrl}/api/states`, {
    headers: { 'Authorization': `Bearer ${haToken}` }
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HA API שגיאה ${res.status}: ${txt}`);
  }
  const all = await res.json();
  // סינון לישויות ניתנות לשליטה — לא כלים מובנים/מערכת
  const SKIP_PREFIXES = ['sun.','weather.','zone.','tts.','update.','todo.','person.','persistent_notification.'];
  const SKIP_SUFFIXES = ['_update','_version','_rssi','_lqi','_battery','_linkquality',
    '_temperature','_humidity','_power_outage_memory','_uptime','_ssid','_wifi_connect_count',
    '_restart_reason','_bridge_permit_join'];
  return all.filter(e => {
    const id = e.entity_id;
    if (SKIP_PREFIXES.some(p => id.startsWith(p))) return false;
    if (SKIP_SUFFIXES.some(s => id.endsWith(s))) return false;
    // רק domainים ניתנים לשליטה
    const domain = id.split('.')[0];
    return ['switch','light','input_boolean','fan','cover','lock','climate'].includes(domain);
  }).map(e => ({
    entity_id: e.entity_id,
    friendly_name: e.attributes?.friendly_name || e.entity_id,
    state: e.state,
    domain: e.entity_id.split('.')[0],
  }));
}

// ── ימות המשיח — API ─────────────────────────────────────
const YEMOT_API_TOKEN = process.env.YEMOT_API_TOKEN || '';
const YEMOT_BASE_URL = 'https://www.call2all.co.il/ym/api';

async function yemotDownloadFile(filePath) {
  if (!YEMOT_API_TOKEN) throw new Error('חסר YEMOT_API_TOKEN');
  const params = new URLSearchParams({ token: YEMOT_API_TOKEN, path: filePath });
  const res = await fetch(`${YEMOT_BASE_URL}/DownloadFile?${params}`);
  const text = await res.text();
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    let data = {};
    try { data = JSON.parse(trimmed); } catch (e) {}
    throw new Error(data.message || 'שגיאה בקריאת הקובץ מימות המשיח');
  }
  return text;
}

async function yemotUploadFile(filePath, content, filename) {
  if (!YEMOT_API_TOKEN) throw new Error('חסר YEMOT_API_TOKEN');
  const params = new URLSearchParams({ token: YEMOT_API_TOKEN, path: filePath });
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), filename);
  const res = await fetch(`${YEMOT_BASE_URL}/UploadFile?${params}`, { method: 'POST', body: form });
  const data = await res.json();
  if (data.responseStatus !== 'OK') throw new Error(data.message || 'שגיאה בשמירת הקובץ לימות המשיח');
  return data;
}

async function yemotGetTemplates() {
  if (!YEMOT_API_TOKEN) throw new Error('חסר YEMOT_API_TOKEN');
  const params = new URLSearchParams({ token: YEMOT_API_TOKEN });
  const res = await fetch(`${YEMOT_BASE_URL}/GetTemplates?${params}`);
  const data = await res.json();
  if (data.responseStatus !== 'OK') throw new Error(data.message || 'שגיאה בקבלת תבניות');
  return data.templates || [];
}

async function yemotGetWhitelistTemplateId() {
  const templates = await yemotGetTemplates();
  const whitelistTemplates = templates.filter(t => t.incomingPolicy === 'WHITELIST');
  if (!whitelistTemplates.length) throw new Error('לא נמצאה תבנית WHITELIST');
  const def = whitelistTemplates.find(t => t.customerDefault);
  return (def || whitelistTemplates[0]).templateId;
}

async function yemotGetTemplateEntries(templateId) {
  if (!YEMOT_API_TOKEN) throw new Error('חסר YEMOT_API_TOKEN');
  const params = new URLSearchParams({ token: YEMOT_API_TOKEN, templateId });
  const res = await fetch(`${YEMOT_BASE_URL}/GetTemplateEntries?${params}`);
  const data = await res.json();
  if (data.responseStatus !== 'OK') throw new Error(data.message || 'שגיאה');
  return data.entries || [];
}

async function yemotAddPhoneToWhitelist(templateId, phone) {
  if (!YEMOT_API_TOKEN) throw new Error('חסר YEMOT_API_TOKEN');
  const params = new URLSearchParams({ token: YEMOT_API_TOKEN, templateId, data: phone });
  const res = await fetch(`${YEMOT_BASE_URL}/UploadPhoneList?${params}`);
  const data = await res.json();
  if (data.responseStatus !== 'OK') throw new Error(data.message || `שגיאה בהוספת ${phone}`);
  return data;
}

function normalizePhoneDigits(p) { return (p || '').replace(/\D/g, ''); }

// ── EXPRESS + SOCKET.IO ──────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(__dirname));

// ── MQTT — מקומי (core-mosquitto של HA) ─────────────────
// ה-URL מגיע מ-config_base.json או מ-env: mqtt://192.168.1.24:1883 (לא "tramway.railway...")
const MQTT_URL = config.MQTT_URL || process.env.MQTT_URL || 'mqtt://core-mosquitto:1883';
const MQTT_USER = config.MQTT_USER || process.env.MQTT_USER || '';
const MQTT_PASS = config.MQTT_PASS || process.env.MQTT_PASS || '';

// ── CONTROLLERS ──────────────────────────────────────────
// תמיכה בשני פורמטים: relayCount (camelCase) ו-relay_count (snake_case מ-HA options)
const CONTROLLERS = (config.CONTROLLERS || []).map(c => ({
  ...c,
  relayCount: c.relayCount || c.relay_count || 0,
}));

// ── IVR STATE ────────────────────────────────────────────
let yemotPhoneMap = config.YEMOT_PHONE_MAP || {};
let yemotPermissions = {};
let ivrPendingTimers = [];
let ivrTodayEvents = [];

function getOrderedRelayIds() {
  return Object.keys(schedulerRelayNames).map(Number).sort((a, b) => a - b);
}

function buildIvrUsersList() {
  return Object.entries(yemotPhoneMap).map(([phone, id]) => {
    const perm = yemotPermissions[id] || {};
    return {
      id, phone,
      name: perm.name || `מתקשר ${id}`,
      isAdmin: !!perm.isAdmin,
      allowedRelays: perm.allowedRelays || [],
      allowedActions: perm.allowedActions || ['ON','OFF'],
      maxDurationMinOn: perm.maxDurationMinOn ?? 0,
      maxDurationMinOff: perm.maxDurationMinOff ?? 0,
    };
  });
}

const relayState = {};
const relayOwner = {};
const _pendingConfirm = {};
const _ackWaiters = {};

function waitForRelayAck(relayId, timeoutMs) {
  return new Promise((resolve) => {
    if (!_ackWaiters[relayId]) _ackWaiters[relayId] = [];
    const entry = { resolve, done: false };
    _ackWaiters[relayId].push(entry);
    setTimeout(() => { if (!entry.done) { entry.done = true; resolve(false); } }, timeoutMs);
  });
}
function notifyRelayAck(relayId) {
  const waiters = _ackWaiters[relayId];
  if (!waiters?.length) return;
  _ackWaiters[relayId] = [];
  waiters.forEach(w => { if (!w.done) { w.done = true; w.resolve(true); } });
}

// בנה schedulerRelayNames + relayState מ-CONTROLLERS + haDevices
const schedulerRelayNames = {};
let _relayOffset = 0;
CONTROLLERS.forEach(ctrl => {
  ctrl._offset = _relayOffset;
  for (let i = 1; i <= ctrl.relayCount; i++) {
    const globalId = i + _relayOffset;
    relayState[globalId] = 'OFF';
    schedulerRelayNames[globalId] = ctrl.relayNames?.[i] || `ממסר ${globalId}`;
  }
  _relayOffset += ctrl.relayCount;
});

// מזהה ממסר HA (entity_id) → globalId: נוסף כשהמשתמש מוסיף התקן מ-HA
// haDevices[].relayId → globalId (מסדרה אחרי offset הבקרים)
function rebuildHaRelayNames() {
  const tasmotaMax = CONTROLLERS.reduce((s, c) => s + c.relayCount, 0);
  let changed = false;
  const usedHaIds = new Set();

  // סבב ראשון — אסוף IDs תקינים וסמן קונפליקטים
  haDevices.forEach(dev => {
    if (!dev.relayId || isNaN(dev.relayId)) {
      dev.relayId = null; changed = true;
    } else if (dev.relayId <= tasmotaMax) {
      console.log(`⚠️ התקן ${dev.entity_id} relayId=${dev.relayId} מתנגש עם בקר (tasmotaMax=${tasmotaMax}) — מוקצה מחדש`);
      dev.relayId = null; changed = true;
    } else {
      usedHaIds.add(dev.relayId);
    }
  });

  // סבב שני — הקצה לכל מי שחסר
  haDevices.forEach(dev => {
    if (!dev.relayId) {
      let nextId = tasmotaMax + 1;
      while (usedHaIds.has(nextId)) nextId++;
      dev.relayId = nextId;
      usedHaIds.add(nextId);
      console.log(`🔧 הוקצה relayId ${nextId} ל-${dev.entity_id}`);
    }
    schedulerRelayNames[dev.relayId] = dev.friendly_name || dev.entity_id;
    if (!relayState[dev.relayId]) relayState[dev.relayId] = 'OFF';
  });

  if (changed) {
    saveConfigLocal();
    console.log(`🏠 התקני HA לאחר תיקון: ${haDevices.map(d => `${d.friendly_name}→${d.relayId}`).join(', ')}`);
  }
}

function getControllerForRelay(globalRelayId) {
  let offset = 0;
  for (const ctrl of CONTROLLERS) {
    if (globalRelayId > offset && globalRelayId <= offset + ctrl.relayCount) {
      return { type: 'tasmota', ctrl, localId: globalRelayId - offset };
    }
    offset += ctrl.relayCount;
  }
  // בדוק אם זה התקן HA
  const haDev = haDevices.find(d => d.relayId === globalRelayId);
  if (haDev) return { type: 'ha', dev: haDev };
  return { type: 'tasmota', ctrl: CONTROLLERS[0], localId: globalRelayId };
}

// ── IVR URL — כעת מצביע לדומיין המקומי (Cloudflare Tunnel) ─
const YEMOT_API_LINK_URL = process.env.YEMOT_API_LINK_URL || 'https://smarthome.example.com/yemot';

function buildYemotAutoFiles() {
  const relayIds = getOrderedRelayIds();
  const relayKeys = relayIds.join('.');
  const tts000 = 'שלום, להלן רשימת המתגים הקיימים. '
    + relayIds.map(id => `ל${schedulerRelayNames[id]} הקש ${id}`).join('. ') + '.';
  const tts001 = 'לבחירת הדלקה הקש 1. לבחירת כיבוי הקש 2.';
  const tts002 = 'כעת הקישו את מספר הדקות לפעולה, או הקישו 0 לפעולה קבועה בלי הגבלת זמן.';
  const extIni = [
    'type=api',
    `api_link=${YEMOT_API_LINK_URL}`,
    'api_hangup_send=No',
    `api_000=Relay,,2,1,7,No,yes,yes,,${relayKeys},3,`,
    'api_001=Action,,1,1,5,No,yes,yes,,1.2,3,',
    'api_002=Duration,,3,1,7,No,yes,no,,,3,',
    'api_end_goto=/',
    '',
  ].join('\n');
  return { tts000, tts001, tts002, extIni };
}

// ── SCHEDULER STATE ──────────────────────────────────────
let schedulerPrograms = [];
let schedulerActiveModeId = 0;
let scheduledModes = []; // תזמוני החלפת מצב
let _previousModeId = null; // המצב לפני מעבר עם duration (לחזרה אוטומטית)
let _activeScheduledModeTimer = null; // טיימר חזרה פעיל
const _firedToday = new Set();
const _actuallyFired = new Set();
const _firedRunOnceToday = new Map();
const _pendingPublish = {};

const _calendarIndex = {};
for (const entry of HOLIDAY_CALENDAR) {
  _calendarIndex[entry['תאריך לועזי']] = entry;
}

let mqttClient = null;
let mqttConnected = false;
const controllerOnline = {};
CONTROLLERS.forEach(ctrl => { controllerOnline[ctrl.id] = false; });

function connectMQTT() {
  if (!CONTROLLERS.length) {
    console.log('⚠️ אין CONTROLLERS מוגדרים — MQTT לא מתחבר');
    return;
  }
  console.log(`מתחבר ל-MQTT: ${MQTT_URL}...`);
  const mqttOpts = { reconnectPeriod: 5000 };
  if (MQTT_USER) { mqttOpts.username = MQTT_USER; mqttOpts.password = MQTT_PASS; }
  mqttClient = mqtt.connect(MQTT_URL, mqttOpts);

  mqttClient.on('connect', () => {
    mqttConnected = true;
    console.log('✅ מחובר ל-MQTT');
    CONTROLLERS.forEach(ctrl => {
      for (let i = 1; i <= ctrl.relayCount; i++) {
        mqttClient.subscribe(`stat/${ctrl.topic}/POWER${i}`);
      }
      mqttClient.subscribe(`stat/${ctrl.topic}/RESULT`);
      mqttClient.subscribe(`stat/${ctrl.topic}/STATUS11`);
      mqttClient.subscribe(`tele/${ctrl.topic}/STATE`);
      mqttClient.subscribe(`tele/${ctrl.topic}/LWT`);
      mqttClient.publish(`cmnd/${ctrl.topic}/STATUS`, '11');
    });
    io.emit('mqtt_status', { connected: true });
  });

  mqttClient.on('message', (topic, message) => {
    const payload = message.toString();
    const ctrl = CONTROLLERS.find(c => topic.includes(c.topic));
    const ctrlName = ctrl ? ctrl.name : 'בקר';

    const matchPower = topic.match(/stat\/.+\/POWER(\d+)$/);
    if (matchPower && ctrl) {
      const localId = parseInt(matchPower[1]);
      const globalId = localId + (ctrl._offset || 0);
      relayState[globalId] = payload.toUpperCase();
      io.emit('relay_state', { id: globalId, state: payload.toUpperCase() });
      notifyRelayAck(globalId);
      if (_pendingConfirm[globalId]) { clearTimeout(_pendingConfirm[globalId]); delete _pendingConfirm[globalId]; }
      const relayName = schedulerRelayNames[globalId] || `ממסר ${globalId}`;
      const originLabel = _lastCommandOrigin[globalId];
      addServerLog({ type: 'success', msg: `✔ בקר אישר: ${relayName} → ${payload.toUpperCase()}${originLabel ? ` [${originLabel}]` : ''}`, user: ctrlName });
    }

    if (topic.endsWith('/LWT')) {
      const isOnline = payload === 'Online';
      if (ctrl) controllerOnline[ctrl.id] = isOnline;
      io.emit('controller_status', { online: isOnline, controller: ctrlName, controllerId: ctrl?.id });
      addServerLog({ type: isOnline ? 'success' : 'danger', msg: `${isOnline ? '🟢' : '🔴'} ${ctrlName} ${isOnline ? 'התחבר' : 'התנתק'}`, user: 'בקר' });
    }

    if (topic.endsWith('/RESULT')) {
      try {
        const d = JSON.parse(payload);
        if (ctrl) {
          for (let i = 1; i <= ctrl.relayCount; i++) {
            if (d[`POWER${i}`] !== undefined) {
              const globalId = i + (ctrl._offset || 0);
              relayState[globalId] = d[`POWER${i}`].toUpperCase();
              io.emit('relay_state', { id: globalId, state: relayState[globalId] });
            }
          }
        }
      } catch(e) {}
    }

    if (topic.endsWith('/STATUS11')) {
      try {
        const d = JSON.parse(payload);
        const sts = d.StatusSTS || d;
        if (ctrl) {
          for (let i = 1; i <= ctrl.relayCount; i++) {
            if (sts[`POWER${i}`] !== undefined) {
              const globalId = i + (ctrl._offset || 0);
              relayState[globalId] = sts[`POWER${i}`].toUpperCase();
              io.emit('relay_state', { id: globalId, state: relayState[globalId] });
            }
          }
        }
      } catch(e) {}
    }

    if (topic.endsWith('/STATE')) {
      try {
        const d = JSON.parse(payload);
        if (ctrl) {
          for (let i = 1; i <= ctrl.relayCount; i++) {
            if (d[`POWER${i}`] !== undefined) {
              const globalId = i + (ctrl._offset || 0);
              relayState[globalId] = d[`POWER${i}`].toUpperCase();
              io.emit('relay_state', { id: globalId, state: relayState[globalId] });
            }
          }
        }
      } catch(e) {}
    }
  });

  mqttClient.on('error', (e) => { mqttConnected = false; io.emit('mqtt_status', { connected: false }); });
  mqttClient.on('close', () => { mqttConnected = false; io.emit('mqtt_status', { connected: false }); });
}

const _lastCommandOrigin = {};

async function publishRelay(relayId, state, originLabel = null) {
  const { type, ctrl, localId, dev } = getControllerForRelay(relayId);
  const relayName = schedulerRelayNames[relayId] || `ממסר ${relayId}`;
  _lastCommandOrigin[relayId] = originLabel;

  if (type === 'ha') {
    // שליחה דרך HA REST API
    if (!dev) throw new Error(`לא נמצא התקן HA ל-relay ${relayId}`);
    const service = state === 'ON' ? 'turn_on' : 'turn_off';
    await haCallService(dev.domain || 'switch', service, dev.entity_id);
    relayState[relayId] = state;
    addServerLog({ type: 'sent', msg: `📤 שרת שלח HA: ${relayName} → ${state}${originLabel ? ` [${originLabel}]` : ''}`, user: 'שרת' });
    io.emit('relay_state', { id: relayId, state });
    // HA לא שולח MQTT — נאמת מיד (ה-API הסינכרוני עצמו הוא האישור)
    notifyRelayAck(relayId);
    return;
  }

  // Tasmota MQTT
  return new Promise((resolve, reject) => {
    if (!mqttConnected) {
      addServerLog({ type: 'danger', msg: `❌ לא ניתן לשלוח לממסר ${relayId} — MQTT מנותק`, user: 'שרת' });
      reject(new Error('לא מחובר')); return;
    }
    const topic = `cmnd/${ctrl.topic}/POWER${localId}`;
    mqttClient.publish(topic, state, { qos: 1 }, (err) => {
      if (err) { reject(err); return; }
      relayState[relayId] = state;
      addServerLog({ type: 'sent', msg: `📤 שרת שלח: ${relayName} → ${state}${originLabel ? ` [${originLabel}]` : ''}`, user: 'שרת' });
      const confirmTimer = setTimeout(() => {
        addServerLog({ type: 'warning', msg: `⚠️ לא התקבל אישור מהבקר: ${relayName} (${state})`, user: 'בקר' });
      }, 5000);
      _pendingConfirm[relayId] = confirmTimer;
      resolve();
    });
  });
}

// ── USERS ────────────────────────────────────────────────
const USERS = config.USERS || [];
const EMERGENCY_PASSWORD = config.EMERGENCY_PASSWORD || null;
function publicProfile(u) { const { password, ...pub } = u; return pub; }
let runtimeUsers = USERS.map(u => ({ ...u }));
let serverConfig = null;

// ── SERVER LOG ───────────────────────────────────────────
const serverLog = [];
const MAX_LOG_DAYS = 30;
function pruneLog() {
  const cutoff = Date.now() - MAX_LOG_DAYS * 24 * 60 * 60 * 1000;
  while (serverLog.length && new Date(serverLog[serverLog.length-1].ts).getTime() < cutoff) serverLog.pop();
}
// ── LOGGER ───────────────────────────────────────────────
const _origLog = console.log;
const _origError = console.error;
const _origWarn = console.warn;
function _ts() {
  return new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
console.log = (...a) => _origLog(`[${_ts()}]`, ...a);
console.error = (...a) => _origError(`[${_ts()}] ❌`, ...a);
console.warn = (...a) => _origWarn(`[${_ts()}] ⚠️`, ...a);

function addServerLog(entry) {
  const now = new Date();
  const nowIL = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const logEntry = { ...entry, ts: now.toISOString(),
    time: nowIL.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    date: nowIL.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' }),
  };
  serverLog.unshift(logEntry);
  pruneLog();
  io.emit('log_broadcast', serverLog[0]);
  // שיקוף ליומן ה-Add-on לאירועים חשובים
  if (['sent','warning','danger','info'].includes(entry.type)) {
    _origLog(`[${logEntry.time}] ${entry.type.toUpperCase()}: ${entry.msg}`);
  }
}

// ── SOCKET.IO ────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('🖥️ ממשק התחבר');
  socket.emit('mqtt_status', { connected: mqttConnected });
  socket.emit('all_states', relayState);
  CONTROLLERS.forEach(ctrl => {
    socket.emit('controller_status', { online: controllerOnline[ctrl.id] || false, controller: ctrl.name, controllerId: ctrl.id });
  });
  if (serverConfig) socket.emit('server_config', serverConfig);
  if (serverLog.length) socket.emit('server_log', serverLog);
  socket.emit('ivr_today_events', ivrTodayEvents);
  // שלח רשימת התקני HA
  socket.emit('ha_devices', haDevices);
  socket.emit('ha_settings', { haUrl, hasToken: !!haToken });
  socket.emit('scheduled_modes', scheduledModes);

  // ── Login ──
  socket.on('login', ({ name, password }) => {
    if (EMERGENCY_PASSWORD && password === EMERGENCY_PASSWORD) {
      const adminUser = runtimeUsers.find(u => u.role === 'admin') || runtimeUsers[0];
      socket.emit('login_result', { success: true, user: publicProfile(adminUser) });
      socket.emit('server_log', serverLog);
      return;
    }
    const user = runtimeUsers.find(u => u.name === name);
    if (!user) { socket.emit('login_result', { success: false }); return; }
    const isHash = user.password?.startsWith('$2b$') || user.password?.startsWith('$2a$');
    const valid = isHash ? bcrypt.compareSync(password, user.password) : password === user.password;
    if (valid) {
      if (!isHash) { user.password = bcrypt.hashSync(password, 10); saveConfigLocal(); }
      addServerLog({ type: 'info', msg: `כניסה למערכת: ${user.name}`, user: user.name });
      socket.emit('login_result', { success: true, user: publicProfile(user) });
      socket.emit('server_log', serverLog);
    } else {
      socket.emit('login_result', { success: false });
    }
  });

  socket.on('get_users', () => { socket.emit('users_list', runtimeUsers.map(u => publicProfile(u))); });

  socket.on('relay_command', async ({ id, state }) => {
    try {
      if (id === 'all') {
        const allIds = [...Object.keys(schedulerRelayNames).map(Number)];
        for (const i of allIds) await publishRelay(i, state);
      } else {
        await publishRelay(parseInt(id), state);
      }
    } catch(err) { console.error('❌', err.message); }
  });

  // ── HA התקנים ──
  // שמירת הגדרות HA (token + URL)
  socket.on('save_ha_settings', async ({ token, url }) => {
    if (token !== undefined) haToken = token;
    if (url) haUrl = url;
    saveConfigLocal();
    socket.emit('ha_settings', { haUrl, hasToken: !!haToken });
    socket.emit('ha_save_status', { ok: true, msg: 'הגדרות HA נשמרו ✅' });
    console.log('💾 הגדרות HA נשמרו');
  });

  // רענון רשימת התקנים מ-HA
  socket.on('fetch_ha_devices', async () => {
    try {
      socket.emit('ha_fetch_status', { stage: 'fetching', msg: 'מושך התקנים מ-Home Assistant...' });
      const states = await haFetchAllStates();
      socket.emit('ha_fetch_status', { stage: 'done', msg: `נמצאו ${states.length} התקנים ✅` });
      socket.emit('ha_available_devices', states);
    } catch(e) {
      socket.emit('ha_fetch_status', { stage: 'error', msg: 'שגיאה: ' + e.message });
    }
  });

  // הוספת/עדכון התקני HA שנבחרו
  socket.on('save_ha_devices', (selectedDevices) => {
    const tasmotaMax = CONTROLLERS.reduce((s, c) => s + c.relayCount, 0);

    // בנה מפה של entity_id → relayId קיים (סנן null/NaN)
    const existingRelayIds = {};
    haDevices.forEach(d => {
      if (d.entity_id && d.relayId && !isNaN(d.relayId)) {
        existingRelayIds[d.entity_id] = d.relayId;
      }
    });

    // פונקציה למציאת relayId חופשי — בטוחה מפני NaN ולולאה אינסופית
    function findNextRelayId() {
      const usedIds = new Set([
        ...Object.values(existingRelayIds).filter(id => id && !isNaN(id)),
        ...haDevices.filter(d => d.relayId && !isNaN(d.relayId)).map(d => d.relayId)
      ]);
      let nextId = Math.max(tasmotaMax, 14) + 1; // לפחות 15
      while (usedIds.has(nextId)) nextId++;
      return nextId;
    }

    // עדכן רשימה — שמור relayId קיים או הקצה חדש
    haDevices = selectedDevices.map(dev => {
      if (existingRelayIds[dev.entity_id]) {
        return { ...dev, relayId: existingRelayIds[dev.entity_id] };
      } else {
        const nextId = findNextRelayId();
        existingRelayIds[dev.entity_id] = nextId; // עדכן למניעת כפילות
        console.log(`🔧 הוקצה relayId ${nextId} ל-${dev.entity_id}`);
        return { ...dev, relayId: nextId };
      }
    });

    rebuildHaRelayNames();
    saveConfigLocal();
    io.emit('ha_devices', haDevices);
    io.emit('relay_names_update', Object.entries(schedulerRelayNames).map(([id, name]) => ({ id: Number(id), name })));
    socket.emit('ha_save_status', { ok: true, msg: `${haDevices.length} התקנים נשמרו ✅` });
    console.log(`🏠 נשמרו ${haDevices.length} התקני HA: ${haDevices.map(d => `${d.entity_id}→${d.relayId}`).join(', ')}`);
    console.log(`🏠 נשמרו ${haDevices.length} התקני HA`);
  });

  // עדכון מצב חי של התקני HA
  socket.on('refresh_ha_states', async () => {
    try {
      for (const dev of haDevices) {
        if (!dev.relayId) continue;
        try {
          const st = await haGetState(dev.entity_id);
          const newState = st.state === 'on' ? 'ON' : 'OFF';
          relayState[dev.relayId] = newState;
          io.emit('relay_state', { id: dev.relayId, state: newState });
        } catch(e) { /* התקן לא זמין */ }
      }
    } catch(e) { console.error('שגיאה בעדכון מצב HA:', e.message); }
  });

  // ── Sync Programs ──
  socket.on('sync_programs', ({ programs, activeModeId, relayNames, modes, fullConfig }) => {
    const newIds = new Set((programs || []).map(p => String(p.id)));
    Array.from(_firedToday).forEach(k => { const progId = k.split('_')[0]; if (!newIds.has(progId)) _firedToday.delete(k); });
    schedulerPrograms = programs || [];
    schedulerActiveModeId = activeModeId || 0;
    if (relayNames) relayNames.forEach(r => { schedulerRelayNames[r.id] = r.name; });
    if (fullConfig) serverConfig = fullConfig;
    socket.emit('sync_ack', { count: schedulerPrograms.length, firedRunOnceToday: Array.from(_firedRunOnceToday.values()) });
    saveConfigLocal();
  });

  // ── Mode Switch ──
  function computeModeSwitchImpact(newModeId) {
    const nowIL = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const nowSec = getNowSecIL();
    const todayKey = nowIL.toDateString();
    const staleRelays = [];
    for (const relayIdStr of Object.keys(relayOwner)) {
      const relayId = parseInt(relayIdStr, 10);
      const owner = relayOwner[relayId];
      const p = schedulerPrograms.find(x => String(x.id) === String(owner.progId));
      const modeIds = p ? (p.modeIds ?? (p.modeId !== null ? [p.modeId] : [0])) : [];
      if (!modeIds.includes(newModeId)) staleRelays.push({ relayId, relayName: schedulerRelayNames[relayId] || `ממסר ${relayId}`, ownerProgName: owner.name });
    }
    const savedMode = schedulerActiveModeId;
    schedulerActiveModeId = newModeId;
    const dow = nowIL.getDay();
    const zmanim = getZmanim(nowIL);
    let newModeEvents = [];
    try { newModeEvents = computeTodayEvents(nowIL, zmanim, dow, todayKey); }
    finally { schedulerActiveModeId = savedMode; }

    // מפה של טווחי-בעלות של תוכניות עדיפות לכל ממסר — כדי לזהות "כיבוי-רפאים": כיבוי מתוזמן
    // מתוכנית לא-עדיפות שבפועל היה נחסם ע"י תוכנית עדיפות אחרת שעדיין מחזיקה את הממסר (בדיוק
    // כמו checkRelayOwnerBlock בזמן אמת) — כיבוי כזה אסור לספור כ"הממסר באמת כבה".
    const priorityIntervalsByRelayA = {};
    for (const ev of newModeEvents) {
      if (ev.action !== 'ON' || ev.isEndEvent || !ev.isPriority) continue;
      (priorityIntervalsByRelayA[ev.relayId] ||= []).push({ progId: ev.progId, start: ev.fireSec, end: ev.endSec });
    }
    const isBlockedByPriorityA = ev => {
      const arr = priorityIntervalsByRelayA[ev.relayId];
      return !!arr && arr.some(iv => iv.progId !== ev.progId && iv.start <= ev.fireSec && (iv.end === null || iv.end > ev.fireSec));
    };

    const lastOffFiredByRelay = {};
    for (const ev of newModeEvents) {
      if (ev.action !== 'OFF' || ev.fireSec > nowSec) continue;
      if (!ev.isPriority && isBlockedByPriorityA(ev)) continue;
      const cur = lastOffFiredByRelay[ev.relayId];
      if (!cur || ev.fireSec > cur.fireSec) lastOffFiredByRelay[ev.relayId] = ev;
    }

    const missedCandidatesByRelay = {};
    for (const ev of newModeEvents) {
      if (ev.action !== 'ON' || ev.isEndEvent) continue;
      if (ev.fireSec > nowSec) continue;
      if (nowSec - ev.fireSec <= 8) continue;
      if (ev.endSec !== null && ev.endSec <= nowSec) continue;
      const lastOff = lastOffFiredByRelay[ev.relayId];
      if (lastOff && lastOff.fireSec > ev.fireSec) continue;
      // סנן runOnce שכבר ירה היום
      if (ev.runOnce && _firedRunOnceToday.has(ev.progId)) continue;
      const cur = missedCandidatesByRelay[ev.relayId];
      if (!cur) { missedCandidatesByRelay[ev.relayId] = ev; continue; }
      const curWins = (cur.isPriority && !ev.isPriority) ? true : (!cur.isPriority && ev.isPriority) ? false : (cur.endSec === null) ? true : (ev.endSec === null) ? false : (cur.endSec >= ev.endSec);
      if (!curWins) missedCandidatesByRelay[ev.relayId] = ev;
    }

    // הרחב — כל הממסרים של כל תוכנית שפספסה
    const missedProgIds = new Set(Object.values(missedCandidatesByRelay).map(ev => ev.progId));
    const missedPrograms = [];
    for (const ev of newModeEvents) {
      if (ev.action !== 'ON' || ev.isEndEvent) continue;
      if (!missedProgIds.has(ev.progId)) continue;
      if (ev.fireSec > nowSec) continue;
      if (ev.endSec !== null && ev.endSec <= nowSec) continue;
      const lastOff = lastOffFiredByRelay[ev.relayId];
      if (lastOff && lastOff.fireSec > ev.fireSec) continue;
      if (missedCandidatesByRelay[ev.relayId]?.progId !== ev.progId) continue;
      missedPrograms.push({
        relayId: ev.relayId, relayName: schedulerRelayNames[ev.relayId] || `ממסר ${ev.relayId}`,
        progId: ev.progId, progName: ev.name, isPriority: !!ev.isPriority, endSec: ev.endSec,
        fireSec: ev.fireSec, segType: ev.segType, cycleIdx: ev.cycleIdx, runOnce: !!ev.runOnce,
      });
    }
    return { staleRelays, missedPrograms };
  }

  socket.on('request_mode_switch', ({ newModeId }) => {
    socket.emit('mode_switch_review', { newModeId, ...computeModeSwitchImpact(newModeId) });
  });

  socket.on('confirm_mode_switch', ({ newModeId, turnOffRelayIds, activateProgIds }) => {
    schedulerActiveModeId = newModeId;
    saveConfigLocal();
    (turnOffRelayIds || []).forEach(relayId => {
      publishRelay(relayId, 'OFF').then(() => {
        if (relayOwner[relayId]) delete relayOwner[relayId];
        io.emit('scheduler_fired', { progName: 'כיבוי — מעבר מצב ידני', relayId, action: 'OFF' });
      }).catch(() => {});
    });
    if ((activateProgIds || []).length) {
      const impact = computeModeSwitchImpact(newModeId);
      activateProgIds.forEach(progId => {
        // filter — תוכנית יכולה לכלול מספר ממסרים
        const matches = impact.missedPrograms.filter(m => String(m.progId) === String(progId));
        const _catchupTodayKey = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' })).toDateString();
        matches.forEach(match => {
          publishRelay(match.relayId, 'ON').then(() => {
            relayOwner[match.relayId] = { progId: match.progId, name: match.progName, priority: match.isPriority, endSec: match.endSec };
            io.emit('scheduler_fired', { progName: match.progName, relayId: match.relayId, action: 'ON' });
            // אותו תיקון כמו במעבר האוטומטי — למנוע דילוג שקט על הכיבוי-לפי-משך העתידי
            if (match.fireSec !== undefined) _actuallyFired.add(`${match.progId}_${match.relayId}_${match.segType}_${match.cycleIdx??'x'}_${match.fireSec}_start_${_catchupTodayKey}`);
            // תוכנית runOnce שהופעלה כהשלמה — יש לכבות את הדגל בדיוק כמו בירייה רגילה, אחרת היא עלולה לירות שוב במחזור עתידי
            if (match.runOnce) {
              const p = schedulerPrograms.find(x => x.id === match.progId);
              if (p && p.active) {
                p.active = false;
                _firedRunOnceToday.set(p.id, { ...p, _todayKey: _catchupTodayKey });
                io.emit('program_updated', { id: p.id, active: false });
                saveConfigLocal();
              }
            }
          }).catch(() => {});
        });
      });
    }
  });

  // ── Users ──
  socket.on('save_users', (users) => {
    runtimeUsers = users.map(u => {
      const existing = runtimeUsers.find(r => r.name === u.name);
      if (!u.password) return { ...u, password: existing?.password || '' };
      const isHash = u.password.startsWith('$2b$') || u.password.startsWith('$2a$');
      if (isHash) return u;
      return { ...u, password: bcrypt.hashSync(u.password, 10) };
    });
    io.emit('users_list', runtimeUsers.map(u => publicProfile(u)));
    saveConfigLocal();
  });

  // ── IVR Users ──
  socket.on('get_ivr_users', () => { socket.emit('ivr_users_list', buildIvrUsersList()); });

  socket.on('save_ivr_users', async (users) => {
    try {
      const newPhoneMap = {};
      const newPermissions = {};
      (users || []).forEach(u => {
        if (!u.phone || !u.id) return;
        newPhoneMap[u.phone] = u.id;
        newPermissions[u.id] = {
          name: u.name, isAdmin: !!u.isAdmin,
          allowedRelays: u.isAdmin ? [] : (u.allowedRelays || []),
          allowedActions: u.isAdmin ? ['ON','OFF'] : (u.allowedActions || []),
          maxDurationMinOn: u.isAdmin ? 0 : (u.maxDurationMinOn ?? 0),
          maxDurationMinOff: u.isAdmin ? 0 : (u.maxDurationMinOff ?? 0),
        };
      });
      yemotPhoneMap = newPhoneMap;
      yemotPermissions = newPermissions;
      saveConfigLocal();
      io.emit('ivr_users_list', buildIvrUsersList());
      socket.emit('ivr_save_status', { stage: 'done', msg: 'נשמר בהצלחה ✅' });
    } catch(e) {
      socket.emit('ivr_save_status', { stage: 'error', msg: 'שגיאה: ' + e.message });
    }
  });

  // ── Yemot Files ──
  socket.on('get_yemot_file', async ({ ext, filename } = {}) => {
    try {
      const content = await yemotDownloadFile(`ivr/${ext}/${filename}`);
      socket.emit('yemot_file_content', { ok: true, content });
    } catch(e) { socket.emit('yemot_file_content', { ok: false, error: e.message }); }
  });

  socket.on('save_yemot_file', async ({ ext, filename, content } = {}) => {
    try {
      await yemotUploadFile(`ivr/${ext}/${filename}`, content || '', filename);
      socket.emit('yemot_save_status', { stage: 'done', msg: 'נשמר בהצלחה ✅' });
    } catch(e) { socket.emit('yemot_save_status', { stage: 'error', msg: 'שגיאה: ' + e.message }); }
  });

  socket.on('get_yemot_autoupdate_preview', () => {
    try { socket.emit('yemot_autoupdate_preview', { ok: true, ...buildYemotAutoFiles() }); }
    catch(e) { socket.emit('yemot_autoupdate_preview', { ok: false, error: e.message }); }
  });

  socket.on('run_yemot_autoupdate', async ({ ext } = {}) => {
    try {
      const { tts000, tts001, tts002, extIni } = buildYemotAutoFiles();
      await yemotUploadFile(`ivr/${ext}/000.tts`, tts000, '000.tts');
      await yemotUploadFile(`ivr/${ext}/001.tts`, tts001, '001.tts');
      await yemotUploadFile(`ivr/${ext}/002.tts`, tts002, '002.tts');
      await yemotUploadFile(`ivr/${ext}/ext.ini`, extIni, 'ext.ini');
      socket.emit('yemot_autoupdate_status', { stage: 'done', msg: 'עודכן בהצלחה ✅' });
    } catch(e) { socket.emit('yemot_autoupdate_status', { stage: 'error', msg: 'שגיאה: ' + e.message }); }
  });

  socket.on('sync_yemot_whitelist', async () => {
    try {
      const templateId = await yemotGetWhitelistTemplateId();
      const entries = await yemotGetTemplateEntries(templateId);
      const existingPhones = new Set(entries.map(e => normalizePhoneDigits(e.phone)));
      const blockedPhones = new Set(entries.filter(e => e.blocked).map(e => normalizePhoneDigits(e.phone)));
      let added = 0, alreadyThere = 0;
      const blockedList = [], failedList = [];
      for (const phone of Object.keys(yemotPhoneMap)) {
        const norm = normalizePhoneDigits(phone);
        if (blockedPhones.has(norm)) { blockedList.push(phone); continue; }
        if (existingPhones.has(norm)) { alreadyThere++; continue; }
        try { await yemotAddPhoneToWhitelist(templateId, phone); added++; }
        catch(e) { failedList.push(phone); }
      }
      let msg = `${added} נוספו, ${alreadyThere} כבר ברשימה`;
      if (blockedList.length) msg += `, ⚠️ ${blockedList.length} חסומים`;
      socket.emit('yemot_whitelist_status', { stage: 'done', msg });
    } catch(e) { socket.emit('yemot_whitelist_status', { stage: 'error', msg: 'שגיאה: ' + e.message }); }
  });

  socket.on('log_entry', (entry) => { addServerLog(entry); });

  // ── תזמוני מצב ──
  socket.on('get_scheduled_modes', () => {
    socket.emit('scheduled_modes', scheduledModes);
  });

  socket.on('save_scheduled_modes', (modes) => {
    scheduledModes = modes || [];
    saveConfigLocal();
    io.emit('scheduled_modes', scheduledModes);
    socket.emit('scheduled_modes_saved', { ok: true, count: scheduledModes.length });
    addServerLog({ type: 'info', msg: `🕐 נשמרו ${scheduledModes.length} תזמוני מצב`, user: 'מערכת' });
  });

  socket.on('disconnect', () => { console.log('🖥️ ממשק התנתק'); });
});

// ── SCHEDULER ENGINE (זהה לגרסה המקורית) ───────────────
function getZmanim(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  const entry = _calendarIndex[`${dd}/${mm}/${yyyy}`];
  if (!entry) return {};
  return {
    sunrise: entry['נץ החמה'], sunset: entry['שקיעה'], candles: entry['שקיעה'],
    havdalah: entry['מוצאי שבת'], tzeit: entry['צאת הכוכבים'],
    alotHaShachar: entry['עלות השחר'], minchaGedola: entry['מנחה גדולה'], rabeinuTam: entry['רבינו תם'],
  };
}
function zmanimKeyForZman(zman) {
  return { sunset:'sunset',sunrise:'sunrise',candles:'candles',havdalah:'havdalah',tzeit:'tzeit',dawn:'alotHaShachar',mincha:'minchaGedola',rabeinuTam:'rabeinuTam' }[zman] || zman;
}
function timeStrToMinutes(t) { if (!t) return null; const [h,m]=t.split(':').map(Number); return h*60+m; }
function getProgMinutes(p, zmanim) {
  if (p.type === 'time') { const [h,m]=p.time.split(':').map(Number); return h*60+m; }
  const base = timeStrToMinutes(zmanim[zmanimKeyForZman(p.zman)]);
  if (base === null) return -1;
  return base + (p.offsetDir==='-'?-1:1)*(p.offsetVal||0);
}
function getRelayFireMin(p, baseMin, relayId) {
  const ri=(p.relay||[]).indexOf(relayId); const idx=ri<0?0:ri;
  return baseMin + idx*(p.delay||0)/60;
}
function getRelayEndMin(p, fireMin) {
  if (!p.durationOn || (!(p.durationH||p.durationM))) return null;
  return fireMin + (p.durationH||0)*60 + (p.durationM||0);
}
function getRelayEventPairs(p, baseMin, relayId) {
  const start=getRelayFireMin(p,baseMin,relayId);
  const totalEnd=getRelayEndMin(p,start);
  if (totalEnd===null) return [{fireMin:start,endMin:null,action:p.action,segType:'single'}];
  if (!p.cycleOn||!p.cycleOnMin||!p.cycleOffMin) return [{fireMin:start,endMin:totalEnd,action:p.action,segType:'single'}];
  const onMin=p.cycleOnMin,offMin=p.cycleOffMin,cycleLen=onMin+offMin;
  const totalMin=totalEnd-start,fullCycles=Math.floor(totalMin/cycleLen);
  const pairs=[];
  for(let i=0;i<fullCycles;i++){const s=start+i*cycleLen;pairs.push({fireMin:s,endMin:s+onMin,action:p.action,segType:'on',cycleIdx:i});pairs.push({fireMin:s+onMin,endMin:s+cycleLen,action:p.action==='ON'?'OFF':'ON',segType:'off',cycleIdx:i});}
  if(!pairs.length) return [{fireMin:start,endMin:totalEnd,action:p.action,segType:'single'}];
  return pairs;
}
const CHILD_BUFFER_MIN=0.5;
function getChildEventPairs(child,parent,parentBaseMin){
  if(!parent) return [];
  const parentRelay=(parent.relay||[])[0];
  const offSegs=getRelayEventPairs(parent,parentBaseMin,parentRelay).filter(s=>s.segType==='off');
  if(!offSegs.length) return [];
  const offsetMin=child.childOffsetMin??child.offsetMin??0;
  const timing=child.childTiming??child.timing??'before';
  const confine=child.childConfine??child.confine??false;
  return offSegs.map((seg,idx)=>{
    const breakStart=seg.fireMin,breakEnd=seg.endMin;
    const fireMin=timing==='before'?(breakStart-offsetMin):(breakStart+offsetMin);
    let endMin=null;
    if(confine&&breakEnd!==null) endMin=Math.max(fireMin,breakEnd-CHILD_BUFFER_MIN);
    return {fireMin,endMin,action:child.action,segType:'child',cycleIdx:idx,breakStart,breakEnd};
  });
}

function computeTodayEvents(nowIL,zmanim,dow,todayKey){
  const events=[];
  const progsById={};
  schedulerPrograms.forEach(p=>progsById[p.id]=p);
  for(const p of schedulerPrograms){
    const runOnceStillOwedToday=p.runOnce&&_firedRunOnceToday.has(p.id)&&_firedRunOnceToday.get(p.id)._todayKey===todayKey;
    if(!p.active&&!runOnceStillOwedToday) continue;
    if(p.parentProgId) continue;
    const modeIds=p.modeIds??(p.modeId!==null&&p.modeId!==undefined?[p.modeId]:[0]);
    if(!modeIds.includes(schedulerActiveModeId)) continue;
    if(p.days?.length&&!p.days.includes(dow)) continue;
    if(p.calType&&p.calType!=='none'){
      const dd=nowIL.getDate(),mm=nowIL.getMonth()+1,yyyy=nowIL.getFullYear();
      if(p.calType==='annual'){if(dd!==p.calDay||mm!==p.calMonth)continue;}
      else if(p.calType==='once'){if(dd!==p.calDay||mm!==p.calMonth||yyyy!==p.calYear)continue;}
    }
    const baseMin=getProgMinutes(p,zmanim);
    if(baseMin<0) continue;
    (p.relay||[]).forEach(relayId=>{
      const pairs=getRelayEventPairs(p,baseMin,relayId);
      pairs.forEach((seg,idx)=>{
        events.push({progId:p.id,name:p.name,relayId,fireSec:Math.round(seg.fireMin*60),endSec:seg.endMin!==null?Math.round(seg.endMin*60):null,action:seg.action,segType:seg.segType,cycleIdx:seg.cycleIdx,isLastSeg:idx===pairs.length-1,runOnce:p.runOnce,isPriority:!!p.priority});
        if(seg.endMin!==null&&seg.segType==='single'){
          events.push({progId:p.id,name:p.name,relayId,fireSec:Math.round(seg.endMin*60),endSec:null,action:seg.action==='ON'?'OFF':'ON',segType:seg.segType,cycleIdx:seg.cycleIdx,isLastSeg:idx===pairs.length-1,runOnce:false,isPriority:!!p.priority,isEndEvent:true,runOnceCleanup:!!p.runOnce,startFireSec:Math.round(seg.fireMin*60)});
        }
      });
      if(p.childProgId){
        const child=progsById[p.childProgId];
        if(child&&child.active){
          const childPairs=getChildEventPairs(child,p,baseMin);
          childPairs.forEach(seg=>{
            events.push({progId:child.id,name:child.name,relayId:(child.relay||[])[0],fireSec:Math.round(seg.fireMin*60),endSec:seg.endMin!==null?Math.round(seg.endMin*60):null,action:seg.action,segType:'child',cycleIdx:seg.cycleIdx,requireAck:!!(child.childRequireAck??child.requireAck),ackRelayId:relayId,ackExpected:seg.action==='ON'?'OFF':'ON',isPriority:!!child.priority});
            if(seg.endMin!==null){events.push({progId:child.id,name:child.name,relayId:(child.relay||[])[0],fireSec:Math.round(seg.endMin*60),endSec:null,action:seg.action==='ON'?'OFF':'ON',segType:'child',cycleIdx:seg.cycleIdx,isEndEvent:true,runOnce:false,isPriority:!!child.priority,startFireSec:Math.round(seg.fireMin*60)});}
          });
        }
      }
    });
  }
  return events;
}

function getNowSecIL(){const n=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Jerusalem'}));return n.getHours()*3600+n.getMinutes()*60+n.getSeconds();}

function checkAckAndFireChild(event,todayKey){
  const expected=event.ackExpected;
  const pending=_pendingPublish[event.ackRelayId];
  if(pending){
    pending
      .then(()=>checkAckAndFireChildNow(event,todayKey,expected))
      .catch(()=>checkAckAndFireChildNow(event,todayKey,expected));
  } else {
    checkAckAndFireChildNow(event,todayKey,expected);
  }
}

function checkAckAndFireChildNow(event,todayKey,expected){
  const actual=relayState[event.ackRelayId];
  if(actual===expected){fireEvent(event,todayKey);return;}
  setTimeout(()=>{
    if(event.endSec!==null&&getNowSecIL()>event.endSec) return;
    if(relayState[event.ackRelayId]===expected) fireEvent(event,todayKey);
  },60000);
}

function checkRelayOwnerBlock(event,nowSec){
  const owner=relayOwner[event.relayId];
  if(!owner) return false;
  if(owner.progId===event.progId) return false;
  if(owner.endSec!==null&&owner.endSec<=nowSec){delete relayOwner[event.relayId];return false;}
  if(event.isPriority) return false;
  if(owner.priority){if(owner.endSec===null)return false;return{blockedBy:owner.name};}
  if(owner.endSec===null) return false;
  if(owner.endSec>event.fireSec) return{blockedBy:owner.name};
  return false;
}

function fireEvent(event,todayKey){
  const{relayId,action,name}=event;
  if(!event.isEndEvent) _actuallyFired.add(`${event.progId}_${relayId}_${event.segType}_${event.cycleIdx??'x'}_${event.fireSec}_start_${todayKey}`);
  const pub = publishRelay(relayId,action).then(()=>{
    io.emit('scheduler_fired',{progName:name,relayId,action});
    if(action==='ON'){
      const existing=relayOwner[relayId];
      const candidate={progId:event.progId,name,priority:!!event.isPriority,endSec:event.endSec};
      const existingExpired=existing&&existing.endSec!==null&&existing.endSec<=getNowSecIL();
      const existingIsStronger=existing&&!existingExpired&&existing.progId!==candidate.progId&&existing.endSec!==null&&((existing.priority&&!candidate.priority)||(!existing.priority&&!candidate.priority&&candidate.endSec!==null&&existing.endSec>candidate.endSec));
      if(!existingIsStronger) relayOwner[relayId]=candidate;
    } else if(relayOwner[relayId]){delete relayOwner[relayId];} // כל כיבוי שמגיע לכאן כבר עבר את checkRelayOwnerBlock (או שזו תוכנית הכיבוי של עצמה) — הממסר כבוי בפועל, אז אין יותר "בעלים", ללא קשר לאיזו תוכנית ביצעה את הכיבוי
    if(event.isEndEvent) addServerLog({type:'info',msg:`[למשך] "${name}" — ממסר ${relayId} → ${action}`,user:'מערכת'});
    else addServerLog({type:'info',msg:`[תזמון] "${name}" — ממסר ${relayId} → ${action}`,user:'מערכת'});
  }).catch(err=>console.error(`❌ שגיאה ממסר ${relayId}:`,err.message));
  _pendingPublish[relayId] = pub;
  return pub;
}

async function schedulerTick(){
  if(!schedulerPrograms.length) return;
  const now=new Date();
  const nowIL=new Date(now.toLocaleString('en-US',{timeZone:'Asia/Jerusalem'}));
  const nowSec=nowIL.getHours()*3600+nowIL.getMinutes()*60+nowIL.getSeconds();
  const todayKey=nowIL.toDateString();
  const dow=nowIL.getDay();
  _firedToday.forEach(k=>{if(!k.endsWith(todayKey))_firedToday.delete(k);});
  if(nowSec>=7200)_actuallyFired.forEach(k=>{if(!k.endsWith(todayKey))_actuallyFired.delete(k);});
  if(_firedRunOnceToday.size>0)_firedRunOnceToday.forEach((p,id)=>{if(p._todayKey!==todayKey)_firedRunOnceToday.delete(id);});
  const zmanim=getZmanim(nowIL);
  const events=computeTodayEvents(nowIL,zmanim,dow,todayKey);
  const WINDOW_SEC=8;
  for(const event of events){
    if(event.fireSec<0||event.fireSec>=86400) continue;
    if(event.fireSec>nowSec||event.fireSec<nowSec-WINDOW_SEC) continue;
    const fireKey=`${event.progId}_${event.relayId}_${event.segType}_${event.cycleIdx??'x'}_${event.fireSec}_${event.isEndEvent?'end':'start'}_${todayKey}`;
    if(_firedToday.has(fireKey)) continue;
    if(event.isEndEvent&&event.startFireSec!==undefined){
      const startKey=`${event.progId}_${event.relayId}_${event.segType}_${event.cycleIdx??'x'}_${event.startFireSec}_start_${todayKey}`;
      if(!_actuallyFired.has(startKey)) continue;
    }
    if(event.action==='OFF'){
      const heldByOther=checkRelayOwnerBlock(event,nowSec);
      if(heldByOther){_firedToday.add(fireKey);addServerLog({type:'info',msg:`[תזמון] "${event.name}" — כיבוי בוטל, ממסר ${event.relayId} בשליטת "${heldByOther.blockedBy}"`,user:'מערכת'});continue;}
    }
    _firedToday.add(fireKey);
    if(event.runOnce&&(event.segType==='single'||event.segType==='on')){
      const p=schedulerPrograms.find(x=>x.id===event.progId);
      if(p&&p.active){p.active=false;_firedRunOnceToday.set(p.id,{...p,_todayKey:todayKey});io.emit('program_updated',{id:p.id,active:false});saveConfigLocal();}
    }
    if(event.isEndEvent){fireEvent(event,todayKey);if(event.runOnceCleanup)_firedRunOnceToday.delete(event.progId);continue;}
    if(event.segType==='child'&&event.requireAck) checkAckAndFireChild(event,todayKey);
    else fireEvent(event,todayKey);
  }
  // אירועי סיום שחצו חצות
  if(nowSec<7200){
    const yIL=new Date(nowIL);yIL.setDate(yIL.getDate()-1);
    const yKey=yIL.toDateString(),yDow=yIL.getDay(),yZman=getZmanim(yIL);
    const yEvts=computeTodayEvents(yIL,yZman,yDow,yKey);
    for(const event of yEvts){
      if(!event.isEndEvent||event.fireSec<=86400) continue;
      const adj=event.fireSec-86400;
      if(adj>nowSec||adj<nowSec-WINDOW_SEC) continue;
      const fireKey=`${event.progId}_${event.relayId}_${event.segType}_${event.cycleIdx??'x'}_${event.fireSec}_end_${yKey}`;
      if(_firedToday.has(fireKey)) continue;
      _firedToday.add(fireKey);
      if(event.startFireSec!==undefined){
        const startKey=`${event.progId}_${event.relayId}_${event.segType}_${event.cycleIdx??'x'}_${event.startFireSec}_start_${yKey}`;
        if(!_actuallyFired.has(startKey)) continue;
      }
      fireEvent(event,yKey);
      if(event.runOnceCleanup) _firedRunOnceToday.delete(event.progId);
    }
  }
}

async function processIvrPendingTimers(){
  const todayKeyIL=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Jerusalem'});
  if(ivrTodayEvents.some(e=>e.dateKey!==todayKeyIL)){ivrTodayEvents=ivrTodayEvents.filter(e=>e.dateKey===todayKeyIL);saveConfigLocal();}
  if(!ivrPendingTimers.length) return;
  const now=Date.now();
  const due=ivrPendingTimers.filter(t=>t.dueAt<=now);
  if(!due.length) return;
  ivrPendingTimers=ivrPendingTimers.filter(t=>t.dueAt>now);
  for(const t of due){
    try{await publishRelay(t.relayId,t.revertAction,`IVR — סיום משך, ID ${t.callerId}`);addServerLog({type:'info',msg:`📞 [IVR — סיום משך] ${t.label} → ${t.revertAction}`,user:'מערכת'});}
    catch(err){console.error('❌ שגיאה IVR timer:',err.message);}
  }
  saveConfigLocal();
}

// ── תזמוני מצב אוטומטיים ───────────────────────────────
const _firedScheduledModes = new Set(); // מונע ירי כפול באותו tick

function commitAutoModeSwitch(newModeId, label) {
  if (newModeId === schedulerActiveModeId) return;
  try {
    const impact = computeModeSwitchImpactGlobal(newModeId);
    schedulerActiveModeId = newModeId;
    saveConfigLocal();
    // כבה ממסרים ממצב קודם
    (impact.staleRelays || []).forEach(r => {
      publishRelay(r.relayId, 'OFF').then(() => {
        if (relayOwner[r.relayId]) delete relayOwner[r.relayId];
        // חובה לשדר scheduler_fired — זהו האירוע היחיד שגורם לדפדפן לעדכן את מצב הממסר בזמן אמת (ראה fireEvent). בלעדיו הממשק נשאר "תקוע" עד רענון ידני.
        io.emit('scheduler_fired', { progName: `כיבוי אוטומטי — יציאה ממצב (${r.ownerProgName || 'תוכנית קודמת'})`, relayId: r.relayId, action: 'OFF' });
      }).catch(() => {});
    });
    // הפעל תוכניות שהיו צריכות לדלוק כעת במצב החדש
    const _catchupTodayKey = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' })).toDateString();
    (impact.missedPrograms || []).forEach(m => {
      publishRelay(m.relayId, 'ON').then(() => {
        relayOwner[m.relayId] = { progId: m.progId, name: m.progName, priority: m.isPriority, endSec: m.endSec };
        // אותו תיקון: לשדר scheduler_fired כדי שהדפדפן יראה מיד שהממסר עלה בעקבות ההשלמה
        io.emit('scheduler_fired', { progName: m.progName, relayId: m.relayId, action: 'ON' });
        // קריטי: לרשום את זה כ"ירה באמת" — אחרת הכיבוי-לפי-משך העתידי של התוכנית הזו יידלג בשקט
        // (schedulerTick בודק _actuallyFired לפני שהוא מרשה לאירוע-הסיום לירות, וההפעלה הזו לא עברה דרך fireEvent הרגיל)
        if (m.fireSec !== undefined) _actuallyFired.add(`${m.progId}_${m.relayId}_${m.segType}_${m.cycleIdx??'x'}_${m.fireSec}_start_${_catchupTodayKey}`);
        // תוכנית runOnce שהופעלה כהשלמה — כיבוי הדגל כמו בירייה רגילה, אחרת היא עלולה לירות שוב במחזור עתידי
        if (m.runOnce) {
          const p = schedulerPrograms.find(x => x.id === m.progId);
          if (p && p.active) {
            p.active = false;
            _firedRunOnceToday.set(p.id, { ...p, _todayKey: _catchupTodayKey });
            io.emit('program_updated', { id: p.id, active: false });
            saveConfigLocal();
          }
        }
      }).catch(() => {});
    });
    io.emit('mode_changed', { newModeId, label });
    addServerLog({ type: 'info', msg: `🕐 [תזמון מצב] עבר למצב ${newModeId} — ${label}`, user: 'מערכת' });
  } catch(e) {
    console.error('❌ שגיאה ב-commitAutoModeSwitch:', e.message);
  }
}

// גרסה גלובלית של computeModeSwitchImpact (לא בתוך io.on)
function computeModeSwitchImpactGlobal(newModeId) {
  const nowIL = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const nowSec = getNowSecIL();
  const todayKey = nowIL.toDateString();
  const staleRelays = [];
  for (const relayIdStr of Object.keys(relayOwner)) {
    const relayId = parseInt(relayIdStr, 10);
    const owner = relayOwner[relayId];
    const p = schedulerPrograms.find(x => String(x.id) === String(owner.progId));
    const modeIds = p ? (p.modeIds ?? (p.modeId !== null ? [p.modeId] : [0])) : [];
    if (!modeIds.includes(newModeId)) staleRelays.push({ relayId, relayName: schedulerRelayNames[relayId] || `ממסר ${relayId}`, ownerProgName: owner.name });
  }
  const savedMode = schedulerActiveModeId;
  schedulerActiveModeId = newModeId;
  const dow = nowIL.getDay();
  const zmanim = getZmanim(nowIL);
  let newModeEvents = [];
  try { newModeEvents = computeTodayEvents(nowIL, zmanim, dow, todayKey); }
  finally { schedulerActiveModeId = savedMode; }

  // מפה של טווחי-בעלות של תוכניות עדיפות לכל ממסר — ראו הסבר מלא בגרסה הידנית של הפונקציה הזו למעלה
  const priorityIntervalsByRelayG = {};
  for (const ev of newModeEvents) {
    if (ev.action !== 'ON' || ev.isEndEvent || !ev.isPriority) continue;
    (priorityIntervalsByRelayG[ev.relayId] ||= []).push({ progId: ev.progId, start: ev.fireSec, end: ev.endSec });
  }
  const isBlockedByPriorityG = ev => {
    const arr = priorityIntervalsByRelayG[ev.relayId];
    return !!arr && arr.some(iv => iv.progId !== ev.progId && iv.start <= ev.fireSec && (iv.end === null || iv.end > ev.fireSec));
  };

  // בנה מפה של אירוע כיבוי אחרון שירה לפני עכשיו, לכל ממסר
  const lastOffFiredByRelayG = {};
  for (const ev of newModeEvents) {
    if (ev.action !== 'OFF' || ev.fireSec > nowSec) continue;
    if (!ev.isPriority && isBlockedByPriorityG(ev)) continue;
    const cur = lastOffFiredByRelayG[ev.relayId];
    if (!cur || ev.fireSec > cur.fireSec) lastOffFiredByRelayG[ev.relayId] = ev;
  }

  // מצא תוכניות שפספסו — מועמד אחד לכל ממסר
  const missedCandidatesByRelay = {};
  for (const ev of newModeEvents) {
    if (ev.action !== 'ON' || ev.isEndEvent) continue;
    if (ev.fireSec > nowSec) continue;
    if (nowSec - ev.fireSec <= 8) continue;
    if (ev.endSec !== null && ev.endSec <= nowSec) continue;
    // אם יש אירוע כיבוי מאוחר יותר שכבר עבר — הממסר כבוי כעת
    const lastOff = lastOffFiredByRelayG[ev.relayId];
    if (lastOff && lastOff.fireSec > ev.fireSec) continue;
    // סנן runOnce שכבר ירה היום
    if (ev.runOnce && _firedRunOnceToday.has(ev.progId)) continue;
    const cur = missedCandidatesByRelay[ev.relayId];
    if (!cur) { missedCandidatesByRelay[ev.relayId] = ev; continue; }
    const curWins = (cur.isPriority && !ev.isPriority) ? true : (!cur.isPriority && ev.isPriority) ? false : (cur.endSec === null) ? true : (ev.endSec === null) ? false : (cur.endSec >= ev.endSec);
    if (!curWins) missedCandidatesByRelay[ev.relayId] = ev;
  }

  // הרחב — כל הממסרים של כל תוכנית שפספסה (לא רק הממסר הראשון)
  const missedProgIds = new Set(Object.values(missedCandidatesByRelay).map(ev => ev.progId));
  const missedPrograms = [];
  for (const ev of newModeEvents) {
    if (ev.action !== 'ON' || ev.isEndEvent) continue;
    if (!missedProgIds.has(ev.progId)) continue;
    if (ev.fireSec > nowSec) continue;
    if (ev.endSec !== null && ev.endSec <= nowSec) continue;
    const lastOff = lastOffFiredByRelayG[ev.relayId];
    if (lastOff && lastOff.fireSec > ev.fireSec) continue;
    // בדוק שהממסר הספציפי הזה לא כבוי כבר
    if (missedCandidatesByRelay[ev.relayId]?.progId !== ev.progId) continue;
    missedPrograms.push({
      relayId: ev.relayId,
      relayName: schedulerRelayNames[ev.relayId] || `ממסר ${ev.relayId}`,
      progId: ev.progId, progName: ev.name, isPriority: !!ev.isPriority, endSec: ev.endSec,
      fireSec: ev.fireSec, segType: ev.segType, cycleIdx: ev.cycleIdx, runOnce: !!ev.runOnce,
    });
  }

  return { staleRelays, missedPrograms };
}

function processScheduledModes() {
  if (!scheduledModes.length) return;
  try {
    const nowIL = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const nowSec = getNowSecIL();
    const dow = nowIL.getDay();
    const todayKey = nowIL.toDateString();
    const zmanim = getZmanim(nowIL);
    const WINDOW_SEC = 15;

    // נקה fired set יומי
    _firedScheduledModes.forEach(k => { if (!k.endsWith(todayKey)) _firedScheduledModes.delete(k); });

    for (const sm of scheduledModes) {
      if (!sm.active) continue;
      if (sm.days?.length && !sm.days.includes(dow)) continue;

      // בדיקת תאריך
      if (sm.calType && sm.calType !== 'none') {
        const dd = String(nowIL.getDate()).padStart(2,'0');
        const mm = String(nowIL.getMonth()+1).padStart(2,'0');
        const yyyy = nowIL.getFullYear();
        const entry = _calendarIndex[`${dd}/${mm}/${yyyy}`];
        if (!entry) continue;
        const calDate = entry['תאריך עברי'] || '';
        if (sm.calType === 'annual') {
          if (!calDate.startsWith(`${sm.calDay} ${sm.calMonth}`)) continue;
        } else if (sm.calType === 'once') {
          if (calDate !== sm.calLabel || yyyy !== sm.calYear) continue;
        }
      }

      // חשב זמן הפעלה
      let fireSec = -1;
      if (sm.type === 'time') {
        const [h,m] = (sm.time||'00:00').split(':').map(Number);
        fireSec = h*3600 + m*60;
      } else if (sm.type === 'zman') {
        const zmKey = { sunset:'sunset',sunrise:'sunrise',candles:'candles',havdalah:'havdalah',tzeit:'tzeit',dawn:'alotHaShachar',mincha:'minchaGedola' }[sm.zman] || sm.zman;
        const base = zmanim[zmKey];
        if (!base) continue;
        const [h,m] = base.split(':').map(Number);
        const baseSec = h*3600 + m*60;
        const offset = (sm.offsetVal||0) * 60;
        fireSec = sm.offsetDir === '-' ? baseSec - offset : baseSec + offset;
      }
      if (fireSec < 0) continue;
      if (fireSec > nowSec || fireSec < nowSec - WINDOW_SEC) continue;

      const fireKey = `sm_${sm.id}_${todayKey}`;
      if (_firedScheduledModes.has(fireKey)) continue;
      _firedScheduledModes.add(fireKey);

      // שמור מצב קודם אם יש duration
      if (sm.durationOn) {
        _previousModeId = schedulerActiveModeId;
        const durationSec = ((sm.durationH||0)*3600 + (sm.durationM||0)*60);

        // הגדר טיימר לחזרה
        if (_activeScheduledModeTimer) clearTimeout(_activeScheduledModeTimer);
        const prevMode = _previousModeId;
        const modeJustSetTo = sm.toModeId;
        _activeScheduledModeTimer = setTimeout(() => {
          _activeScheduledModeTimer = null;
          // הגנה מפני race condition: אם תזמון מצב אחר כבר החליף את המצב הפעיל בינתיים (למשל שני תזמונים
          // שחלים כמעט באותו רגע), אסור לטיימר החזרה "העיוור" הזה לדרוס את המצב הנוכחי בחזרה — רק אם
          // עדיין נמצאים באותו מצב שאליו עברנו במקור, מותר לחזור.
          if (schedulerActiveModeId !== modeJustSetTo) {
            addServerLog({ type: 'info', msg: `🕐 חזרה אוטומטית למצב ${prevMode} בוטלה — תזמון אחר כבר החליף את המצב בינתיים (נשארים במצב ${schedulerActiveModeId})`, user: 'מערכת' });
            return;
          }
          commitAutoModeSwitch(prevMode, `חזרה אוטומטית למצב ${prevMode}`);
        }, durationSec * 1000);
      }

      commitAutoModeSwitch(sm.toModeId, sm.name || `תזמון מצב ${sm.id}`);
    }
  } catch(e) {
    console.error('❌ שגיאה ב-processScheduledModes:', e.message);
  }
}

setInterval(schedulerTick, 5000);
setInterval(processIvrPendingTimers, 5000);
setInterval(processScheduledModes, 10000);
schedulerTick();
processIvrPendingTimers();

// ── ימות המשיח ──────────────────────────────────────────
function ymResponse(text){
  const clean=text.replace(/[:]/g," , ").replace(/\.{2,}/g," , ").replace(/\.(?!\d)/g," , ").replace(/[*#_>"]/g,"").replace(/\n/g," , ").replace(/\s+/g," ").trim();
  return `id_list_message=t-${clean}`;
}

const IVR_ACK_TIMEOUT_MS = 3000;

app.get('/yemot', async (req, res) => {
  const relayDigits=req.query.Relay||'',actionDigit=req.query.Action||'',durationStr=req.query.Duration||'',callerPhone=req.query.ApiPhone||'',hangup=req.query.hangup==='yes';
  if(hangup) return res.send('');
  if(relayDigits&&actionDigit&&callerPhone){
    const callerId=yemotPhoneMap[callerPhone];
    if(callerId===undefined) return res.send('id_list_message=t-אין הרשאה למספר זה&go_to_folder=hangup&');
    const perm=yemotPermissions[callerId]||{};
    const relayId=parseInt(relayDigits,10),relayName=schedulerRelayNames[relayId];
    const action=actionDigit==='1'?'ON':actionDigit==='2'?'OFF':null;
    const durationMin=parseInt(durationStr,10);
    if(!relayName||!action||isNaN(durationMin)||durationMin<0) return res.send('id_list_message=t-קלט לא תקין, נסה שוב&go_to_folder=hangup&');
    if(!perm.isAdmin){
      const maxDur=action==='ON'?(perm.maxDurationMinOn??0):(perm.maxDurationMinOff??0);
      if(!(perm.allowedRelays||[]).includes(relayId)||!(perm.allowedActions||[]).includes(action)||(maxDur!==0&&(durationMin===0||durationMin>maxDur)))
        return res.send('id_list_message=t-אינך מורשה, נסה שוב&go_to_folder=hangup&');
    }
    try{
      const isOn=action==='ON';
      const ackPromise=waitForRelayAck(relayId,IVR_ACK_TIMEOUT_MS);
      await publishRelay(relayId,action,`IVR — ID ${callerId}`);
      const ackReceived=await ackPromise;
      if(durationMin>0){
        const timerId=`ivr_${Date.now()}_${Math.round(Math.random()*1e6)}`;
        const startedAt=Date.now(),dueAt=startedAt+durationMin*60000;
        ivrPendingTimers.push({id:timerId,relayId,revertAction:isOn?'OFF':'ON',startedAt,dueAt,label:`${relayName} (IVR — ID ${callerId})`,callerId});
        ivrTodayEvents.push({id:timerId,relayId,callerId,startedAt,dueAt,dateKey:new Date(startedAt).toLocaleDateString('en-CA',{timeZone:'Asia/Jerusalem'})});
        saveConfigLocal();io.emit('ivr_today_events',ivrTodayEvents);
      }
      const msg=!ackReceived?`${relayName}: הפקודה נשלחה, ממתין לאישור`
        :durationMin>0?`${relayName}: ${isOn?'הודלק':'כובה'} בהצלחה, יחזור אוטומטית בעוד ${durationMin} דקות`
        :`${relayName}: ${isOn?'הודלק':'כובה'} בהצלחה`;
      return res.send(ymResponse(msg));
    }catch(err){return res.send(ymResponse('שגיאה בביצוע הפעולה, נסה שוב'));}
  }
  return res.send(ymResponse('לא התקבל קלט מלא, נסה שוב'));
});

app.get('/dashboard', (req, res) => res.redirect('/smart_home_v3.html'));

app.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    mqtt: mqttConnected ? 'מחובר' : 'מנותק',
    uptime: Math.floor(process.uptime()) + ' שניות',
    states: relayState,
    haDevices: haDevices.length,
    controllers: CONTROLLERS.map(c => ({ id: c.id, name: c.name, online: controllerOnline[c.id] || false })),
  });
});

const PORT = process.env.PORT || 3000;

// טיפול בשגיאות לא מתוכננות — מונע קריסה שקטה
process.on('uncaughtException', (err) => {
  console.error(`💥 uncaughtException: ${err.message}`);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`💥 unhandledRejection: ${reason}`);
});

(async () => {
  loadConfigLocal();
  rebuildHaRelayNames();
  connectMQTT();
  server.listen(PORT, () => {
    console.log(`\n🏠 שרת בית חכם (גרסה מקומית) פועל על פורט ${PORT}\n`);
  });
})();
