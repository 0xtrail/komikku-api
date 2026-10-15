/**
 * Pemuat gambar halaman reader. `loading="lazy"` bawaan browser baru mulai sekitar satu layar sebelum
 * gambar terlihat, padahal tiap gambar lewat proxy memakan 1,5-3 dtk: pembaca selalu menunggu. Di sini
 * gambar selain yang pertama hanya membawa `data-src` dan baru diberi `src` saat sudah dalam beberapa
 * tinggi viewport di bawahnya (dan sedikit di atasnya, untuk scroll naik) — lihat `lookahead`.
 * Gambar yang gagal dimuat ditangani images.ts (tombol coba lagi).
 */
import { lookahead, rootMargin } from './readerlogic';
import { prefetchAllowed } from './prefetch';

/** Gambar chapter berikutnya yang dihangatkan (browser menyimpannya di cache HTTP; proxy `immutable`). */
const WARM_COUNT = 3;

export interface ImageLoader {
  /** Pantau gambar `data-src`; tanpa IntersectionObserver semuanya dimuat langsung. */
  observe(imgs: Iterable<HTMLImageElement>): void;
  /** Beri `src` sekarang juga (bila belum punya). */
  load(img: HTMLImageElement): void;
  /** Berhenti memantau gambar yang akan dibuang dari DOM. */
  forget(imgs: Iterable<HTMLImageElement>): void;
}

export function createImageLoader(): ImageLoader {
  const load = (img: HTMLImageElement): void => {
    const src = img.dataset.src;
    if (!src || img.getAttribute('src')) return;
    img.src = src;
    img.removeAttribute('data-src');
  };
  const io =
    typeof IntersectionObserver === 'undefined'
      ? undefined
      : new IntersectionObserver(
          (entries) => {
            for (const en of entries) {
              if (!en.isIntersecting || !(en.target instanceof HTMLImageElement)) continue;
              io?.unobserve(en.target);
              load(en.target);
            }
          },
          { rootMargin: rootMargin(lookahead(!prefetchAllowed())) },
        );
  return {
    load,
    observe(imgs) {
      for (const img of imgs) {
        if (!img.dataset.src) continue;
        if (io) io.observe(img);
        else load(img);
      }
    },
    forget(imgs) {
      for (const img of imgs) io?.unobserve(img);
    },
  };
}

const warmed = new Set<string>();

/**
 * Hangatkan beberapa gambar pertama sebuah chapter (prioritas rendah) supaya terbuka instan saat
 * chapter itu muncul. Sekali per chapter; tidak melakukan apa-apa saat hemat data/2G.
 */
export function warmImages(chapter: string, images: readonly string[]): void {
  if (!prefetchAllowed() || warmed.has(chapter)) return;
  warmed.add(chapter);
  for (const src of images.slice(0, WARM_COUNT)) {
    const im = new Image();
    im.decoding = 'async';
    im.setAttribute('fetchpriority', 'low');
    im.src = src;
  }
}
