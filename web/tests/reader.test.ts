// Tes logika murni reader (src/lib/readerlogic.ts) dan template-nya (src/lib/readerview.ts): tanpa DOM.
// Jalankan dari web/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../src/lib/readerlogic.ts';
import * as V from '../src/lib/readerview.ts';
import type { ChapterRef } from '../src/lib/api.ts';

const ref = (slug: string, name = `Chapter ${slug}`): ChapterRef => ({ name, endpoint: `/${slug}/` });

/** Daftar chapter ala API: terbaru -> terlama. Judul manga TIDAK sama dengan awalan slug chapter. */
const LIST: ChapterRef[] = [
  ref('solo-leveling-ragnarok-chapter-67', 'Chapter 67'),
  ref('solo-leveling-ragnarok-chapter-66', 'Chapter 66'),
  ref('solo-leveling-ragnarok-chapter-65', 'Chapter 65'),
];

/* ------------------------------------------------------- manga & tetangga chapter */

test('nameFromSlug: nomor chapter dari slug, desimal, dan slug tanpa pola', () => {
  assert.equal(L.nameFromSlug('solo-leveling-ragnarok-chapter-66'), 'Chapter 66');
  assert.equal(L.nameFromSlug('judul-chapter-12-5'), 'Chapter 12.5');
  assert.equal(L.nameFromSlug('Judul-Chapter-7'), 'Chapter 7');
  assert.equal(L.nameFromSlug('one-shot'), 'one-shot');
});

test('mangaRefOf: manga_endpoint dari API menang atas tebakan slug (judul tak sama dengan awalan slug)', () => {
  const real = L.mangaRefOf({ manga_endpoint: '/manga/alone-leveling-ragnarok/' }, 'solo-leveling-ragnarok-chapter-66');
  assert.deepEqual(real, { slug: 'alone-leveling-ragnarok', confirmed: true });
  // Tebakan lama akan salah: ini yang menyebabkan prev/next dan simpan posisi gagal diam-diam.
  assert.equal(L.mangaRefOf({}, 'solo-leveling-ragnarok-chapter-66').slug, 'solo-leveling-ragnarok');
});

test('mangaRefOf: field kosong/hilang = tebakan yang belum terverifikasi; tanpa pola = tak diketahui', () => {
  assert.deepEqual(L.mangaRefOf({ manga_endpoint: '' }, 'one-piece-chapter-1196'), { slug: 'one-piece', confirmed: false });
  assert.deepEqual(L.mangaRefOf({ manga_endpoint: undefined }, 'one-piece-chapter-1196'), { slug: 'one-piece', confirmed: false });
  assert.deepEqual(L.mangaRefOf({ manga_endpoint: '  ' }, 'x-chapter-1'), { slug: 'x', confirmed: false });
  assert.deepEqual(L.mangaRefOf({}, 'oneshot'), { slug: undefined, confirmed: false });
});

test('listHasChapter: cocok tanpa peduli huruf besar/kecil', () => {
  assert.equal(L.listHasChapter(LIST, 'Solo-Leveling-Ragnarok-Chapter-66'), true);
  assert.equal(L.listHasChapter(LIST, 'solo-leveling-chapter-66'), false);
});

test('resolveSteps: prev/next dari API dipakai apa adanya, nama dari daftar chapter bila ada', () => {
  const ch = {
    prev_endpoint: '/solo-leveling-ragnarok-chapter-65/',
    next_endpoint: '/solo-leveling-ragnarok-chapter-67/',
  };
  const withList = L.resolveSteps('solo-leveling-ragnarok-chapter-66', ch, LIST);
  assert.deepEqual(withList.prev, { slug: 'solo-leveling-ragnarok-chapter-65', name: 'Chapter 65' });
  assert.deepEqual(withList.next, { slug: 'solo-leveling-ragnarok-chapter-67', name: 'Chapter 67' });
  assert.equal(withList.latest, false);
  // Tanpa daftar chapter (info belum tiba): nama diturunkan dari slug, tautan tetap benar.
  const bare = L.resolveSteps('solo-leveling-ragnarok-chapter-66', ch);
  assert.deepEqual(bare.next, { slug: 'solo-leveling-ragnarok-chapter-67', name: 'Chapter 67' });
});

