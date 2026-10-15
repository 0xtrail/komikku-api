/**
 * Halaman detail manga (/manga/<slug>): info, sinopsis, daftar chapter, dan keadaan
 * pustaka (Simpan, Lanjutkan, chapter yang sudah dibaca). Dipisah dari client.ts agar
 * file itu tidak membengkak; memakai `loadView` yang sama (cache dulu, skeleton hanya
 * bila cache kosong, validasi ulang di latar belakang).
 */
import { chapterSlug, paths, slugOf, type MangaInfo } from './api';
import { getProgress, isBookmarked, subscribe } from './library';
import { syncBookmarkButtons } from './bookmarks';
import { prefetchPath } from './prefetch';
import { loadView } from './client';
import { appEl, setTitle } from './page';
import { detailHtml, skelDetail, sortAriaLabel, sortLabel, type DetailLib } from './views';

/** Kontrol yang fokusnya dipertahankan saat detail digambar ulang (innerHTML membuang elemen lama). */
const KEEP_FOCUS = ['[data-bm]', '[data-syn-toggle]', '[data-sort]', '[data-filter]'];

export function mountMangaDetail(slug: string): void {
  const el = appEl();
  if (!el) return;
  const mslug = slugOf(slug); // kunci pustaka = slug di /manga/<slug>/
  let info: MangaInfo | undefined;
  let synopsisOpen = false;
  let oldestFirst = false; // urutan daftar chapter; bertahan saat detail digambar ulang

  const libState = (): DetailLib => {
    const progress = getProgress(mslug);
    return { slug: mslug, bookmarked: isBookmarked(mslug), progress, read: new Set(progress?.read), synopsisOpen, oldestFirst };
  };

  /** Gambar detail dari info + pustaka: saat data tiba/berubah dan saat pustaka berubah (tab lain, bfcache, tombol Simpan). */
  const paint = (i: MangaInfo) => {
    // Render ulang: pertahankan filter, posisi scroll daftar, dan fokus pada kontrol yang sedang dipakai.
    const prevFilter = el.querySelector<HTMLInputElement>('[data-filter]')?.value ?? '';
    const prevScroll = el.querySelector<HTMLElement>('.chapter-list')?.scrollTop ?? 0;
    const active = document.activeElement;
    const keep = active && el.contains(active) ? KEEP_FOCUS.find((sel) => active.matches(sel)) : undefined;

    el.innerHTML = detailHtml(i, libState());
    syncBookmarkButtons(el);
    setTitle(i.title);
    wireChapterFilter(el, prevFilter);
    fitSynopsis(el);
    const list = el.querySelector<HTMLElement>('.chapter-list');
    if (list) list.scrollTop = prevScroll;

    const target = keep ? el.querySelector<HTMLElement>(keep) : null;
    if (target) {
      target.focus({ preventScroll: true });
      if (target instanceof HTMLInputElement) target.setSelectionRange(target.value.length, target.value.length);
    }
  };

  loadView<MangaInfo>(el, {
    path: paths.info(slug),
    skeleton: skelDetail(),
    render: (i) => {
      info = i;
      paint(i);

      // Halaman berikutnya yang paling mungkin dibuka: chapter pertama & terbaru.
      const chapters = i.chapter_list ?? [];
      if (chapters.length) {
        prefetchPath(paths.chapter(chapterSlug(chapters[chapters.length - 1].endpoint)), 'low');
        prefetchPath(paths.chapter(chapterSlug(chapters[0].endpoint)), 'low');
      }
    },
  });

  subscribe(() => {
    if (info) paint(info);
  });

  // Delegated: tetap jalan setelah detail digambar ulang. Tombol Bookmark ([data-bm]) ditangani
  // pendengar global di bookmarks.ts; perubahannya kembali ke sini lewat subscribe() di atas.
  el.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest('[data-syn-toggle]')) {
      // Di tempat, tanpa render ulang: sampul & daftar chapter tidak ikut berkedip.
      synopsisOpen = !synopsisOpen;
      el.querySelector('[data-synopsis]')?.classList.toggle('is-clamped', !synopsisOpen);
      const btn = el.querySelector('[data-syn-toggle]');
      btn?.setAttribute('aria-expanded', String(synopsisOpen));
      if (btn) btn.textContent = synopsisOpen ? 'Ringkas' : 'Selengkapnya';
    } else if (t?.closest('[data-sort]')) {
      oldestFirst = !oldestFirst;
      reverseChapters(el, oldestFirst);
    }
  });
}

/**
 * Sinopsis pendek yang tidak benar-benar terpangkas (teks <= 3 baris di layar lebar) tidak butuh tombol
 * "Selengkapnya": ukur setelah digambar dan sembunyikan bila tak ada yang tersembunyi.
 */
function fitSynopsis(el: HTMLElement): void {
  const sec = el.querySelector<HTMLElement>('[data-synopsis].is-clamped');
  const body = sec?.querySelector<HTMLElement>('.syn-body');
  const btn = sec?.querySelector<HTMLButtonElement>('[data-syn-toggle]');
  if (!sec || !body || !btn) return;
  if (body.scrollHeight <= body.clientHeight + 1) {
    sec.classList.remove('is-clamped');
    btn.hidden = true;
  }
}

/** Balik urutan baris chapter di DOM (kotak cari tetap berfungsi: ia memegang elemen `li`, bukan posisinya). */
function reverseChapters(el: HTMLElement, oldest: boolean): void {
  const list = el.querySelector<HTMLElement>('.chapter-list');
  if (list) {
    list.append(...Array.from(list.children).reverse());
    list.scrollTop = 0;
  }
  const btn = el.querySelector<HTMLElement>('[data-sort]');
  btn?.setAttribute('aria-label', sortAriaLabel(oldest));
  const lbl = btn?.querySelector('.sort-lbl');
  if (lbl) lbl.textContent = sortLabel(oldest);
}

function wireChapterFilter(el: HTMLElement, initial: string): void {
  const input = el.querySelector<HTMLInputElement>('[data-filter]');
  const items = Array.from(el.querySelectorAll<HTMLElement>('.chapter-list > li'));
  const empty = el.querySelector<HTMLElement>('[data-empty]');
  const count = el.querySelector<HTMLElement>('[data-count]');
  if (!input) return;

  const apply = () => {
    const q = input.value.trim().toLowerCase();
    let shown = 0;
    for (const li of items) {
      const ok = !q || (li.querySelector('.ch-name')?.textContent ?? li.textContent ?? '').toLowerCase().includes(q);
      li.hidden = !ok;
      if (ok) shown++;
    }
    if (empty) empty.hidden = shown > 0;
    if (count) count.textContent = q ? `${shown} dari ${items.length} Chapter` : `${items.length} Chapter`;
  };
  input.addEventListener('input', apply);
  if (initial) {
    input.value = initial;
    apply();
  }
}
