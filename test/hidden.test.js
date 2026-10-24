'use strict';
// Uji fitur "Sembunyikan Room dari List Server": registry, HTTP sungguhan, dan kode klien (index.html) terhadap server nyata.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Registry } = require('../server/rooms');
const { createHandler } = require('../server/http');

async function start(opts = {}) {
  const reg = new Registry(opts.reg);
  const h = createHandler(reg, {});
  const srv = http.createServer((q, s) => h(q, s, () => { s.statusCode = 404; s.end('{}'); }));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  return { reg, srv, base, close: () => new Promise(r => srv.close(r)) };
}
const J = (base, p, method = 'GET', body) =>
  fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

test('registry: room tersembunyi tidak ada di list, tetap tersimpan; default publik', () => {
  const r = new Registry();
  r.create({ id: 'PUBL' });
  const h = r.create({ id: 'HIDE', hidden: true });
  assert.strictEqual(h.hidden, true);
  assert.deepStrictEqual(r.list('online').map(x => x.id), ['PUBL']);
  assert.deepStrictEqual(r.list().map(x => x.id), ['PUBL']);
  assert.strictEqual(r.size(), 2);
  assert.strictEqual(r.publicSize(), 1);
  assert.throws(() => r.create({ id: 'HIDE' }), { code: 'id_taken' }, 'ID room tersembunyi tetap terpakai');
  assert.throws(() => r.create({ id: 'XXXX', hidden: 'ya' }), { code: 'bad_hidden' });
});

test('registry: hidden ditetapkan saat membuat & TIDAK bisa diubah saat berjalan; token wajib', () => {
  const r = new Registry();
  const a = r.create({ id: 'ABCD', max: 4, hidden: true });
  // heartbeat biasa (players/status) tidak mengubah status hidden; nilai hidden yang sama diterima
  r.heartbeat('ABCD', 'online', a.token, { players: 3, status: 'BERMAIN', hidden: true });
  r.heartbeat('ABCD', 'online', a.token, { players: 2 });
  assert.strictEqual(r.list().length, 0);
  // mengubah hidden lewat heartbeat ditolak (opsi hanya saat membuat server)
  assert.throws(() => r.heartbeat('ABCD', 'online', a.token, { hidden: false }), { code: 'hidden_immutable' });
  assert.throws(() => r.heartbeat('ABCD', 'online', 'salah', { hidden: false }), { code: 'bad_token' });
  assert.throws(() => r.heartbeat('ABCD', 'online', a.token, { hidden: 'false' }), { code: 'bad_hidden' });
  assert.strictEqual(r.list().length, 0, 'room tetap tersembunyi');
  const b = r.create({ id: 'PUBL' });
  assert.throws(() => r.heartbeat('PUBL', 'online', b.token, { hidden: true }), { code: 'hidden_immutable' });
  assert.deepStrictEqual(r.list().map(x => x.id), ['PUBL'], 'room publik tidak bisa disembunyikan setelah dibuat');
});

test('registry: hidden hanya untuk mode online (LAN menolak hidden:true)', () => {
  const r = new Registry();
  assert.throws(() => r.create({ id: 'LANN', mode: 'lan', hidden: true }), { code: 'hidden_online_only' });
  const l = r.create({ id: 'LANN', mode: 'lan' });
  assert.strictEqual(l.hidden, false);
  assert.deepStrictEqual(r.list('lan').map(x => x.id), ['LANN']);
  r.create({ id: 'LANF', mode: 'lan', hidden: false });
  assert.strictEqual(r.list('lan').length, 2);
});

test('registry: room tersembunyi tetap kedaluwarsa & dibersihkan seperti biasa', () => {
  let t = 1000;
  const r = new Registry({ ttlMs: 20000, now: () => t });
  r.create({ id: 'HIDE', hidden: true });
  t += 30000;
  r.sweep();
  assert.strictEqual(r.size(), 0);
});