test('resolveSteps: API menang atas daftar chapter bila keduanya ada tapi berbeda', () => {
  const s = L.resolveSteps(
    'solo-leveling-ragnarok-chapter-66',
    { prev_endpoint: '/lompat-chapter-1/', next_endpoint: '/lompat-chapter-9/' },
    LIST,
  );
  assert.equal(s.prev?.slug, 'lompat-chapter-1');
  assert.equal(s.next?.slug, 'lompat-chapter-9');
});

test('resolveSteps: field kosong atau hilang jatuh ke tetangga di daftar chapter (urutan terbaru -> terlama)', () => {
  for (const ch of [{}, { prev_endpoint: '', next_endpoint: '' }, { prev_endpoint: undefined, next_endpoint: undefined }]) {
    const s = L.resolveSteps('solo-leveling-ragnarok-chapter-66', ch, LIST);
    assert.equal(s.prev?.slug, 'solo-leveling-ragnarok-chapter-65', 'prev = indeks lebih besar');
    assert.equal(s.next?.slug, 'solo-leveling-ragnarok-chapter-67', 'next = indeks lebih kecil');
  }
});

test('resolveSteps: terbaru (tak ada next) hanya pasti bila ada sumber tepercaya', () => {
  // API baru menjawab next_endpoint "" = memang tidak ada.
  const api = L.resolveSteps('solo-leveling-ragnarok-chapter-67', { prev_endpoint: '/x-chapter-66/', next_endpoint: '' });
  assert.equal(api.next, undefined);
  assert.equal(api.latest, true);
  // API lama (field undefined) + daftar yang memuat chapter ini di paling atas.
  const list = L.resolveSteps('solo-leveling-ragnarok-chapter-67', {}, LIST);
  assert.equal(list.next, undefined);
  assert.equal(list.latest, true);
  // API lama tanpa daftar chapter: tidak ada bukti apa pun -> jangan klaim "chapter terbaru".
  const none = L.resolveSteps('solo-leveling-ragnarok-chapter-67', {});
  assert.equal(none.next, undefined);
  assert.equal(none.latest, false);
  // Chapter tak ada di daftar (manga salah): juga bukan bukti.
  assert.equal(L.resolveSteps('lain-chapter-1', {}, LIST).latest, false);
});

test('resolveSteps: chapter pertama tidak punya prev', () => {
  const s = L.resolveSteps('solo-leveling-ragnarok-chapter-65', { prev_endpoint: '', next_endpoint: '/solo-leveling-ragnarok-chapter-66/' }, LIST);
  assert.equal(s.prev, undefined);
  assert.equal(s.next?.name, 'Chapter 66');
});

test('chapter_list null (seri tanpa chapter) dan nomor chapter yang bukan aritmetika tidak membuat reader gagal', () => {
  assert.equal(L.listHasChapter(null, 'x-chapter-1'), false);
  assert.equal(L.listName(null, 'x-chapter-1'), undefined);
  const s = L.resolveSteps('x-chapter-1', { prev_endpoint: '', next_endpoint: '/x-chapter-1-5/' }, null);
  assert.equal(s.prev, undefined);
  assert.equal(s.next?.slug, 'x-chapter-1-5');
  assert.equal(s.latest, false, 'tanpa daftar dan next ada: bukan terbaru');
  // Tetangga selalu dari API/daftar, tidak pernah dihitung dari angka: 00-1 -> 00-15 -> ... -> 271-5.
  const odd = L.resolveSteps(
    'solo-leveling-ragnarok-chapter-00-1',
    { prev_endpoint: '', next_endpoint: '/solo-leveling-ragnarok-chapter-00-15/' },
    null,
  );
  assert.equal(odd.next?.slug, 'solo-leveling-ragnarok-chapter-00-15');
  assert.equal(L.nameFromSlug('solo-leveling-ragnarok-chapter-271-5'), 'Chapter 271.5');
});

