// Tes template murni src/lib/views.ts dan src/lib/routes.ts (string masuk, string keluar; tanpa DOM).
// Jalankan dari web/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from '../src/lib/views.ts';
import * as r from '../src/lib/routes.ts';
import { paths } from '../src/lib/api.ts';

const parse = (u: string) => r.parseRoute(new URL(u, 'http://x'));

/** Judul uji yang mencoba keluar dari teks: tag, atribut, dan skrip. */
const EVIL = `One Piece <img src=x onerror=alert(1)> <b>x</b> "q" 'a' & <script>alert(2)</script>`;
const EVIL_ESCAPED = 'One Piece &lt;img src=x onerror=alert(1)&gt; &lt;b&gt;x&lt;/b&gt; &quot;q&quot; &#39;a&#39; &amp; &lt;script&gt;alert(2)&lt;/script&gt;';

/** Tidak ada markup yang berasal dari judul uji: tag tidak muncul mentah dan atribut tak bisa ditutup dini. */
function assertInert(html: string, label: string): void {
  assert.ok(!html.includes('<img src=x'), `${label}: <img> mentah`);
  assert.ok(!html.includes('<b>x</b>'), `${label}: <b> mentah`);
  assert.ok(!html.includes('<script'), `${label}: <script> mentah`);
  // Atribut event handler hanya berbahaya bila berada di dalam tag sungguhan (nilai atribut yang berisi
  // teks "onerror=" sudah di-escape dan tidak berbahaya): buang nilai berkutip, lalu cari nama atribut on*.
  for (const tag of html.match(/<[^>]*>/g) ?? []) {
    assert.ok(!/\son[a-z]+\s*=/i.test(tag.replace(/"[^"]*"/g, '""')), `${label}: atribut event handler hidup di ${tag.slice(0, 80)}`);
  }
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), `${label}: teks judul harus tampil sebagai teks`);
}

test('highlightHtml: escape dulu, <mark> hanya pada potongan cocok', () => {
  assert.equal(v.highlightHtml('Solo Leveling', 'solo'), '<mark>Solo</mark> Leveling');
  assert.equal(v.highlightHtml('The Solo Life', ' SOLO '), 'The <mark>Solo</mark> Life');
  assert.equal(v.highlightHtml('A <b>x</b> & "y"', 'x'), 'A &lt;b&gt;<mark>x</mark>&lt;/b&gt; &amp; &quot;y&quot;');
  assert.equal(v.highlightHtml('<img src=x onerror=alert(1)>', 'img'), '&lt;<mark>img</mark> src=x onerror=alert(1)&gt;');
  assert.equal(v.highlightHtml('Tanpa cocok', 'zzz'), 'Tanpa cocok');
  assert.equal(v.highlightHtml('Apa saja', ''), 'Apa saja');
  assert.equal(v.highlightHtml('<script>', '<script>'), '<mark>&lt;script&gt;</mark>');
  assert.ok(!/<(?!\/?mark>)/.test(v.highlightHtml('a<b>c', 'b')), 'tidak ada tag selain <mark>');
});

test('highlightHtml: kata kunci berisi HTML tidak pernah menjadi markup (regresi XSS autocomplete)', () => {
  const out = v.highlightHtml(EVIL, 'onerror');
  assert.ok(out.includes('<mark>onerror</mark>'));
  assert.ok(!out.includes('<img') && !out.includes('<b>') && !out.includes('<script'));
  // yang dicari justru potongan tag: tetap di-escape di dalam <mark>
  assert.equal(v.highlightHtml('x <b>y</b>', '<b>'), 'x <mark>&lt;b&gt;</mark>y&lt;/b&gt;');
});

test('suggestOptionHtml: judul disorot, semua field di-escape, tautan ke halaman manga', () => {
  const html = v.suggestOptionHtml({ slug: 's"><script>', title: EVIL, cover: 'https://x/c.jpg?a="b"', type: 'Manhwa<b>' }, 'piece', 3);
  assert.ok(html.includes('id="sg-3"') && html.includes('role="option"'));
  assert.ok(html.includes('One <mark>Piece</mark> &lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<img src=x') && !html.includes('<script') && !html.includes('<b>'));
  assert.ok(html.includes('badge-other') && html.includes('Manhwa&lt;b&gt;'));
  assert.ok(!v.suggestOptionHtml({ slug: 'a', title: 'A', cover: '' }, 'a', 0).includes('<img'), 'tanpa sampul: tanpa <img>');
});

