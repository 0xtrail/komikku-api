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
import { slugOf, chapterSlug, type Manga, type Genre, type MangaInfo, type ChapterDetail, type ListTipe } from './api.ts';
import { mangaHref, chapterHref, genreHref, genreSlug, daftarHref, resumeHref, type LibTab } from './routes.ts';
// Hanya TIPE (terhapus saat build): views tidak boleh menyentuh storage. Data pustaka dioper sebagai parameter.
import type { Bookmark, Progress } from './library';

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
    (m.image
      ? `<img src="${esc(m.image)}" alt="Sampul ${esc(m.title)}" width="200" height="300" loading="lazy" decoding="async">`
      : '') +
    `${badge}${rankEl}</span>` +
    `<h3 class="card-title">${esc(m.title)}</h3>` +
    `</a>`
  );
}

/**
 * Atribut yang dibaca pendengar klik tunggal di bookmarks.ts untuk menyimpan satu judul.
 * `data-bm` = slug (kunci pustaka); judul/sampul/jenis dibawa agar tombol tak perlu data lain.
 */
const bmData = (slug: string, title: string, cover: string, type?: string): string =>
  `data-bm="${esc(slug)}" data-title="${esc(title)}" data-cover="${esc(cover)}"${type ? ` data-type="${esc(type)}"` : ''}`;

/**
 * Tombol bookmark kartu. SAUDARA dari `<a class="card">` di dalam `<li>` (tombol di dalam tautan
 * tidak valid dan menekannya akan menavigasi); CSS menumpuknya di pojok kanan atas sampul.
 * Nama aksesibel tetap "Simpan <judul>"; keadaan lewat `aria-pressed` (disetel `syncBookmarkButtons`).
 */
export const bookmarkButtonHtml = (m: Manga): string =>
  `<button type="button" class="card-bm" ${bmData(slugOf(m.endpoint), m.title, m.image, m.type)} aria-pressed="false" aria-label="Simpan ${esc(m.title)}">${ICON_BOOKMARK}<span class="bm-label">Simpan</span></button>`;

/** Satu item daftar: kartu + tombol bookmark. Dipakai grid, baris Populer, dan feed. */
export const cardItemHtml = (m: Manga, rank?: number): string =>
  `<li class="has-bm">${cardHtml(m, rank)}${bookmarkButtonHtml(m)}</li>`;

const EMPTY = '<p class="empty">Belum ada data untuk ditampilkan.</p>';

/** Grid padat: 2 kolom di ponsel, sampai 6 di desktop (CSS). */
export const gridHtml = (list: Manga[]): string =>
  list.length ? `<ul class="grid" role="list">${list.map((m) => cardItemHtml(m)).join('')}</ul>` : EMPTY;

/** Baris geser horizontal dengan angka peringkat. */
export const railHtml = (list: Manga[]): string =>
  list.length ? `<ol class="rail" role="list">${list.map((m, i) => cardItemHtml(m, i + 1)).join('')}</ol>` : EMPTY;

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

/** Keadaan pustaka untuk satu manga; dioper dari klien (views tidak mengimpor library). */
export interface DetailLib {
  /** Slug manga (kunci pustaka), untuk tombol bookmark `[data-bm]`. */
  slug: string;
  bookmarked: boolean;
  /** Posisi baca terakhir; ada = tombol utama jadi "Lanjutkan". */
  progress?: Readonly<Progress>;
  /** Slug chapter (huruf kecil) yang sudah dibaca. */
  read: ReadonlySet<string>;
  synopsisOpen?: boolean;
}

const ICON_BOOKMARK =
  '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6.5 3.5h11a1 1 0 0 1 1 1V20.5l-6.5-4.4-6.5 4.4V4.5a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>';

const ICON_CHECK =
  '<svg class="ch-check" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Sinopsis lebih panjang dari ini dipangkas (~4 baris) dengan tombol "Selengkapnya". */
const SYNOPSIS_LONG = 280;

/** Sinopsis API: paragraf dipisah baris kosong. Kosong/tidak ada = bagian disembunyikan. */
export function synopsisHtml(text: string | undefined, open = false): string {
  const paras = (text ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!paras.length) return '';
  const long = paras.join(' ').length > SYNOPSIS_LONG;
  return `<section class="synopsis${long && !open ? ' is-clamped' : ''}" aria-labelledby="h-syn" data-synopsis>
      <h2 id="h-syn"><i class="mark" aria-hidden="true"></i>Sinopsis</h2>
      <div class="syn-body" id="syn-body">${paras.map((p) => `<p>${esc(p)}</p>`).join('')}</div>
      ${
        long
          ? `<button type="button" class="btn syn-toggle" data-syn-toggle aria-expanded="${open}" aria-controls="syn-body">${open ? 'Ringkas' : 'Selengkapnya'}</button>`
          : ''
      }
    </section>`;
}