test('listName: nama dari daftar, undefined bila daftar belum ada atau tak memuatnya', () => {
  assert.equal(L.listName(LIST, 'solo-leveling-ragnarok-chapter-66'), 'Chapter 66');
  assert.equal(L.listName(undefined, 'solo-leveling-ragnarok-chapter-66'), undefined);
  assert.equal(L.listName(LIST, 'tidak-ada-chapter-1'), undefined);
});

/* ------------------------------------------------------------------ lanjut baca */

test('parsePageHash: #p20 (1-based) -> indeks 19; hash lain/rusak -> undefined', () => {
  assert.equal(L.parsePageHash('#p20'), 19);
  assert.equal(L.parsePageHash('#P3'), 2);
  assert.equal(L.parsePageHash('#p1'), 0);
  for (const bad of ['', '#', '#p', '#p0', '#p-3', '#p1.5', '#pabc', '#halaman2', 'p20', '#p20x', '#p123456']) {
    assert.equal(L.parsePageHash(bad), undefined, bad);
  }
});

test('resumeTarget: hash menang, #p1 berarti dari awal, posisi tersimpan hanya bila halaman > 0', () => {
  const stored = { page: 7, offset: 0.4 };
  assert.deepEqual(L.resumeTarget({ hash: '#p20', pageCount: 69, stored }), { index: 19, offset: 0, source: 'hash' });
  assert.equal(L.resumeTarget({ hash: '#p1', pageCount: 69, stored }), undefined, '#p1 tidak jatuh ke posisi tersimpan');
  assert.deepEqual(L.resumeTarget({ hash: '', pageCount: 69, stored }), { index: 7, offset: 0.4, source: 'progress' });
  assert.equal(L.resumeTarget({ hash: '', pageCount: 69, stored: { page: 0, offset: 0.9 } }), undefined);
  assert.equal(L.resumeTarget({ hash: '', pageCount: 69 }), undefined);
  assert.deepEqual(L.resumeTarget({ hash: '#bukan-halaman', pageCount: 69, stored }), { index: 7, offset: 0.4, source: 'progress' });
});

test('resumeTarget: dibatasi ke halaman terakhir, offset ke 0..1, chapter kosong tanpa target', () => {
  assert.equal(L.resumeTarget({ hash: '#p500', pageCount: 30 })?.index, 29);
  const past = L.resumeTarget({ hash: '', pageCount: 30, stored: { page: 80, offset: 0.7 } });
  assert.deepEqual(past, { index: 29, offset: 0, source: 'progress' }, 'halaman hilang: awal halaman terakhir, bukan offset lama');
  assert.equal(L.resumeTarget({ hash: '', pageCount: 30, stored: { page: 3, offset: 9 } })?.offset, 1);
  assert.equal(L.resumeTarget({ hash: '', pageCount: 30, stored: { page: 3, offset: -2 } })?.offset, 0);
  assert.equal(L.resumeTarget({ hash: '#p5', pageCount: 0 }), undefined);
});

test('resumeToastText: nomor halaman 1-based', () => {
  assert.equal(L.resumeToastText(19), 'Lanjut dari halaman 20');
});

/* ------------------------------------------------------------- halaman yang dibaca */

/** Halaman setinggi `h` bertumpuk dari `top0` (koordinat viewport). */
const stack = (count: number, h: number, top0: number) => (i: number) => ({ top: top0 + i * h, height: h });