test('relativeTime: bahasa Indonesia', () => {
  const now = 1_800_000_000_000;
  const ago = (s: number) => v.relativeTime(now - s * 1000, now);
  assert.equal(ago(10), 'baru saja');
  assert.equal(ago(-500), 'baru saja', 'cap waktu di masa depan');
  assert.equal(ago(60), '1 menit lalu');
  assert.equal(ago(5 * 60), '5 menit lalu');
  assert.equal(ago(2 * 3600), '2 jam lalu');
  assert.equal(ago(86400), 'kemarin');
  assert.equal(ago(3 * 86400), '3 hari lalu');
  assert.equal(ago(8 * 86400), 'minggu lalu');
  assert.equal(ago(70 * 86400), '2 bulan lalu');
  assert.equal(ago(400 * 86400), 'tahun lalu');
});

test('synopsisHtml: paragraf, escape, clamp > 280, tersembunyi bila kosong', () => {
  assert.equal(v.synopsisHtml(undefined), '');
  assert.equal(v.synopsisHtml('   \n\n  '), '');
  const short = v.synopsisHtml('Satu.\n\nDua <b>x</b>.');
  assert.ok(short.includes('<p>Satu.</p><p>Dua &lt;b&gt;x&lt;/b&gt;.</p>'));
  assert.ok(!short.includes('data-syn-toggle') && !short.includes('is-clamped'));
  const long = v.synopsisHtml('x'.repeat(300));
  assert.ok(long.includes('is-clamped') && long.includes('data-syn-toggle') && long.includes('aria-expanded="false"') && long.includes('aria-controls="syn-body"'));
  const open = v.synopsisHtml('x'.repeat(300), true);
  assert.ok(!open.includes('is-clamped') && open.includes('aria-expanded="true"') && open.includes('Ringkas'));
  assert.ok(v.synopsisHtml('a\r\n\r\nb').includes('<p>a</p><p>b</p>'), 'CRLF');
});

const info = {
  thumbnail: 'https://x/t.jpg',
  title: 'Judul <X>',
  type: 'Manhwa',
  genre: ['Action'],
  chapter_list: [
    { name: 'Chapter 3', endpoint: '/judul-chapter-3/' },
    { name: 'Chapter 2', endpoint: '/judul-chapter-2/' },
    { name: 'Chapter 1', endpoint: '/judul-chapter-1/' },
  ],
};

test('detailHtml tanpa riwayat: CTA lama + tombol Simpan ber-[data-bm], tanpa sinopsis', () => {
  const h = v.detailHtml(info, { slug: 'judul', bookmarked: false, read: new Set() });
  assert.ok(h.includes('Baca Chapter Awal') && h.includes('Chapter Terbaru'));
  assert.ok(h.includes('data-bookmark') && h.includes('data-bm="judul"') && h.includes('data-title="Judul &lt;X&gt;"'));
  assert.ok(h.includes('data-cover="https://x/t.jpg"') && h.includes('data-type="Manhwa"'));
  assert.ok(h.includes('aria-pressed="false"') && h.includes('<span class="bm-label">Bookmark</span>'));
  assert.ok(!h.includes('data-synopsis') && !h.includes('btn-resume'));
  assert.ok(h.includes('Judul &lt;X&gt;') && !h.includes('<X>'));
  assert.ok(!h.includes('is-read'));
});

