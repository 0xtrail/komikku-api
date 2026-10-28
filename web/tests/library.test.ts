// Tes logika murni src/lib/library.ts (bookmark, riwayat, impor/ekspor, event) dengan localStorage palsu.
// Jalankan dari web/: npm test   (= node --experimental-strip-types --test tests/)
// Berkas ini dijalankan Node apa adanya (strip types): tanpa dependensi, tanpa bundler.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const LIB_URL = new URL('../src/lib/library.ts', import.meta.url).href;
const KEY = 'mr:lib:v1';
const BACKUP = 'mr:lib:v1:corrupt';

class FakeStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
}

let n = 0;
/** Instance modul segar (cache ESM per URL) + storage palsu baru. */
async function fresh(storage: unknown = new FakeStorage()) {
  (globalThis as any).localStorage = storage;
  const lib = await import(`${LIB_URL}?i=${++n}`);
  return { lib, storage: storage as FakeStorage };
}

// Jam palsu yang maju 1 detik tiap dibaca: urutan "terbaru" jadi deterministik.
let clock = 1_700_000_000_000;
const realNow = Date.now;
before(() => { Date.now = () => (clock += 1000); });
after(() => { Date.now = realNow; });

const meta = (slug: string, extra: Record<string, unknown> = {}) => ({ slug, title: `Judul ${slug}`, cover: `https://img.example/${slug}.jpg`, type: 'Manhwa', ...extra });
const ch = (slug: string, name = slug) => ({ slug, name });
const save = (lib: any, slug: string, chapter: string, page = 0, extra: Record<string, unknown> = {}) =>
  lib.saveProgress({ manga: meta(slug), chapter: ch(chapter, `Chapter ${chapter}`), page, pageCount: 20, offset: 0, ...extra });

test('bookmark: toggle, urutan terbaru, persist, remove', async () => {
  const { lib, storage } = await fresh();
  assert.deepEqual(lib.getBookmarks(), []);
  assert.equal(lib.toggleBookmark(meta('a')), true);
  assert.equal(lib.toggleBookmark(meta('b')), true);
  assert.equal(lib.isBookmarked('a'), true);
  assert.deepEqual(lib.getBookmarks().map((b) => b.slug), ['b', 'a'], 'terbaru dulu');
  const saved = JSON.parse(storage.getItem(KEY));
  assert.equal(saved.v, 1);
  assert.deepEqual(Object.keys(saved.bookmarks).sort(), ['a', 'b']);
  assert.equal(lib.toggleBookmark(meta('a')), false);
  assert.equal(lib.isBookmarked('a'), false);
  lib.removeBookmark('b');
  assert.deepEqual(lib.getBookmarks(), []);
  assert.equal(lib.toggleBookmark({ slug: '', title: 'x', cover: '' }), false, 'slug kosong ditolak');
  // sampul dengan skema berbahaya dikosongkan, bukan disimpan
  lib.toggleBookmark(meta('c', { cover: 'javascript:alert(1)' }));
  assert.equal(lib.getBookmarks()[0].cover, '');
});