test('currentPage: halaman yang melewati garis + posisi 0..1 di dalamnya', () => {
  // 10 halaman @ 800px, atas halaman 0 di -2500: garis di 300 -> y dokumen 2800 -> halaman 3, 0.5 ke dalam.
  assert.deepEqual(L.currentPage(10, stack(10, 800, -2500), 300), { index: 3, offset: 0.5 });
  // Tepat di tepi atas halaman 3 (atasnya di -100): halaman itu, offset 0.
  assert.deepEqual(L.currentPage(10, stack(10, 800, -2500), -100), { index: 3, offset: 0 });
  // Satu piksel sebelum tepi: masih halaman sebelumnya, hampir penuh.
  const before = L.currentPage(10, stack(10, 800, -2500), -101);
  assert.equal(before.index, 2);
  assert.ok(before.offset > 0.99 && before.offset < 1);
});

test('currentPage: di atas halaman pertama = halaman 0; di bawah yang terakhir = terakhir, offset 1', () => {
  assert.deepEqual(L.currentPage(5, stack(5, 600, 400), 300), { index: 0, offset: 0 }, 'header masih di atas halaman 1');
  assert.deepEqual(L.currentPage(5, stack(5, 600, -5000), 300), { index: 4, offset: 1 });
  assert.deepEqual(L.currentPage(0, () => ({ top: 0, height: 0 }), 300), { index: 0, offset: 0 });
});

test('currentPage: tinggi tak seragam (placeholder vs gambar asli) dan tinggi 0 tidak menghasilkan NaN', () => {
  const heights = [900, 300, 1200, 600];
  const tops: number[] = [];
  let y = -1000;
  for (const h of heights) {
    tops.push(y);
    y += h;
  }
  const at = (i: number) => ({ top: tops[i], height: heights[i] });
  // tops = [-1000, -100, 200, 1400]: garis di 300 melewati halaman 2 (atas di 200, tinggi 1200).
  const got = L.currentPage(4, at, 300);
  assert.equal(got.index, 2);
  assert.ok(Math.abs(got.offset - 100 / 1200) < 1e-9);
  const zero = L.currentPage(2, (i) => ({ top: i * 0, height: 0 }), 300);
  assert.ok(Number.isFinite(zero.offset));
});

test('currentPage: pencarian biner, bukan pindai linear (log2 n pembacaan layout per scroll)', () => {
  let reads = 0;
  const at = (i: number) => {
    reads++;
    return { top: -50000 + i * 800, height: 800 };
  };
  const got = L.currentPage(500, at, 300);
  assert.equal(got.index, Math.floor((300 + 50000) / 800));
  assert.ok(reads <= 12, `pembacaan layout: ${reads}`);
});

test('sectionAt: chapter yang halaman pertamanya sudah melewati garis; sebelumnya yang pertama', () => {
  assert.equal(L.sectionAt([500, 5000], 300), 0, 'halaman pertama belum sampai garis');
  assert.equal(L.sectionAt([-400, 5000], 300), 0);
  assert.equal(L.sectionAt([-9000, 250, 8000], 300), 1, 'masuk ke chapter 2');
  assert.equal(L.sectionAt([-9000, -100, 250], 300), 2);
  assert.equal(L.sectionAt([], 300), 0);
});

test('sectionAt bekerja dua arah: scroll naik kembali ke chapter sebelumnya', () => {
  const tops = (scroll: number) => [0 - scroll, 6000 - scroll];
  assert.equal(L.sectionAt(tops(5900), 300), 1);
  assert.equal(L.sectionAt(tops(5600), 300), 0, 'halaman pertama chapter 2 turun di bawah garis lagi');
});

test('fractionRead: halaman + posisi, dibatasi 0..1', () => {
  assert.equal(L.fractionRead(0, 0, 10), 0);
  assert.equal(L.fractionRead(5, 0.5, 10), 0.55);
  assert.equal(L.fractionRead(9, 1, 10), 1);
  assert.equal(L.fractionRead(3, 0.5, 0), 0);
});

/* ------------------------------------------------------------- pemuatan gambar */

