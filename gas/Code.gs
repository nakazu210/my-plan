/**
 * マイプラン バックエンド（Google Apps Script）
 * ・データはスプレッドシート「マイプラン データ」に保存
 * ・予定ごとに「アプリだけ / 自分のカレンダー / 夫婦の共有カレンダー」へ同期
 *
 * 初回だけ：エディタ上部の関数選択で「setup」を選んで実行 → 実行ログに合言葉が出ます
 */

const HEADERS = ['id', 'type', 'title', 'date', 'start', 'end', 'memo', 'data', 'sync', 'eventId', 'calId', 'done', 'updated'];
const CAT_NAMES = { run: 'ラン計画', study: '勉強計画', money: '資金計画', other: 'マイプラン' };

function P_() { return PropertiesService.getScriptProperties(); }

/** 初回セットアップ（手動で1回実行） */
function setup() {
  const p = P_();
  if (!p.getProperty('TOKEN')) p.setProperty('TOKEN', Utilities.getUuid().replace(/-/g, '').slice(0, 16));
  const sh = sheet_();
  Object.keys(CAT_NAMES).forEach(catCal_);
  Logger.log('セットアップ完了');
  Logger.log('合言葉（アプリの設定画面に入力）： ' + p.getProperty('TOKEN'));
  Logger.log('データの保存先： ' + sh.getParent().getUrl());
}

/* ---------- 受け口 ---------- */

function doGet() {
  return ContentService.createTextOutput('マイプランAPIは動いています');
}

function doPost(e) {
  let res;
  try {
    const req = JSON.parse(e.postData.contents);
    if (!req.token || req.token !== P_().getProperty('TOKEN')) throw new Error('合言葉が違います');
    const fn = { config: config_, list: list_, save: save_, remove: remove_, settings: saveSettings_ }[req.action];
    if (!fn) throw new Error('不明な操作です：' + req.action);
    res = { ok: true, result: fn(req) };
  } catch (err) {
    res = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- 設定 ---------- */

function config_() {
  const p = P_();
  const own = Object.keys(CAT_NAMES).map(k => p.getProperty('CAL_' + k));
  const calendars = CalendarApp.getAllCalendars()
    .filter(c => own.indexOf(c.getId()) < 0)
    .map(c => ({ id: c.getId(), name: c.getName(), owned: c.isOwnedByMe() }));
  return {
    calendars: calendars,
    sharedCalId: p.getProperty('SHARED_CAL') || '',
    settings: JSON.parse(p.getProperty('SETTINGS') || '{}'),
  };
}

function saveSettings_(req) {
  const p = P_();
  if (req.sharedCalId !== undefined && req.sharedCalId !== null) p.setProperty('SHARED_CAL', req.sharedCalId);
  if (req.settings) p.setProperty('SETTINGS', JSON.stringify(req.settings));
  return config_();
}

/* ---------- 一覧 ---------- */

function list_(req) {
  const items = readAll_().map(r => r.obj);
  const events = [];
  const sid = P_().getProperty('SHARED_CAL');
  if (sid && req.from && req.to) {
    const cal = CalendarApp.getCalendarById(sid);
    if (cal) {
      const mine = {};
      items.forEach(i => { if (i.eventId) mine[i.eventId] = 1; });
      cal.getEvents(parseDate_(req.from), addDays_(parseDate_(req.to), 1)).forEach(ev => {
        if (mine[ev.getId()]) return; // アプリから入れた予定は二重に出さない
        events.push(evToObj_(ev, cal.getName()));
      });
    }
  }
  return { items: items, events: events };
}

function evToObj_(ev, calName) {
  const tz = Session.getScriptTimeZone();
  const f = (d, fmt) => Utilities.formatDate(d, tz, fmt);
  const allDay = ev.isAllDayEvent();
  const s = ev.getStartTime(), e = ev.getEndTime();
  return {
    id: ev.getId(),
    title: ev.getTitle() || '（タイトルなし）',
    date: f(s, 'yyyy-MM-dd'),
    endDate: allDay ? f(addDays_(e, -1), 'yyyy-MM-dd') : f(e, 'yyyy-MM-dd'),
    start: allDay ? '' : f(s, 'HH:mm'),
    end: allDay ? '' : f(e, 'HH:mm'),
    allDay: allDay,
    location: ev.getLocation() || '',
    memo: ev.getDescription() || '',
    calName: calName,
  };
}

/* ---------- 保存・削除 ---------- */

function save_(req) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const it = req.item;
    if (!it || !it.date) throw new Error('日付がありません');
    if (!it.id) it.id = Utilities.getUuid();
    const found = readAll_().filter(r => r.obj.id === it.id)[0];
    const prev = found ? found.obj : {};

    const target = it.sync === 'mine' ? catCal_(it.type) : it.sync === 'shared' ? sharedCal_() : null;
    const targetId = target ? target.getId() : '';
    let eventId = prev.eventId || '', calId = prev.calId || '';

    // 同期先が変わったら古い予定を消す
    if (eventId && calId !== targetId) { deleteEvent_(calId, eventId); eventId = ''; calId = ''; }

    if (target) {
      let ev = null;
      if (eventId) { try { ev = target.getEventById(eventId); } catch (e) { ev = null; } }
      if (ev) updateEvent_(ev, it); else ev = createEvent_(target, it);
      eventId = ev.getId(); calId = targetId;
    }

    it.eventId = eventId;
    it.calId = calId;
    it.updated = new Date().toISOString();
    writeRow_(found ? found.row : 0, it);
    return clean_(it);
  } finally {
    lock.releaseLock();
  }
}