test('detailHtml dengan pustaka: Lanjutkan, hal., read, Terakhir dibaca, Tersimpan', () => {
  const lib = {
    slug: 'judul',
    bookmarked: true,
    read: new Set(['judul-chapter-1', 'judul-chapter-2']),
    progress: { slug: 'judul', title: 'J', cover: '', chapter: { slug: 'judul-chapter-2', name: 'Chapter 2' }, page: 3, pageCount: 20, offset: 0.1, updatedAt: 1, read: [] },
  };
  const h = v.detailHtml({ ...info, synopsis: 'Cerita.' }, lib);
  assert.ok(h.includes('href="/chapter/judul-chapter-2/#p4"'), 'hash 1-based');
  assert.ok(h.includes('Lanjutkan · Chapter 2') && h.includes('hal. 4'));
  assert.ok(h.includes('Baca dari awal') && !h.includes('Baca Chapter Awal') && h.includes('Chapter Terbaru'));
  assert.ok(h.includes('aria-pressed="true"') && h.includes('<span class="bm-label">Tersimpan</span>'));
  assert.equal((h.match(/class="is-read"/g) ?? []).length, 2);
  assert.equal((h.match(/Terakhir dibaca/g) ?? []).length, 1);
  assert.equal((h.match(/sudah dibaca/g) ?? []).length, 1, 'sr-only hanya untuk yang sudah dibaca bukan terakhir');
  assert.ok(h.includes('data-synopsis') && h.includes('Cerita.'));
  const h0 = v.detailHtml(info, { ...lib, progress: { ...lib.progress, page: 0 } });
  assert.ok(h0.includes('href="/chapter/judul-chapter-2/"') && !h0.includes('hal.'));
});

test('detailHtml: tanpa chapter tetap punya Bookmark; sinopsis di panel judul, sebelum tombol dan daftar chapter', () => {
  const lib = { slug: 'judul', bookmarked: false, read: new Set<string>() };
  const h = v.detailHtml({ ...info, chapter_list: [], synopsis: 'x' }, lib);
  assert.ok(h.includes('Belum ada chapter yang tersedia') && h.includes('data-bm="judul"'));
  assert.ok(!h.includes('data-sort'), 'tanpa chapter tak ada tombol urutan');
  const withSyn = v.detailHtml({ ...info, synopsis: 'x' }, lib);
  const at = (s: string) => withSyn.indexOf(s);
  assert.ok(at('<h1>') < at('data-synopsis') && at('data-synopsis') < at('class="cta"') && at('class="cta"') < at('chapter-box'));
});

test('detailHtml: latar sampul dekoratif, statistik (Rating/Chapter/Tipe), Status + Pengarang, genre', () => {
  const lib = { slug: 'judul', bookmarked: false, read: new Set<string>() };
  const h = v.detailHtml({ ...info, rating: '15+', status: 'ongoing', author: 'Si <A>', synopsis: 'x' }, lib);
  assert.ok(h.includes('<div class="detail-bg" aria-hidden="true"><img src="https://x/t.jpg" alt=""'), 'latar kabur: alt kosong, aria-hidden');
  assert.ok(/<dt>Rating<\/dt><dd class="stat-gold">15\+<\/dd>/.test(h));
  assert.ok(/<dt>Chapter<\/dt><dd class="stat-green">3<\/dd>/.test(h));
  assert.ok(/<dt>Tipe<\/dt><dd class="stat-blue">Manhwa<\/dd>/.test(h));
  assert.ok(h.includes('<dt>Status</dt>') && h.includes('ongoing') && h.includes('Si &lt;A&gt;') && !h.includes('Si <A>'));
  assert.ok(h.includes('class="chip chip-sm" href="/genre/action/"'));
  const none = v.detailHtml({ ...info, genre: undefined }, lib);
  assert.ok(/<dt>Rating<\/dt><dd class="stat-gold">-<\/dd>/.test(none), 'tanpa rating: tanda hubung, bukan angka karangan');
  assert.ok(!none.includes('aria-label="Genre"'));
  assert.ok(!v.detailHtml({ ...info, thumbnail: '' }, lib).includes('detail-bg'), 'tanpa sampul: tanpa latar');
});

test('detailHtml: tombol urutan chapter membalik daftar; kotak cari hanya untuk > 8 chapter', () => {
  const lib = { slug: 'judul', bookmarked: false, read: new Set<string>() };
  const order = (h: string) => [...h.matchAll(/class="ch-name">(Chapter \d+)</g)].map((m) => m[1]);
  const newest = v.detailHtml(info, lib);
  assert.deepEqual(order(newest), ['Chapter 3', 'Chapter 2', 'Chapter 1']);
  assert.ok(newest.includes('data-sort') && newest.includes('<span class="sort-lbl">Terbaru</span>'));
  assert.ok(!newest.includes('data-filter'), '3 chapter: tanpa kotak cari');
  const oldest = v.detailHtml(info, { ...lib, oldestFirst: true });
  assert.deepEqual(order(oldest), ['Chapter 1', 'Chapter 2', 'Chapter 3']);
  assert.ok(oldest.includes('<span class="sort-lbl">Terlama</span>') && oldest.includes('terlama dulu'));
  const many = Array.from({ length: 12 }, (_, i) => ({ name: `Chapter ${12 - i}`, endpoint: `/judul-chapter-${12 - i}/` }));
  const big = v.detailHtml({ ...info, chapter_list: many }, lib);
  assert.ok(big.includes('data-filter') && big.includes('data-count') && big.includes('12 Chapter'));
});

