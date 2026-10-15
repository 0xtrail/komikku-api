/**
 * Template HTML reader (string murni, tanpa DOM): kerangka, header (+ sakelar "Lanjut otomatis"),
 * bar navigasi, satu `section.chapter` per chapter, dan keadaan slot di bawah chapter terakhir.
 *
 * Hook stabil (dipakai restyle/tes): `[data-reader]` akar; `section.chapter[data-chapter="<slug>"]
 * [data-chapter-name]` per chapter; `.chapter-divider` antar chapter; `img.page[data-page="<1-based>"]`
 * (tanpa id ganda); `[data-append-slot]` (= `[data-rnav-slot="end"]`, dengan `data-state`) tempat chapter
 * berikutnya/ keadaan memuat/ galat; `[data-read-progress]`; `[data-autonext-toggle]`.
 *
 * ATURAN: setiap string dari API WAJIB lewat `esc()`.
 */
import { esc, shortName } from './views.ts';
import { ICON_ARROW_LEFT } from './icons.ts';
import { mangaHref, chapterHref } from './routes.ts';
import { resumeToastText, type Step } from './readerlogic.ts';

/**
 * Keadaan navigasi reader.
 *  - none    : manga induk tak diketahui -> tanpa navigasi
 *  - pending : tebakan manga (API lama) belum terverifikasi lewat info
 *  - ready   : manga diketahui; prev/next ada bila diketahui
 * `title` = judul dari API chapter, dipakai bila nama chapter tidak diketahui.
 */
export interface ReaderCtx {
  title: string;
  state: 'none' | 'pending' | 'ready';
  back?: string;
  mangaTitle?: string;
  current?: string;
  prev?: Step;
  next?: Step;
  /** Pasti chapter terbaru (tak ada chapter berikutnya) -> catatan "Ini chapter terbaru" di akhir. */
  latest?: boolean;
  /** Sakelar "Lanjut otomatis"; undefined = aktif. */
  autoNext?: boolean;
  /** Sampul manga (dari info) untuk panel akhir chapter; tanpa itu panelnya tak bergambar. */
  cover?: string;
}

/** Judul chapter yang tampil: nama dari daftar chapter bila ada, kalau tidak judul API. */
export const readerTitle = (c: ReaderCtx): string => c.current || c.title;

/**
 * Bar atas reader (tetap di atas layar): tombol kembali ke manga, nama manga + chapter, sakelar
 * "Lanjut otomatis", dan penunjuk halaman (desktop). Di ponsel penunjuk ada di bar bawah.
 */
export function readerHeadHtml(c: ReaderCtx): string {
  // Tebakan manga (pending) belum boleh ditautkan: slug-nya bisa salah. Ruangnya ditahan agar header tak bergeser.
  const back =
    c.back && c.state === 'pending'
      ? '<span class="reader-back" aria-hidden="true">&nbsp;</span>'
      : c.back
        ? `<a class="reader-back" href="${esc(mangaHref(c.back))}" aria-label="Kembali ke ${esc(c.mangaTitle || 'info manga')}">${ICON_ARROW_LEFT}</a>`
        : '';
  const on = c.autoNext !== false;
  const manga = c.mangaTitle ? `<span class="reader-manga">${esc(c.mangaTitle)}</span>` : '';
  return `${back}<div class="reader-meta">${manga}<h1 class="reader-title">${esc(readerTitle(c))}</h1></div>
    <div class="reader-tools">
      <button type="button" class="reader-toggle" data-autonext-toggle aria-pressed="${on}"><span class="toggle-sw" aria-hidden="true"></span><span class="toggle-lbl">Lanjut otomatis</span></button>
      <span class="reader-progress" data-read-progress></span>
    </div>`;
}

/**
 * Tombol prev/next. `pos`:
 *  - top   : baris prev/next di bawah bar atas
 *  - end   : akhir chapter — tombol kembali + prev/next berlabel nama chapter (+ "Ini chapter terbaru")
 *  - fixed : bar tetap di bawah layar (zona jempol): ← | ‹ Ch. 1 | Chapter 2 · 3 / 40 | Ch. 3 ›
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
        : `<span class="fix-now"><span class="fix-name">${esc(readerTitle(c))}</span><span class="fix-pg" data-read-progress></span></span>`;
    return `<nav class="fixbar" data-rnav="fixed" aria-label="Navigasi chapter">
      <a class="btn btn-ghost fix-back" href="${back}" aria-label="Kembali ke info manga">${ICON_ARROW_LEFT}</a>
      ${step('prev')}${now}${step('next')}
    </nav>`;
  }

  if (pos === 'end') {
    const note = c.latest && !c.next ? '<p class="reader-end-note">Ini chapter terbaru</p>' : '';
    const cover = c.cover
      ? `<span class="cover end-cover"><img src="${esc(c.cover)}" alt="" width="60" height="80" loading="lazy" decoding="async"></span>`
      : '';
    return `<nav class="reader-bar reader-bar-end" data-rnav="end" aria-label="Navigasi chapter (akhir)">
    <div class="end-panel">
      ${cover}
      <div class="end-text"><p class="end-title">Kamu sudah sampai akhir</p>${note}</div>
      <span class="reader-steps">${step('prev')}${step('next')}</span>
      <a class="btn btn-ghost reader-home" href="${back}">Info manga</a>
    </div>
  </nav>`;
  }
  return `<nav class="reader-bar reader-bar-top" data-rnav="top" aria-label="Navigasi chapter (atas)">
    <span class="reader-steps">${step('prev')}${step('next')}</span>
  </nav>`;
}

/* ---------------------------------------------------------------- chapter */

