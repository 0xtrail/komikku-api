/**
 * Lanjut baca: melompat ke halaman/posisi terakhir dan menahannya di sana.
 *
 * Gambar halaman dimuat satu per satu dan baru tahu tingginya setelah selesai; tiap kali tinggi di atas
 * (atau di) halaman target berubah, posisi target ikut bergeser. Selama pembaca belum menyentuh
 * apa pun, posisi dihitung ulang tiap gambar selesai dimuat/gagal dan saat ukuran layar berubah
 * (Safari tidak punya scroll anchoring seperti Chrome, jadi tanpa ini halaman "lari" dari bawah mata);
 * perubahan tinggi lain (header yang berganti saat info manga tiba) ikut tertangkap lewat ResizeObserver.
 * Begitu pembaca menggulir/mengetuk/menekan tombol, atau 10 detik lewat, penahanan dilepas.
 */
import type { ResumeTarget } from './readerlogic';
import { resumeToastHtml } from './readerview';

/** Lama maksimum menahan posisi bila pembaca tidak menyentuh apa pun. */
const HOLD_MS = 10_000;
/** Toast hilang sendiri setelah ini. */
const TOAST_MS = 8_000;

/** Interaksi pembaca = ia sudah memegang kendali posisi. */
const INTERACTION = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

export interface ResumeHandle {
  /** Masih menahan posisi? Selama true, posisi baca belum boleh disimpan (akan menimpa posisi lama dengan awal chapter). */
  active(): boolean;
  stop(): void;
}

export interface ResumeOpts {
  /** Akar reader; perubahan ukurannya (apa pun penyebabnya) menghitung ulang posisi. */
  root: HTMLElement;
  target: ResumeTarget;
  /** Elemen halaman target: gambarnya, atau tombol coba lagi bila gambar gagal dimuat. */
  pageEl: () => HTMLElement | undefined;
  /** Gambar yang tingginya menggeser target bila berubah (halaman target dan semua di atasnya). */
  affects: (img: HTMLImageElement) => boolean;
  /** Tinggi garis baca (px dari atas viewport); posisi tersimpan disejajarkan ke garis ini. */
  line: () => number;
  /** Penahanan dilepas (interaksi atau waktu habis). */
  onDone: () => void;
}

/** Lompat sekarang dan tahan. Tidak melakukan apa-apa selain scroll; DOM tidak disentuh. */
export function startResume(o: ResumeOpts): ResumeHandle {
  let active = true;
  let timer = 0;
  let ro: ResizeObserver | undefined;

  /** Hash `#p<N>`: atas halaman rata dengan atas layar. Posisi tersimpan: titik terakhir rata dengan garis baca. */
  const align = (): void => {
    const el = o.pageEl();
    if (!el) return;
    const r = el.getBoundingClientRect();
    const want = o.target.source === 'hash' ? 0 : o.line();
    const delta = r.top + o.target.offset * r.height - want;
    if (Math.abs(delta) >= 1) window.scrollBy({ top: delta, behavior: 'instant' });
  };

  const onMedia = (e: Event): void => {
    if (e.target instanceof HTMLImageElement && o.affects(e.target)) align();
  };

  const stop = (): void => {
    if (!active) return;
    active = false;
    window.clearTimeout(timer);
    ro?.disconnect();
    document.removeEventListener('load', onMedia, true);
    document.removeEventListener('error', onMedia, true);
    window.removeEventListener('resize', align);
    for (const type of INTERACTION) window.removeEventListener(type, stop, true);
    o.onDone();
  };

  document.addEventListener('load', onMedia, true);
  document.addEventListener('error', onMedia, true);
  window.addEventListener('resize', align);
  for (const type of INTERACTION) window.addEventListener(type, stop, { capture: true, passive: true });
  timer = window.setTimeout(stop, HOLD_MS);
  align();
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(align);
    ro.observe(o.root);
  }

  return { active: () => active, stop };
}

/** Toast "Lanjut dari halaman N" di dalam `root` (dibuang bersama reader). `onRestart` = tombol "Mulai dari awal". */
export function showResumeToast(root: HTMLElement, index: number, onRestart: () => void): void {
  root.querySelector('[data-reader-toast]')?.remove();
  root.insertAdjacentHTML('beforeend', resumeToastHtml(index));
  const toast = root.querySelector<HTMLElement>('[data-reader-toast]');
  if (!toast) return;
  const close = (): void => {
    window.clearTimeout(timer);
    toast.remove();
  };
  const timer = window.setTimeout(close, TOAST_MS);
  toast.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest('[data-toast-restart]')) onRestart();
    if (t?.closest('[data-toast-restart], [data-toast-close]')) close();
  });
}