export function detailHtml(info: MangaInfo, lib: DetailLib): string {
  const chapters = info.chapter_list ?? [];
  const latest = chapters[0];
  const first = chapters[chapters.length - 1];
  const p = lib.progress;

  const row = (label: string, value?: string) =>
    `<tr><th scope="row">${label}</th><td>${esc(value || '-')}</td></tr>`;

  const genres = (info.genre ?? [])
    .map((g) => ({ g, slug: genreSlug(g) }))
    .filter((x) => x.slug)
    .map((x) => `<li><a class="chip" href="${esc(genreHref(x.slug))}">${esc(x.g)}</a></li>`)
    .join('');

  const resume = p
    ? `<a class="btn btn-primary btn-resume" data-resume href="${esc(resumeHref(p.chapter.slug, p.page))}"><span class="lbl">Lanjutkan · ${esc(p.chapter.name)}</span>${
        p.page > 0 ? `<span class="btn-pg">hal. ${p.page + 1}</span>` : ''
      }</a>`
    : '';
  const bookmark = `<button type="button" class="btn btn-bookmark" data-bookmark ${bmData(lib.slug, info.title, info.thumbnail, info.type)} aria-pressed="${lib.bookmarked}">${ICON_BOOKMARK}<span class="bm-label">${
    lib.bookmarked ? 'Tersimpan' : 'Simpan'
  }</span></button>`;
  const read = chapters.length
    ? `${resume || `<a class="btn btn-primary" href="${esc(chapterHref(chapterSlug(first.endpoint)))}">Baca Chapter Awal</a>`}
       ${resume ? `<a class="btn" href="${esc(chapterHref(chapterSlug(first.endpoint)))}">Baca dari awal</a>` : ''}
       <a class="btn" href="${esc(chapterHref(chapterSlug(latest.endpoint)))}">Chapter Terbaru</a>`
    : `${resume}<p class="muted">Belum ada chapter yang tersedia.</p>`;

  const lastRead = p ? p.chapter.slug.toLowerCase() : '';
  const list = chapters
    .map((c) => {
      const slug = chapterSlug(c.endpoint);
      const key = slug.toLowerCase();
      const isRead = lib.read.has(key);
      const isLast = key === lastRead;
      return `<li${isRead ? ' class="is-read"' : ''}><a href="${esc(chapterHref(slug))}"><span class="ch-name">${esc(c.name)}</span>${
        isLast ? '<span class="ch-tag">Terakhir dibaca</span>' : ''
      }${isRead ? `${ICON_CHECK}${isLast ? '' : '<span class="sr-only">sudah dibaca</span>'}` : ''}</a></li>`;
    })
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
      <div class="cta">${read}${bookmark}</div>
    </article>
    ${synopsisHtml(info.synopsis, lib.synopsisOpen)}
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
export const shortName = (n: string) => n.replace(/^chapter\s*/i, 'Ch. ');

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

/* ---------------------------------------------------------- daftar komik */

/** Sub-menu Daftar Komik: satu tabel untuk tab, judul halaman, dan menu header. */
export const LIST_TABS: ReadonlyArray<{ tipe: ListTipe; label: string; title: string }> = [
  { tipe: '', label: 'Semua', title: 'Daftar Komik' },
  { tipe: 'manga', label: 'Manga', title: 'Daftar Manga' },
  { tipe: 'manhwa', label: 'Manhwa', title: 'Daftar Manhwa' },
  { tipe: 'manhua', label: 'Manhua', title: 'Daftar Manhua' },
];

/** Baris tab jenis (tautan biasa, `aria-current` pada yang aktif). Statis: boleh tampil sebelum data tiba. */
export const daftarTabsHtml = (active: ListTipe): string =>
  `<nav class="seg" aria-label="Jenis komik">${LIST_TABS.map(
    (t) =>
      `<a class="seg-item" href="${esc(daftarHref(t.tipe))}" data-tipe="${t.tipe}"${t.tipe === active ? ' aria-current="page"' : ''}>${t.label}</a>`,
  ).join('')}</nav>`;

/* ---------------------------------------------------------------- helpers */

/** Judul dengan potongan yang cocok dibungkus <mark>. Teks di-escape per potongan, jadi aman dari XSS. */
export function highlightHtml(text: string, q: string): string {
  const needle = q.trim().toLowerCase();
  const hay = text.toLowerCase();
  // toLowerCase() bisa mengubah panjang untuk huruf tertentu; indeks lalu tak sejajar -> tanpa sorotan.
  const i = needle && hay.length === text.length ? hay.indexOf(needle) : -1;
  if (i < 0) return esc(text);
  const end = i + needle.length;
  return `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, end))}</mark>${esc(text.slice(end))}`;
}

/** Satu opsi autocomplete (`a[role=option]`): sampul kecil, judul dengan sorotan, lencana jenis. */
export const suggestOptionHtml = (o: { slug: string; title: string; cover: string; type?: string }, q: string, i: number): string =>
  `<a class="sg-opt" role="option" id="sg-${i}" aria-selected="false" tabindex="-1" href="${esc(mangaHref(o.slug))}">` +
  (o.cover
    ? `<img class="sg-cover" src="${esc(o.cover)}" alt="" width="40" height="56" loading="lazy" decoding="async">`
    : '<span class="sg-cover"></span>') +
  `<span class="sg-title">${highlightHtml(o.title, q)}</span>` +
  (o.type ? `<span class="sg-badge badge-${typeKey(o.type)}">${esc(o.type)}</span>` : '') +
  `</a>`;

let rtf: Intl.RelativeTimeFormat | undefined;

/** "baru saja", "5 menit lalu", "kemarin", "3 hari lalu", "minggu lalu"... (Intl, bahasa Indonesia). */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const s = Math.floor((now - ts) / 1000);
  if (s < 45) return 'baru saja'; // termasuk cap waktu di masa depan (jam perangkat bergeser)
  const [unit, size]: [Intl.RelativeTimeFormatUnit, number] =
    s < 3600 ? ['minute', 60]
    : s < 86400 ? ['hour', 3600]
    : s < 604800 ? ['day', 86400]
    : s < 2592000 ? ['week', 604800]
    : s < 31557600 ? ['month', 2592000]
    : ['year', 31557600];
  rtf ??= new Intl.RelativeTimeFormat('id', { numeric: 'auto' });
  return rtf.format(-Math.max(1, Math.floor(s / size)), unit).replace(' yang lalu', ' lalu');
}