test('saveProgress: posisi, read, markChapterRead, isChapterRead', async () => {
  const { lib } = await fresh();
  save(lib, 'm1', 'm1-chapter-1', 3, { offset: 0.4 });
  let p = lib.getProgress('m1');
  assert.deepEqual([p.page, p.pageCount, p.offset, p.chapter.slug], [3, 20, 0.4, 'm1-chapter-1']);
  assert.deepEqual(p.read, ['m1-chapter-1']);
  const t1 = p.updatedAt;
  save(lib, 'm1', 'M1-Chapter-2', 0);
  save(lib, 'm1', 'm1-chapter-1', 7); // chapter lama dibuka lagi: tidak ganda
  p = lib.getProgress('m1');
  assert.deepEqual(p.read, ['m1-chapter-1', 'm1-chapter-2'], 'huruf kecil, tanpa duplikat, terbaru di akhir');
  assert.equal(p.chapter.slug, 'm1-chapter-1');
  assert.ok(p.updatedAt > t1);
  assert.equal(lib.isChapterRead('m1', 'M1-CHAPTER-2'), true, 'tak peduli huruf besar/kecil');
  assert.equal(lib.isChapterRead('m1', 'm1-chapter-9'), false);
  assert.equal(lib.isChapterRead('nope', 'x'), false);
  const before = lib.getProgress('m1').updatedAt;
  lib.markChapterRead('m1', 'm1-chapter-5');
  p = lib.getProgress('m1');
  assert.deepEqual(p.read.at(-1), 'm1-chapter-5');
  assert.equal(p.updatedAt, before, 'markChapterRead tidak menggeser posisi/waktu');
  assert.equal(p.chapter.slug, 'm1-chapter-1');
  lib.markChapterRead('belum-ada', 'x');
  assert.equal(lib.getProgress('belum-ada'), undefined, 'tanpa riwayat: tidak membuat entri');
  // nilai aneh dinormalkan
  lib.saveProgress({ manga: meta('m2'), chapter: ch('m2-chapter-1', 'C1'), page: -5, pageCount: NaN, offset: 7 });
  const q = lib.getProgress('m2');
  assert.deepEqual([q.page, q.pageCount, q.offset], [0, 0, 1]);
});

test('riwayat: urutan terbaru, batas 300 riwayat, batas read 2000', async () => {
  const { lib } = await fresh();
  for (let i = 0; i < 305; i++) save(lib, `s${i}`, `s${i}-chapter-1`);
  const h = lib.getHistory();
  assert.equal(h.length, 300);
  assert.equal(h[0].slug, 's304');
  assert.equal(h.at(-1).slug, 's5', 's0..s4 (tertua) dibuang');
  assert.equal(lib.getProgress('s0'), undefined);
  save(lib, 's10', 's10-chapter-2'); // s10 kini paling baru
  assert.equal(lib.getHistory()[0].slug, 's10');
  for (let i = 0; i < 2005; i++) lib.markChapterRead('s10', `s10-chapter-${100 + i}`);
  const r = lib.getProgress('s10').read;
  assert.equal(r.length, 2000);
  assert.equal(r.at(-1), 's10-chapter-2104', 'yang terbaru dipertahankan');
  assert.equal(r.includes('s10-chapter-1'), false, 'yang tertua dibuang');
  lib.removeHistory('s10');
  assert.equal(lib.getProgress('s10'), undefined);
  lib.clearHistory();
  assert.deepEqual(lib.getHistory(), []);
});

test('ekspor -> impor: round-trip ke storage kosong', async () => {
  const a = await fresh();
  a.lib.toggleBookmark(meta('b1'));
  a.lib.toggleBookmark(meta('b2', { type: undefined }));
  save(a.lib, 'p1', 'p1-chapter-1', 2);
  save(a.lib, 'p1', 'p1-chapter-2', 5);
  const dump = a.lib.exportJSON();
  const b = await fresh();
  const res = b.lib.importJSON(dump);
  assert.deepEqual(res, { bookmarks: 2, history: 1 });
  assert.deepEqual(JSON.parse(b.lib.exportJSON()), JSON.parse(dump), 'isi identik setelah round-trip');
});

test('impor: gabung (bookmark gabungan, riwayat terbaru menang, read disatukan)', async () => {
  const a = await fresh();
  a.lib.toggleBookmark(meta('x'));
  a.lib.toggleBookmark(meta('only-a'));
  save(a.lib, 'shared', 'shared-chapter-1', 1);
  save(a.lib, 'shared', 'shared-chapter-2', 9); // terbaru di A
  save(a.lib, 'older', 'older-chapter-1', 4);
  const dumpA = a.lib.exportJSON();

  const b = await fresh();
  save(b.lib, 'older', 'older-chapter-3', 8); // lebih baru dari A, tapi dibuat setelahnya?
  b.lib.toggleBookmark(meta('only-b'));
  save(b.lib, 'shared', 'shared-chapter-1', 0); // lebih tua dari A: harus kalah
  const stampB = JSON.parse(b.lib.exportJSON()).progress;
  // shared di B ditulis SETELAH A (jam palsu naik terus) -> B menang; paksa skenario eksplisit:
  const crafted = JSON.parse(dumpA);
  crafted.progress.shared.updatedAt = stampB.shared.updatedAt + 10_000; // A lebih baru
  crafted.progress.older.updatedAt = stampB.older.updatedAt - 10_000; // A lebih tua
  const res = b.lib.importJSON(JSON.stringify(crafted));
  assert.deepEqual(res, { bookmarks: 2, history: 2 });
  assert.deepEqual(b.lib.getBookmarks().map((x) => x.slug).sort(), ['only-a', 'only-b', 'x']);
  const shared = b.lib.getProgress('shared');
  assert.equal(shared.page, 9, 'updatedAt lebih baru (dari berkas) menang');
  assert.deepEqual(shared.read, ['shared-chapter-1', 'shared-chapter-2'], 'read disatukan tanpa duplikat');
  const older = b.lib.getProgress('older');
  assert.equal(older.chapter.slug, 'older-chapter-3', 'lokal lebih baru: tetap menang');
  assert.deepEqual(older.read.sort(), ['older-chapter-1', 'older-chapter-3'], 'read tetap disatukan');
});

