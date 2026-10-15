/**
 * Keadaan galat di dalam aplikasi (DOM). Markup dari `errorview.ts`; di sini hanya perilaku:
 * memilih jenis galat dari ApiError, memasang tombol "Coba lagi", dan mengulang otomatis begitu
 * browser kembali online. Pesan mentah API/Go tidak pernah sampai ke pengguna.
 */
import { errorKind } from './api';
import { errorStateHtml, errorTitle, notFoundPageHtml } from './errorview';
import { setTitle } from './page';

/**
 * Panggil `fn` sekali begitu browser kembali online. Mengembalikan fungsi pembatal.
 * Memakai event `online` (bukan polling): tanpa beban saat tetap offline.
 */
export function whenOnline(fn: () => void): () => void {
  const run = () => {
    window.removeEventListener('online', run);
    fn();
  };
  window.addEventListener('online', run);
  return () => window.removeEventListener('online', run);
}

/**
 * Ganti isi `el` dengan keadaan galat untuk `e`. `retry` dipanggil dari tombol "Coba lagi" dan,
 * untuk jenis `offline`, otomatis saat koneksi kembali (selama keadaan galat ini masih tampil).
 * `compact` untuk section/feed; tanpa itu = galat satu halaman penuh (`<h1>`).
 */
export function showError(el: HTMLElement, e: unknown, retry: () => void, compact = false): void {
  const kind = errorKind(e);
  el.setAttribute('aria-busy', 'false');
  el.innerHTML = errorStateHtml(kind, { compact, live: true });
  if (!compact) setTitle(errorTitle(kind)); // galat satu halaman: judul tab ikut menjelaskan
  const state = el.querySelector('[data-error-state]');

  let cancel: (() => void) | undefined;
  el.querySelector('[data-retry]')?.addEventListener('click', () => {
    cancel?.();
    retry();
  });
  if (kind === 'offline') {
    // `isConnected`/pencocokan node: jangan mengulang kalau tampilan sudah diganti (navigasi, retry manual).
    cancel = whenOnline(() => {
      if (state && state.isConnected && el.contains(state)) retry();
    });
  }
}

/** Rute yang tidak dikenal: desain yang sama dengan `404.html`. */
export function showNotFoundPage(el: HTMLElement): void {
  el.setAttribute('aria-busy', 'false');
  el.innerHTML = notFoundPageHtml();
}
