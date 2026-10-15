/**
 * UI pustaka yang bergantung pada localStorage, jadi hanya berjalan di browser:
 *   - halaman /pustaka/ (tab Riwayat & Bookmark, ekspor/impor), dan
 *   - baris "Lanjutkan Membaca" di beranda (section `[data-sec="resume"]`, tersembunyi
 *     sampai ada riwayat; markup-nya dibuat views.ts dari data yang dioper ke sini).
 * Semua perubahan lewat modul library; tampilan digambar ulang dari `subscribe`, jadi
 * perubahan dari tab lain ikut tercermin lewat satu jalur yang sama.
 */
import {
  clearHistory,
  exportJSON,
  getBookmarks,
  getHistory,
  importJSON,
  removeBookmark,
  removeHistory,
  subscribe,
} from './library';
import { appEl, setTitle } from './page';
import { observeCards } from './prefetch';
import { pustakaHref, type LibTab } from './routes';
import { libraryShellHtml, libraryViewHtml, resumeRailHtml } from './views';

/** Jumlah kartu di baris "Lanjutkan Membaca" beranda. */
const RESUME_MAX = 12;

/** Berkas impor lebih besar dari ini ditolak sebelum dibaca (data asli jauh lebih kecil). */
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

const TABS: readonly LibTab[] = ['riwayat', 'bookmark'];

/* ------------------------------------------------------------------- home */

export function mountResumeRail(): void {
  const sec = document.querySelector<HTMLElement>('[data-sec="resume"]');
  const body = sec?.querySelector<HTMLElement>('[data-body]');
  if (!sec || !body) return;

  const paint = () => {
    const items = getHistory().slice(0, RESUME_MAX);
    sec.hidden = items.length === 0; // tanpa riwayat: tidak ada keadaan kosong di beranda
    body.innerHTML = items.length ? resumeRailHtml(items) : '';
    if (items.length) observeCards(body); // kartu menuju chapter: data chapter ikut dipanaskan
  };
  paint();
  subscribe(paint);
}

/* ---------------------------------------------------------------- pustaka */

export function mountLibrary(initial: LibTab): void {
  const el = appEl();
  if (!el) return;
  setTitle('Pustaka');
  el.setAttribute('aria-busy', 'false');
  el.innerHTML = libraryShellHtml();

  const view = el.querySelector<HTMLElement>('[data-lib-view]');
  const status = el.querySelector<HTMLElement>('[data-lib-status]');
  const fileInput = el.querySelector<HTMLInputElement>('[data-import-file]');
  if (!view || !status || !fileInput) return;

  let tab = initial;
  /** Dipakai paint berikutnya untuk menaruh fokus (innerHTML membuang elemen yang tadinya fokus). */
  let nextFocus: (() => HTMLElement | null | undefined) | undefined;

  const activeTab = () => view.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');

  const count = el.querySelector<HTMLElement>('[data-lib-count]');

  const paint = (focus?: () => HTMLElement | null | undefined) => {
    const history = getHistory();
    const bookmarks = getBookmarks();
    view.innerHTML = libraryViewHtml({ tab, history, bookmarks, now: Date.now() });
    if (count) {
      count.textContent = `${bookmarks.length} bookmark · ${history.length} riwayat`;
      count.hidden = false;
    }
    observeCards(view);
    focus?.()?.focus();
  };

  const select = (next: LibTab) => {
    tab = next;
    try {
      history.replaceState(history.state, '', pustakaHref(next));
    } catch {
      /* history tidak bisa ditulis: hanya URL yang tidak ikut berubah */
    }
    paint(() => view.querySelector<HTMLElement>(`[data-tab="${next}"]`));
  };

  /** Setelah satu baris/kartu dihapus, fokus ke yang menggantikannya (atau ke tab bila habis). */
  const focusSameSlot = (btn: HTMLElement, selector: string) => {
    const i = Array.from(view.querySelectorAll<HTMLElement>(selector)).indexOf(btn);
    nextFocus = () => {
      const now = view.querySelectorAll<HTMLElement>(selector);
      return now[Math.min(i, now.length - 1)] ?? activeTab();
    };
  };

  const say = (text: string, error = false) => {
    status.textContent = text;
    status.classList.toggle('is-error', error);
  };

  const download = () => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const name = `panel-pustaka-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
    const url = URL.createObjectURL(new Blob([exportJSON()], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    say(`Berkas ${name} diunduh.`);
  };

  paint();
  subscribe(() => {
    const inside = view.contains(document.activeElement);
    paint(nextFocus ?? (inside ? activeTab : undefined));
    nextFocus = undefined;
  });

  el.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const hit = (sel: string) => t?.closest<HTMLElement>(sel) ?? null;

    const tabBtn = hit('[data-tab]');
    const rmHistory = hit('[data-remove-history]');
    const rmBookmark = hit('[data-remove-bookmark]');
    if (tabBtn) select(tabBtn.dataset.tab === 'bookmark' ? 'bookmark' : 'riwayat');
    else if (rmHistory) {
      focusSameSlot(rmHistory, '[data-remove-history]');
      removeHistory(rmHistory.dataset.slug ?? '');
    } else if (rmBookmark) {
      focusSameSlot(rmBookmark, '[data-remove-bookmark]');
      removeBookmark(rmBookmark.dataset.slug ?? '');
    } else if (hit('[data-clear-history]')) {
      if (confirm('Hapus semua riwayat bacaan? Bookmark tidak ikut terhapus.')) {
        nextFocus = activeTab;
        clearHistory();
      }
    } else if (hit('[data-export]')) download();
    else if (hit('[data-import]')) fileInput.click();
  });

  // Tab ARIA: panah kiri/kanan, Home, End berpindah tab (roving tabindex dibuat oleh template).
  el.addEventListener('keydown', (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('[role="tab"]')) return;
    const i = TABS.indexOf(tab);
    const next =
      e.key === 'ArrowRight' ? TABS[(i + 1) % TABS.length]
      : e.key === 'ArrowLeft' ? TABS[(i - 1 + TABS.length) % TABS.length]
      : e.key === 'Home' ? TABS[0]
      : e.key === 'End' ? TABS[TABS.length - 1]
      : undefined;
    if (!next) return;
    e.preventDefault();
    select(next);
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = ''; // berkas yang sama boleh dipilih lagi
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      say('Berkas terlalu besar (maksimal 5 MB).', true);
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      say('Berkas tidak bisa dibaca.', true);
      return;
    }
    try {
      const r = importJSON(text);
      say(`${r.bookmarks} bookmark, ${r.history} riwayat diimpor.`);
    } catch (err) {
      say(err instanceof Error ? err.message : 'Gagal mengimpor berkas.', true);
    }
  });
}