test('impor: input tidak valid -> Error ramah, tidak mengubah apa pun', async () => {
  const { lib } = await fresh();
  save(lib, 'keep', 'keep-chapter-1');
  const snapshot = lib.exportJSON();
  const good = JSON.parse(snapshot);
  const cases = {
    'bukan JSON': 'ini bukan json',
    'null': 'null',
    'array': '[]',
    'versi salah': JSON.stringify({ v: 2, bookmarks: {}, progress: {} }),
    'bookmarks array': JSON.stringify({ v: 1, bookmarks: [], progress: {} }),
    'sampul javascript:': JSON.stringify({ v: 1, bookmarks: { z: { slug: 'z', title: 't', cover: 'javascript:alert(1)', addedAt: 1 } }, progress: {} }),
    'slug tak cocok kunci': JSON.stringify({ v: 1, bookmarks: { z: { slug: 'y', title: 't', cover: '', addedAt: 1 } }, progress: {} }),
    'addedAt string': JSON.stringify({ v: 1, bookmarks: { z: { slug: 'z', title: 't', cover: '', addedAt: '1' } }, progress: {} }),
    'progress tanpa chapter': JSON.stringify({ v: 1, bookmarks: {}, progress: { z: { ...good.progress.keep, slug: 'z', chapter: undefined } } }),
    'read berisi angka': JSON.stringify({ v: 1, bookmarks: {}, progress: { z: { ...good.progress.keep, slug: 'z', read: [1] } } }),
    'satu entri rusak di antara yang valid': JSON.stringify({ v: 1, bookmarks: { ok: { slug: 'ok', title: 't', cover: '', addedAt: 1 }, bad: 5 }, progress: {} }),
  };
  for (const [label, text] of Object.entries(cases)) {
    assert.throws(() => lib.importJSON(text), (e) => e instanceof Error && /^(Berkas|Versi|Data)/.test(e.message) && !/Unexpected|position|TypeError/.test(e.message), label);
  }
  assert.equal(lib.exportJSON(), snapshot, 'atomik: tidak ada perubahan setelah semua penolakan');
});

test('storage rusak: pulih tanpa melempar, cadangan sekali', async () => {
  const s = new FakeStorage();
  s.setItem(KEY, '{bukan json');
  const { lib } = await fresh(s);
  assert.deepEqual(lib.getBookmarks(), []);
  assert.deepEqual(lib.getHistory(), []);
  assert.equal(s.getItem(BACKUP), '{bukan json', 'salinan data rusak diselamatkan');
  lib.toggleBookmark(meta('baru'));
  assert.equal(JSON.parse(s.getItem(KEY)).bookmarks.baru.slug, 'baru', 'tulisan berikutnya menimpa kunci utama');
  assert.equal(s.getItem(BACKUP), '{bukan json');

  // rusak lagi dengan isi berbeda: cadangan pertama TIDAK ditimpa
  s.setItem(KEY, '[[[kedua');
  const again = await fresh(s);
  assert.deepEqual(again.lib.getHistory(), []);
  assert.equal(s.getItem(BACKUP), '{bukan json');

  // versi masa depan / bentuk salah diperlakukan sama (tidak ditimpa diam-diam)
  const s2 = new FakeStorage();
  s2.setItem(KEY, JSON.stringify({ v: 2, bookmarks: {}, progress: {} }));
  const f = await fresh(s2);
  assert.deepEqual(f.lib.getBookmarks(), []);
  assert.ok(s2.getItem(BACKUP)?.includes('"v":2'));

  // entri rusak di dalam data yang valid: dibuang, sisanya selamat
  const s3 = new FakeStorage();
  s3.setItem(KEY, JSON.stringify({ v: 1, bookmarks: { ok: { slug: 'ok', title: 't', cover: '', addedAt: 1 }, bad: { slug: 'bad' } }, progress: {} }));
  const g = await fresh(s3);
  assert.deepEqual(g.lib.getBookmarks().map((x) => x.slug), ['ok']);
});

