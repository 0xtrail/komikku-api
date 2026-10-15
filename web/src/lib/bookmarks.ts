/**
 * Tombol bookmark di kartu & lencana jumlah bookmark di navigasi (DOM). Semuanya digerakkan
 * oleh data pustaka, bukan oleh pemanggil, sehingga tombol mana pun di halaman mana pun tetap
 * sejalan:
 *   - `[data-bm="<slug>"]` (kartu: `button.card-bm`; detail: `button.btn-bookmark`) membawa
 *     `data-title`, `data-cover`, `data-type`; SATU pendengar klik di document menyimpan/menghapus
 *     dan tidak pernah menavigasi (tombol saudara dari `<a class="card">`, bukan anak).
 *   - `syncBookmarkButtons(root)` menyetel `aria-pressed` + teks `.bm-label` ("Bookmark"/"Tersimpan")
 *     dari pustaka untuk setiap `[data-bm]` di `root`. Dipanggil setelah setiap render (grid, feed,
 *     beranda, pencarian, daftar, detail) dan otomatis saat `library:change` (perubahan lokal,
 *     tab lain, impor, bfcache).
 *   - `syncBookmarkCount()` mengisi `[data-bm-count]` (lencana di Pustaka) dan menyembunyikannya bila 0.
 */
import { getBookmarks, isBookmarked, startSync, toggleBookmark, CHANGE_EVENT, type LibraryChange } from './library';

/** Lencana menampilkan angka ini sebagai "99+" bila lebih. */
const BADGE_MAX = 99;

export function syncBookmarkButtons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-bm]').forEach((btn) => {
    const on = isBookmarked(btn.dataset.bm ?? '');
    // Hanya sentuh DOM bila berubah: fokus & pembaca layar tidak terganggu oleh penulisan yang sama.
    if (btn.getAttribute('aria-pressed') !== String(on)) btn.setAttribute('aria-pressed', String(on));
    const label = btn.querySelector('.bm-label');
    const text = on ? 'Tersimpan' : 'Bookmark';
    if (label && label.textContent !== text) label.textContent = text;
  });
}

export function syncBookmarkCount(): void {
  const n = getBookmarks().length;
  document.querySelectorAll<HTMLElement>('[data-bm-count]').forEach((badge) => {
    badge.hidden = n === 0;
    // Angka aman (bukan teks dari API). Teks sr-only agar pembaca layar mendengar "Pustaka 3 bookmark".
    badge.innerHTML = n ? `${n > BADGE_MAX ? `${BADGE_MAX}+` : n}<span class="sr-only"> bookmark</span>` : '';
  });
}

function onClick(e: MouseEvent): void {
  const btn = e.target instanceof Element ? e.target.closest<HTMLElement>('button[data-bm]') : null;
  if (!btn) return;
  e.preventDefault(); // tidak pernah menavigasi, walau ditempatkan di atas kartu
  const slug = btn.dataset.bm ?? '';
  if (!slug) return;
  // library:change -> syncAll memperbarui setiap tombol dan lencana; tidak perlu menyetel tombol ini sendiri.
  toggleBookmark({ slug, title: btn.dataset.title ?? '', cover: btn.dataset.cover ?? '', type: btn.dataset.type || undefined });
}

const syncAll = (): void => {
  syncBookmarkButtons();
  syncBookmarkCount();
};

/** Posisi baca (sering tersimpan saat membaca) dan hapus-riwayat tidak menyentuh bookmark: lewati. */
function onChange(e: Event): void {
  const kind = (e as CustomEvent<{ kind?: LibraryChange }>).detail?.kind;
  if (kind !== 'progress' && kind !== 'clear') syncAll();
}

/** Dipanggil sekali per halaman (site.ts). Sinkronisasi pertama menangani kartu hasil prerender. */
export function initBookmarks(): void {
  document.addEventListener('click', onClick);
  window.addEventListener(CHANGE_EVENT, onChange);
  startSync(); // event juga terbit untuk perubahan dari tab lain/bfcache, walau tak ada yang memakai subscribe()
  syncAll();
}
