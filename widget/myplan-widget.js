// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: blue; icon-glyph: calendar-alt;

/*
 * マイプラン ウィジェット（Scriptable用）
 * ・今日の予定と、今月のまとめ（ラン・勉強・資金）を表示
 * ・初回：Scriptableアプリの中でこのスクリプトを実行 → 接続先URLと合言葉を入力
 *   （URLと合言葉はiPhoneの中の安全な保管場所＝キーチェーンにだけ保存されます）
 * ・設定し直すとき：もう一度アプリの中で実行 →「接続を設定し直す」
 */

const APP_URL = 'https://nakazu210.github.io/my-plan/';
const KC_URL = 'myplan_api_url';
const KC_TOKEN = 'myplan_token';

const CATS = {
  other: { label: 'その他', color: '#8E24AA' },
  run:   { label: 'ラン',   color: '#0B8043' },
  study: { label: '勉強',   color: '#039BE5' },
  money: { label: '資金',   color: '#F4511E' },
};
const EXT_COLOR = '#757575';
const C = {
  bg:   Color.dynamic(new Color('#ffffff'), new Color('#1f1f1f')),
  fg:   Color.dynamic(new Color('#3c4043'), new Color('#e3e3e3')),
  fg2:  Color.dynamic(new Color('#70757a'), new Color('#a8a8a8')),
  blue: Color.dynamic(new Color('#1a73e8'), new Color('#a8c7fa')),
};
const WD = '日月火水木金土';

const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parse = s => { const a = s.split('-').map(Number); return new Date(a[0], a[1] - 1, a[2]); };
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const yen = n => Math.round(n).toLocaleString('ja-JP') + '円';
const hm = m => (m >= 60 ? Math.floor(m / 60) + '時間' : '') + (m % 60 || m === 0 ? (m % 60) + '分' : '');

/* ---------- 通信 ---------- */
function hasConfig() { return Keychain.contains(KC_URL) && Keychain.contains(KC_TOKEN); }

async function api(action, payload = {}, url = Keychain.get(KC_URL), token = Keychain.get(KC_TOKEN)) {
  const r = new Request(url);
  r.method = 'POST';
  r.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
  r.body = JSON.stringify(Object.assign({ action, token }, payload));
  r.timeoutInterval = 25;
  let j;
  try { j = await r.loadJSON(); } catch (e) { throw new Error('接続先に届きませんでした'); }
  if (!j.ok) throw new Error(j.error === 'LOGIN_REQUIRED' ? '合言葉が違います' : (j.error || '不明なエラー'));
  return j.result;
}

async function loadData() {
  const fm = FileManager.local();
  const path = fm.joinPath(fm.cacheDirectory(), 'myplan_widget.json');
  try {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const tmr = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const [conf, list] = await Promise.all([
      api('config'),
      api('list', { from: ymd(first), to: ymd(last > tmr ? last : tmr) }),
    ]);
    const data = { settings: conf.settings || {}, items: list.items || [], events: list.events || [], at: Date.now() };
    fm.writeString(path, JSON.stringify(data));
    return data;
  } catch (e) {
    if (fm.fileExists(path)) {
      const d = JSON.parse(fm.readString(path));
      d.stale = true;
      return d;
    }
    throw e;
  }
}

/* ---------- 集計 ---------- */
function autoTitle(it) {
  const d = it.data || {};
  if (it.type === 'run') return 'ラン' + (d.dist ? ' ' + d.dist + 'km' : '');
  if (it.type === 'study') return (d.subject || '勉強') + (d.min ? ' ' + d.min + '分' : '');
  if (it.type === 'money') return '資金' + (d.amount ? ' ' + num(d.amount).toLocaleString('ja-JP') + '円' : '');
  return '予定';
}