const coverImg = (src: string, w: number, h: number): string =>
  src ? `<img src="${esc(src)}" alt="" width="${w}" height="${h}" loading="lazy" decoding="async">` : '';

const ICON_X =
  '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

/* ------------------------------------------------- lanjut membaca (beranda) */

/** Kartu lanjut baca: sampul, judul, "Ch. X · hal. N"; langsung ke posisi terakhir. */
function resumeCardHtml(p: Progress): string {
  const badge = p.type ? `<span class="badge badge-${typeKey(p.type)}">${esc(p.type)}</span>` : '';
  return (
    `<a class="card" href="${esc(resumeHref(p.chapter.slug, p.page))}">` +
    `<span class="cover">${
      p.cover ? `<img src="${esc(p.cover)}" alt="Sampul ${esc(p.title)}" width="200" height="300" loading="lazy" decoding="async">` : ''
    }${badge}</span>` +
    `<h3 class="card-title">${esc(p.title)}</h3>` +
    `<p class="card-sub">${esc(shortName(p.chapter.name))} · hal. ${p.page + 1}</p>` +
    `</a>`
  );
}

export const resumeRailHtml = (list: readonly Progress[]): string =>
  `<ol class="rail" role="list">${list.map((p) => `<li>${resumeCardHtml(p)}</li>`).join('')}</ol>`;

/* ---------------------------------------------------------------- pustaka */

/** Kerangka halaman Pustaka: dibuat sekali. Isi tab ada di `[data-lib-view]`, yang digambar ulang. */
export const libraryShellHtml = (): string => `
  <div class="page-head"><h1>Pustaka</h1><p class="muted">Tersimpan di browser ini.</p></div>
  <div data-lib-view></div>
  <section class="lib-tools" aria-labelledby="h-tools">
    <h2 id="h-tools" class="sr-only">Cadangan data</h2>
    <p class="muted">Pindahkan pustaka ke perangkat lain dengan ekspor lalu impor berkasnya di sana.</p>
    <div class="lib-tools-row">
      <button type="button" class="btn" data-export>Ekspor data</button>
      <button type="button" class="btn" data-import>Impor data</button>
      <input type="file" accept="application/json,.json" data-import-file hidden>
    </div>
    <p class="lib-status" role="status" aria-live="polite" data-lib-status></p>
  </section>`;

