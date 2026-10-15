/**
 * Template beranda (string murni, tanpa DOM): strip Sorotan, daftar Update Terbaru, daftar peringkat
 * sidebar, dan tabel `HOME_VIEWS` — satu sumber render + skeleton per section beranda.
 *
 * Dipakai dengan markup IDENTIK di build time (index.astro, prerender) dan di browser (client.ts
 * `mountHome`, tukar isi section hanya bila datanya berbeda). Karena keduanya membaca tabel yang sama,
 * mengganti isi tidak menggeser layout.
 *
 * ATURAN: setiap string dari API WAJIB lewat `esc()`.
 */
import { slugOf, type Manga, type Genre } from './api.ts';
import { mangaHref } from './routes.ts';
import { EMPTY, esc, genreCloud, recoRailHtml, skelChips, skelRail, typeBadgeHtml } from './views.ts';

/** Gambar sampul baris/strip. `eager` = tanpa lazy (yang terlihat di layar pertama). */
const img = (m: Manga, w: number, h: number, eager = false): string =>
  m.image
    ? `<img src="${esc(m.image)}" alt="" width="${w}" height="${h}" ${eager ? '' : 'loading="lazy" '}decoding="async">`
    : '';

/** Strip Sorotan: sampul besar 3/4 bergulir horizontal, judul di atas gradien gelap. */
export function heroHtml(list: Manga[]): string {
  if (!list.length) return '';
  return `<ol class="hero-track" role="list">${list
    .map(
      (m, i) =>
        `<li><a class="card hero-item" href="${esc(mangaHref(slugOf(m.endpoint)))}"><span class="cover">` +
        (m.image
          ? `<img src="${esc(m.image)}" alt="Sampul ${esc(m.title)}" width="300" height="400" ${i < 6 ? '' : 'loading="lazy" '}decoding="async">`
          : '') +
        `${typeBadgeHtml(m.type)}<span class="hero-title card-title">${esc(m.title)}</span></span></a></li>`,
    )
    .join('')}</ol>`;
}

/** Isi baris: judul, jenis, dan sinopsis pendek (`desc`, dua baris di CSS) bila API memberinya; "-" = kosong. */
const rowBody = (m: Manga): string =>
  `<span class="row-body"><span class="card-title row-title">${esc(m.title)}</span>` +
  `<span class="row-meta">${typeBadgeHtml(m.type)}</span>` +
  (m.desc && m.desc.trim().length > 1 ? `<span class="row-desc">${esc(m.desc)}</span>` : '') +
  `</span>`;

/** Update Terbaru: dua kolom di desktop (CSS); sampul 64x86. */
export function updatesHtml(list: Manga[]): string {
  if (!list.length) return EMPTY;
  return `<ul class="updates" role="list">${list
    .map(
      (m) =>
        `<li><a class="card row" href="${esc(mangaHref(slugOf(m.endpoint)))}"><span class="cover row-cover">${img(m, 64, 86)}</span>${rowBody(m)}</a></li>`,
    )
    .join('')}</ul>`;
}

/** Daftar peringkat sidebar: nomor bulat ungu menimpa pojok kiri atas sampul 60x80. */
export function rankedHtml(list: Manga[]): string {
  if (!list.length) return EMPTY;
  return `<ol class="ranked" role="list">${list
    .map(
      (m, i) =>
        `<li><a class="card row" href="${esc(mangaHref(slugOf(m.endpoint)))}"><span class="rk-thumb"><span class="cover row-cover">${img(m, 60, 80)}</span><span class="rk-num" aria-hidden="true">${i + 1}</span></span>${rowBody(m)}</a></li>`,
    )
    .join('')}</ol>`;
}

/* -------------------------------------------------------------- skeletons */

export const skelHero = (n = 8): string =>
  `<ol class="hero-track" role="list" aria-hidden="true">${'<li><span class="sk hero-sk"></span></li>'.repeat(n)}</ol>`;

const skelRow = '<span class="sk-rowcard"><span class="sk sk-thumb"></span><span class="sk-lines"><span class="sk sk-line"></span><span class="sk sk-line s"></span></span></span>';

export const skelUpdates = (n = 6): string =>
  `<ul class="updates" role="list" aria-hidden="true">${`<li>${skelRow}</li>`.repeat(n)}</ul>`;

export const skelRanked = (n = 6): string =>
  `<ol class="ranked" role="list" aria-hidden="true">${`<li>${skelRow}</li>`.repeat(n)}</ol>`;

/* ----------------------------------------------------------- tabel section */

/**
 * Section beranda yang isinya dari API, per kunci `data-sec`. Sumber data (path API) ada di client.ts
 * dan index.astro; di sini hanya cara menggambarnya. `hero` dan `rank-popular` memakai data Populer
 * yang sama, `recommended` dan `rank-recommended` data Rekomendasi yang sama (cache menyatukan request).
 */
export const HOME_VIEWS = {
  hero: { render: heroHtml, skeleton: skelHero() },
  recommended: { render: recoRailHtml, skeleton: skelRail() },
  newest: { render: updatesHtml, skeleton: skelUpdates() },
  'rank-popular': { render: rankedHtml, skeleton: skelRanked() },
  'rank-recommended': { render: rankedHtml, skeleton: skelRanked() },
  genre: { render: (l: Genre[]) => genreCloud(l), skeleton: skelChips() },
} as const;

export type HomeKey = keyof typeof HOME_VIEWS;
