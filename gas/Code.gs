/**
 * マイプラン バックエンド（Google Apps Script）
 * ・データはスプレッドシート「マイプラン データ」に保存
 * ・予定ごとに「アプリだけ / 自分のカレンダー / 夫婦の共有カレンダー」へ同期
 *
 * 初回だけ：エディタ上部の関数選択で「setup」を選んで実行 → 実行ログに合言葉が出ます
 */

// Googleログイン用のクライアントID（Google Cloudで作成したもの。秘密の情報ではありません）
const CLIENT_ID = '668061744549-2pb0nfulpkngjppp6pem4l0r2dk4gleo.apps.googleusercontent.com';

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
    if (req.action === 'login') {
      res = { ok: true, result: login_(req) };
      return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
    }
    auth_(req);
    const fn = { config: config_, list: list_, save: save_, remove: remove_, settings: saveSettings_, logout: logout_ }[req.action];
    if (!fn) throw new Error('不明な操作です：' + req.action);
    res = { ok: true, result: fn(req) };
  } catch (err) {
    res = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- ログイン ---------- */

function hash_(s) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
}
function sessions_() { return JSON.parse(P_().getProperty('SESSIONS') || '{}'); }

/** Googleでログイン → この端末用のログインキーを発行（端末ごとに1回だけ） */
function login_(req) {
  const cid = CLIENT_ID || P_().getProperty('CLIENT_ID');
  if (!cid) throw new Error('GoogleログインのクライアントIDが未設定です');
  if (!req.idToken) throw new Error('ログイン情報がありません');
  const r = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(req.idToken), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('Googleログインを確認できませんでした');
  const t = JSON.parse(r.getContentText());
  if (t.aud !== cid) throw new Error('ログイン情報が正しくありません');
  if (String(t.email_verified) !== 'true') throw new Error('メールアドレスが確認されていないアカウントです');
  const allowed = [Session.getEffectiveUser().getEmail()]
    .concat((P_().getProperty('ALLOWED_EMAILS') || '').split(','))
    .map(s => String(s).trim().toLowerCase()).filter(Boolean);
  if (allowed.indexOf(String(t.email).toLowerCase()) < 0) throw new Error('このGoogleアカウントでは使えません（' + t.email + '）');

  const key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = sessions_();
    ss[hash_(key)] = { email: t.email, at: new Date().toISOString() };
    const keys = Object.keys(ss).sort((a, b) => (ss[a].at < ss[b].at ? -1 : 1));
    while (keys.length > 20) delete ss[keys.shift()]; // 古い端末から順に整理
    P_().setProperty('SESSIONS', JSON.stringify(ss));
  } finally {
    lock.releaseLock();
  }
  return { session: key, email: t.email, name: t.name || '' };
}

function auth_(req) {
  if (req.session && sessions_()[hash_(req.session)]) return;
  const token = P_().getProperty('TOKEN');
  if (req.token && token && req.token === token) return; // 予備の合言葉
  throw new Error('LOGIN_REQUIRED');
}

function logout_(req) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = sessions_();
    if (req.session) delete ss[hash_(req.session)];
    P_().setProperty('SESSIONS', JSON.stringify(ss));
  } finally {
    lock.releaseLock();
  }
  return true;
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
  const events = [];
  if (!req.from || !req.to) return { items: readAll_().map(r => r.obj), events: events };
  const from = parseDate_(req.from), to = addDays_(parseDate_(req.to), 1);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const rows = readAll_();
    const byEvent = {};
    rows.forEach(r => { if (r.obj.eventId) byEvent[r.obj.eventId] = r; });

    // 1) 自分のカレンダー（ラン計画など）に直接入った予定を取り込む／時間の変更を反映
    Object.keys(CAT_NAMES).forEach(type => {
      const id = P_().getProperty('CAL_' + type);
      const cal = id && CalendarApp.getCalendarById(id);
      if (!cal) return;
      cal.getEvents(from, to).forEach(ev => {
        const linked = byEvent[ev.getId()];
        if (linked) { syncBack_(linked, ev); return; }
        if (ev.isRecurringEvent()) return; // 繰り返し予定は取り込まない
        const it = importEvent_(ev, type, id);
        writeRow_(0, it);
        byEvent[it.eventId] = { row: -1, obj: it };
        rows.push({ row: -1, obj: it });
      });
    });

    // 2) 夫婦の共有カレンダー：アプリの予定は時間の変更を反映、それ以外は「見るだけ」で表示
    const sid = P_().getProperty('SHARED_CAL');
    const cal = sid && CalendarApp.getCalendarById(sid);
    if (cal) {
      const me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
      cal.getEvents(from, to).forEach(ev => {
        const linked = byEvent[ev.getId()];
        if (linked) { syncBack_(linked, ev); return; }
        const o = evToObj_(ev, cal.getName());
        // 誰が入れた予定か（自分／妻）で色を分けるため
        let creators = [];
        try { creators = ev.getCreators().map(c => String(c).toLowerCase()); } catch (e) { creators = []; }
        o.byMe = !creators.length || creators.indexOf(me) >= 0;
        events.push(o);
      });
    }
    return { items: rows.map(r => r.obj), events: events };
  } finally {
    lock.releaseLock();
  }
}

