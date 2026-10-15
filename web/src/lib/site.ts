/**
 * Perilaku yang dipakai di setiap halaman: header (panel ponsel, pintasan cari), penanda menu aktif,
 * sub-menu Daftar, kolom cari (+ autocomplete), prefetch, tombol/lencana bookmark, dan gambar gagal muat.
 * Tampilan hanya gelap: tidak ada tombol tema.
 */
import { initBookmarks } from './bookmarks';
import { initHeader } from './header';
import { initImageFallback } from './images';
import { initNavMenu } from './navmenu';
import { initPrefetch } from './prefetch';
import { parseRoute } from './routes';
import { initSuggest } from './suggest';

const root = document.documentElement;

// Menu aktif ditentukan dari data-view (diset skrip inline di <head>).
const view = root.dataset.view;
const active = view === 'chapter' || view === 'manga' || view === 'search' ? undefined : view;
// Selector tanpa `a`: pemicu sub-menu Daftar adalah <button>.
document.querySelectorAll<HTMLElement>('[data-nav]').forEach((a) => {
  if (a.dataset.nav === active) a.setAttribute('aria-current', 'page');
});

// Sub-menu Daftar: tandai jenis yang sedang dibuka.
const here = parseRoute(new URL(location.href));
if (here.kind === 'list') {
  document.querySelector(`[data-menu-list] a[data-tipe="${here.tipe}"]`)?.setAttribute('aria-current', 'page');
}

// Kolom cari terisi dengan kata kunci saat ini.
if (view === 'search') {
  const q = new URLSearchParams(location.search).get('q');
  const input = document.getElementById('q') as HTMLInputElement | null;
  if (input && q) input.value = q;
}

initHeader();
initNavMenu();
initSuggest();
initPrefetch();
initBookmarks();
initImageFallback();