test('storage melempar / tidak ada: fallback memori', async () => {
  // 1) getItem & setItem melempar
  const boom = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); }, removeItem() { throw new Error('x'); } };
  let { lib } = await fresh(boom);
  assert.equal(lib.toggleBookmark(meta('mem')), true);
  save(lib, 'mem', 'mem-chapter-1', 2);
  assert.equal(lib.isBookmarked('mem'), true);
  assert.equal(lib.getProgress('mem').page, 2);
  assert.deepEqual(JSON.parse(lib.exportJSON()).bookmarks.mem.slug, 'mem');
  assert.deepEqual(lib.importJSON(lib.exportJSON()), { bookmarks: 1, history: 1 });

  // 2) mengakses localStorage sendiri melempar (mode privat/diblokir)
  delete globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
  const lib2 = (await import(`${LIB_URL}?i=${++n}`));
  assert.equal(lib2.toggleBookmark(meta('x')), true);
  assert.equal(lib2.getBookmarks().length, 1);

  // 3) tidak ada localStorage sama sekali (build Node)
  delete globalThis.localStorage;
  const lib3 = (await import(`${LIB_URL}?i=${++n}`));
  save(lib3, 'y', 'y-chapter-1');
  assert.equal(lib3.getHistory().length, 1);
});

test('import modul tidak menyentuh window/localStorage', async () => {
  delete globalThis.localStorage;
  delete globalThis.window;
  const lib = await import(`${LIB_URL}?i=${++n}`);
  assert.equal(typeof lib.getBookmarks, 'function');
});

test('subscribe: perubahan lokal, event storage lintas-tab, pageshow bfcache', async () => {
  const win = new EventTarget();
  globalThis.window = win;
  const { lib, storage } = await fresh();
  let calls = 0;
  const off = lib.subscribe(() => calls++);
  lib.toggleBookmark(meta('s1'));
  save(lib, 's1', 's1-chapter-1');
  assert.equal(calls, 2, 'tiap perubahan lokal memanggil pendengar');

  // tab lain menulis langsung ke storage lalu menembakkan event storage
  const other = JSON.parse(storage.getItem(KEY));
  other.bookmarks.dari_tab_lain = { slug: 'dari_tab_lain', title: 'T', cover: '', addedAt: 5 };
  storage.setItem(KEY, JSON.stringify(other));
  assert.equal(lib.isBookmarked('dari_tab_lain'), false, 'belum tahu sebelum event');
  win.dispatchEvent(Object.assign(new Event('storage'), { key: KEY }));
  assert.equal(calls, 3);
  assert.equal(lib.isBookmarked('dari_tab_lain'), true, 'dibaca ulang dari storage');
  win.dispatchEvent(Object.assign(new Event('storage'), { key: 'kunci-lain' }));
  assert.equal(calls, 3, 'kunci lain diabaikan');

  // bfcache
  win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
  assert.equal(calls, 3);
  win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  assert.equal(calls, 4);

  off();
  lib.toggleBookmark(meta('s2'));
  assert.equal(calls, 4, 'berhenti berlangganan');
  delete globalThis.window;
});