/** Googleカレンダー側で日時が変わっていたら、アプリにも反映。
 *  ランの予定はタイトルに「✓」が付いたら実施済みにし、タイトルの実績（距離・時間）も入れる */
function syncBack_(r, ev) {
  if (r.row < 0) return;
  const o = evToObj_(ev, '');
  const it = r.obj;
  let changed = false;
  if (it.date !== o.date || it.start !== o.start || it.end !== o.end) {
    it.date = o.date; it.start = o.start; it.end = o.end;
    changed = true;
  }
  if (it.type === 'run' && !it.done && /^[✓✔]/.test(o.title)) {
    it.done = true;
    it.data = Object.assign({}, it.data || {}, runResult_(o.title));
    changed = true;
  }
  if (!changed) return;
  it.updated = new Date().toISOString();
  writeRow_(r.row, it);
}

const toNum_ = s => Number(String(s).replace(/[，,]/g, '').replace(/[０-９．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)));

/** 実施済みランのタイトル（例「✓ ラン 1.57km 21分47秒（予定4km）」）から距離と時間を読む。
 *  「（予定…）」より後ろは予定の内容なので読まない */
function runResult_(title) {
  const t = String(title).replace(/^[✓✔]\s*/, '').split(/[（(]予定/)[0];
  const d = {};
  let m;
  if ((m = t.match(/([0-9０-９.．]+)\s*(km|ｋｍ|キロ)/i))) d.dist = toNum_(m[1]);
  if ((m = t.match(/([0-9０-９]+)\s*時間\s*([0-9０-９]+)\s*分\s*([0-9０-９]+)\s*秒/))) {
    d.min = toNum_(m[1]) * 60 + toNum_(m[2]); d.sec = toNum_(m[3]);
  } else if ((m = t.match(/([0-9０-９]+)\s*分\s*([0-9０-９]+)\s*秒/))) {
    d.min = toNum_(m[1]); d.sec = toNum_(m[2]);
  }
  return d;
}

/** カレンダーの予定をアプリの予定に変換（タイトルから距離・時間・金額を読み取る） */
function importEvent_(ev, type, calId) {
  const o = evToObj_(ev, '');
  let title = o.title;
  let done = false;
  if (/^[✓✔]\s*/.test(title)) { done = true; title = title.replace(/^[✓✔]\s*/, ''); }
  const memo = String(o.memo || '').replace(/\n*（マイプランから登録）\s*$/, '');
  const text = title + ' ' + memo;
  const toNum = s => Number(String(s).replace(/[，,]/g, '').replace(/[０-９．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)));
  const data = {};
  let m;
  if (type === 'run') {
    if (done) Object.assign(data, runResult_(title));
    else if ((m = text.match(/([0-9０-９.．]+)\s*(km|ｋｍ|キロ)/i))) data.dist = toNum(m[1]);
  } else if (type === 'study') {
    if ((m = text.match(/([0-9０-９.．]+)\s*時間/))) data.min = Math.round(toNum(m[1]) * 60);
    if ((m = text.match(/([0-9０-９]+)\s*分/))) data.min = (data.min || 0) + toNum(m[1]);
    const subj = title.replace(/[0-9０-９.．]+\s*(時間|分)/g, '').replace(/勉強/g, '').trim();
    if (subj) data.subject = subj;
  } else if (type === 'money') {
    if ((m = text.match(/([0-9０-９,，]+)\s*円/))) data.amount = toNum(m[1]);
    data.kind = /取り崩し|引き出し|出金|−|-/.test(title) ? 'out' : 'in';
  }
  return {
    id: Utilities.getUuid(), type: type, title: title, date: o.date, start: o.start, end: o.end,
    memo: memo, data: data, sync: 'mine', eventId: ev.getId(), calId: calId, done: done,
    updated: new Date().toISOString(),
  };
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