function entriesFor(data, day) {
  const out = [];
  data.items.forEach(it => {
    if (it.date !== day) return;
    out.push({ start: it.start || '', title: it.title || autoTitle(it), color: (CATS[it.type] || CATS.other).color, done: !!it.done, ext: false });
  });
  data.events.forEach(ev => {
    if (day < ev.date || day > (ev.endDate || ev.date)) return;
    out.push({ start: ev.allDay ? '' : ev.start, title: ev.title, color: EXT_COLOR, done: false, ext: true });
  });
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

function summary(data) {
  const now = new Date(), s = data.settings || {};
  const prefix = now.getFullYear() + '-' + pad(now.getMonth() + 1);
  const month = data.items.filter(i => (i.date || '').startsWith(prefix) && i.done);
  const d = i => i.data || {};
  const dist = sum(month.filter(i => i.type === 'run'), i => num(d(i).dist));
  const mins = sum(month.filter(i => i.type === 'study'), i => num(d(i).min));
  const signed = i => (d(i).kind === 'out' ? -1 : 1) * num(d(i).amount);
  const fund = sum(data.items.filter(i => i.type === 'money' && i.done), signed);
  let examDays = null;
  if (s.examDate) examDays = Math.ceil((parse(s.examDate) - parse(ymd(now))) / 86400000);
  return {
    run: { value: Math.round(dist * 10) / 10, goal: num(s.runGoal) },
    study: { value: mins, goal: num(s.studyGoal) * 60, exam: s.examName || '試験', examDays },
    money: { value: fund, goal: num(s.fundGoal), name: s.fundName || '' },
  };
}

/* ---------- 描画 ---------- */
function text(stack, str, size, color, weight) {
  const t = stack.addText(str);
  t.font = weight === 'bold' ? Font.semiboldSystemFont(size) : Font.systemFont(size);
  t.textColor = color;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.75;
  return t;
}

function barImage(ratio, color, w, h) {
  const dc = new DrawContext();
  dc.size = new Size(w, h);
  dc.opaque = false;
  dc.respectScreenScale = true;
  const track = new Path();
  track.addRoundedRect(new Rect(0, 0, w, h), h / 2, h / 2);
  dc.addPath(track);
  dc.setFillColor(new Color('#8a8a8a', 0.28));
  dc.fillPath();
  const r = Math.max(0, Math.min(1, ratio || 0));
  if (r > 0) {
    const bar = new Path();
    bar.addRoundedRect(new Rect(0, 0, Math.max(h, w * r), h), h / 2, h / 2);
    dc.addPath(bar);
    dc.setFillColor(new Color(color));
    dc.fillPath();
  }
  return dc.getImage();
}

function header(w, stale) {
  const now = new Date();
  const row = w.addStack();
  row.centerAlignContent();
  text(row, (now.getMonth() + 1) + '/' + now.getDate() + '（' + WD[now.getDay()] + '）', 15, C.blue, 'bold');
  row.addSpacer();
  text(row, stale ? '前回の情報' : 'マイプラン', 10, C.fg2);
}

function entryList(stack, list, max, size) {
  if (!list.length) { text(stack, '予定はありません', size - 1, C.fg2); return; }
  const shown = list.length > max ? max - 1 : list.length;
  list.slice(0, shown).forEach(e => {
    const row = stack.addStack();
    row.centerAlignContent();
    row.spacing = 4;
    text(row, e.ext ? '○' : '●', size - 4, new Color(e.color));
    text(row, e.start || '終日', size - 2, C.fg2);
    const t = text(row, (e.done ? '✓' : '') + e.title, size, C.fg);
    if (e.done) t.textOpacity = 0.6;
    stack.addSpacer(3);
  });
  if (list.length > shown) text(stack, '他' + (list.length - shown) + '件', size - 2, C.fg2);
}

function sumRows(stack, s, width, size) {
  const rows = [
    { c: CATS.run.color, label: 'ラン', val: s.run.value + (s.run.goal ? '/' + s.run.goal : '') + 'km', r: s.run.goal ? s.run.value / s.run.goal : 0 },
    { c: CATS.study.color, label: '勉強', val: hm(s.study.value) + (s.study.goal ? '/' + s.study.goal / 60 + 'h' : ''), r: s.study.goal ? s.study.value / s.study.goal : 0 },
    { c: CATS.money.color, label: s.money.name || '資金', val: s.money.goal ? Math.floor(s.money.value / s.money.goal * 100) + '%' : yen(s.money.value), r: s.money.goal ? s.money.value / s.money.goal : 0 },
  ];
  rows.forEach((x, i) => {
    const line = stack.addStack();
    line.centerAlignContent();
    text(line, x.label, size - 1, C.fg2);
    line.addSpacer();
    text(line, x.val, size, C.fg, 'bold');
    stack.addSpacer(2);
    const img = stack.addImage(barImage(x.r, x.c, width, 5));
    img.imageSize = new Size(width, 5);
    if (i < rows.length - 1) stack.addSpacer(6);
  });
}

function message(w, msg) {
  text(w, 'マイプラン', 15, C.blue, 'bold');
  w.addSpacer(6);
  const t = w.addText(msg);
  t.font = Font.systemFont(12);
  t.textColor = C.fg2;
}

async function build(family) {
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.url = APP_URL;
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
  w.setPadding(12, 14, 12, 14);

  if (!hasConfig()) { message(w, 'Scriptableアプリでこのスクリプトを実行して、接続を設定してください。'); return w; }
  let data;
  try { data = await loadData(); } catch (e) { message(w, '読み込めませんでした：' + e.message); return w; }

  const now = new Date();
  const today = entriesFor(data, ymd(now));
  const s = summary(data);
  header(w, data.stale);
  w.addSpacer(6);

  if (family === 'small') {
    entryList(w, today, 3, 12);
    w.addSpacer();
    const line = w.addStack();
    text(line, 'ラン', 10, C.fg2);
    line.addSpacer();
    text(line, s.run.value + (s.run.goal ? '/' + s.run.goal : '') + 'km', 11, C.fg, 'bold');
    w.addSpacer(2);
    const img = w.addImage(barImage(s.run.goal ? s.run.value / s.run.goal : 0, CATS.run.color, 120, 5));
    img.imageSize = new Size(120, 5);
  } else if (family === 'extraLarge' || family === 'extraLargePortrait') {
    // 特大（iPhone Duo を開いたときなど）：今日から3日分の予定＋今月のまとめ
    for (let k = 0; k < 3; k++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + k);
      if (k > 0) {
        w.addSpacer(8);
        text(w, ['', '明日', 'あさって'][k] + ' ' + (d.getMonth() + 1) + '/' + d.getDate() + '（' + WD[d.getDay()] + '）', 13, C.fg2, 'bold');
        w.addSpacer(4);
      }
      entryList(w, entriesFor(data, ymd(d)), k === 0 ? 5 : 3, 14);
    }
    w.addSpacer();
    text(w, (now.getMonth() + 1) + '月のまとめ', 13, C.fg2, 'bold');
    w.addSpacer(6);
    sumRows(w, s, 300, 13);
    if (s.study.examDays != null && s.study.examDays >= 0) {
      w.addSpacer(8);
      text(w, s.study.exam + 'まで あと' + s.study.examDays + '日', 12, C.fg2);
    }
  } else if (family === 'large') {
    entryList(w, today, 5, 13);
    w.addSpacer(8);
    const tmr = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    text(w, '明日 ' + (tmr.getMonth() + 1) + '/' + tmr.getDate() + '（' + WD[tmr.getDay()] + '）', 12, C.fg2, 'bold');
    w.addSpacer(4);
    entryList(w, entriesFor(data, ymd(tmr)), 3, 13);
    w.addSpacer();
    text(w, (now.getMonth() + 1) + '月のまとめ', 12, C.fg2, 'bold');
    w.addSpacer(4);
    sumRows(w, s, 290, 12);
    if (s.study.examDays != null && s.study.examDays >= 0) {
      w.addSpacer(6);
      text(w, s.study.exam + 'まで あと' + s.study.examDays + '日', 11, C.fg2);
    }
  } else {
    const row = w.addStack();
    row.topAlignContent();
    const left = row.addStack();
    left.layoutVertically();
    left.size = new Size(160, 0);
    entryList(left, today, 4, 12);
    row.addSpacer(10);
    const right = row.addStack();
    right.layoutVertically();
    sumRows(right, s, 120, 11);
  }
  return w;
}

