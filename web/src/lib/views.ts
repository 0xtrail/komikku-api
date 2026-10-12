/**
 * Template HTML (string murni, tanpa DOM) untuk semua tampilan.
 *
 * Dipakai di dua tempat dengan markup yang IDENTIK:
 *   - build time, oleh index.astro (prerender beranda), dan
 *   - browser, oleh client.ts (render dari cache / hasil fetch).
 * Karena markup-nya satu sumber, mengganti isi beranda dengan data terbaru
 * tidak menggeser layout sama sekali.
 *
 * ATURAN: setiap string dari API WAJIB lewat `esc()` sebelum masuk template.
 */
import { slugOf, chapterSlug, type Manga, type Genre, type MangaInfo, type ChapterDetail } from './api';
import { mangaHref, chapterHref, genreHref, genreSlug } from './routes';

export const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

/** Tanda tangan ringkas isi data — untuk tahu apakah data baru berbeda dari yang sudah tampil. */
export function sig(v: unknown): string {
  const s = JSON.stringify(v) ?? '';
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${h.toString(36)}:${s.length}`;
}

/** Teks khusus pembaca layar (kelas `.sr-only` disembunyikan secara visual). */
export const SR_LOADING = '<span class="sr-only">Sedang memuat konten</span>';

/* ------------------------------------------------------------------ cards */

const typeKey = (t?: string): string => {
  const k = (t ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return k === 'manga' || k === 'manhwa' || k === 'manhua' ? k : 'other';
};

/**
 * Kartu manga. `rank` (1-based) menambah angka peringkat besar di sampul —
 * dipakai baris Populer.
 */
export function cardHtml(m: Manga, rank?: number): string {
  const badge = m.type
    ? `<span class="badge badge-${typeKey(m.type)}">${esc(m.type)}</span>`
    : '';
  const rankEl = rank ? `<span class="rank" aria-hidden="true">${rank}</span>` : '';
  return (
    `<a class="card" href="${esc(mangaHref(slugOf(m.endpoint)))}">` +
    `<span class="cover">` +
    `<img src="${esc(m.image)}" alt="Sampul ${esc(m.title)}" width="200" height="300" loading="lazy" decoding="async">` +
    `${badge}${rankEl}</span>` +
    `<h3 class="card-title">${esc(m.title)}</h3>` +
    `</a>`
  );
}

const EMPTY = '<p class="empty">Belum ada data untuk ditampilkan.</p>';

/** Grid padat: 2 kolom di ponsel, sampai 6 di desktop (CSS). */
export const gridHtml = (list: Manga[]): string =>
  list.length
    ? `<ul class="grid" role="list">${list.map((m) => `<li>${cardHtml(m)}</li>`).join('')}</ul>`
    : EMPTY;

/** Baris geser horizontal dengan angka peringkat. */
export const railHtml = (list: Manga[]): string =>
  list.length
    ? `<ol class="rail" role="list">${list.map((m, i) => `<li>${cardHtml(m, i + 1)}</li>`).join('')}</ol>`
    : EMPTY;

/** Genre yang paling sering dicari: tampil dulu; sisanya di balik tombol "Semua genre". */
const FEATURED_GENRES = [
  'action', 'romance', 'fantasy', 'comedy', 'drama', 'isekai', 'adventure', 'school-life',
  'supernatural', 'martial-arts', 'shounen', 'seinen', 'slice-of-life', 'harem', 'horror',
  'mystery', 'psychological', 'historical', 'sci-fi', 'reincarnation', 'regression', 'system',
  'webtoon', 'villainess',
];

/**
 * Awan chip genre. Tap target 44px membuat 99 chip terlalu panjang di ponsel,
 * jadi hanya genre unggulan yang tampil; sisanya `hidden` sampai tombol ditekan
 * (handler di client.ts, delegated).
 */
export function genreCloud(list: Genre[]): string {
  if (!list.length) return EMPTY;
  const slugOfG = (g: Genre) => chapterSlug(g.endpoint);
  const rank = new Map(FEATURED_GENRES.map((s, i) => [s, i]));
  let shown = list
    .filter((g) => rank.has(slugOfG(g)))
    .sort((a, b) => (rank.get(slugOfG(a)) as number) - (rank.get(slugOfG(b)) as number));
  if (shown.length < 8) shown = list.slice(0, 20); // daftar tak dikenal: jangan kosong
  const shownSet = new Set(shown);
  const chip = (g: Genre, hidden: boolean) =>
    `<li${hidden ? ' hidden data-more' : ''}><a class="chip" href="${esc(genreHref(slugOfG(g)))}">${esc(g.title)}</a></li>`;
  const rest = list.filter((g) => !shownSet.has(g));
  return (
    `<ul class="chips" role="list">${shown.map((g) => chip(g, false)).join('')}${rest.map((g) => chip(g, true)).join('')}</ul>` +
    (rest.length
      ? `<button type="button" class="btn chips-toggle" data-more-genres aria-expanded="false">Semua genre (${list.length})</button>`
      : '')
  );
}

/* -------------------------------------------------------------- skeletons */

const skelCard =
  '<li><span class="sk-card"><span class="sk sk-cover"></span><span class="sk sk-line"></span><span class="sk sk-line s"></span></span></li>';

export const skelGrid = (n = 10): string =>
  `<ul class="grid" role="list" aria-hidden="true">${skelCard.repeat(n)}</ul>`;

export const skelRail = (n = 8): string =>
  `<ol class="rail" role="list" aria-hidden="true">${skelCard.repeat(n)}</ol>`;

export const skelChips = (n = 18): string =>
  `<ul class="chips" role="list" aria-hidden="true">${'<li><span class="sk sk-chip"></span></li>'.repeat(n)}</ul>`;

/** Kerangka halaman daftar: judul + grid. */
export const skelListing = (): string =>
  `<div class="page-head" aria-hidden="true"><span class="sk sk-title"></span></div>${skelGrid(10)}${SR_LOADING}`;

export const skelDetail = (): string =>
  `<div class="detail" aria-hidden="true">
    <div class="detail-cover"><span class="sk sk-cover"></span></div>
    <div class="detail-main">
      <span class="sk sk-title"></span>
      <span class="sk sk-line"></span><span class="sk sk-line"></span><span class="sk sk-line s"></span>
    </div>
    <div class="cta"><span class="sk sk-btn"></span><span class="sk sk-btn"></span></div>
  </div>
  <div class="chapter-box" aria-hidden="true">${'<span class="sk sk-row"></span>'.repeat(6)}</div>${SR_LOADING}`;

export const skelReader = (): string =>
  `<div class="reader" aria-hidden="true">
    <div class="reader-head"><span class="sk sk-title"></span></div>
    <div class="reader-bar"><span class="sk sk-btn"></span><span class="sk sk-btn"></span></div>
    ${'<span class="sk sk-page"></span>'.repeat(3)}
  </div>${SR_LOADING}`;

/* ----------------------------------------------------------------- detail */

export function detailHtml(info: MangaInfo): string {
  const chapters = info.chapter_list ?? [];
  const latest = chapters[0];
  const first = chapters[chapters.length - 1];

  const row = (label: string, value?: string) =>
    `<tr><th scope="row">${label}</th><td>${esc(value || '-')}</td></tr>`;

  const genres = (info.genre ?? [])
    .map((g) => ({ g, slug: genreSlug(g) }))
    .filter((x) => x.slug)
    .map((x) => `<li><a class="chip" href="${esc(genreHref(x.slug))}">${esc(x.g)}</a></li>`)
    .join('');

  const cta = chapters.length
    ? `<a class="btn btn-primary" href="${esc(chapterHref(chapterSlug(first.endpoint)))}">Baca Chapter Awal</a>
       <a class="btn" href="${esc(chapterHref(chapterSlug(latest.endpoint)))}">Chapter Terbaru</a>`
    : '<p class="muted">Belum ada chapter yang tersedia.</p>';

  const list = chapters
    .map(
      (c) =>
        `<li><a href="${esc(chapterHref(chapterSlug(c.endpoint)))}">${esc(c.name)}</a></li>`,
    )
    .join('');

  return `
    <article class="detail">
      <div class="detail-cover">
        <span class="cover"><img src="${esc(info.thumbnail)}" alt="Sampul ${esc(info.title)}" width="240" height="360" decoding="async" fetchpriority="high"></span>
      </div>
      <div class="detail-main">
        <h1>${esc(info.title)}</h1>
        <table class="meta"><tbody>
          ${row('Tipe', info.type)}${row('Pengarang', info.author)}${row('Status', info.status)}${row('Rating', info.rating)}
        </tbody></table>
        ${genres ? `<ul class="chips" role="list" aria-label="Genre">${genres}</ul>` : ''}
      </div>
      <div class="cta">${cta}</div>
    </article>
    <section class="chapter-box" aria-labelledby="h-chapters">
      <div class="chapter-head">
        <h2 id="h-chapters"><i class="mark" aria-hidden="true"></i>Daftar Chapter</h2>
        <span class="muted count" data-count aria-live="polite">${chapters.length} chapter</span>
        ${
          chapters.length > 8
            ? '<input class="filter" type="search" data-filter placeholder="Cari chapter, mis. 12" aria-label="Cari chapter" autocomplete="off">'
            : ''
        }
      </div>
      <ul class="chapter-list" role="list" aria-label="Daftar chapter">${list || '<li class="muted pad">Belum ada chapter.</li>'}</ul>
      <p class="muted pad" data-empty hidden>Tidak ada chapter yang cocok dengan pencarian.</p>
    </section>`;
}

/* ----------------------------------------------------------------- reader */

export interface ChapterStep {
  slug: string;
  name: string;
}

/**
 * Keadaan navigasi reader.
 *  - none    : slug tidak cocok pola `<manga>-chapter-<n>` -> tanpa navigasi
 *  - pending : info manga (untuk prev/next & nama chapter) belum tiba
 *  - ready   : info tiba (atau gagal: hanya `back`, tanpa prev/next/current)
 * `title` = judul dari API chapter, dipakai bila nama chapter tidak diketahui.
 */
export interface ReaderCtx {
  title: string;
  state: 'none' | 'pending' | 'ready';
  back?: string;
  mangaTitle?: string;
  current?: string;
  prev?: ChapterStep;
  next?: ChapterStep;
}

/** "Chapter 12" -> "Ch. 12" (untuk bar bawah yang sempit). */
const shortName = (n: string) => n.replace(/^chapter\s*/i, 'Ch. ');

/** Judul chapter yang tampil: nama dari chapter_list bila ada, kalau tidak judul API. */
export const readerTitle = (c: ReaderCtx): string => c.current || c.title;

/** Header reader: tautan kembali ke manga + nama chapter yang sedang dibaca. */
export function readerHeadHtml(c: ReaderCtx): string {
  const back = c.back
    ? `<a class="reader-back" href="${esc(mangaHref(c.back))}"><span aria-hidden="true">&larr;</span> ${esc(c.mangaTitle || 'Info manga')}</a>`
    : '';
  return `${back}<h1 class="reader-title">${esc(readerTitle(c))}</h1>`;
}

/**
 * Tombol prev/next. `pos`:
 *  - top   : baris prev/next di bawah header
 *  - end   : akhir chapter — tombol kembali + prev/next berlabel nama chapter
 *  - fixed : bar tetap di bawah layar (zona jempol): ← | ‹ Ch. 1 | Chapter 2 | Ch. 3 ›
 */
export function readerNavHtml(c: ReaderCtx, pos: 'top' | 'end' | 'fixed'): string {
  if (c.state === 'none' || !c.back) return '';

  const step = (dir: 'prev' | 'next'): string => {
    const s = c[dir];
    const short = pos === 'fixed';
    // Tak ada chapter di arah ini (awal / terbaru): label cadangan, singkat di bar bawah yang sempit.
    const fallback = short ? (dir === 'prev' ? 'Awal' : 'Terbaru') : dir === 'prev' ? 'Sebelumnya' : 'Berikutnya';
    const label = s ? (short ? shortName(s.name) : s.name) : fallback;
    const arrow = (a: string) => `<span aria-hidden="true">${a}</span>`;
    const inner =
      dir === 'prev'
        ? `${arrow('&lsaquo;')}<span class="lbl">${esc(label)}</span>`
        : `<span class="lbl">${esc(label)}</span>${arrow('&rsaquo;')}`;
    if (c.state === 'pending') return `<span class="btn is-pending" aria-hidden="true">${inner}</span>`;
    if (!s) return `<span class="btn is-disabled" aria-disabled="true">${inner}</span>`;
    return `<a class="btn${dir === 'next' ? ' btn-primary' : ''}" rel="${dir}" href="${esc(chapterHref(s.slug))}" aria-label="${
      dir === 'prev' ? 'Chapter sebelumnya' : 'Chapter berikutnya'
    }: ${esc(s.name)}">${inner}</a>`;
  };

  const back = esc(mangaHref(c.back));

  if (pos === 'fixed') {
    const now =
      c.state === 'pending'
        ? '<span class="fix-now sk" aria-hidden="true">&nbsp;</span>'
        : `<span class="fix-now">${esc(readerTitle(c))}</span>`;
    return `<nav class="fixbar" data-rnav="fixed" aria-label="Navigasi chapter">
      <a class="btn btn-ghost fix-back" href="${back}" aria-label="Kembali ke info manga">&larr;</a>
      ${step('prev')}${now}${step('next')}
    </nav>`;
  }

  return `<nav class="reader-bar reader-bar-${pos}" data-rnav="${pos}" aria-label="Navigasi chapter (${pos === 'top' ? 'atas' : 'akhir'})">
    ${pos === 'end' ? `<a class="btn btn-ghost reader-home" href="${back}">&larr; Info manga</a>` : ''}
    <span class="reader-steps">${step('prev')}${step('next')}</span>
  </nav>`;
}

