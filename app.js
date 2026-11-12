'use strict';
/* マイプラン — ラン・勉強・資金の計画カレンダー（Googleカレンダー連携） */

const CATS = {
  other: { label: 'その他', color: '#8E24AA', done: '完了' },
  run:   { label: 'ラン',   color: '#0B8043', done: '走った（記録として残す）' },
  study: { label: '勉強',   color: '#039BE5', done: '勉強した（記録として残す）' },
  money: { label: '資金',   color: '#F4511E', done: '入金済み（記録として残す）' },
};
const MPC = window.MP_CONFIG || {};
const EXT_COLOR = '#616161';
const SYNC_LABEL = { none: 'アプリのみ', mine: '自分', shared: '共有' };
const WD = ['日', '月', '火', '水', '木', '金', '土'];

/* ---------- 小道具 ---------- */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parse = s => { const a = s.split('-').map(Number); return new Date(a[0], a[1] - 1, a[2]); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const yen = n => Math.round(n).toLocaleString('ja-JP') + '円';
const wideMQ = matchMedia('(min-width: 640px)');
const isWide = () => wideMQ.matches;

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動かす */ } },
};

function loadCfg() {
  const saved = LS.get('mp_cfg', {}) || {};
  return { apiUrl: saved.apiUrl || MPC.apiUrl || '', token: saved.token || '' };
}

const state = {
  cfg: loadCfg(),
  session: LS.get('mp_session', null), // { key, email, name }
  demoForced: false,
  view: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  sel: ymd(new Date()),
  items: [], events: [], settings: {}, calendars: [], sharedCalId: '',
  filters: LS.get('mp_filters', { run: true, study: true, money: true, other: true, ext: true }),
  editing: null,
};
const isDemo = () => !state.cfg.apiUrl || state.demoForced;
const needsLogin = () => !!state.cfg.apiUrl && !state.demoForced && !state.session && !state.cfg.token;
const cacheKey = () => 'mp_cache_' + (isDemo() ? 'demo' : 'live');

