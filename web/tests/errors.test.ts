// Tes jenis galat (api.ts), markup keadaan galat (errorview.ts), dan inisial placeholder sampul (images.ts).
// Jalankan dari web/: npm test
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, errorKind, get } from '../src/lib/api.ts';
import { errorStateHtml, errorTitle, notFoundPageHtml, serverErrorPageHtml } from '../src/lib/errorview.ts';
import { initials } from '../src/lib/images.ts';

const g = globalThis as any;
const realFetch = g.fetch;
const navDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

afterEach(() => {
  g.fetch = realFetch;
  if (navDescriptor) Object.defineProperty(globalThis, 'navigator', navDescriptor);
});

let n = 0;
/** Panggil get() pada path baru (cache tidak ikut campur) dan kembalikan error yang dilempar. */
async function failure(fetchImpl: () => Promise<Response>): Promise<ApiError> {
  g.fetch = fetchImpl;
  try {
    await get(`/api/uji/${++n}`);
  } catch (e) {
    assert.ok(e instanceof ApiError, 'selalu ApiError, bukan TypeError/SyntaxError mentah');
    return e;
  }
  throw new Error('seharusnya melempar');
}

const envelope = (status: number, body: Record<string, unknown>) => async () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const raw = (status: number, text: string) => async () => new Response(text, { status });
const setOnline = (onLine: boolean | undefined) =>
  Object.defineProperty(globalThis, 'navigator', { value: { onLine }, configurable: true });

test('jenis galat dari status HTTP: 404/410 notfound, 408/504 timeout, sisanya server', async () => {
  assert.equal((await failure(envelope(404, { success: false, data: null, message: 'Data not found', code: 404 }))).kind, 'notfound');
  assert.equal((await failure(envelope(410, { success: false, data: null, message: 'x', code: 410 }))).kind, 'notfound');
  assert.equal((await failure(envelope(502, { success: false, data: null, message: 'Bad Gateway', code: 502 }))).kind, 'server');
  assert.equal((await failure(envelope(500, { success: false, data: null, message: 'boom', code: 500 }))).kind, 'server');
  assert.equal((await failure(envelope(504, { success: false, data: null, message: 'x', code: 504 }))).kind, 'timeout');
  assert.equal((await failure(envelope(408, { success: false, data: null, message: 'x', code: 408 }))).kind, 'timeout');
  // success:false tanpa code di body: pakai status HTTP
  assert.equal((await failure(envelope(503, { success: false, data: null, message: 'x' }))).kind, 'server');
});

test('respons bukan JSON (halaman galat proxy/nginx) tetap menghasilkan jenis dari statusnya', async () => {
  assert.equal((await failure(raw(503, '<html><h1>503 Service Temporarily Unavailable</h1></html>'))).kind, 'server');
  assert.equal((await failure(raw(502, '<html>Bad Gateway</html>'))).kind, 'server');
  assert.equal((await failure(raw(504, '<html>Gateway Time-out</html>'))).kind, 'timeout');
  assert.equal((await failure(raw(404, '<html>404 Not Found</html>'))).kind, 'notfound');
  assert.equal((await failure(raw(200, 'bukan json'))).kind, 'server');
});

test('fetch gagal: timeout, offline, dan API tidak terjangkau saat browser online', async () => {
  assert.equal((await failure(async () => { throw new DOMException('signal timed out', 'TimeoutError'); })).kind, 'timeout');

  setOnline(false);
  assert.equal((await failure(async () => { throw new TypeError('Failed to fetch'); })).kind, 'offline');

  // Online tetapi fetch ditolak (API mati, DNS, CORS): bukan "offline".
  setOnline(true);
  assert.equal((await failure(async () => { throw new TypeError('Failed to fetch'); })).kind, 'server');
  setOnline(undefined); // Node/SSR: tidak ada navigator.onLine
  assert.equal((await failure(async () => { throw new TypeError('Failed to fetch'); })).kind, 'server');
});

test('errorKind: ApiError membawa jenisnya, error lain unknown', () => {
  assert.equal(errorKind(new ApiError('x', 404)), 'notfound');
  assert.equal(errorKind(new ApiError('x', 0, 'offline')), 'offline');
  assert.equal(errorKind(new ApiError('x')), 'server');
  assert.equal(errorKind(new TypeError('render gagal')), 'unknown');
  assert.equal(errorKind('apa saja'), 'unknown');
});

const KINDS = ['notfound', 'server', 'timeout', 'offline', 'unknown'] as const;

