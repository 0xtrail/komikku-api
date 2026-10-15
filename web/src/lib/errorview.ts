/**
 * Tampilan keadaan galat (string murni, tanpa DOM): satu sumber markup untuk
 *   - halaman statis `404.astro` dan `50x.astro` (build time),
 *   - keadaan galat di dalam aplikasi (`errorstate.ts`: halaman gagal dimuat, section beranda,
 *     rute tak dikenal di `mountUnknown`).
 * Karena markup-nya sama, halaman galat dari nginx dan galat di aplikasi tampil seragam.
 *
 * Hook stabil untuk restyle/tes: `[data-error-state]` + `data-error-kind="notfound|server|
 * timeout|offline|unknown"` pada pembungkus, `[data-retry]` pada tombol/tautan "Coba lagi".
 * Teks untuk pengguna dipilih dari JENIS galat; pesan mentah API/Go tidak pernah masuk ke sini.
 */
import type { ErrorKind } from './api.ts';
import { esc } from './views.ts';

interface Copy {
  title: string;
  text: string;
}

const COPY: Record<ErrorKind, Copy> = {
  notfound: {
    title: 'Konten tidak ditemukan',
    text: 'Judul atau halaman yang kamu cari tidak ada, atau sudah dipindahkan.',
  },
  server: {
    title: 'Server sumber sedang bermasalah',
    text: 'Sumber komik sedang tidak bisa dihubungi. Biasanya pulih dalam beberapa menit, coba lagi sebentar lagi.',
  },
  timeout: {
    title: 'Server terlalu lama merespons',
    text: 'Permintaan memakan waktu terlalu lama. Coba lagi sebentar lagi.',
  },
  offline: {
    title: 'Kamu sedang offline',
    text: 'Periksa koneksi internetmu. Halaman dimuat ulang otomatis begitu kamu kembali online.',
  },
  unknown: {
    title: 'Terjadi kesalahan',
    text: 'Ada yang tidak berjalan semestinya. Coba muat ulang.',
  },
};

/** Judul singkat satu baris (status feed, saran pencarian). */
export const errorTitle = (kind: ErrorKind): string => COPY[kind].title;

const svg = (body: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false">${body}</svg>`;

const ICON: Record<ErrorKind, string> = {
  notfound: svg('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5M8.8 8.8l4.4 4.4M13.2 8.8l-4.4 4.4"/>'),
  server: svg(
    '<rect x="3.5" y="4" width="17" height="6.5" rx="2"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="2"/><path d="M7.5 7.25h.01M7.5 16.75h.01"/>',
  ),
  timeout: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  offline: svg(
    '<path d="M3 9.2a13 13 0 0 1 5-3M21 9.2a13 13 0 0 0-9-3.7M6.2 12.8a8.5 8.5 0 0 1 3-1.7M17.8 12.8a8.5 8.5 0 0 0-3-1.7M9.5 16.2a4 4 0 0 1 5 0M12 19.5h.01M3.5 3.5l17 17"/>',
  ),
  unknown: svg('<path d="M12 4 3 19.5h18L12 4ZM12 10v4.2M12 17h.01"/>'),
};

export interface ErrorOpts {
  /** Ringkas (section, feed) alih-alih halaman penuh dengan `<h1>`. */
  compact?: boolean;
  /** Angka besar dekoratif ("404"); hanya halaman penuh. */
  code?: string;
  /** Ganti judul/teks bawaan jenis ini (mis. "Halaman tidak ditemukan"). */
  title?: string;
  text?: string;
  /**
   * 'button' = `<button data-retry>` (butuh JS), 'link' = `<a data-retry href="">` yang membuka
   * ulang URL ini dan jalan tanpa JS, false = tanpa. Bawaan: tombol, kecuali `notfound` (mengulang tak ada gunanya).
   */
  retry?: 'button' | 'link' | false;
  /** Atribut tambahan untuk tombol coba lagi (konstanta dari pemanggil, mis. `data-feed-retry`). */
  retryAttr?: string;
  /** role="alert" — untuk keadaan yang disisipkan SETELAH halaman tampil, supaya diumumkan pembaca layar. */
  live?: boolean;
}

/** Keadaan galat untuk satu JENIS galat. Kembalian aman dimasukkan ke innerHTML. */
export function errorStateHtml(kind: ErrorKind, o: ErrorOpts = {}): string {
  const copy = COPY[kind];
  const retry = o.retry ?? (kind === 'notfound' ? false : 'button');
  const compact = o.compact === true;
  const title = esc(o.title ?? copy.title);
  const text = esc(o.text ?? copy.text);

  const retryEl =
    retry === 'button'
      ? `<button type="button" class="btn btn-primary" data-retry${o.retryAttr ? ` ${o.retryAttr}` : ''}>Coba lagi</button>`
      : retry === 'link'
        ? '<a class="btn btn-primary" href="" data-retry>Coba lagi</a>'
        : '';
  // notfound: orang butuh jalan keluar. Galat lain di mode ringkas cukup tombol coba lagi.
  const links =
    kind === 'notfound'
      ? '<a class="btn btn-primary" href="/">Ke beranda</a><a class="btn" href="/search/">Cari judul</a>'
      : compact
        ? ''
        : '<a class="btn" href="/">Ke beranda</a>';
  const actions = retryEl + links;

  const attrs = `data-error-state data-error-kind="${kind}"${o.live ? ' role="alert"' : ''}`;
  const icon = `<span class="err-ic" aria-hidden="true">${ICON[kind]}</span>`;

  if (compact) {
    return `<div class="err err--compact" ${attrs}>${icon}<div class="err-body"><p class="err-title">${title}</p><p class="err-text">${text}</p></div>${
      actions ? `<div class="err-actions">${actions}</div>` : ''
    }</div>`;
  }
  return `<section class="err err--page" ${attrs}>${icon}${
    o.code ? `<p class="err-code" aria-hidden="true">${esc(o.code)}</p>` : ''
  }<h1 class="err-title">${title}</h1><p class="err-text">${text}</p>${actions ? `<div class="err-actions">${actions}</div>` : ''}</section>`;
}

/** Halaman 404 (`404.astro`) dan rute tak dikenal di aplikasi (`mountUnknown`): satu markup. */
export const notFoundPageHtml = (live = false): string =>
  errorStateHtml('notfound', {
    code: '404',
    title: 'Halaman tidak ditemukan',
    text: 'Alamat yang kamu buka tidak ada atau sudah dipindahkan. Mulai dari beranda, atau cari judul yang kamu mau.',
    live,
  });

/** Halaman 5xx (`50x.astro`): nginx/proxy gagal, bukan API sumber. Tombol coba lagi berupa tautan (tanpa JS). */
export const serverErrorPageHtml = (): string =>
  errorStateHtml('server', {
    title: 'Layanan sedang tidak tersedia',
    text: 'Panel sedang mengalami gangguan. Ini bukan salahmu, dan biasanya pulih dalam beberapa menit.',
    retry: 'link',
  });