test('library:change terbit di window untuk setiap perubahan, dengan detail.kind yang tepat', async () => {
  const win = new EventTarget();
  (globalThis as any).window = win;
  const { lib } = await fresh();
  const kinds: string[] = [];
  win.addEventListener('library:change', (e) => kinds.push((e as CustomEvent).detail.kind));

  lib.toggleBookmark(meta('k1')); // simpan
  lib.toggleBookmark(meta('k1')); // hapus
  lib.toggleBookmark(meta('k2'));
  lib.removeBookmark('k2');
  save(lib, 'k3', 'k3-chapter-1');
  lib.markChapterRead('k3', 'k3-chapter-2');
  lib.removeHistory('k3');
  save(lib, 'k4', 'k4-chapter-1');
  lib.clearHistory();
  lib.importJSON(lib.exportJSON());
  assert.deepEqual(kinds, [
    'bookmark', 'bookmark', 'bookmark', 'bookmark',
    'progress', 'progress', 'progress',
    'progress', 'clear',
    'import',
  ]);

  // Tanpa perubahan nyata: tidak ada event.
  kinds.length = 0;
  lib.removeBookmark('tidak-ada');
  lib.removeHistory('tidak-ada');
  lib.clearHistory();
  lib.markChapterRead('tidak-ada', 'x');
  lib.toggleBookmark({ slug: '', title: 'x', cover: '' });
  assert.deepEqual(kinds, []);
  delete (globalThis as any).window;
});

test('library:change tetap terbit walau storage melempar (data hidup di memori)', async () => {
  const win = new EventTarget();
  (globalThis as any).window = win;
  const boom = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };
  const { lib } = await fresh(boom);
  let calls = 0;
  win.addEventListener('library:change', () => calls++);
  lib.toggleBookmark(meta('mem'));
  assert.equal(calls, 1);
  assert.equal(lib.isBookmarked('mem'), true);
  delete (globalThis as any).window;
});

test('startSync: perubahan dari tab lain dan bfcache terbit sebagai library:change "import", tanpa subscribe', async () => {
  const win = new EventTarget();
  (globalThis as any).window = win;
  const { lib, storage } = await fresh();
  const kinds: string[] = [];
  win.addEventListener('library:change', (e) => kinds.push((e as CustomEvent).detail.kind));

  // Sebelum startSync tak ada pendengar storage: tab lain tidak terdeteksi.
  win.dispatchEvent(Object.assign(new Event('storage'), { key: KEY }));
  assert.deepEqual(kinds, []);

  lib.startSync();
  lib.startSync(); // idempoten: tidak menggandakan pendengar
  const other = JSON.parse(storage.getItem(KEY) ?? '{"v":1,"bookmarks":{},"progress":{}}');
  other.bookmarks.dari_tab_lain = { slug: 'dari_tab_lain', title: 'T', cover: '', addedAt: 5 };
  storage.setItem(KEY, JSON.stringify(other));
  win.dispatchEvent(Object.assign(new Event('storage'), { key: KEY }));
  assert.deepEqual(kinds, ['import']);
  assert.equal(lib.isBookmarked('dari_tab_lain'), true, 'dibaca ulang dari storage sebelum event terbit');

  win.dispatchEvent(Object.assign(new Event('storage'), { key: 'kunci-lain' }));
  win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
  assert.deepEqual(kinds, ['import'], 'kunci lain dan pageshow biasa diabaikan');
  win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  assert.deepEqual(kinds, ['import', 'import']);
  delete (globalThis as any).window;
});

test('subscribe menerima kind perubahan', async () => {
  (globalThis as any).window = new EventTarget();
  const { lib } = await fresh();
  const seen: string[] = [];
  lib.subscribe((kind: string) => seen.push(kind));
  lib.toggleBookmark(meta('s1'));
  save(lib, 's1', 's1-chapter-1');
  lib.clearHistory();
  assert.deepEqual(seen, ['bookmark', 'progress', 'clear']);
  delete (globalThis as any).window;
});

test('judul berisi HTML/XSS disimpan apa adanya (escape adalah tugas tampilan, bukan penyimpanan)', async () => {
  const { lib } = await fresh();
  const evil = 'One Piece <img src=x onerror=alert(1)> <b>x</b>';
  lib.toggleBookmark(meta('evil', { title: evil }));
  assert.equal(lib.getBookmarks()[0].title, evil);
  assert.equal(JSON.parse(lib.exportJSON()).bookmarks.evil.title, evil);
});

