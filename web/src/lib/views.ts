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
import { slugOf, chapterSlug, type Manga, type Genre, type MangaInfo, type ListTipe } from './api.ts';
import { mangaHref, chapterHref, genreHref, genreSlug, daftarHref, resumeHref, type LibTab } from './routes.ts';
// Hanya TIPE (terhapus saat build): views tidak boleh menyentuh storage. Data pustaka dioper sebagai parameter.
import type { Bookmark, Progress } from './library';
import {
  ICON_BOOKMARK,
  ICON_CHECK,
  ICON_CHEV_DOWN,
  ICON_CLOCK,
  ICON_EYE,
  ICON_PLUS_CIRCLE,
  ICON_SEARCH,
  ICON_SORT,
  ICON_X,
} from './icons.ts';

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

export const typeKey = (t?: string): string => {
  const k = (t ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return k === 'manga' || k === 'manhwa' || k === 'manhua' ? k : 'other';
};

/** Chip jenis (Manga/Manhwa/Manhua) dengan titik warna; di sampul ia melayang di pojok kanan atas (CSS). */
export const typeBadgeHtml = (t?: string): string =>
  t ? `<span class="badge badge-${typeKey(t)}"><i class="dot" aria-hidden="true"></i>${esc(t)}</span>` : '';

/**
 * Kartu manga. `rank` (1-based) menambah angka peringkat besar di sampul —
 * dipakai baris Populer.
 */
export function cardHtml(m: Manga, rank?: number): string {
  const badge = typeBadgeHtml(m.type);
  const rankEl = rank ? `<span class="rank" aria-hidden="true">${rank}</span>` : '';
  return (
    `<a class="card" href="${esc(mangaHref(slugOf(m.endpoint)))}">` +
    `<span class="cover">` +
    (m.image
      ? `<img src="${esc(m.image)}" alt="Sampul ${esc(m.title)}" width="300" height="400" loading="lazy" decoding="async">`
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
 * tidak valid dan menekannya akan menavigasi); CSS memasangnya selebar kartu di dasar `li.has-bm`.
 * Nama aksesibel "Bookmark <judul>" memuat teks yang tampil ("Bookmark"/"Tersimpan" di `.bm-label`);
 * keadaan lewat `aria-pressed` (disetel `syncBookmarkButtons`).
 */
export const bookmarkButtonHtml = (m: Manga): string =>
  `<button type="button" class="card-bm" ${bmData(slugOf(m.endpoint), m.title, m.image, m.type)} aria-pressed="false" aria-label="Bookmark ${esc(m.title)}">${ICON_BOOKMARK}<span class="bm-label">Bookmark</span></button>`;

/** Satu item daftar: kartu + tombol bookmark. Dipakai grid, baris Populer, dan feed. */
export const cardItemHtml = (m: Manga, rank?: number): string =>
  `<li class="has-bm">${cardHtml(m, rank)}${bookmarkButtonHtml(m)}</li>`;

export const EMPTY = '<p class="empty">Belum ada data untuk ditampilkan.</p>';

/** Grid kartu: 2 kolom di ponsel, sampai 6 di desktop (CSS). */
export const gridHtml = (list: Manga[]): string =>
  list.length ? `<ul class="grid" role="list">${list.map((m) => cardItemHtml(m)).join('')}</ul>` : EMPTY;

/** Baris geser horizontal; `ranked` menambah angka peringkat besar di sampul. */
export const railHtml = (list: Manga[], ranked = true): string =>
  list.length
    ? `<ol class="rail" role="list">${list.map((m, i) => cardItemHtml(m, ranked ? i + 1 : undefined)).join('')}</ol>`
    : EMPTY;

/** Baris geser panel Rekomendasi di beranda (tanpa peringkat: peringkat ada di sidebar). */
export const recoRailHtml = (list: Manga[]): string => railHtml(list, false);

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
  '<li><span class="sk-card"><span class="sk sk-cover"></span><span class="sk sk-line"></span><span class="sk sk-btn-block"></span></span></li>';

export const skelGrid = (n = 10): string =>
  `<ul class="grid" role="list" aria-hidden="true">${skelCard.repeat(n)}</ul>`;

export const skelRail = (n = 8): string =>
  `<ol class="rail" role="list" aria-hidden="true">${skelCard.repeat(n)}</ol>`;

export const skelChips = (n = 18): string =>
  `<ul class="chips" role="list" aria-hidden="true">${'<li><span class="sk sk-chip"></span></li>'.repeat(n)}</ul>`;

/** Kerangka halaman daftar: panel judul + grid. */
export const skelListing = (): string =>
  `<div class="page-head filter-panel" aria-hidden="true"><span class="sk sk-title"></span></div>${skelGrid(10)}${SR_LOADING}`;

export const skelDetail = (): string =>
  `<div class="detail-page" aria-hidden="true">
    <article class="detail">
      <div class="detail-side"><div class="detail-cover"><span class="sk sk-cover"></span></div><span class="sk sk-block"></span></div>
      <div class="detail-main">
        <div class="title-panel"><span class="sk sk-title"></span><span class="sk sk-line"></span><span class="sk sk-line"></span><span class="sk sk-line s"></span></div>
        <div class="cta"><span class="sk sk-btn-lg"></span><span class="sk sk-btn-lg"></span><span class="sk sk-btn-lg"></span></div>
        <div class="chapter-box panel">${'<span class="sk sk-row"></span>'.repeat(6)}</div>
      </div>
    </article>
  </div>${SR_LOADING}`;

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
  /** Daftar chapter dari yang terlama (default: terbaru dulu, urutan API). */
  oldestFirst?: boolean;
}

/** Sinopsis lebih panjang dari ini dipangkas (~3 baris) dengan tombol "Selengkapnya". */
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
      <h2 id="h-syn" class="sr-only">Sinopsis</h2>
      <div class="syn-body" id="syn-body">${paras.map((p) => `<p>${esc(p)}</p>`).join('')}</div>
      ${
        long
          ? `<button type="button" class="syn-toggle" data-syn-toggle aria-expanded="${open}" aria-controls="syn-body">${open ? 'Ringkas' : 'Selengkapnya'}</button>`
          : ''
      }
    </section>`;
}

/** Teks tombol urutan chapter: urutan yang sedang tampil. */
export const sortLabel = (oldestFirst: boolean): string => (oldestFirst ? 'Terlama' : 'Terbaru');

export const sortAriaLabel = (oldestFirst: boolean): string =>
  `Urutan chapter: ${sortLabel(oldestFirst).toLowerCase()} dulu. Tekan untuk membalik`;

export function detailHtml(info: MangaInfo, lib: DetailLib): string {
  const chapters = info.chapter_list ?? [];
  const latest = chapters[0];
  const first = chapters[chapters.length - 1];
  const p = lib.progress;
  const oldest = lib.oldestFirst === true;

  const stat = (tone: string, label: string, value: string) =>
    `<div class="stat"><dt>${label}</dt><dd class="stat-${tone}">${esc(value || '-')}</dd></div>`;
  const fact = (label: string, value: string, dot = false) =>
    `<div class="fact"><dt>${label}</dt><dd>${dot ? '<i class="dot" aria-hidden="true"></i>' : ''}<span class="fact-val">${esc(value || '-')}</span></dd></div>`;

  const genres = (info.genre ?? [])
    .map((g) => ({ g, slug: genreSlug(g) }))
    .filter((x) => x.slug)
    .map((x) => `<li><a class="chip chip-sm" href="${esc(genreHref(x.slug))}">${esc(x.g)}</a></li>`)
    .join('');

  const firstHref = chapters.length ? esc(chapterHref(chapterSlug(first.endpoint))) : '';
  const resume = p
    ? `<a class="btn btn-lg btn-resume" data-resume href="${esc(resumeHref(p.chapter.slug, p.page))}">${ICON_EYE}<span class="lbl">Lanjutkan · ${esc(p.chapter.name)}</span>${
        p.page > 0 ? `<span class="btn-pg">hal. ${p.page + 1}</span>` : ''
      }</a>`
    : '';
  const bookmark = `<button type="button" class="btn btn-lg btn-bookmark" data-bookmark ${bmData(lib.slug, info.title, info.thumbnail, info.type)} aria-pressed="${lib.bookmarked}">${ICON_BOOKMARK}<span class="bm-label">${
    lib.bookmarked ? 'Tersimpan' : 'Bookmark'
  }</span></button>`;
  const cta = chapters.length
    ? `${bookmark}${resume || `<a class="btn btn-lg btn-first" href="${firstHref}">${ICON_EYE}<span class="lbl">Baca Chapter Awal</span></a>`}` +
      `<a class="btn btn-lg btn-latest" href="${esc(chapterHref(chapterSlug(latest.endpoint)))}">${ICON_CLOCK}<span class="lbl">Chapter Terbaru</span></a>` +
      (resume ? `<a class="cta-more" href="${firstHref}">Baca dari awal</a>` : '')
    : `${bookmark}${resume}<p class="muted cta-none">Belum ada chapter yang tersedia.</p>`;

  const lastRead = p ? p.chapter.slug.toLowerCase() : '';
  const rows = oldest ? [...chapters].reverse() : chapters;
  const list = rows
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
    <div class="detail-page">
    ${info.thumbnail ? `<div class="detail-bg" aria-hidden="true"><img src="${esc(info.thumbnail)}" alt="" width="240" height="360" decoding="async"></div>` : ''}
    <article class="detail">
      <div class="detail-side">
        <div class="detail-cover">
          <span class="cover"><img src="${esc(info.thumbnail)}" alt="Sampul ${esc(info.title)}" width="300" height="400" decoding="async" fetchpriority="high"></span>
        </div>
        <dl class="stats">${stat('gold', 'Rating', info.rating ?? '')}${stat('green', 'Chapter', String(chapters.length))}${stat('blue', 'Tipe', info.type ?? '')}</dl>
        <dl class="facts">${fact('Status', info.status ?? '', true)}${fact('Pengarang', info.author ?? '')}</dl>
        ${genres ? `<ul class="chips" role="list" aria-label="Genre">${genres}</ul>` : ''}
      </div>
      <div class="detail-main">
        <div class="title-panel">
          <h1>${esc(info.title)}</h1>
          ${synopsisHtml(info.synopsis, lib.synopsisOpen)}
        </div>
        <div class="cta">${cta}</div>
        <section class="chapter-box panel" aria-labelledby="h-chapters">
          <div class="chapter-head">
            <h2 id="h-chapters"><span data-count aria-live="polite">${chapters.length} Chapter</span></h2>
            ${
              chapters.length > 1
                ? `<button type="button" class="btn btn-sm sort-btn" data-sort aria-label="${sortAriaLabel(oldest)}">${ICON_SORT}<span class="sort-lbl">${sortLabel(oldest)}</span></button>`
                : ''
            }
          </div>
          ${
            chapters.length > 8
              ? `<div class="filter-wrap"><input class="filter" type="search" data-filter placeholder="Cari chapter, mis. 12" aria-label="Cari chapter" autocomplete="off">${ICON_SEARCH}</div>`
              : ''
          }
          <ul class="chapter-list" role="list" aria-label="Daftar chapter">${list || '<li class="muted pad">Belum ada chapter.</li>'}</ul>
          <p class="muted pad" data-empty hidden>Tidak ada chapter yang cocok dengan pencarian.</p>
        </section>
      </div>
    </article>
    </div>`;
}

/** "Chapter 12" -> "Ch. 12" (untuk ruang sempit: bar bawah reader, kartu lanjut baca). */
export const shortName = (n: string) => n.replace(/^chapter\s*/i, 'Ch. ');

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
      `<a class="seg-item" href="${esc(daftarHref(t.tipe))}" data-tipe="${t.tipe}"${t.tipe === active ? ' aria-current="page"' : ''}>${ICON_PLUS_CIRCLE}${t.label}</a>`,
  ).join('')}</nav>`;

/**
 * Tombol "Genre" + popover daftar genre (isi dimuat genrepop.ts saat pertama dibuka).
 * Tombol memegang `aria-expanded`; panel `hidden` sampai dibuka.
 */
export const genrePopHtml = (): string =>
  `<div class="genre-pop" data-genre-pop>` +
  `<button type="button" class="seg-item seg-genre" data-genre-toggle aria-expanded="false" aria-controls="genre-pop-panel">${ICON_PLUS_CIRCLE}Genre${ICON_CHEV_DOWN}</button>` +
  `<div class="pop-panel" id="genre-pop-panel" data-genre-panel role="region" aria-label="Pilih genre" hidden><div data-genre-body></div></div>` +
  `</div>`;

/** Baris filter Daftar Komik: tab jenis + tombol Genre. */
export const daftarFilterHtml = (active: ListTipe): string =>
  `<div class="filter-bar">${daftarTabsHtml(active)}${genrePopHtml()}</div>`;

/**
 * Kepala halaman bergaya panel filter: judul (`<h1>`), pil label/jumlah, baris keterangan, dan filter.
 * `title`/`pill` di-escape di sini; `sub` dan `filters` adalah HTML tepercaya dari pemanggil
 * (yang sendiri meng-escape teks API di dalamnya).
 */
export function pageHeadHtml(o: { title: string; pill?: string; sub?: string; filters?: string }): string {
  return `<header class="page-head filter-panel"><div class="ph-row"><h1>${esc(o.title)}</h1>${
    o.pill ? `<span class="pill">${esc(o.pill)}</span>` : ''
  }</div>${o.sub ?? ''}${o.filters ?? ''}</header>`;
}

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

/* ------------------------------------------------- lanjut membaca (beranda) */

/** Kartu lanjut baca: sampul, judul, "Ch. X · hal. N"; langsung ke posisi terakhir. */
function resumeCardHtml(p: Progress): string {
  return (
    `<a class="card" href="${esc(resumeHref(p.chapter.slug, p.page))}">` +
    `<span class="cover">${
      p.cover ? `<img src="${esc(p.cover)}" alt="Sampul ${esc(p.title)}" width="300" height="400" loading="lazy" decoding="async">` : ''
    }${typeBadgeHtml(p.type)}</span>` +
    `<h3 class="card-title">${esc(p.title)}</h3>` +
    `<p class="card-sub">${esc(shortName(p.chapter.name))} · hal. ${p.page + 1}</p>` +
    `</a>`
  );
}

export const resumeRailHtml = (list: readonly Progress[]): string =>
  `<ol class="rail" role="list">${list.map((p) => `<li class="card-li">${resumeCardHtml(p)}</li>`).join('')}</ol>`;

/* ---------------------------------------------------------------- pustaka */

/** Kerangka halaman Pustaka: dibuat sekali. Isi tab ada di `[data-lib-view]`, yang digambar ulang. */
export const libraryShellHtml = (): string => `
  <header class="page-head filter-panel"><div class="ph-row"><h1>Pustaka</h1><span class="pill" data-lib-count hidden></span></div><p class="ph-sub">Tersimpan di browser ini.</p></header>
  <div data-lib-view></div>
  <section class="lib-tools panel" aria-labelledby="h-tools">
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
    <a class="lib-cover" href="${manga}" tabindex="-1" aria-hidden="true"><span class="cover">${coverImg(p.cover, 60, 80)}</span></a>
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
  if (!list.length) return libEmpty('Belum ada bookmark. Tekan Bookmark di halaman sebuah judul untuk menaruhnya di sini.');
  // Tombol hapus saudara dari tautan kartu (bukan di dalamnya): menekannya tidak membuka judul.
  return `<ul class="grid" role="list">${list
    .map(
      (b) =>
        `<li class="bm">${cardHtml({ title: b.title, image: b.cover, type: b.type, endpoint: `/manga/${b.slug}/` })}` +
        `<button type="button" class="bm-remove" data-remove-bookmark data-slug="${esc(b.slug)}" aria-label="Hapus ${esc(b.title)} dari bookmark">${ICON_X}<span>Hapus</span></button></li>`,
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