test('lookahead & rootMargin: 3 layar ke bawah/1 ke atas; separuh bila hemat data', () => {
  assert.deepEqual(L.lookahead(false), { up: 1, down: 3 });
  assert.deepEqual(L.lookahead(true), { up: 0.5, down: 1 });
  assert.equal(L.rootMargin(L.lookahead(false)), '100% 0px 300% 0px');
  assert.equal(L.rootMargin(L.lookahead(true)), '50% 0px 100% 0px');
});

test('initialPages: tiga pertama; saat lompat ke halaman N dimuat N-1..N+3', () => {
  assert.deepEqual([...L.initialPages(30)], [0, 1, 2]);
  assert.deepEqual([...L.initialPages(2)], [0, 1]);
  assert.deepEqual([...L.initialPages(69, 19)], [18, 19, 20, 21, 22]);
  assert.deepEqual([...L.initialPages(69, 0)], [0, 1, 2, 3]);
  assert.deepEqual([...L.initialPages(69, 68)], [67, 68], 'tidak melewati halaman terakhir');
  assert.deepEqual([...L.initialPages(0)], []);
});

/* ------------------------------------------------ chapter berikutnya & batas DOM */

test('nearEnd: dasar chapter terakhir dalam 1,5 tinggi layar di bawah layar', () => {
  const vh = 800;
  assert.equal(L.nearEnd(vh + 1.5 * vh, vh), true, 'tepat di batas');
  assert.equal(L.nearEnd(vh + 1.5 * vh + 1, vh), false);
  assert.equal(L.nearEnd(200, vh), true, 'dasar sudah di dalam layar');
  assert.equal(L.nearEnd(-50, vh), true);
  assert.equal(L.nearEnd(5000, vh, 6), true, 'faktor bisa diubah');
});

test('sectionsToDrop: hanya yang seluruhnya di atas layar, dari yang tertua, tidak pernah chapter yang dibaca', () => {
  const box = (...bottoms: number[]) => bottoms.map((bottom) => ({ bottom }));
  assert.equal(L.sectionsToDrop(box(-100, 4000, 9000), 1), 0, 'batas belum terlewati');
  assert.equal(L.sectionsToDrop(box(-100, 4000, 9000, 14000), 2), 1, 'tertua sudah di atas layar');
  assert.equal(L.sectionsToDrop(box(100, 4000, 9000, 14000), 2), 0, 'tertua masih terlihat: jangan dibuang');
  assert.equal(L.sectionsToDrop(box(-100, 4000, 9000, 14000), 0), 0, 'tertua = yang sedang dibaca');
  assert.equal(L.sectionsToDrop(box(-9000, -4000, 200, 8000, 12000), 3), 2, 'dua tertua; berhenti di batas 3');
  assert.equal(L.sectionsToDrop(box(-9000, -4000, -10, 8000, 12000), 3), 2, 'jumlah sisa = batas, bukan lebih banyak');
  assert.equal(L.sectionsToDrop(box(-9000, 4000, 12000, 20000), 3), 1);
  assert.equal(L.MAX_SECTIONS, 3);
});

test('kompensasi scroll: membuang chapter di atas tidak menggeser isi yang sedang dibaca', () => {
  // Dokumen: [ch1 3000px][ch2 4000px][ch3 4000px][ch4 baru]. Pembaca di ch3, 600px ke dalamnya.
  const heights = [3000, 4000, 4000, 2500];
  const docTop = (n: number) => heights.slice(0, n).reduce((a, b) => a + b, 0);
  let scrollY = docTop(2) + 600;
  const anchorTop = (n: number) => docTop(n) - scrollY; // atas chapter ke-n di viewport
  const before = anchorTop(1); // jangkar = chapter terlama yang dipertahankan (ch2)
  const readingBefore = anchorTop(2);

  // Buang ch1: semua yang di bawahnya naik setinggi ch1; scrollY browser tetap -> isi melompat 3000px.
  const removed = heights.shift() as number;
  const afterRaw = before - removed;
  const delta = L.scrollCompensation(before, afterRaw);
  assert.equal(delta, -3000);
  scrollY += delta;
  const readingAfter = heights.slice(0, 1).reduce((a, b) => a + b, 0) - scrollY; // atas ch3 yang baru
  assert.equal(readingAfter, readingBefore, 'posisi ch3 di layar identik sebelum/sesudah');
  // Bila browser sudah mengompensasi sendiri (scroll anchoring), selisihnya 0 dan tidak ada penyesuaian ganda.
  assert.equal(L.scrollCompensation(120, 120), 0);
});