/* ------------------------------------------------------------------ jurnal posisi baca */

test('sink: put menerima catatan tersimpan; drop(slug) dan drop(null) saat riwayat dihapus', async () => {
  const { lib } = await fresh();
  const puts: any[] = [];
  const drops: (string | null)[] = [];
  lib.setProgressSink({ put: (p: any) => puts.push(p), drop: (s: string | null) => drops.push(s) });

  save(lib, 'j1', 'j1-chapter-1', 4, { offset: 0.5 });
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0], lib.getProgress('j1'), 'persis catatan yang tersimpan');
  assert.deepEqual([puts[0].page, puts[0].offset, puts[0].chapter.slug], [4, 0.5, 'j1-chapter-1']);

  lib.markChapterRead('j1', 'j1-chapter-2');
  assert.equal(puts.length, 2);
  assert.deepEqual(puts[1], lib.getProgress('j1'));
  assert.deepEqual(puts[1].read, ['j1-chapter-1', 'j1-chapter-2'], 'tanda baca baru ikut terjurnal');
  assert.equal(puts[1].updatedAt, puts[0].updatedAt, 'markChapterRead tidak menggeser waktu');

  // tanpa perubahan nyata: sink tidak dipanggil
  lib.markChapterRead('j1', 'j1-chapter-2');
  lib.markChapterRead('belum-ada', 'x');
  lib.saveProgress({ manga: { slug: '', title: 't', cover: '' }, chapter: ch('x'), page: 0, pageCount: 0, offset: 0 });
  lib.removeHistory('tidak-ada');
  assert.equal(puts.length, 2);
  assert.deepEqual(drops, []);

  lib.removeHistory('j1');
  assert.deepEqual(drops, ['j1']);
  lib.removeHistory('j1');
  assert.deepEqual(drops, ['j1'], 'sudah tak ada: tidak ada drop');

  save(lib, 'j2', 'j2-chapter-1');
  save(lib, 'j3', 'j3-chapter-1');
  lib.clearHistory();
  assert.deepEqual(drops, ['j1', null], 'clearHistory = drop(null)');
  lib.clearHistory();
  assert.deepEqual(drops, ['j1', null], 'riwayat sudah kosong: tidak ada drop');

  // pelepasan sink: tidak ada panggilan lagi
  lib.setProgressSink(undefined);
  save(lib, 'j4', 'j4-chapter-1');
  assert.equal(puts.length, 4);
});

test('sink yang melempar tidak merusak penyimpanan', async () => {
  const { lib, storage } = await fresh();
  lib.setProgressSink({ put() { throw new Error('IDB rusak'); }, drop() { throw new Error('IDB rusak'); } });
  save(lib, 'b1', 'b1-chapter-1', 6);
  lib.markChapterRead('b1', 'b1-chapter-2');
  assert.equal(lib.getProgress('b1').page, 6);
  assert.deepEqual(JSON.parse(storage.getItem(KEY)).progress.b1.read, ['b1-chapter-1', 'b1-chapter-2'], 'tetap tersimpan di localStorage');
  assert.doesNotThrow(() => lib.removeHistory('b1'));
  assert.equal(lib.getProgress('b1'), undefined);
  save(lib, 'b2', 'b2-chapter-1');
  assert.doesNotThrow(() => lib.clearHistory());
  assert.deepEqual(lib.getHistory(), []);
});

/** Catatan mentah seperti yang dibaca dari jurnal. */
const rec = (slug: string, chapter: string, page: number, updatedAt: number, read: string[] = [chapter], extra: Record<string, unknown> = {}) => ({
  ...meta(slug), chapter: ch(chapter, `Chapter ${chapter}`), page, pageCount: 20, offset: 0.25, updatedAt, read, ...extra,
});