test('pageHeadHtml: <h1> + pil di-escape; sub dan filter dioper apa adanya', () => {
  const h = v.pageHeadHtml({ title: 'Hasil pencarian: <b>x</b>', pill: '3 judul', sub: '<p class="ph-sub">s</p>', filters: '<div class="filter-bar"></div>' });
  assert.ok(h.startsWith('<header class="page-head filter-panel">') && h.includes('<h1>Hasil pencarian: &lt;b&gt;x&lt;/b&gt;</h1>'));
  assert.ok(h.includes('<span class="pill">3 judul</span>') && h.includes('<p class="ph-sub">s</p>') && h.includes('filter-bar'));
  assert.ok(!v.pageHeadHtml({ title: 'T' }).includes('pill'));
});

test('daftarFilterHtml: tab jenis + tombol Genre (aria-expanded/aria-controls, panel hidden)', () => {
  const h = v.daftarFilterHtml('manhua');
  assert.ok(h.includes('class="seg"') && /href="\/daftar\/\?tipe=manhua"[^>]*aria-current="page"/.test(h));
  assert.equal((h.match(/aria-current="page"/g) ?? []).length, 1, 'tombol Genre bukan tab jenis');
  assert.ok(/data-genre-toggle aria-expanded="false" aria-controls="genre-pop-panel"/.test(h));
  assert.ok(/id="genre-pop-panel" data-genre-panel[^>]*hidden/.test(h));
});

test('routes: daftar & pustaka, href, apiPathFor', () => {
  assert.deepEqual(parse('/daftar/'), { kind: 'list', tipe: '', page: 1 });
  assert.deepEqual(parse('/daftar/?tipe=manhwa&page=3'), { kind: 'list', tipe: 'manhwa', page: 3 });
  assert.deepEqual(parse('/daftar/?tipe=BOGUS'), { kind: 'list', tipe: '', page: 1 });
  assert.deepEqual(parse('/daftar/?tipe=MANGA&page=-4'), { kind: 'list', tipe: 'manga', page: 1 });
  assert.deepEqual(parse('/pustaka/'), { kind: 'library', tab: 'riwayat' });
  assert.deepEqual(parse('/pustaka/?tab=bookmark'), { kind: 'library', tab: 'bookmark' });
  assert.deepEqual(parse('/pustaka/?tab=lain'), { kind: 'library', tab: 'riwayat' });
  assert.equal(r.daftarHref(), '/daftar/');
  assert.equal(r.daftarHref('manhwa'), '/daftar/?tipe=manhwa');
  assert.equal(r.daftarHref('manga', 3), '/daftar/?tipe=manga&page=3');
  assert.equal(r.pustakaHref(), '/pustaka/');
  assert.equal(r.pustakaHref('bookmark'), '/pustaka/?tab=bookmark');
  assert.equal(r.resumeHref('a-chapter-1', 0), '/chapter/a-chapter-1/');
  assert.equal(r.resumeHref('a-chapter-1', 6), '/chapter/a-chapter-1/#p7');
  assert.equal(r.apiPathFor(parse('/daftar/?tipe=manhwa&page=2')), '/api/comic/list?filter=manhwa&page=2');
  assert.equal(r.apiPathFor(parse('/daftar/')), '/api/comic/list');
  assert.equal(paths.list('', 1), '/api/comic/list');
  assert.equal(r.apiPathFor(parse('/pustaka/')), undefined);
});

test('daftarTabsHtml: aria-current pada tab aktif saja', () => {
  const h = v.daftarTabsHtml('manhwa');
  assert.equal((h.match(/aria-current="page"/g) ?? []).length, 1);
  assert.ok(/href="\/daftar\/\?tipe=manhwa"[^>]*aria-current="page"/.test(h));
  assert.ok(v.daftarTabsHtml('').includes('href="/daftar/" data-tipe="" aria-current="page"'));
});