export interface SectionInput {
  slug: string;
  /** Nama tampilan ("Chapter 66"). */
  name: string;
  images: readonly string[];
  /** Indeks gambar yang langsung punya `src`; sisanya hanya `data-src` (dimuat observer saat mendekat). */
  eager: ReadonlySet<number>;
  /** Indeks gambar berprioritas tinggi (`fetchpriority=high`). */
  priority?: number;
  /** Chapter yang ditambahkan di bawah chapter lain diawali pembatas bernama. */
  divider?: boolean;
}

/** Satu chapter: pembatas (opsional) + gambar halaman. Gambar tanpa `src` tetap memegang tempat lewat aspect-ratio CSS. */
export function chapterSectionHtml(o: SectionInput): string {
  const pages = o.images
    .map((src, i) => {
      const source =
        o.eager.has(i) ? `src="${esc(src)}"${i === o.priority ? ' fetchpriority="high"' : ''}` : `data-src="${esc(src)}"`;
      return `<img class="page" data-page="${i + 1}" ${source} alt="Halaman ${i + 1}" decoding="async">`;
    })
    .join('');
  const divider = o.divider
    ? `<div class="chapter-divider"><span class="chapter-divider-name">${esc(o.name)}</span><span class="chapter-divider-cap" aria-hidden="true">Chapter berikutnya</span><a class="chapter-divider-link" href="${esc(chapterHref(o.slug))}">Buka chapter ini</a></div>`
    : '';
  return `<section class="chapter" data-chapter="${esc(o.slug)}" data-chapter-name="${esc(o.name)}">${divider}<div class="pages">${
    pages || '<p class="empty">Chapter ini belum memiliki halaman.</p>'
  }</div></section>`;
}

/* ------------------------------------------------------- slot di bawah chapter */

export type SlotState = 'idle' | 'loading' | 'end' | 'off';

/**
 * Isi `[data-append-slot]` untuk chapter terakhir yang dimuat.
 *  - idle    : lanjut otomatis aktif, belum dipicu: tautan manual ke chapter berikutnya
 *  - loading : sedang mengambil chapter berikutnya
 *  - end     : tak ada chapter berikutnya: navigasi akhir (+ "Ini chapter terbaru")
 *  - off     : lanjut otomatis mati: navigasi akhir klasik
 * Keadaan galat diisi `showError` (errorstate.ts) langsung ke slot.
 */
export function slotHtml(state: SlotState, c: ReaderCtx): string {
  if (state === 'loading') {
    return `<div class="append-loading"><span class="feed-spinner" aria-hidden="true"></span><span>Memuat ${esc(c.next?.name ?? 'chapter berikutnya')}…</span></div>`;
  }
  if (state === 'idle' && c.next) {
    return `<div class="append-idle"><a class="btn btn-primary" href="${esc(chapterHref(c.next.slug))}">Lanjut: ${esc(c.next.name)}</a></div>`;
  }
  return readerNavHtml(c, 'end');
}

/** Kerangka reader: header, navigasi atas, chapter-chapter, slot bawah, bar tetap. */
export function readerShellHtml(o: { ctx: ReaderCtx; sections: string; slot: string; slotState: SlotState }): string {
  return `<div class="reader" data-reader>
    <header class="reader-head" data-rnav-slot="head">${readerHeadHtml(o.ctx)}</header>
    <div data-rnav-slot="top">${readerNavHtml(o.ctx, 'top')}</div>
    <div class="chapters" data-chapters>${o.sections}</div>
    <div data-rnav-slot="end" data-append-slot data-state="${o.slotState}" aria-live="polite">${o.slot}</div>
    <div data-rnav-slot="fixed">${readerNavHtml(o.ctx, 'fixed')}</div>
  </div>`;
}

/** Toast setelah reader melompat ke posisi terakhir (`index` 0-based): bisa ditutup atau diulang dari awal. */
export const resumeToastHtml = (index: number): string =>
  `<div class="reader-toast" data-reader-toast role="status"><span class="reader-toast-text">${esc(resumeToastText(index))}</span><button type="button" class="reader-toast-btn" data-toast-restart>Mulai dari awal</button><button type="button" class="reader-toast-x" data-toast-close aria-label="Tutup"><span aria-hidden="true">&times;</span></button></div>`;