export function readerHtml(ch: ChapterDetail, ctx: ReaderCtx): string {
  // 2 gambar pertama eager (yang pertama prioritas tinggi); sisanya lazy dengan cadangan aspect-ratio di CSS.
  const pages = ch.image
    .map(
      (src, i) =>
        `<img class="page" src="${esc(src)}" alt="Halaman ${i + 1}" ${
          i === 0 ? 'loading="eager" fetchpriority="high"' : i === 1 ? 'loading="eager"' : 'loading="lazy"'
        } decoding="async">`,
    )
    .join('');
  return `<div class="reader">
    <header class="reader-head" data-rnav-slot="head">${readerHeadHtml(ctx)}</header>
    <div data-rnav-slot="top">${readerNavHtml(ctx, 'top')}</div>
    <div class="pages">${pages || '<p class="empty">Chapter ini belum memiliki halaman.</p>'}</div>
    <div data-rnav-slot="end">${readerNavHtml(ctx, 'end')}</div>
    <div data-rnav-slot="fixed">${readerNavHtml(ctx, 'fixed')}</div>
  </div>`;
}

/* ----------------------------------------------------------------- pager */

export function pagerHtml(opts: { page: number; hasNext: boolean; href: (page: number) => string }): string {
  const { page, hasNext, href } = opts;
  const prev =
    page > 1
      ? `<a class="btn" rel="prev" href="${esc(href(page - 1))}">&larr; Sebelumnya</a>`
      : '<span class="btn is-disabled" aria-disabled="true">&larr; Sebelumnya</span>';
  const next = hasNext
    ? `<a class="btn btn-primary" rel="next" href="${esc(href(page + 1))}">Berikutnya &rarr;</a>`
    : '<span class="btn is-disabled" aria-disabled="true">Berikutnya &rarr;</span>';
  return `<nav class="pager" aria-label="Halaman daftar">${prev}<span class="pager-page" aria-current="page">Halaman ${page}</span>${next}</nav>`;
}