test('recoverProgress: menyisipkan catatan yang belum ada, menulis ke localStorage, menerbitkan "import"', async () => {
  const win = new EventTarget();
  (globalThis as any).window = win;
  try {
    const { lib, storage } = await fresh();
    const kinds: string[] = [];
    win.addEventListener('library:change', (e) => kinds.push((e as CustomEvent).detail.kind));

    assert.equal(lib.recoverProgress(rec('r0', 'r0-chapter-7', 11, 1_800_000_000_000, ['R0-Chapter-6', 'r0-chapter-7'])), true);
    const p = lib.getProgress('r0');
    assert.deepEqual([p.chapter.slug, p.chapter.name, p.page, p.pageCount, p.offset, p.updatedAt], ['r0-chapter-7', 'Chapter r0-chapter-7', 11, 20, 0.25, 1_800_000_000_000]);
    assert.deepEqual(p.read, ['r0-chapter-6', 'r0-chapter-7'], 'read dinormalkan huruf kecil');
    assert.deepEqual(lib.getHistory().map((x) => x.slug), ['r0']);
    assert.deepEqual(kinds, ['import']);

    const saved = JSON.parse(storage.getItem(KEY));
    assert.equal(saved.progress.r0.page, 11, 'dipersist ke localStorage');
    // instance baru yang hanya membaca storage melihatnya
    const again = await fresh(storage);
    assert.equal(again.lib.getProgress('r0').chapter.slug, 'r0-chapter-7');
  } finally {
    delete (globalThis as any).window;
  }
});

test('recoverProgress: jurnal lebih baru menang, read disatukan', async () => {
  const { lib, storage } = await fresh();
  save(lib, 'r1', 'r1-chapter-1', 2);
  const stored = lib.getProgress('r1');
  const inc = rec('r1', 'r1-chapter-5', 9, stored.updatedAt + 5000, ['r1-chapter-4', 'r1-chapter-5']);
  assert.equal(lib.recoverProgress(inc), true);
  const p = lib.getProgress('r1');
  assert.deepEqual([p.chapter.slug, p.page, p.updatedAt], ['r1-chapter-5', 9, stored.updatedAt + 5000], 'posisi dari jurnal');
  assert.deepEqual(p.read, ['r1-chapter-1', 'r1-chapter-4', 'r1-chapter-5'], 'read gabungan, tanpa duplikat');
  assert.equal(lib.getHistory().length, 1);
  assert.equal(JSON.parse(storage.getItem(KEY)).progress.r1.page, 9, 'dipersist');
});

test('recoverProgress: jurnal lebih tua tidak menimpa data yang lebih baru', async () => {
  const win = new EventTarget();
  (globalThis as any).window = win;
  try {
    const { lib, storage } = await fresh();
    const kinds: string[] = [];
    win.addEventListener('library:change', (e) => kinds.push((e as CustomEvent).detail.kind));
    save(lib, 'r2', 'r2-chapter-3', 8);
    save(lib, 'r2', 'r2-chapter-3', 12); // simpan lagi: read tetap ['r2-chapter-3']
    const stored = { ...lib.getProgress('r2') };
    kinds.length = 0;

    // lebih tua dan read-nya sudah termuat: tidak ada yang berubah
    let before = storage.getItem(KEY);
    assert.equal(lib.recoverProgress(rec('r2', 'r2-chapter-1', 0, stored.updatedAt - 5000, ['r2-chapter-3'])), false);
    assert.equal(storage.getItem(KEY), before, 'tidak menulis ulang storage');
    assert.deepEqual(kinds, [], 'tidak ada event');

    // sama persis dengan yang tersimpan (kasus boot biasa): juga tidak berubah
    assert.equal(lib.recoverProgress(JSON.parse(JSON.stringify(stored))), false);
    assert.deepEqual(kinds, []);

    // lebih tua tetapi membawa chapter terbaca yang belum ada: hanya read yang bertambah, posisi tetap milik storage
    assert.equal(lib.recoverProgress(rec('r2', 'r2-chapter-1', 0, stored.updatedAt - 5000, ['r2-chapter-0', 'r2-chapter-3'])), true);
    const p = lib.getProgress('r2');
    assert.deepEqual([p.chapter.slug, p.page, p.updatedAt], ['r2-chapter-3', 12, stored.updatedAt], 'posisi tidak tertimpa');
    assert.deepEqual(p.read, ['r2-chapter-0', 'r2-chapter-3']);
    assert.deepEqual(kinds, ['import']);
    assert.deepEqual(JSON.parse(storage.getItem(KEY)).progress.r2.read, ['r2-chapter-0', 'r2-chapter-3']);
  } finally {
    delete (globalThis as any).window;
  }
});