/* ---------- 設定（アプリの中で実行したとき） ---------- */
async function setupConnection() {
  const a = new Alert();
  a.title = 'マイプランの接続設定';
  a.message = 'Apps ScriptのURL（/exec で終わるもの）と、合言葉を入れてください。';
  a.addTextField('https://script.google.com/macros/s/…/exec', Keychain.contains(KC_URL) ? Keychain.get(KC_URL) : '');
  a.addSecureTextField('合言葉', '');
  a.addAction('保存');
  a.addCancelAction('キャンセル');
  if (await a.presentAlert() === -1) return false;
  const url = a.textFieldValue(0).trim(), token = a.textFieldValue(1).trim();
  const done = new Alert();
  try {
    await api('config', {}, url, token);
    Keychain.set(KC_URL, url);
    Keychain.set(KC_TOKEN, token);
    done.title = 'つながりました';
    done.message = 'ホーム画面にScriptableのウィジェットを置き、長押し→「ウィジェットを編集」でこのスクリプト（マイプラン）を選んでください。';
  } catch (e) {
    done.title = 'つながりませんでした';
    done.message = e.message;
  }
  done.addAction('OK');
  await done.present();
  return hasConfig();
}

async function main() {
  if (config.runsInWidget) {
    Script.setWidget(await build(config.widgetFamily || 'medium'));
    return;
  }
  if (!hasConfig() && !(await setupConnection())) return;
  const m = new Alert();
  m.title = 'マイプラン';
  m.addAction('プレビュー（中）');
  m.addAction('プレビュー（小）');
  m.addAction('プレビュー（大）');
  m.addAction('プレビュー（特大）');
  m.addAction('接続を設定し直す');
  m.addCancelAction('閉じる');
  const i = await m.presentSheet();
  if (i === 0) await (await build('medium')).presentMedium();
  if (i === 1) await (await build('small')).presentSmall();
  if (i === 2) await (await build('large')).presentLarge();
  if (i === 3) {
    const xl = await build('extraLarge');
    if (typeof xl.presentExtraLarge === 'function') await xl.presentExtraLarge(); else await xl.presentLarge();
  }
  if (i === 4) await setupConnection();
}

await main();
Script.complete();