/* ---------- 通信 ---------- */
async function api(action, payload = {}, cfg = state.cfg) {
  if (!cfg.apiUrl || (state.demoForced && cfg === state.cfg)) return demoApi(action, payload);
  const body = Object.assign({ action, token: cfg.token, session: state.session ? state.session.key : '' }, payload);
  const res = await fetch(cfg.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('通信エラー（' + res.status + '）');
  let j;
  try { j = await res.json(); } catch (e) { throw new Error('接続先URLが正しくないようです'); }
  if (!j.ok) {
    if (j.error === 'LOGIN_REQUIRED') {
      state.session = null;
      LS.set('mp_session', null);
      if (cfg === state.cfg) showLogin();
      throw new Error('ログインが必要です');
    }
    throw new Error(j.error || '不明なエラー');
  }
  return j.result;
}

/* ---------- Googleログイン ---------- */
let gsiLoaded = null;
function loadGsi() {
  if (!gsiLoaded) {
    gsiLoaded = new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = 'https://accounts.google.com/gsi/client';
      sc.async = true;
      sc.onload = resolve;
      sc.onerror = () => reject(new Error('Googleのログイン部品を読み込めませんでした'));
      document.head.appendChild(sc);
    });
  }
  return gsiLoaded;
}
async function showLogin() {
  $('#login').hidden = false;
  $('#loginMsg').textContent = '';
  if (!MPC.clientId) { $('#loginMsg').textContent = 'Googleログインの準備がまだです（クライアントID未設定）'; return; }
  try {
    await loadGsi();
    google.accounts.id.initialize({ client_id: MPC.clientId, callback: onGoogleCredential, auto_select: false, ux_mode: 'popup' });
    $('#gsiBtn').innerHTML = '';
    google.accounts.id.renderButton($('#gsiBtn'), { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', locale: 'ja', width: 280 });
  } catch (e) {
    $('#loginMsg').textContent = e.message;
  }
}
async function onGoogleCredential(resp) {
  $('#loginMsg').textContent = 'ログイン中…';
  try {
    const r = await api('login', { idToken: resp.credential });
    state.session = { key: r.session, email: r.email, name: r.name };
    LS.set('mp_session', state.session);
    $('#login').hidden = true;
    toast(r.email + ' でログインしました');
    await loadConfig();
    await load();
  } catch (e) {
    $('#loginMsg').textContent = 'ログインできませんでした：' + e.message;
  }
}
async function logout() {
  if (!confirm('この端末からログアウトしますか？')) return;
  try { await api('logout', {}); } catch (e) { /* ログアウトはそのまま進める */ }
  state.session = null;
  LS.set('mp_session', null);
  $('#settings').close();
  showLogin();
}

/* ---------- 色のテーマ ---------- */
function applyTheme(v) {
  const root = document.documentElement;
  if (v === 'light' || v === 'dark') root.dataset.theme = v; else delete root.dataset.theme;
  const dark = v === 'dark' || (v !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  $$('meta[name=theme-color]').forEach(m => { m.content = dark ? '#1f1f1f' : '#ffffff'; });
}

/* お試し表示（Google未接続のとき）。データはこの端末の中だけ */
async function demoApi(action, p) {
  let items = LS.get('mp_demo_items', null);
  if (!items) { items = seedDemo(); LS.set('mp_demo_items', items); }
  const settings = LS.get('mp_demo_settings', null) || demoSettings();
  switch (action) {
    case 'config': return { calendars: [{ id: 'demo-shared', name: '（例）夫婦の共有カレンダー' }], sharedCalId: LS.get('mp_demo_shared', 'demo-shared'), settings };
    case 'settings':
      if (p.settings) LS.set('mp_demo_settings', p.settings);
      if (p.sharedCalId != null) LS.set('mp_demo_shared', p.sharedCalId);
      return demoApi('config', {});
    case 'list': return { items, events: LS.get('mp_demo_shared', 'demo-shared') ? demoEvents() : [] };
    case 'save': {
      const it = Object.assign({}, p.item);
      if (!it.id) it.id = 'd' + Date.now().toString(36);
      it.updated = new Date().toISOString();
      delete it.calTitle; delete it.calDesc;
      const i = items.findIndex(x => x.id === it.id);
      if (i >= 0) items[i] = it; else items.push(it);
      LS.set('mp_demo_items', items);
      return it;
    }
    case 'remove':
      LS.set('mp_demo_items', items.filter(x => x.id !== p.id));
      return true;
  }
  throw new Error('不明な操作');
}
function demoSettings() {
  const t = new Date();
  return { runGoal: 100, studyGoal: 30, examName: '簿記2級', examDate: ymd(addDays(t, 45)), fundName: 'Mac mini', fundGoal: 200000, fundDate: ymd(addDays(t, 150)) };
}
function seedDemo() {
  const t = new Date(), d = n => ymd(addDays(t, n));
  let i = 0;
  const mk = o => Object.assign({ id: 'demo' + (i++), title: '', start: '', end: '', memo: '', data: {}, done: false, sync: 'mine' }, o);
  return [
    mk({ type: 'run', date: d(-6), start: '06:00', end: '06:40', data: { dist: 6, min: 36, sec: 30 }, done: true }),
    mk({ type: 'run', date: d(-3), start: '06:00', end: '06:45', data: { dist: 7.5, min: 44, sec: 10 }, done: true }),
    mk({ type: 'run', date: d(-1), start: '06:00', end: '07:00', data: { dist: 10, min: 58, sec: 0 }, done: true }),
    mk({ type: 'run', date: d(2), start: '06:00', end: '06:40', data: { dist: 6 } }),
    mk({ type: 'run', date: d(12), title: 'ハーフマラソン大会', data: { dist: 21.1 }, sync: 'shared' }),
    mk({ type: 'study', date: d(-2), start: '21:00', end: '22:00', data: { subject: '簿記2級', min: 60 }, done: true, sync: 'none' }),
    mk({ type: 'study', date: d(-1), start: '21:00', end: '22:30', data: { subject: '簿記2級', min: 90 }, done: true, sync: 'none' }),
    mk({ type: 'study', date: d(1), start: '21:00', end: '22:00', data: { subject: 'FP3級', min: 60 }, sync: 'none' }),
    mk({ type: 'money', date: d(-5), title: 'Mac mini 積み立て', data: { amount: 30000, kind: 'in' }, done: true }),
    mk({ type: 'money', date: d(20), title: 'Mac mini 積み立て', data: { amount: 30000, kind: 'in' } }),
    mk({ type: 'other', date: d(4), start: '19:00', end: '20:00', title: '家計の作戦会議', sync: 'shared' }),
  ];
}
function demoEvents() {
  const t = new Date(), d = n => ymd(addDays(t, n)), cal = '（例）夫婦の共有カレンダー';
  return [
    { id: 'e1', title: '（例）買い物', date: d(0), endDate: d(0), start: '10:00', end: '11:00', allDay: false, calName: cal, memo: '' },
    { id: 'e2', title: '（例）実家へ', date: d(6), endDate: d(7), start: '', end: '', allDay: true, calName: cal, memo: '' },
    { id: 'e3', title: '（例）歯医者', date: d(9), endDate: d(9), start: '15:00', end: '16:00', allDay: false, calName: cal, memo: '' },
  ];
}

/* ---------- 読み込み ---------- */
function monthGrid() {
  const f = state.view;
  const start = addDays(f, -f.getDay());
  const daysInMonth = new Date(f.getFullYear(), f.getMonth() + 1, 0).getDate();
  const weeks = Math.ceil((f.getDay() + daysInMonth) / 7);
  return { f, start, weeks, end: addDays(start, weeks * 7 - 1) };
}

let loadSeq = 0;
async function load() {
  const seq = ++loadSeq;
  const { start, end } = monthGrid();
  setStatus('読み込み中…');
  try {
    const r = await api('list', { from: ymd(start), to: ymd(end) });
    if (seq !== loadSeq) return;
    state.items = r.items || [];
    state.events = r.events || [];
    LS.set(cacheKey(), { items: state.items, settings: state.settings });
    setStatus('');
  } catch (e) {
    if (seq !== loadSeq) return;
    setStatus('未接続');
    toast('読み込めませんでした：' + e.message);
  }
  render();
}

async function loadConfig() {
  try {
    applyConfig(await api('config'));
  } catch (e) {
    toast('設定を読み込めませんでした：' + e.message);
  }
}
function applyConfig(c) {
  state.calendars = c.calendars || [];
  state.sharedCalId = c.sharedCalId || '';
  state.settings = c.settings || {};
}

/* ---------- 表示 ---------- */
function autoTitle(it) {
  const d = it.data || {};
  if (it.type === 'run') return 'ラン' + (d.dist ? ' ' + d.dist + 'km' : '');
  if (it.type === 'study') return (d.subject || '勉強') + (d.min ? ' ' + d.min + '分' : '');
  if (it.type === 'money') return '資金' + (d.amount ? ' ' + (d.kind === 'out' ? '−' : '＋') + num(d.amount).toLocaleString('ja-JP') + '円' : '');
  return '予定';
}
const titleOf = it => it.title || autoTitle(it);

function paceText(dist, secs) {
  if (!dist || !secs) return '';
  const p = Math.round(secs / dist);
  return Math.floor(p / 60) + "'" + pad(p % 60) + '"/km';
}
function detailOf(it) {
  const d = it.data || {};
  const parts = [];
  if (it.type === 'run') {
    if (d.dist) parts.push(d.dist + 'km');
    const secs = num(d.min) * 60 + num(d.sec);
    if (secs) parts.push(num(d.min) + '分' + (num(d.sec) ? pad(num(d.sec)) + '秒' : ''));
    const p = paceText(num(d.dist), secs); if (p) parts.push(p);
  } else if (it.type === 'study') {
    if (d.subject && it.title) parts.push(d.subject);
    if (d.min) parts.push(d.min + '分');
  } else if (it.type === 'money') {
    if (d.amount) parts.push((d.kind === 'out' ? '取り崩し ' : '積み立て ') + yen(num(d.amount)));
  }
  parts.unshift(it.done ? '実施済み' : '予定');
  return parts.join('・');
}
function calDesc(it) {
  const lines = [CATS[it.type].label + '｜' + detailOf(it)];
  if (it.memo) lines.push('', it.memo);
  lines.push('', '（マイプランから登録）');
  return lines.join('\n');
}

function entriesByDay() {
  const out = {};
  const add = (k, e) => { (out[k] = out[k] || []).push(e); };
  state.items.forEach(it => {
    if (!state.filters[it.type] || !it.date) return;
    add(it.date, { kind: 'item', it, id: it.id, start: it.start, end: it.end, title: titleOf(it), color: CATS[it.type].color, done: it.done });
  });
  if (state.filters.ext) {
    state.events.forEach(ev => {
      let d = parse(ev.date);
      const end = parse(ev.endDate || ev.date);
      for (let i = 0; i < 62 && d <= end; i++, d = addDays(d, 1)) {
        add(ymd(d), { kind: 'ext', ev, id: ev.id, start: ev.allDay ? '' : ev.start, end: ev.end, title: ev.title, color: EXT_COLOR });
      }
    });
  }
  Object.values(out).forEach(l => l.sort((a, b) => (a.start || '').localeCompare(b.start || '')));
  return out;
}

function render() {
  const f = state.view;
  $('#monthTitle').textContent = f.getFullYear() + '年' + (f.getMonth() + 1) + '月';
  $('#demoBanner').hidden = !isDemo();
  renderFilters();
  const map = entriesByDay();
  renderGrid(map);
  renderAgenda(map);
  renderSummary();
}

function renderFilters() {
  const list = Object.keys(CATS).map(k => ({ k, label: CATS[k].label, color: CATS[k].color }));
  if (isDemo() || state.sharedCalId) list.push({ k: 'ext', label: '共有カレンダーの予定', color: EXT_COLOR });
  $('#filters').innerHTML = list.map(x =>
    `<button type="button" class="fchip${state.filters[x.k] ? '' : ' off'}" data-k="${x.k}" style="--c:${x.color}"><i></i>${esc(x.label)}</button>`
  ).join('');
}

function chipHtml(e) {
  const cls = ['chip'];
  if (e.start) cls.push('timed');
  if (e.kind === 'ext') cls.push('ext');
  if (e.done) cls.push('done');
  return `<button type="button" class="${cls.join(' ')}" style="--c:${e.color}" data-kind="${e.kind}" data-id="${esc(e.id)}">` +
    (e.start ? `<span class="t">${esc(e.start)}</span>` : '') + (e.done ? '✓' : '') + esc(e.title) + '</button>';
}

function renderGrid(map) {
  const { f, start, weeks } = monthGrid();
  const today = ymd(new Date());
  const max = isWide() ? 4 : 3;
  let h = '';
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(start, i), k = ymd(d), list = map[k] || [];
    const cls = ['cell'];
    if (d.getMonth() !== f.getMonth()) cls.push('out');
    if (k === state.sel) cls.push('sel');
    if (d.getDay() === 0) cls.push('sun');
    if (d.getDay() === 6) cls.push('sat');
    const shown = list.length > max ? max - 1 : list.length;
    h += `<div class="${cls.join(' ')}" data-date="${k}"><span class="num${k === today ? ' today' : ''}">${d.getDate()}</span>`;
    list.slice(0, shown).forEach(e => { h += chipHtml(e); });
    if (list.length > shown) h += `<span class="more">他${list.length - shown}件</span>`;
    h += '</div>';
  }
  $('#grid').innerHTML = h;
}

function timeText(e) {
  if (!e.start) return '終日';
  return esc(e.start) + (e.end ? '<br>〜' + esc(e.end) : '');
}

function renderAgenda(map) {
  const d = parse(state.sel);
  const list = map[state.sel] || [];
  let h = `<div class="ag-head"><h2>${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）</h2><button type="button" class="ag-add" data-add="${state.sel}">＋ 追加</button></div>`;
  if (!list.length) h += '<div class="ag-empty">予定はありません</div>';
  list.forEach(e => {
    if (e.kind === 'item') {
      const it = e.it;
      h += `<button type="button" class="ag-row${it.done ? ' done' : ''}" style="--c:${e.color}" data-kind="item" data-id="${esc(it.id)}">` +
        `<span class="dot"></span><span class="ag-time">${timeText(e)}</span>` +
        `<span class="ag-main"><span class="ag-title">${esc(e.title)}</span><span class="ag-sub">${esc(CATS[it.type].label + '｜' + detailOf(it))}</span></span>` +
        `<span class="badge ${it.sync}">${SYNC_LABEL[it.sync] || ''}</span></button>`;
    } else {
      h += `<button type="button" class="ag-row ext" style="--c:${e.color}" data-kind="ext" data-id="${esc(e.id)}">` +
        `<span class="dot"></span><span class="ag-time">${timeText(e)}</span>` +
        `<span class="ag-main"><span class="ag-title">${esc(e.title)}</span><span class="ag-sub">${esc(e.ev.calName || '共有カレンダー')}</span></span></button>`;
    }
  });
  $('#agendaBox').innerHTML = h;
}

const card = (color, title, body) => `<section class="card" style="--c:${color}"><h3><i></i>${title}</h3>${body}</section>`;
const bar = (v, max) => `<div class="bar"><span style="width:${max > 0 ? Math.max(0, Math.min(100, v / max * 100)) : 0}%"></span></div>`;
const kv = (k, v) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`;
const daysUntil = s => Math.ceil((parse(s) - parse(ymd(new Date()))) / 86400000);
const round1 = n => Math.round(n * 10) / 10;

function renderSummary() {
  const f = state.view, s = state.settings || {};
  const prefix = f.getFullYear() + '-' + pad(f.getMonth() + 1);
  const month = state.items.filter(i => (i.date || '').startsWith(prefix));
  const days = new Date(f.getFullYear(), f.getMonth() + 1, 0).getDate();
  let h = `<div class="sum-title">${f.getMonth() + 1}月のまとめ</div>`;

  // ラン
  const runs = month.filter(i => i.type === 'run');
  const runDone = runs.filter(i => i.done);
  const dist = sum(runDone, i => num(i.data.dist));
  const planDist = sum(runs.filter(i => !i.done), i => num(i.data.dist));
  const timed = runDone.filter(i => num(i.data.min) || num(i.data.sec));
  const pace = paceText(sum(timed, i => num(i.data.dist)), sum(timed, i => num(i.data.min) * 60 + num(i.data.sec)));
  const daily = Array.from({ length: days }, (_, i) => sum(runDone.filter(r => r.date === prefix + '-' + pad(i + 1)), r => num(r.data.dist)));
  const maxDay = Math.max(1, ...daily);
  const runGoal = num(s.runGoal);
  h += card(CATS.run.color, 'ラン',
    `<div class="big">${round1(dist)}<small>${runGoal ? '/ ' + runGoal + ' km' : 'km'}</small></div>` +
    (runGoal ? bar(dist, runGoal) : '') +
    kv('走った回数', runDone.length + '回') +
    (pace ? kv('平均ペース', pace) : '') +
    (planDist ? kv('これからの予定', round1(planDist) + 'km') : '') +
    `<div class="spark">${daily.map(v => `<span class="${v ? '' : 'zero'}" style="height:${v ? Math.max(8, v / maxDay * 100) : 4}%"></span>`).join('')}</div>`);

  // 勉強
  const st = month.filter(i => i.type === 'study');
  const stDone = st.filter(i => i.done);
  const mins = sum(stDone, i => num(i.data.min));
  const goalMin = num(s.studyGoal) * 60;
  const bySub = {};
  stDone.forEach(i => { const k = i.data.subject || 'その他'; bySub[k] = (bySub[k] || 0) + num(i.data.min); });
  const maxSub = Math.max(1, ...Object.values(bySub));
  const hm = m => Math.floor(m / 60) + '時間' + (m % 60 ? (m % 60) + '分' : '');
  let exam = '';
  if (s.examDate) {
    const n = daysUntil(s.examDate);
    exam = kv((s.examName || '試験') + 'まで', n > 0 ? 'あと' + n + '日' : n === 0 ? '今日' : '終了');
  }
  h += card(CATS.study.color, '勉強',
    `<div class="big">${hm(mins)}<small>${goalMin ? '/ ' + num(s.studyGoal) + '時間' : ''}</small></div>` +
    (goalMin ? bar(mins, goalMin) : '') + exam +
    kv('勉強した日数', new Set(stDone.map(i => i.date)).size + '日') +
    (Object.keys(bySub).length ? '<div class="subj">' + Object.entries(bySub).sort((a, b) => b[1] - a[1]).map(([k, v]) => kv(esc(k), hm(v)) + bar(v, maxSub)).join('') + '</div>' : ''));

  // 資金（目標に向けた累計）
  const signed = i => (i.data.kind === 'out' ? -1 : 1) * num(i.data.amount);
  const money = state.items.filter(i => i.type === 'money');
  const total = sum(money.filter(i => i.done), signed);
  const monthNet = sum(month.filter(i => i.type === 'money' && i.done), signed);
  const goal = num(s.fundGoal);
  let fund = '';
  if (goal) {
    const rest = Math.max(0, goal - total);
    fund += bar(total, goal) + kv('達成率', Math.floor(total / goal * 100) + '%') + kv('あと', yen(rest));
    if (s.fundDate && rest > 0) {
      const dl = daysUntil(s.fundDate);
      if (dl > 0) {
        const months = Math.max(1, Math.ceil(dl / 30.4));
        fund += kv('期限まで', 'あと' + dl + '日') + kv('1か月あたり必要', yen(rest / months));
      } else fund += kv('期限', '過ぎています');
    }
  }
  h += card(CATS.money.color, '資金' + (s.fundName ? '（' + esc(s.fundName) + '）' : ''),
    `<div class="big">${yen(total)}<small>${goal ? '/ ' + yen(goal) : ''}</small></div>` + fund +
    kv('今月の積み立て', (monthNet < 0 ? '−' : '') + yen(Math.abs(monthNet))));

  if (!runGoal && !goalMin && !goal) h += '<p class="hint">右上の設定から目標を入れると、進み具合が表示されます。</p>';
  $('#summaryBox').innerHTML = h;
}

/* ---------- 予定の入力 ---------- */
function defaultSync(type) {
  const s = LS.get('mp_sync_' + type, 'mine');
  return s === 'shared' && !sharedAvailable() ? 'mine' : s;
}
const sharedAvailable = () => isDemo() || !!state.sharedCalId;

function openEditor(it, date) {
  if (it) {
    state.editing = JSON.parse(JSON.stringify(it));
  } else {
    const type = 'other'; // 新しい予定は「その他」から始める
    state.editing = { type, date: date || state.sel, title: '', start: '', end: '', memo: '', data: {}, done: date ? date < ymd(new Date()) : false, sync: defaultSync(type) };
  }
  const e = state.editing;
  $('#editTitle').textContent = e.id ? '予定を編集' : '予定を追加';
  $('#fTitle').value = e.title || '';
  $('#fDate').value = e.date;
  $('#fAllDay').checked = !e.start;
  $('#fStart').value = e.start || '06:00';
  $('#fEnd').value = e.end || '07:00';
  const d = e.data || {};
  $('#fDist').value = d.dist != null ? d.dist : '';
  $('#fMin').value = d.min != null ? d.min : '';
  $('#fSec').value = d.sec != null ? d.sec : '';
  $('#fSubject').value = d.subject || '';
  $('#fStudyMin').value = d.min != null && e.type === 'study' ? d.min : '';
  $('#fAmount').value = d.amount != null ? d.amount : '';
  $('#fKind').value = d.kind || 'in';
  $('#fDone').checked = !!e.done;
  $('#fMemo').value = e.memo || '';
  $('#delBtn').hidden = !e.id;
  const subs = new Set(state.items.filter(i => i.type === 'study' && i.data && i.data.subject).map(i => i.data.subject));
  if (state.settings.examName) subs.add(state.settings.examName);
  $('#subjects').innerHTML = Array.from(subs).map(x => `<option value="${esc(x)}">`).join('');
  const sharedOk = sharedAvailable();
  $('input[name=sync][value=shared]').disabled = !sharedOk;
  $('#sharedDesc').textContent = sharedOk ? '妻と共有しているカレンダーに入れる' : '設定で共有カレンダーを選ぶと使えます';
  setType(e.type, false);
  toggleTime();
  updatePace();
  $('#saveBtn').disabled = false;
  $('#editor').showModal();
}

function setType(t, fromUser) {
  const e = state.editing;
  e.type = t;
  $$('#fType button').forEach(b => { b.classList.toggle('on', b.dataset.v === t); b.style.setProperty('--c', CATS[b.dataset.v].color); });
  $$('.type-fields').forEach(x => x.classList.toggle('on', x.dataset.type === t));
  $('#doneLabel').textContent = CATS[t].done;
  const mineNames = { run: '「ラン計画」', study: '「勉強計画」', money: '「資金計画」', other: '「マイプラン」' };
  $('#mineDesc').textContent = '自分専用の' + mineNames[t] + 'カレンダーに入れる（妻には見えない）';
  if (fromUser && !e.id) e.sync = defaultSync(t);
  const r = $(`input[name=sync][value=${e.sync}]`);
  if (r && !r.disabled) r.checked = true; else $('input[name=sync][value=mine]').checked = true;
}

function toggleTime() { $('#timeRow').hidden = $('#fAllDay').checked; }
function updatePace() {
  const p = paceText(num($('#fDist').value), num($('#fMin').value) * 60 + num($('#fSec').value));
  $('#fPace').textContent = p || '—';
}

function readEditor() {
  const e = state.editing;
  const val = id => { const v = $(id).value; return v === '' ? '' : Number(v); };
  e.title = $('#fTitle').value.trim();
  e.date = $('#fDate').value;
  if ($('#fAllDay').checked) { e.start = ''; e.end = ''; } else { e.start = $('#fStart').value; e.end = $('#fEnd').value; }
  if (e.type === 'run') e.data = { dist: val('#fDist'), min: val('#fMin'), sec: val('#fSec') };
  else if (e.type === 'study') e.data = { subject: $('#fSubject').value.trim(), min: val('#fStudyMin') };
  else if (e.type === 'money') e.data = { amount: val('#fAmount'), kind: $('#fKind').value };
  else e.data = {};
  e.done = $('#fDone').checked;
  e.memo = $('#fMemo').value;
  e.sync = ($('input[name=sync]:checked') || {}).value || 'none';
  e.calTitle = (e.done ? '✓ ' : '') + titleOf(e);
  e.calDesc = calDesc(e);
  return e;
}

async function saveEditor(ev) {
  ev.preventDefault();
  if (!$('#fDate').value) { toast('日付を入れてください'); return; }
  const it = readEditor();
  $('#saveBtn').disabled = true;
  try {
    const saved = await api('save', { item: it });
    const i = state.items.findIndex(x => x.id === saved.id);
    if (i >= 0) state.items[i] = saved; else state.items.push(saved);
    LS.set('mp_sync_' + it.type, it.sync);
    LS.set(cacheKey(), { items: state.items, settings: state.settings });
    state.sel = saved.date;
    const sd = parse(saved.date);
    const moved = sd.getFullYear() !== state.view.getFullYear() || sd.getMonth() !== state.view.getMonth();
    if (moved) state.view = new Date(sd.getFullYear(), sd.getMonth(), 1);
    $('#editor').close();
    render();
    if (moved) load();
    const msg = { none: 'アプリに保存しました', mine: '保存して、自分のカレンダーに反映しました', shared: '保存して、夫婦の共有カレンダーに反映しました' }[it.sync];
    toast(isDemo() && it.sync !== 'none' ? '保存しました（お試し表示なのでカレンダーには入りません）' : msg);
  } catch (e) {
    toast('保存できませんでした：' + e.message);
    $('#saveBtn').disabled = false;
  }
}

async function deleteItem() {
  const it = state.editing;
  const extra = it.sync === 'shared' ? '\n夫婦の共有カレンダーからも消えます。' : it.sync === 'mine' ? '\n自分のカレンダーからも消えます。' : '';
  if (!confirm('この予定を削除しますか？' + extra)) return;
  try {
    await api('remove', { id: it.id });
    state.items = state.items.filter(x => x.id !== it.id);
    LS.set(cacheKey(), { items: state.items, settings: state.settings });
    $('#editor').close();
    render();
    toast('削除しました');
  } catch (e) {
    toast('削除できませんでした：' + e.message);
  }
}

function openExt(id) {
  const ev = state.events.find(x => x.id === id);
  if (!ev) return;
  const d = parse(ev.date);
  const when = d.getMonth() + 1 + '月' + d.getDate() + '日（' + WD[d.getDay()] + '）' +
    (ev.allDay ? (ev.endDate && ev.endDate !== ev.date ? '〜' + parse(ev.endDate).getDate() + '日' : '') + ' 終日' : ' ' + ev.start + '〜' + ev.end);
  $('#detailBody').innerHTML =
    `<div class="detail-title">${esc(ev.title)}</div>` +
    `<div class="detail-line">${esc(when)}</div>` +
    (ev.location ? `<div class="detail-line">場所：${esc(ev.location)}</div>` : '') +
    `<div class="detail-line">${esc(ev.calName || '共有カレンダー')}</div>` +
    (ev.memo ? `<div class="detail-line">${esc(ev.memo)}</div>` : '') +
    `<p class="hint">この予定はGoogleカレンダー側で作られたものです。変更はGoogleカレンダーのアプリから行ってください。</p>`;
  $('#detail').showModal();
}

/* ---------- 設定 ---------- */
function fillSharedSelect() {
  const sel = $('#sShared');
  sel.innerHTML = '<option value="">（まだ選んでいません）</option>' +
    state.calendars.map(c => `<option value="${esc(c.id)}">${esc(c.name)}${c.owned === false ? '（共有されたもの）' : ''}</option>`).join('');
  sel.value = state.sharedCalId || '';
}
function openSettings() {
  const s = state.settings || {};
  $('#sTheme').value = LS.get('mp_theme', 'auto');
  $('#accountName').textContent = isDemo() ? 'お試し表示中（未ログイン）'
    : state.session ? state.session.email : state.cfg.token ? '予備の合言葉で接続中' : '未ログイン';
  $('#logoutBtn').hidden = isDemo() || !state.session;
  $('#sUrl').value = state.cfg.apiUrl || '';
  $('#sToken').value = state.cfg.token || '';
  $('#testMsg').textContent = '';
  fillSharedSelect();
  $('#sRunGoal').value = s.runGoal || '';
  $('#sExamName').value = s.examName || '';
  $('#sExamDate').value = s.examDate || '';
  $('#sStudyGoal').value = s.studyGoal || '';
  $('#sFundName').value = s.fundName || '';
  $('#sFundGoal').value = s.fundGoal || '';
  $('#sFundDate').value = s.fundDate || '';
  $('#settings').showModal();
}
async function testConnection() {
  const cfg = { apiUrl: $('#sUrl').value.trim(), token: $('#sToken').value.trim() };
  if (!cfg.apiUrl) { $('#testMsg').textContent = '接続先URLを入れてください'; return; }
  $('#testMsg').textContent = '確認中…';
  try {
    const c = await api('config', {}, cfg);
    state.calendars = c.calendars || [];
    if (c.sharedCalId) state.sharedCalId = c.sharedCalId;
    fillSharedSelect();
    $('#testMsg').textContent = 'つながりました（カレンダー' + state.calendars.length + '件）';
  } catch (e) {
    $('#testMsg').textContent = 'つながりません：' + e.message;
  }
}
async function saveSettings(ev) {
  ev.preventDefault();
  const newCfg = { apiUrl: $('#sUrl').value.trim(), token: $('#sToken').value.trim() };
  const changed = newCfg.apiUrl !== state.cfg.apiUrl || newCfg.token !== state.cfg.token;
  const settings = {
    runGoal: $('#sRunGoal').value, examName: $('#sExamName').value.trim(), examDate: $('#sExamDate').value,
    studyGoal: $('#sStudyGoal').value, fundName: $('#sFundName').value.trim(), fundGoal: $('#sFundGoal').value, fundDate: $('#sFundDate').value,
  };
  state.cfg = newCfg;
  LS.set('mp_cfg', { apiUrl: newCfg.apiUrl === MPC.apiUrl ? '' : newCfg.apiUrl, token: newCfg.token });
  if (changed) {
    state.demoForced = false;
    state.items = (LS.get(cacheKey(), {}).items) || [];
    if (needsLogin()) { $('#settings').close(); render(); showLogin(); return; }
  }
  try {
    applyConfig(await api('settings', { settings, sharedCalId: $('#sShared').value }));
    $('#settings').close();
    toast('設定を保存しました');
  } catch (e) {
    toast('保存できませんでした：' + e.message);
    return;
  }
  render();
  load();
}

/* ---------- 操作 ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}
function setStatus(s) { $('#syncState').textContent = s; }
function moveMonth(n) {
  state.view = new Date(state.view.getFullYear(), state.view.getMonth() + n, 1);
  const sel = parse(state.sel);
  if (sel.getMonth() !== state.view.getMonth() || sel.getFullYear() !== state.view.getFullYear()) {
    const today = new Date();
    state.sel = today.getMonth() === state.view.getMonth() && today.getFullYear() === state.view.getFullYear() ? ymd(today) : ymd(state.view);
  }
  render();
  load();
}
function openEntry(kind, id) {
  if (kind === 'ext') openExt(id);
  else { const it = state.items.find(x => x.id === id); if (it) openEditor(it); }
}

function bind() {
  $('#prevBtn').onclick = () => moveMonth(-1);
  $('#nextBtn').onclick = () => moveMonth(1);
  $('#todayBtn').onclick = () => {
    const t = new Date();
    state.sel = ymd(t);
    state.view = new Date(t.getFullYear(), t.getMonth(), 1);
    render(); load();
  };
  $('#reloadBtn').onclick = () => { loadConfig().then(load); };
  $('#settingsBtn').onclick = openSettings;
  $('#fab').onclick = () => openEditor(null, state.sel);

  $('#filters').onclick = e => {
    const b = e.target.closest('.fchip'); if (!b) return;
    state.filters[b.dataset.k] = !state.filters[b.dataset.k];
    LS.set('mp_filters', state.filters);
    render();
  };
  $('#grid').onclick = e => {
    const chip = e.target.closest('.chip');
    const cell = e.target.closest('.cell'); if (!cell) return;
    const date = cell.dataset.date;
    if (chip && isWide()) { state.sel = date; render(); openEntry(chip.dataset.kind, chip.dataset.id); return; }
    if (date === state.sel && !isWide()) { openEditor(null, date); return; }
    if (date === state.sel && isWide() && !chip) { openEditor(null, date); return; }
    state.sel = date;
    const d = parse(date);
    if (d.getMonth() !== state.view.getMonth()) { state.view = new Date(d.getFullYear(), d.getMonth(), 1); render(); load(); return; }
    render();
  };
  $('#agendaBox').onclick = e => {
    const add = e.target.closest('[data-add]');
    if (add) { openEditor(null, add.dataset.add); return; }
    const row = e.target.closest('.ag-row');
    if (row) openEntry(row.dataset.kind, row.dataset.id);
  };
  $$('.tabbar button').forEach(b => { b.onclick = () => { document.body.dataset.tab = b.dataset.tab; window.scrollTo(0, 0); }; });

  // 入力画面
  $('#editForm').onsubmit = saveEditor;
  $('#fType').onclick = e => { const b = e.target.closest('button'); if (b) setType(b.dataset.v, true); };
  $('#fAllDay').onchange = toggleTime;
  ['#fDist', '#fMin', '#fSec'].forEach(id => { $(id).oninput = updatePace; });
  $('#fStart').onchange = () => {
    const s = $('#fStart').value, en = $('#fEnd').value;
    if (s && (!en || en <= s)) { const [h, m] = s.split(':').map(Number); $('#fEnd').value = pad(Math.min(23, h + 1)) + ':' + pad(m); }
  };
  $('#delBtn').onclick = deleteItem;
  $('#settingsForm').onsubmit = saveSettings;
  $('#sTheme').onchange = () => { LS.set('mp_theme', $('#sTheme').value); applyTheme($('#sTheme').value); };
  $('#logoutBtn').onclick = logout;
  $('#demoBtn').onclick = () => {
    state.demoForced = true;
    $('#login').hidden = true;
    state.items = (LS.get(cacheKey(), {}).items) || [];
    loadConfig().then(load);
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(LS.get('mp_theme', 'auto')));
  $('#testBtn').onclick = testConnection;
  $$('[data-close]').forEach(b => { b.onclick = () => b.closest('dialog').close(); });
  $$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

  // iPhone Duo を開いた・閉じたときに表示を切り替える
  wideMQ.addEventListener('change', render);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
}

async function init() {
  bind();
  applyTheme(LS.get('mp_theme', 'auto'));
  const cache = LS.get(cacheKey(), null);
  if (cache) { state.items = cache.items || []; state.settings = cache.settings || {}; }
  render();
  if (needsLogin()) { showLogin(); return; }
  await loadConfig();
  await load();
}
init();