test('HTTP: POST hidden -> tidak muncul di GET (berkali-kali refresh); /health tidak membocorkan jumlah', async () => {
  const s = await start();
  const c = await J(s.base, '/api/rooms', 'POST', { id: 'ABCD', name: 'Rahasia', hostName: 'Host', mode: 'online', hidden: true });
  assert.strictEqual(c.status, 201);
  assert.strictEqual(c.body.hidden, true);
  await J(s.base, '/api/rooms', 'POST', { id: 'WXYZ', name: 'Publik', hostName: 'Host', mode: 'online' });
  for (let i = 0; i < 3; i++) {
    // heartbeat host + refresh daftar oleh pemain lain: room tersembunyi tidak boleh muncul
    assert.strictEqual((await J(s.base, '/api/rooms/ABCD', 'PUT', { mode: 'online', token: c.body.token, players: 2 + i % 2, status: 'LOBBY', hidden: true })).status, 200);
    const l = await J(s.base, '/api/rooms?mode=online');
    assert.deepStrictEqual(l.body.rooms.map(r => r.id), ['WXYZ']);
    assert.ok(!JSON.stringify(l.body).includes('Rahasia') && !JSON.stringify(l.body).includes('ABCD'));
  }
  assert.strictEqual((await J(s.base, '/api/rooms')).body.rooms.length, 1, 'tanpa filter mode pun tidak bocor');
  assert.strictEqual((await J(s.base, '/health')).body.rooms, 1);
  assert.strictEqual((await J(s.base, '/api/rooms/ABCD')).status, 404, 'tidak ada endpoint lookup per-ID');
  assert.strictEqual((await J(s.base, '/api/rooms', 'POST', { id: 'QQQQ', hidden: 'true' })).status, 400);
  assert.strictEqual((await J(s.base, '/api/rooms', 'POST', { id: 'LANN', mode: 'lan', hidden: true })).status, 400);
  await s.close();
});

test('HTTP: hidden tidak bisa diubah via PUT (token benar maupun salah)', async () => {
  const s = await start();
  const c = await J(s.base, '/api/rooms', 'POST', { id: 'ABCD', name: 'Uji', mode: 'online', hidden: true });
  const tok = c.body.token;
  let r = await J(s.base, '/api/rooms/ABCD', 'PUT', { mode: 'online', token: tok, hidden: false });
  assert.deepStrictEqual([r.status, r.body.code], [400, 'hidden_immutable']);
  assert.strictEqual((await J(s.base, '/api/rooms/ABCD', 'PUT', { mode: 'online', token: 'x'.repeat(32), hidden: false })).status, 403);
  assert.strictEqual((await J(s.base, '/api/rooms?mode=online')).body.rooms.length, 0);
  r = await J(s.base, '/api/rooms/ABCD', 'PUT', { mode: 'online', token: tok, players: 2, status: 'BERMAIN', hidden: true });
  assert.deepStrictEqual([r.status, r.body.hidden, r.body.status], [200, true, 'BERMAIN']);
  assert.strictEqual(s.reg.rooms.size, 1);
  await s.close();
});

// ---- kode klien nyata dari index.html, dijalankan terhadap server HTTP nyata ----
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Potong HTML menjadi elemen overlay (id="...") untuk memeriksa di layar mana sebuah elemen berada.
const section = id => { const i = html.indexOf('<div id="' + id + '"'); assert.ok(i >= 0, id); const n = html.indexOf('\n', i); return html.slice(i, n < 0 ? undefined : n); };

test('index.html: checkbox hidden HANYA di form Buat Server online (bukan join, lobi, jeda, LAN)', () => {
  assert.strictEqual((html.match(/type="checkbox" id="ohd"/g) || []).length, 1);
  assert.ok(section('ocf').includes('id="ohd"') || section('mo').includes('id="ohd"'));
  const mo = section('mo');
  const ocf = mo.slice(mo.indexOf('<div id="ocf"'), mo.indexOf('<div class="orow mr2">'));
  assert.ok(ocf.includes('id="ohd"'), 'ada di dalam form Buat Server');
  assert.ok(!mo.slice(mo.indexOf('<div class="orow mr2">')).includes('id="ohd"'), 'tidak di bagian GABUNG ID');
  assert.ok(!mo.slice(0, mo.indexOf('<div id="ocf"')).includes('id="ohd"'), 'tidak di bagian daftar/cari server');
  assert.ok(!section('mp').includes('Sembunyikan'), 'lobi + LAN bersih');
  assert.ok(!section('pause').includes('Sembunyikan'), 'menu jeda bersih');
  assert.strictEqual((html.match(/Sembunyikan Room dari List Server/g) || []).length, 1, 'teks hanya muncul sekali');
  for (const id of ['mhd', 'phd', 'mhk', 'phk', 'mhs', 'phs']) assert.ok(!html.includes('id="' + id + '"') && !html.includes("'" + id + "'") && !html.includes('$(\'' + id + '\')'), id + ' sudah dihapus');
  assert.ok(!/setHidden|hidUI/.test(html), 'tidak ada toggle saat room berjalan');
});