const hist = [
  {
    slug: 'm1',
    title: 'T<1>',
    cover: 'https://x/c.jpg',
    type: 'Manga',
    chapter: { slug: 'm1-chapter-9', name: 'Chapter 9' },
    page: 4,
    pageCount: 30,
    offset: 0,
    updatedAt: 1_800_000_000_000 - 300_000,
    read: ['m1-chapter-9'],
  },
];

test('libraryViewHtml: tab ARIA, baris riwayat, kartu bookmark, escape, kosong', () => {
  const bms = [{ slug: 'b1', title: 'B"1', cover: '', type: 'Manhua', addedAt: 1 }];
  const h = v.libraryViewHtml({ tab: 'riwayat', history: hist, bookmarks: bms, now: 1_800_000_000_000 });
  assert.ok(h.includes('role="tablist"') && h.includes('id="tab-riwayat"') && h.includes('aria-selected="true"') && h.includes('aria-controls="panel-riwayat"'));
  assert.ok(h.includes('hal. 5 dari 30') && h.includes('5 menit lalu') && h.includes('/chapter/m1-chapter-9/#p5'));
  assert.ok(h.includes('T&lt;1&gt;') && !h.includes('T<1>'));
  assert.ok(h.includes('data-remove-history') && h.includes('aria-label="Hapus T&lt;1&gt; dari riwayat"'));
  assert.ok(h.includes('id="panel-bookmark"') && /id="panel-bookmark"[^>]*hidden/.test(h));
  const hb = v.libraryViewHtml({ tab: 'bookmark', history: hist, bookmarks: bms, now: 1 });
  assert.ok(hb.includes('data-remove-bookmark') && hb.includes('B&quot;1') && hb.includes('href="/manga/b1/"') && !hb.includes('<img'), 'sampul kosong: tanpa <img>');
  const empty = v.libraryViewHtml({ tab: 'riwayat', history: [], bookmarks: [], now: 1 });
  assert.ok(empty.includes('href="/daftar/"') && empty.includes('Belum ada riwayat'));
  const emptyB = v.libraryViewHtml({ tab: 'bookmark', history: [], bookmarks: [], now: 1 });
  assert.ok(emptyB.includes('Belum ada bookmark') && emptyB.includes('href="/daftar/"'));
});

test('resumeRailHtml: tautan langsung ke posisi terakhir, Ch. X · hal. N', () => {
  const h = v.resumeRailHtml([{ ...hist[0], slug: 'm', title: 'M', chapter: { slug: 'm-chapter-12', name: 'Chapter 12' }, page: 0, pageCount: 9 }]);
  assert.ok(h.includes('href="/chapter/m-chapter-12/"') && h.includes('Ch. 12 · hal. 1') && h.includes('class="rail"'));
});

test('cardHtml: tanpa <img> bila sampul kosong; dengan sampul tetap sama', () => {
  assert.ok(!v.cardHtml({ title: 'T', image: '', endpoint: '/manga/t/' }).includes('<img'));
  assert.ok(v.cardHtml({ title: 'T', image: 'https://x/i.jpg', endpoint: '/manga/t/' }).includes('loading="lazy"'));
});

test('cardHtml: chip jenis berpenanda titik di dalam sampul; tanpa jenis tanpa chip', () => {
  const h = v.cardHtml({ title: 'T', image: 'https://x/i.jpg', type: 'Manhwa', endpoint: '/manga/t/' });
  assert.ok(h.includes('<span class="badge badge-manhwa"><i class="dot" aria-hidden="true"></i>Manhwa</span>'));
  assert.ok(h.indexOf('badge-manhwa') < h.indexOf('</span><h3'), 'chip di dalam .cover, sebelum judul');
  assert.ok(!v.cardHtml({ title: 'T', image: '', endpoint: '/manga/t/' }).includes('badge'));
  assert.ok(v.cardHtml({ title: 'T', image: '', endpoint: '/manga/t/' }, 4).includes('<span class="rank" aria-hidden="true">4</span>'));
});