test('parseAutoNext: aktif kecuali nilainya persis "0"', () => {
  assert.equal(L.parseAutoNext(null), true, 'default aktif');
  assert.equal(L.parseAutoNext('1'), true);
  assert.equal(L.parseAutoNext(''), true);
  assert.equal(L.parseAutoNext('0'), false);
});

/* ------------------------------------------------------------------- template */

const EVIL = `<img src=x onerror=alert(1)>"'&`;
const EVIL_ESC = '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;';

const ready = (over: Partial<V.ReaderCtx> = {}): V.ReaderCtx => ({
  title: 'Solo Leveling: Ragnarok Chapter 66',
  state: 'ready',
  back: 'alone-leveling-ragnarok',
  mangaTitle: 'Alone Leveling: Ragnarok',
  current: 'Chapter 66',
  prev: { slug: 'solo-leveling-ragnarok-chapter-65', name: 'Chapter 65' },
  next: { slug: 'solo-leveling-ragnarok-chapter-67', name: 'Chapter 67' },
  ...over,
});

test('readerHeadHtml: tautan balik ke manga ASLI, sakelar Lanjut otomatis (aria-pressed), penunjuk halaman', () => {
  const on = V.readerHeadHtml(ready());
  assert.ok(on.includes('href="/manga/alone-leveling-ragnarok/"'));
  assert.ok(on.includes('<h1 class="reader-title">Chapter 66</h1>'));
  assert.ok(/data-autonext-toggle[^>]*aria-pressed="true"/.test(on));
  assert.ok(on.includes('data-read-progress'));
  assert.ok(/aria-pressed="true"/.test(V.readerHeadHtml(ready({ autoNext: undefined }))), 'default aktif');
  assert.ok(/aria-pressed="false"/.test(V.readerHeadHtml(ready({ autoNext: false }))));
});

test('readerHeadHtml: tebakan manga (pending) tidak ditautkan tapi ruangnya ditahan; tanpa manga tidak ada tautan', () => {
  const pending = V.readerHeadHtml(ready({ state: 'pending' }));
  assert.ok(!pending.includes('href='), 'slug tebakan bisa salah');
  assert.ok(pending.includes('class="reader-back"'));
  const none = V.readerHeadHtml({ title: 'X', state: 'none' });
  assert.ok(!none.includes('reader-back') && !none.includes('href='));
  assert.ok(none.includes('data-autonext-toggle'), 'sakelar tetap ada');
});

test('readerNavHtml: top/end/fixed; fixed membawa nama chapter + penunjuk halaman; none = kosong', () => {
  const top = V.readerNavHtml(ready(), 'top');
  assert.ok(top.includes('rel="prev"') && top.includes('href="/chapter/solo-leveling-ragnarok-chapter-65/"'));
  assert.ok(top.includes('rel="next"') && top.includes('href="/chapter/solo-leveling-ragnarok-chapter-67/"'));
  const fixed = V.readerNavHtml(ready(), 'fixed');
  assert.ok(fixed.includes('class="fix-name">Chapter 66<'));
  assert.ok(/class="fix-pg" data-read-progress/.test(fixed));
  assert.equal(V.readerNavHtml({ title: 'X', state: 'none' }, 'top'), '');
  assert.equal(V.readerNavHtml({ title: 'X', state: 'none' }, 'fixed'), '');
});