test('index.html: alur pembuatan mengirim hidden hanya untuk online; checkbox default off & di-reset', () => {
  assert.ok(html.includes("mpJoin(CODE(),1,OMX,'online',n,$('ohd').checked)"));
  assert.ok(/net=='online'&&!!hidden/.test(html), 'LAN selalu hidden=false');
  assert.ok(!/id="ohd"[^>]*checked/.test(html), 'default tidak dicentang');
  assert.ok(html.includes("osnAuto();$('ohd').checked=false"), 'direset tiap form dibuka');
  // join (mpJoin tanpa host / GABUNG ID) tidak membawa hidden
  assert.ok(!/\$\('ojn'\)\.onclick[^;]*ohd/.test(html));
});

function clientWorld(base) {
  const m = /\/\/ --- registry client[\s\S]*?(?=addEventListener\('pagehide')/.exec(html);
  assert.ok(m, 'blok registry klien tidak ditemukan');
  const els = {};
  const el = id => els[id] || (els[id] = { id, checked: false, disabled: false, textContent: '' });
  const ctx = {
    $: el, S: { host: 1, mp: 0, peers: [{}, {}] }, C: { name: 'Host' }, performance, setInterval, clearInterval, setTimeout, clearTimeout, console,
    fj: (url, ms, opt) => fetch(url, opt).then(async r => { const j = await r.json().catch(() => null); if (!r.ok) throw { type: 'http', status: r.status, msg: j && j.error }; return j; }),
    errMsg: e => (e && e.msg) || 'error',
    navigator: {}, fetch,
  };
  vm.createContext(ctx);
  vm.runInContext("const api=(b,p,o)=>fj(b+p,8000,o&&o.body?Object.assign({headers:{'Content-Type':'application/json'}},o):o);", ctx);
  vm.runInContext(m[0].replace(/^\/\/.*$/m, ''), ctx);
  vm.runInContext('globalThis.__x={regStart,regStop,regSync,getREG:()=>REG};', ctx);
  return { x: ctx.__x, els, ctx };
}

test('klien nyata: room tersembunyi tak pernah tampil, tetap hidup setelah heartbeat & daftar ulang (server restart)', async () => {
  const s = await start();
  const { x } = clientWorld(s.base + '/api');
  const api = s.base + '/api';
  await x.regStart({ api }, 'online', 'HIDE', 'Server Uji', 4, true);
  assert.strictEqual(x.getREG().hidden, true);
  assert.strictEqual((await J(s.base, '/api/rooms?mode=online')).body.rooms.length, 0, 'sejak registrasi pertama sudah tersembunyi');
  assert.strictEqual(s.reg.rooms.size, 1, 'room tetap terdaftar di server (bukan dihapus)');
  x.regSync(1);
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual((await J(s.base, '/api/rooms?mode=online')).body.rooms.length, 0, 'heartbeat tidak membuka room');
  // server kehilangan room (mis. restart) -> klien mendaftar ulang dan TETAP tersembunyi
  s.reg.rooms.clear();
  x.regSync(1);
  await new Promise(r => setTimeout(r, 200));
  assert.strictEqual(s.reg.rooms.size, 1, 'terdaftar ulang');
  assert.strictEqual([...s.reg.rooms.values()][0].hidden, true);
  assert.strictEqual((await J(s.base, '/api/rooms?mode=online')).body.rooms.length, 0);
  x.regStop();
  await s.close();
});

test('klien nyata: room publik (hidden off) tampil; LAN selalu publik', async () => {
  const s = await start();
  const { x } = clientWorld(s.base + '/api');
  const api = s.base + '/api';
  await x.regStart({ api }, 'online', 'ONLN', 'Online', 4, false);
  assert.deepStrictEqual((await J(s.base, '/api/rooms?mode=online')).body.rooms.map(r => r.id), ['ONLN']);
  x.regStop();
  await x.regStart({ api }, 'lan', 'LANN', 'LAN Uji', 4, false);
  assert.deepStrictEqual((await J(s.base, '/api/rooms?mode=lan')).body.rooms.map(r => r.id), ['LANN']);
  x.regStop();
  await s.close();
});
