/**
 * Perilaku yang dipakai di setiap halaman: tombol tema, penanda menu aktif, sub-menu
 * Daftar, kolom cari (+ autocomplete), prefetch, tombol/lencana bookmark, dan gambar gagal muat.
 */
import { initBookmarks } from './bookmarks';
import { initImageFallback } from './images';
import { initNavMenu } from './navmenu';
import { initPrefetch } from './prefetch';
import { parseRoute } from './routes';
import { initSuggest } from './suggest';

const root = document.documentElement;
const dark = window.matchMedia('(prefers-color-scheme: dark)');

const isDark = (): boolean => (root.dataset.theme ? root.dataset.theme === 'dark' : dark.matches);

// Tombol tema: tema pilihan disimpan di localStorage (try/catch: bisa diblokir);
// tanpa pilihan, ikut pengaturan sistem lewat CSS.
const toggle = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
const syncToggle = () => toggle?.setAttribute('aria-pressed', String(isDark()));
syncToggle();
dark.addEventListener('change', syncToggle);
toggle?.addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  root.dataset.theme = next;
  try {
    localStorage.setItem('mr:theme', next);
  } catch {
    /* storage diblokir: tema tetap berlaku untuk sesi ini */
  }
  syncToggle();
});

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

initNavMenu();
initSuggest();
initPrefetch();
initBookmarks();
initImageFallback();
