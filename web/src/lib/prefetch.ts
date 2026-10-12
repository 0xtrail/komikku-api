/**
 * Prefetch: memanaskan cache `api.ts` SEBELUM pengguna membuka sebuah halaman.
 * Mobile-first: di layar sentuh tidak ada hover, jadi pemicu utamanya
 * IntersectionObserver.
 *
 * Pemicu:
 *   1. (UTAMA) kartu `a.card` yang terlihat >= 50% selama 300 ms
 *      (IntersectionObserver), maks 12 kartu per tampilan halaman.
 *   2. pointerdown / touchstart (passive) pada link yang belum dipanaskan;
 *      dibatalkan oleh pointercancel/touchmove, jadi gerakan scroll tidak memicu.
 *   3. (BONUS, hanya perangkat `(hover: hover)`) hover mouse dengan intent 65 ms,
 *      dan focusin untuk navigasi keyboard.
 *   4. Pemicu spesifik halaman (chapter awal/terbaru, chapter berikutnya,
 *      halaman daftar berikutnya) memanggil `prefetchPath` langsung.
 *
 * SEMUA prefetch mati bila `navigator.connection.saveData` aktif atau
 * `effectiveType` slow-2g/2g.
 *
 * API men-scrape live (0,5-3 dtk per panggilan), jadi antrean dibatasi: paling
 * banyak 2 request prefetch berjalan bersamaan, sisanya antre (maks 24, yang
 * prioritas rendah paling akhir dibuang). Prioritas tinggi menyalip antrean.
 */
import { get, peek } from './api';
import { parseRoute, apiPathFor } from './routes';

const MAX_ACTIVE = 2;
const MAX_QUEUE = 24;
const HOVER_INTENT_MS = 65;
const DWELL_MS = 300;
const VISIBLE_BUDGET = 12;

type Priority = 'high' | 'low';

const queue: string[] = [];
const queued = new Set<string>();
let active = 0;

function pump(): void {
  while (active < MAX_ACTIVE && queue.length) {
    const path = queue.shift() as string;
    queued.delete(path);
    if (peek(path) !== undefined) continue;
    active++;
    // `get` berbagi request yang sedang berjalan & mengisi cache; error prefetch tidak penting.
    get(path)
      .catch(() => {})
      .finally(() => {
        active--;
        pump();
      });
  }
}

type NetInfo = { saveData?: boolean; effectiveType?: string };

/** false bila pengguna meminta hemat data atau koneksi 2G: tidak ada prefetch sama sekali. */
function prefetchAllowed(): boolean {
  const c = (navigator as Navigator & { connection?: NetInfo }).connection;
  return !c?.saveData && !/(^|-)2g$/.test(c?.effectiveType ?? '');
}

/** Hangatkan satu path API. Tidak melakukan apa-apa jika sudah ada di cache atau antrean. */
export function prefetchPath(path: string | undefined, priority: Priority = 'low'): void {
  if (!path || !prefetchAllowed() || peek(path) !== undefined) return;
  if (queued.has(path)) {
    if (priority === 'high') {
      queue.splice(queue.indexOf(path), 1);
      queue.unshift(path);
    }
    return;
  }
  if (priority === 'high') queue.unshift(path);
  else queue.push(path);
  queued.add(path);
  while (queue.length > MAX_QUEUE) {
    const dropped = queue.pop() as string;
    queued.delete(dropped);
  }
  pump();
}

/* ---------------------------------------------------------------- links */

function internalLink(t: EventTarget | null): HTMLAnchorElement | null {
  if (!(t instanceof Element)) return null;
  const a = t.closest('a[href]') as HTMLAnchorElement | null;
  if (!a || a.target === '_blank' || a.hasAttribute('download') || a.dataset.noPrefetch !== undefined) {
    return null;
  }
  return a.origin === location.origin ? a : null;
}

const pathForLink = (a: HTMLAnchorElement): string | undefined =>
  apiPathFor(parseRoute(new URL(a.href)));

function intent(a: HTMLAnchorElement | null): void {
  if (a) prefetchPath(pathForLink(a), 'high');
}

/* ------------------------------------------------- visible-card prefetch */

let io: IntersectionObserver | undefined;
const dwell = new Map<Element, number>();
let budget = VISIBLE_BUDGET;

function visibleCard(el: Element): void {
  if (budget <= 0 || !(el instanceof HTMLAnchorElement)) return;
  const path = pathForLink(el);
  if (!path || peek(path) !== undefined) return;
  budget--;
  prefetchPath(path, 'low');
}

/** Amati kartu `a.card` di dalam `root`; panggil lagi setiap kali daftar dirender ulang. */
export function observeCards(root: ParentNode = document): void {
  if (typeof IntersectionObserver === 'undefined' || !prefetchAllowed()) return;
  io ??= new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        const el = en.target;
        if (en.isIntersecting) {
          if (!dwell.has(el)) {
            dwell.set(
              el,
              window.setTimeout(() => {
                dwell.delete(el);
                io?.unobserve(el);
                visibleCard(el);
              }, DWELL_MS),
            );
          }
        } else {
          window.clearTimeout(dwell.get(el));
          dwell.delete(el);
        }
      }
    },
    { threshold: 0.5 },
  );
  root.querySelectorAll('a.card').forEach((el) => io?.observe(el));
}

/* ------------------------------------------------------------ listeners */

const queuedOrCached = (path: string) => queued.has(path) || peek(path) !== undefined;

let started = false;

export function initPrefetch(): void {
  if (started) return;
  started = true;

  const passive = { passive: true } as const;

  // (2) Sentuh/tekan: tunda sebentar & batalkan bila ternyata scroll (touchmove/pointercancel).
  let pressTimer = 0;
  const press = (e: Event) => {
    window.clearTimeout(pressTimer);
    const a = internalLink(e.target);
    const path = a && pathForLink(a);
    if (!a || !path || queuedOrCached(path)) return; // hanya link yang belum dipanaskan
    pressTimer = window.setTimeout(() => prefetchPath(path, 'high'), HOVER_INTENT_MS);
  };
  const cancelPress = () => window.clearTimeout(pressTimer);
  document.addEventListener('pointerdown', press, passive);
  document.addEventListener('touchstart', press, passive);
  document.addEventListener('pointercancel', cancelPress, passive);
  document.addEventListener('touchmove', cancelPress, passive);
  document.addEventListener('touchcancel', cancelPress, passive);

  // (3) Bonus untuk mouse: hover-intent & fokus keyboard. Tidak dipasang di layar sentuh murni.
  if (window.matchMedia('(hover: hover)').matches) {
    let hoverTimer = 0;
    let hoverLink: HTMLAnchorElement | null = null;
    const clearHover = () => {
      window.clearTimeout(hoverTimer);
      hoverTimer = 0;
      hoverLink = null;
    };
    document.addEventListener(
      'mouseover',
      (e) => {
        const a = internalLink(e.target);
        if (!a || a === hoverLink) return;
        clearHover();
        hoverLink = a;
        hoverTimer = window.setTimeout(() => {
          intent(a);
          hoverTimer = 0;
        }, HOVER_INTENT_MS);
      },
      passive,
    );
    document.addEventListener(
      'mouseout',
      (e) => {
        if (!hoverLink) return;
        const to = e.relatedTarget;
        if (to instanceof Node && hoverLink.contains(to)) return; // masih di dalam link yang sama
        clearHover();
      },
      passive,
    );
    document.addEventListener('focusin', (e) => intent(internalLink(e.target)), passive);
  }

  // (1) Pemicu utama: kartu yang terlihat.
  observeCards(document);
}