test('readerNavHtml: "Ini chapter terbaru" hanya di akhir, hanya bila pasti terbaru dan tak ada next', () => {
  const latest = ready({ next: undefined, latest: true });
  assert.ok(V.readerNavHtml(latest, 'end').includes('Ini chapter terbaru'));
  assert.ok(V.readerNavHtml(latest, 'end').includes('href="/manga/alone-leveling-ragnarok/"'), 'kembali ke info');
  assert.ok(!V.readerNavHtml(latest, 'top').includes('Ini chapter terbaru'));
  assert.ok(!V.readerNavHtml(ready({ next: undefined, latest: false }), 'end').includes('Ini chapter terbaru'));
  assert.ok(!V.readerNavHtml(ready({ latest: true }), 'end').includes('Ini chapter terbaru'), 'ada next: bukan terbaru');
  assert.ok(V.readerNavHtml(latest, 'end').includes('is-disabled'), 'tombol berikutnya nonaktif');
});

test('chapterSectionHtml: hook stabil, src hanya untuk gambar awal, data-src untuk sisanya, tanpa id ganda', () => {
  const images = ['https://i/1.jpg', 'https://i/2.jpg', 'https://i/3.jpg', 'https://i/4.jpg', 'https://i/5.jpg'];
  const html = V.chapterSectionHtml({ slug: 'solo-leveling-ragnarok-chapter-66', name: 'Chapter 66', images, eager: new Set([0, 1, 2]), priority: 0 });
  assert.ok(html.startsWith('<section class="chapter" data-chapter="solo-leveling-ragnarok-chapter-66" data-chapter-name="Chapter 66">'));
  assert.equal((html.match(/<img /g) ?? []).length, 5);
  for (let i = 1; i <= 5; i++) assert.ok(html.includes(`data-page="${i}"`) && html.includes(`alt="Halaman ${i}"`), `halaman ${i}`);
  assert.equal((html.match(/ src="/g) ?? []).length, 3, 'tiga gambar langsung punya src');
  assert.equal((html.match(/ data-src="/g) ?? []).length, 2, 'dua sisanya menunggu pengamat');
  assert.ok(html.includes('<img class="page" data-page="1" src="https://i/1.jpg" fetchpriority="high"'));
  assert.equal((html.match(/fetchpriority/g) ?? []).length, 1, 'hanya satu gambar berprioritas tinggi');
  assert.ok(/<img class="page" data-page="4" data-src="https:\/\/i\/4\.jpg" alt="Halaman 4"/.test(html));
  assert.ok(!/\sid=/.test(html), 'tidak ada id (tak mungkin ganda antar-chapter)');
  assert.ok(!html.includes('chapter-divider'), 'chapter pertama tanpa pembatas');
});

test('chapterSectionHtml: lompat ke halaman N memberi prioritas tinggi ke halaman itu', () => {
  const images = Array.from({ length: 30 }, (_, i) => `https://i/${i + 1}.jpg`);
  const html = V.chapterSectionHtml({ slug: 'x-chapter-1', name: 'Chapter 1', images, eager: L.initialPages(30, 19), priority: 19 });
  assert.ok(/data-page="20" src="https:\/\/i\/20\.jpg" fetchpriority="high"/.test(html));
  assert.ok(/data-page="1" data-src=/.test(html), 'halaman 1 tidak dimuat dulu');
  assert.ok(/data-page="19" src=/.test(html) && /data-page="23" src=/.test(html) && /data-page="24" data-src=/.test(html));
});

test('chapterSectionHtml: pembatas chapter berikutnya dan chapter tanpa gambar', () => {
  const html = V.chapterSectionHtml({ slug: 'x-chapter-2', name: 'Chapter 2', images: ['https://i/1.jpg'], eager: new Set([0]), divider: true });
  assert.ok(html.includes('<div class="chapter-divider"><span class="chapter-divider-name">Chapter 2</span>'));
  assert.ok(html.includes('class="chapter-divider-link" href="/chapter/x-chapter-2/"'));
  const empty = V.chapterSectionHtml({ slug: 'x-chapter-3', name: 'Chapter 3', images: [], eager: new Set() });
  assert.ok(empty.includes('Chapter ini belum memiliki halaman.'));
  assert.ok(!empty.includes('<img'));
});

test('slotHtml: idle = tautan manual, loading = penunjuk, end/off = navigasi akhir', () => {
  assert.ok(V.slotHtml('idle', ready()).includes('Lanjut: Chapter 67'));
  assert.ok(V.slotHtml('idle', ready()).includes('href="/chapter/solo-leveling-ragnarok-chapter-67/"'));
  assert.ok(V.slotHtml('loading', ready()).includes('Memuat Chapter 67'));
  const off = V.slotHtml('off', ready());
  assert.ok(off.includes('reader-bar-end') && off.includes('rel="next"'));
  const end = V.slotHtml('end', ready({ next: undefined, latest: true }));
  assert.ok(end.includes('Ini chapter terbaru'));
  assert.ok(V.slotHtml('idle', ready({ next: undefined })).includes('reader-bar-end'), 'idle tanpa next jatuh ke navigasi akhir');
  assert.ok(V.slotHtml('loading', ready({ next: undefined })).includes('Memuat chapter berikutnya'));
});

test('readerShellHtml: semua hook ada dan slot membawa keadaannya', () => {
  const html = V.readerShellHtml({ ctx: ready(), sections: '<section class="chapter"></section>', slot: V.slotHtml('idle', ready()), slotState: 'idle' });
  for (const hook of ['data-reader', 'data-chapters', 'data-append-slot', 'data-state="idle"', 'data-rnav-slot="head"', 'data-rnav-slot="top"', 'data-rnav-slot="end"', 'data-rnav-slot="fixed"', 'data-autonext-toggle', 'data-read-progress']) {
    assert.ok(html.includes(hook), hook);
  }
  assert.ok(html.includes('aria-live="polite"'));
});

test('resumeToastHtml: teks, tombol "Mulai dari awal" dan tutup', () => {
  const html = V.resumeToastHtml(19);
  assert.ok(html.includes('role="status"') && html.includes('data-reader-toast'));
  assert.ok(html.includes('Lanjut dari halaman 20'));
  assert.ok(html.includes('data-toast-restart') && html.includes('Mulai dari awal'));
  assert.ok(html.includes('data-toast-close') && html.includes('aria-label="Tutup"'));
});

test('escape: judul/slug/nama/URL dari API tidak pernah menjadi markup di template reader', () => {
  const evil = ready({ title: EVIL, mangaTitle: EVIL, current: EVIL, prev: { slug: 'a', name: EVIL }, next: { slug: 'b', name: EVIL } });
  const outputs = [
    V.readerHeadHtml(evil),
    V.readerNavHtml(evil, 'top'),
    V.readerNavHtml(evil, 'end'),
    V.readerNavHtml(evil, 'fixed'),
    V.slotHtml('idle', evil),
    V.slotHtml('loading', evil),
    V.chapterSectionHtml({ slug: EVIL, name: EVIL, images: [EVIL, EVIL], eager: new Set([0]), divider: true }),
  ];
  for (const html of outputs) {
    assert.ok(!html.includes('<img src=x'), 'img mentah');
    // Teks yang berisi "onerror=" sudah ter-escape dan aman; yang berbahaya hanyalah atribut di dalam tag sungguhan.
    for (const tag of html.match(/<[^>]*>/g) ?? []) {
      assert.ok(!/\son[a-z]+\s*=/i.test(tag.replace(/"[^"]*"/g, '""')), `handler hidup di ${tag.slice(0, 80)}`);
    }
    assert.ok(html.includes(EVIL_ESC), 'teks ter-escape muncul');
  }
  assert.ok(!V.chapterSectionHtml({ slug: 'x', name: 'x', images: ['"onload="alert(1)'], eager: new Set([0]) }).includes('"onload='));
});