test('errorStateHtml: hook [data-error-state] + data-error-kind untuk setiap jenis', () => {
  for (const kind of KINDS) {
    const page = errorStateHtml(kind);
    assert.ok(page.includes('data-error-state') && page.includes(`data-error-kind="${kind}"`), kind);
    assert.ok(page.includes('<h1 class="err-title">') && page.includes(errorTitle(kind)), `${kind}: halaman penuh memakai <h1>`);
    const compact = errorStateHtml(kind, { compact: true });
    assert.ok(compact.includes('err--compact') && !compact.includes('<h1') && compact.includes(`data-error-kind="${kind}"`), `${kind}: ringkas`);
  }
});

test('errorStateHtml: judul sesuai kontrak ("Konten tidak ditemukan", "Server sumber sedang bermasalah", ...)', () => {
  assert.equal(errorTitle('notfound'), 'Konten tidak ditemukan');
  assert.equal(errorTitle('server'), 'Server sumber sedang bermasalah');
  assert.equal(errorTitle('timeout'), 'Server terlalu lama merespons');
  assert.equal(errorTitle('offline'), 'Kamu sedang offline');
});

test('errorStateHtml: tombol Coba lagi [data-retry] kecuali notfound; notfound punya jalan keluar', () => {
  for (const kind of ['server', 'timeout', 'offline', 'unknown'] as const) {
    assert.ok(errorStateHtml(kind).includes('<button type="button" class="btn btn-primary" data-retry>Coba lagi</button>'), kind);
    assert.ok(errorStateHtml(kind, { compact: true }).includes('data-retry'), `${kind} ringkas`);
  }
  const nf = errorStateHtml('notfound');
  assert.ok(!nf.includes('data-retry'));
  assert.ok(nf.includes('href="/"') && nf.includes('href="/search/"'), 'beranda dan cari');
  assert.ok(errorStateHtml('notfound', { retry: 'button' }).includes('data-retry'), 'bisa dipaksa');
  assert.ok(errorStateHtml('server', { retry: false }).indexOf('data-retry') === -1);
  assert.ok(errorStateHtml('server', { compact: true, retryAttr: 'data-feed-retry' }).includes('data-retry data-feed-retry>'));
});

test('errorStateHtml: role="alert" hanya bila live; link retry tanpa JS memakai href kosong', () => {
  assert.ok(!errorStateHtml('server').includes('role="alert"'));
  assert.ok(errorStateHtml('server', { live: true }).includes('role="alert"'));
  const link = errorStateHtml('server', { retry: 'link' });
  assert.ok(link.includes('<a class="btn btn-primary" href="" data-retry>Coba lagi</a>') && !link.includes('<button'));
});

test('errorStateHtml: teks pengguna tidak pernah memuat status mentah ("HTTP 503") dan override di-escape', () => {
  for (const kind of KINDS) {
    const html = errorStateHtml(kind);
    assert.ok(!/HTTP|\b[45]\d\d\b|Unexpected|TypeError|Failed to fetch/i.test(html.replace(/<[^>]*>/g, ' ')), kind);
  }
  const html = errorStateHtml('server', { title: '<b>x</b>', text: '"<script>"', code: '<5xx>' });
  assert.ok(!html.includes('<b>x') && !html.includes('<script') && !html.includes('<5xx'));
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
});

test('halaman 404 dan 50x: markup yang sama dengan keadaan di aplikasi', () => {
  const nf = notFoundPageHtml();
  assert.ok(nf.includes('Halaman tidak ditemukan') && nf.includes('err-code') && nf.includes('>404<'));
  assert.ok(nf.includes('data-error-kind="notfound"') && !nf.includes('role="alert"'));
  assert.ok(notFoundPageHtml(true).includes('role="alert"'), 'mountUnknown menyisipkannya setelah halaman tampil');
  const sv = serverErrorPageHtml();
  assert.ok(sv.includes('Layanan sedang tidak tersedia') && sv.includes('data-error-kind="server"'));
  assert.ok(sv.includes('href="" data-retry') && !sv.includes('<button'), 'tanpa JS: tautan, bukan tombol');
  assert.ok(sv.includes('href="/"'));
});

test('initials: inisial placeholder sampul', () => {
  assert.equal(initials('One Piece'), 'OP');
  assert.equal(initials('solo'), 'S');
  assert.equal(initials('The Beginning After the End'), 'TB');
  assert.equal(initials('  '), '?');
  assert.equal(initials('!!! ???'), '?');
  assert.equal(initials('한국어 만화'), '한만');
  assert.equal(initials('<b>x</b>'), 'B', 'tanda baca dibuang; hasilnya teks biasa');
});