test('railHtml: peringkat bisa dimatikan (Rekomendasi); resume rail memakai kartu <li class="card-li">', () => {
  const list = [manga];
  assert.ok(v.railHtml(list).includes('class="rank"') && !v.railHtml(list, false).includes('class="rank"'));
  assert.equal(v.recoRailHtml(list), v.railHtml(list, false));
  assert.ok(v.resumeRailHtml([hist[0]]).includes('<li class="card-li">'));
});

/* --------------------------------------------------- tombol bookmark di kartu */

const manga = { title: 'Solo Leveling', image: 'https://img.example/s.jpg', type: 'Manhwa', endpoint: '/manga/solo-leveling/' };

test('cardItemHtml: tombol [data-bm] adalah SAUDARA <a class="card"> di dalam <li>, bukan anaknya', () => {
  const html = v.cardItemHtml(manga);
  assert.ok(html.startsWith('<li class="has-bm"><a class="card"') && html.endsWith('</button></li>'));
  const closeA = html.indexOf('</a>');
  const button = html.indexOf('<button');
  assert.ok(closeA > 0 && button > closeA, 'tombol setelah </a>: tidak bersarang di dalam tautan');
  assert.equal((html.match(/<button/g) ?? []).length, 1);
  assert.ok(html.includes('type="button"'), 'bukan tombol submit');
  assert.ok(html.includes('data-bm="solo-leveling"') && html.includes('data-title="Solo Leveling"'));
  assert.ok(html.includes('data-cover="https://img.example/s.jpg"') && html.includes('data-type="Manhwa"'));
  assert.ok(html.includes('aria-pressed="false"') && html.includes('aria-label="Bookmark Solo Leveling"'));
  assert.ok(html.includes('<span class="bm-label">Bookmark</span>'), 'teks tampil termuat di nama aksesibel');
});

test('gridHtml dan railHtml: setiap kartu punya tepat satu tombol bookmark; rail membawa peringkat', () => {
  const list = [manga, { ...manga, title: 'Lain', endpoint: '/manga/lain/' }];
  const grid = v.gridHtml(list);
  assert.equal((grid.match(/data-bm="/g) ?? []).length, 2);
  assert.equal((grid.match(/<li class="has-bm">/g) ?? []).length, 2);
  const rail = v.railHtml(list);
  assert.equal((rail.match(/data-bm="/g) ?? []).length, 2);
  assert.ok(rail.includes('class="rank"'));
  assert.equal(v.gridHtml([]).includes('data-bm'), false);
});

test('regresi escape: judul berisi HTML tampil sebagai teks di semua tampilan (bukan markup)', () => {
  const evil = { title: EVIL, image: 'https://x/"><script>.jpg', type: 'Manga"><b>', endpoint: '/manga/e/' };
  assertInert(v.cardHtml(evil), 'cardHtml');
  assertInert(v.cardItemHtml(evil), 'cardItemHtml');
  assertInert(v.gridHtml([evil]), 'gridHtml');
  assertInert(v.railHtml([evil]), 'railHtml');

  const lib = { slug: 'e', bookmarked: false, read: new Set<string>() };
  assertInert(v.detailHtml({ ...info, title: EVIL, synopsis: EVIL, thumbnail: 'https://x/"><script>.jpg' }, lib), 'detailHtml');

  const prog = { ...hist[0], title: EVIL, chapter: { slug: 'e-chapter-1', name: EVIL } };
  assertInert(v.resumeRailHtml([prog]), 'resumeRailHtml');
  const bm = { slug: 'e', title: EVIL, cover: 'https://x/c.jpg', type: 'Manga', addedAt: 1 };
  assertInert(v.libraryViewHtml({ tab: 'riwayat', history: [prog], bookmarks: [bm], now: 1_800_000_000_000 }), 'library riwayat');
  assertInert(v.libraryViewHtml({ tab: 'bookmark', history: [prog], bookmarks: [bm], now: 1_800_000_000_000 }), 'library bookmark');
  assertInert(v.suggestOptionHtml({ slug: 'e', title: EVIL, cover: '', type: 'Manga' }, 'zzz', 0), 'suggest');

  // Atribut data-title/aria-label membawa teks yang sama dan tetap tertutup rapi.
  const item = v.cardItemHtml(evil);
  assert.ok(item.includes(`data-title="${EVIL_ESCAPED}"`));
  assert.ok(item.includes(`aria-label="Bookmark ${EVIL_ESCAPED}"`));
});