function remove_(req) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const found = readAll_().filter(r => r.obj.id === req.id)[0];
    if (!found) return true;
    if (found.obj.eventId) deleteEvent_(found.obj.calId, found.obj.eventId);
    sheet_().deleteRow(found.row);
    return true;
  } finally {
    lock.releaseLock();
  }
}

/* ---------- カレンダー操作 ---------- */

function catCal_(type) {
  const p = P_();
  const key = 'CAL_' + type;
  const id = p.getProperty(key);
  if (id) { const c = CalendarApp.getCalendarById(id); if (c) return c; }
  const colors = { run: CalendarApp.Color.GREEN, study: CalendarApp.Color.BLUE, money: CalendarApp.Color.ORANGE, other: CalendarApp.Color.PURPLE };
  const c = CalendarApp.createCalendar(CAT_NAMES[type] || 'マイプラン', { color: colors[type] || CalendarApp.Color.PURPLE });
  p.setProperty(key, c.getId());
  return c;
}

function sharedCal_() {
  const id = P_().getProperty('SHARED_CAL');
  if (!id) throw new Error('共有カレンダーが未設定です（アプリの設定画面で選んでください）');
  const c = CalendarApp.getCalendarById(id);
  if (!c) throw new Error('共有カレンダーが見つかりません');
  return c;
}

function times_(it) {
  const d = parseDate_(it.date);
  if (!it.start) return { allDay: true, d: d };
  const hm = s => s.split(':').map(Number);
  const [sh, sm] = hm(it.start);
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), sh, sm);
  let e = null;
  if (it.end) { const [eh, em] = hm(it.end); e = new Date(d.getFullYear(), d.getMonth(), d.getDate(), eh, em); }
  if (!e || e <= s) e = new Date(s.getTime() + 60 * 60 * 1000);
  return { allDay: false, s: s, e: e };
}

function createEvent_(cal, it) {
  const t = times_(it);
  const opt = { description: it.calDesc || it.memo || '' };
  const title = it.calTitle || it.title || '予定';
  return t.allDay ? cal.createAllDayEvent(title, t.d, opt) : cal.createEvent(title, t.s, t.e, opt);
}

function updateEvent_(ev, it) {
  const t = times_(it);
  ev.setTitle(it.calTitle || it.title || '予定');
  ev.setDescription(it.calDesc || it.memo || '');
  if (t.allDay) ev.setAllDayDate(t.d); else ev.setTime(t.s, t.e);
}

function deleteEvent_(calId, eventId) {
  try {
    const c = CalendarApp.getCalendarById(calId);
    const ev = c && c.getEventById(eventId);
    if (ev) ev.deleteEvent();
  } catch (e) { /* すでに消えている場合は無視 */ }
}

/* ---------- スプレッドシート ---------- */

function sheet_() {
  const p = P_();
  const id = p.getProperty('SHEET_ID');
  let ss;
  if (id) ss = SpreadsheetApp.openById(id);
  else { ss = SpreadsheetApp.create('マイプラン データ'); p.setProperty('SHEET_ID', ss.getId()); }
  let sh = ss.getSheetByName('items');
  if (!sh) {
    sh = ss.getSheets()[0];
    sh.setName('items');
    sh.getRange(1, 1, sh.getMaxRows(), HEADERS.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function readAll_() {
  const v = sheet_().getDataRange().getValues();
  const out = [];
  for (let r = 1; r < v.length; r++) {
    if (!v[r][0]) continue;
    const o = {};
    HEADERS.forEach((h, i) => { o[h] = v[r][i] === '' || v[r][i] == null ? '' : String(v[r][i]); });
    try { o.data = o.data ? JSON.parse(o.data) : {}; } catch (e) { o.data = {}; }
    o.done = o.done === '1';
    out.push({ row: r + 1, obj: o });
  }
  return out;
}

function writeRow_(row, it) {
  const sh = sheet_();
  const values = HEADERS.map(h => {
    if (h === 'data') return JSON.stringify(it.data || {});
    if (h === 'done') return it.done ? '1' : '';
    return it[h] == null ? '' : String(it[h]);
  });
  const r = row || sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, HEADERS.length).setNumberFormat('@').setValues([values]);
}

function clean_(it) {
  const o = {};
  HEADERS.forEach(h => { o[h] = it[h]; });
  o.data = it.data || {};
  o.done = !!it.done;
  return o;
}

/* ---------- 日付 ---------- */

function parseDate_(s) { const a = s.split('-').map(Number); return new Date(a[0], a[1] - 1, a[2]); }
function addDays_(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