const libEmpty = (text: string): string =>
  `<div class="empty"><p>${text}</p><a class="btn btn-primary" href="${esc(daftarHref())}">Jelajahi Daftar Komik</a></div>`;

function historyRowHtml(p: Progress, now: number): string {
  const at = new Date(p.updatedAt);
  const where = `${esc(p.chapter.name)} · hal. ${p.page + 1}${p.pageCount > 0 ? ` dari ${Math.max(p.pageCount, p.page + 1)}` : ''}`;
  const manga = esc(mangaHref(p.slug));
  return `<li class="lib-row">
    <a class="lib-cover" href="${manga}" tabindex="-1" aria-hidden="true"><span class="cover">${coverImg(p.cover, 56, 84)}</span></a>
    <div class="lib-main">
      <a class="lib-title" href="${manga}">${esc(p.title)}</a>
      <p class="lib-meta">${where}</p>
      <p class="lib-time muted"><time datetime="${esc(at.toISOString())}" title="${esc(at.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }))}">${esc(relativeTime(p.updatedAt, now))}</time></p>
    </div>
    <button type="button" class="icon-btn lib-remove" data-remove-history data-slug="${esc(p.slug)}" aria-label="Hapus ${esc(p.title)} dari riwayat">${ICON_X}</button>
    <div class="lib-actions">
      <a class="btn btn-primary" href="${esc(resumeHref(p.chapter.slug, p.page))}">Lanjutkan</a>
      <a class="btn" href="${manga}">Info</a>
    </div>
  </li>`;
}

function historyPanelHtml(list: readonly Progress[], now: number): string {
  if (!list.length) return libEmpty('Belum ada riwayat bacaan. Mulai membaca dan posisimu akan tersimpan di sini.');
  return `<div class="lib-bar"><p class="muted">${list.length} judul, terakhir dibaca di atas</p>
      <button type="button" class="btn" data-clear-history>Hapus semua riwayat</button></div>
    <ul class="lib-list" role="list">${list.map((p) => historyRowHtml(p, now)).join('')}</ul>`;
}

function bookmarkPanelHtml(list: readonly Bookmark[]): string {
  if (!list.length) return libEmpty('Belum ada bookmark. Tekan Simpan di halaman sebuah judul untuk menaruhnya di sini.');
  // Tombol hapus saudara dari tautan kartu (bukan di dalamnya): menekannya tidak membuka judul.
  return `<ul class="grid" role="list">${list
    .map(
      (b) =>
        `<li class="bm">${cardHtml({ title: b.title, image: b.cover, type: b.type, endpoint: `/manga/${b.slug}/` })}` +
        `<button type="button" class="bm-remove" data-remove-bookmark data-slug="${esc(b.slug)}" aria-label="Hapus ${esc(b.title)} dari bookmark"><span aria-hidden="true">${ICON_X}</span></button></li>`,
    )
    .join('')}</ul>`;
}

/** Tab Riwayat/Bookmark (ARIA tabs) + panel aktif. Panel yang tidak aktif `hidden` dan kosong. */
export function libraryViewHtml(o: {
  tab: LibTab;
  history: readonly Progress[];
  bookmarks: readonly Bookmark[];
  now: number;
}): string {
  const tab = (t: LibTab, label: string, n: number) =>
    `<button type="button" class="tab" role="tab" id="tab-${t}" data-tab="${t}" aria-selected="${o.tab === t}" aria-controls="panel-${t}" tabindex="${o.tab === t ? 0 : -1}">${label}<span class="tab-count">${n}</span></button>`;
  const panel = (t: LibTab, html: string) =>
    `<div class="tab-panel" role="tabpanel" id="panel-${t}" aria-labelledby="tab-${t}" tabindex="0"${o.tab === t ? '' : ' hidden'}>${
      o.tab === t ? html : ''
    }</div>`;
  return (
    `<div class="tabs" role="tablist" aria-label="Pustaka">${tab('riwayat', 'Riwayat', o.history.length)}${tab('bookmark', 'Bookmark', o.bookmarks.length)}</div>` +
    panel('riwayat', historyPanelHtml(o.history, o.now)) +
    panel('bookmark', bookmarkPanelHtml(o.bookmarks))
  );
}