test('recoverProgress: input tidak valid -> false, tanpa melempar, tanpa mengubah apa pun', async () => {
  const win = new EventTarget();
  (globalThis as any).window = win;
  try {
    const { lib, storage } = await fresh();
    save(lib, 'keep', 'keep-chapter-1', 3);
    const snapshot = lib.exportJSON();
    const stored = storage.getItem(KEY);
    let events = 0;
    win.addEventListener('library:change', () => events++);
    const good = rec('z', 'z-chapter-1', 1, 1_800_000_000_000);
    const cases: Record<string, unknown> = {
      'null': null,
      'undefined': undefined,
      'string': 'bukan objek',
      'angka': 42,
      'array': [good],
      'objek kosong': {},
      'tanpa slug': { ...good, slug: undefined },
      'slug bukan string': { ...good, slug: 5 },
      'slug kosong': { ...good, slug: '' },
      'tanpa chapter': { ...good, chapter: undefined },
      'chapter bukan objek': { ...good, chapter: 'z-chapter-1' },
      'read bukan array': { ...good, read: 'z-chapter-1' },
      'read berisi angka': { ...good, read: [1] },
      'page negatif': { ...good, page: -1 },
      'page pecahan': { ...good, page: 1.5 },
      'offset bukan angka': { ...good, offset: '0.5' },
      'updatedAt string': { ...good, updatedAt: '1800000000000' },
      'updatedAt di luar rentang': { ...good, updatedAt: 9e15 },
      'judul kosong': { ...good, title: '' },
      'sampul javascript:': { ...good, cover: 'javascript:alert(1)' },
      'sampul data:': { ...good, cover: 'data:text/html,<script>alert(1)</script>' },
    };
    for (const [label, input] of Object.entries(cases)) {
      let res: unknown;
      assert.doesNotThrow(() => { res = lib.recoverProgress(input); }, label);
      assert.equal(res, false, label);
    }
    assert.equal(lib.exportJSON(), snapshot, 'tidak ada perubahan di memori');
    assert.equal(storage.getItem(KEY), stored, 'tidak ada perubahan di storage');
    assert.equal(events, 0, 'tidak ada event');
    assert.equal(lib.getProgress('z'), undefined);
  } finally {
    delete (globalThis as any).window;
  }
});

test('recoverProgress: batas riwayat tetap dijaga; catatan paling tua yang melewati batas tidak mengubah apa pun', async () => {
  const { lib, storage } = await fresh();
  for (let i = 0; i < 300; i++) save(lib, `h${i}`, `h${i}-chapter-1`);
  const oldest = lib.getHistory().at(-1);
  const newest = lib.getHistory()[0];
  // lebih baru dari semuanya: masuk, yang paling tua terbuang
  assert.equal(lib.recoverProgress(rec('baru', 'baru-chapter-1', 2, newest.updatedAt + 1000)), true);
  assert.equal(lib.getHistory().length, 300);
  assert.equal(lib.getProgress('baru').page, 2);
  assert.equal(lib.getProgress(oldest.slug), undefined, 'yang tertua dibuang');
  // lebih tua dari semuanya: langsung terbuang lagi -> tak ada yang berubah
  const before = storage.getItem(KEY);
  assert.equal(lib.recoverProgress(rec('kuno', 'kuno-chapter-1', 2, 1)), false);
  assert.equal(lib.getProgress('kuno'), undefined);
  assert.equal(storage.getItem(KEY), before);
});

test('recoverProgress: bekerja walau storage melempar (data hidup di memori)', async () => {
  const boom = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };
  const { lib } = await fresh(boom);
  assert.equal(lib.recoverProgress(rec('mem', 'mem-chapter-2', 4, 1_800_000_000_000)), true);
  assert.equal(lib.getProgress('mem').page, 4);
});
