/**
 * Logika murni reader (tanpa DOM, tanpa storage): resolusi manga & tetangga chapter, hash `#p<N>`,
 * halaman yang sedang dibaca dari posisi gambar, jendela pemuatan gambar, dan batas jumlah chapter
 * di DOM. Dipisah dari `reader.ts` agar bisa diuji di Node polos (`npm test`), jadi hanya memakai
 * sintaks TypeScript yang bisa di-strip dan import relatif dengan ekstensi `.ts`.
 */
import { chapterSlug, slugOf, type ChapterDetail, type ChapterRef } from './api.ts';
import { mangaSlugOfChapter } from './routes.ts';

/** Chapter tetangga untuk tombol prev/next dan pemuatan otomatis. */
export interface Step {
  slug: string;
  name: string;
}

/** Kotak elemen dalam koordinat viewport (hasil getBoundingClientRect, disederhanakan). */
export interface Rect {
  top: number;
  height: number;
}

export const eqSlug = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/* -------------------------------------------------- manga & tetangga chapter */

/** "judul-chapter-12" -> "Chapter 12", "judul-chapter-12-5" -> "Chapter 12.5"; tanpa pola: slug apa adanya. */
export function nameFromSlug(slug: string): string {
  const i = slug.toLowerCase().lastIndexOf('-chapter-');
  if (i < 0) return slug;
  const n = slug.slice(i + '-chapter-'.length);
  return /^\d+-\d+$/.test(n) ? `Chapter ${n.replace('-', '.')}` : `Chapter ${n}`;
}

export interface MangaRef {
  /** Slug manga di `/manga/<slug>/`; undefined bila tak diketahui sama sekali. */
  slug?: string;
  /** true = dari API (`manga_endpoint`); false = tebakan dari slug chapter yang harus diverifikasi lewat info. */
  confirmed: boolean;
}

/** Manga induk sebuah chapter: `manga_endpoint` bila ada, kalau tidak tebakan dari slug chapter (cadangan API lama). */
export function mangaRefOf(ch: Pick<ChapterDetail, 'manga_endpoint'>, chapter: string): MangaRef {
  const slug = ch.manga_endpoint ? slugOf(ch.manga_endpoint.trim()) : '';
  return slug ? { slug, confirmed: true } : { slug: mangaSlugOfChapter(chapter), confirmed: false };
}

/** Tebakan baru dianggap benar bila chapter ini ada di daftar chapter manga tersebut. */
export const listHasChapter = (list: readonly ChapterRef[], chapter: string): boolean =>
  list.some((c) => eqSlug(chapterSlug(c.endpoint), chapter));

export interface Steps {
  prev?: Step;
  next?: Step;
  /** Pasti chapter terbaru: tidak ada chapter berikutnya DAN ada sumber yang bisa dipercaya (API baru atau daftar chapter). */
  latest: boolean;
}

/**
 * Tetangga chapter. Sumber utama `prev_endpoint`/`next_endpoint` dari API (hanya bila tidak kosong);
 * cadangan: tetangga di daftar chapter manga (terbaru -> terlama, jadi indeks lebih besar = lebih awal).
 * Nama diambil dari daftar chapter bila ada, kalau tidak diturunkan dari slug.
 */
export function resolveSteps(
  slug: string,
  ch: Pick<ChapterDetail, 'prev_endpoint' | 'next_endpoint'>,
  list?: readonly ChapterRef[],
): Steps {
  const at = list ? list.findIndex((c) => eqSlug(chapterSlug(c.endpoint), slug)) : -1;
  const step = (endpoint: string | undefined, neighbour: ChapterRef | undefined): Step | undefined => {
    const s = endpoint ? chapterSlug(endpoint) : neighbour ? chapterSlug(neighbour.endpoint) : '';
    return s ? { slug: s, name: listName(list, s) ?? nameFromSlug(s) } : undefined;
  };
  const prev = step(ch.prev_endpoint, at >= 0 ? list?.[at + 1] : undefined);
  const next = step(ch.next_endpoint, at >= 0 ? list?.[at - 1] : undefined);
  // "" dari API baru berarti tidak ada; undefined (API lama) tidak membuktikan apa pun tanpa daftar chapter.
  const latest = !next && (typeof ch.next_endpoint === 'string' || at >= 0);
  return { prev, next, latest };
}

/** Nama chapter menurut daftar chapter manga (cocok lewat slug); undefined bila daftar belum ada / tak memuatnya. */
export const listName = (list: readonly ChapterRef[] | undefined, slug: string): string | undefined =>
  list?.find((c) => eqSlug(chapterSlug(c.endpoint), slug))?.name;

/* ------------------------------------------------------------ lanjut baca */

/** `#p20` (1-based) -> indeks 0-based 19; hash lain/rusak -> undefined. */
export function parsePageHash(hash: string): number | undefined {
  const m = /^#p(\d{1,5})$/i.exec(hash);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 1 ? n - 1 : undefined;
}

export interface ResumeTarget {
  /** Indeks halaman 0-based. */
  index: number;
  /** 0..1 di dalam halaman itu (hash: selalu 0 = awal halaman). */
  offset: number;
  source: 'hash' | 'progress';
}

/**
 * Ke mana reader harus melompat saat dibuka. Hash `#p<N>` menang atas posisi tersimpan; `#p1` berarti
 * "dari awal" dan tidak jatuh ke posisi tersimpan. Posisi tersimpan hanya dipakai bila halamannya > 0.
 * Indeks dibatasi ke halaman terakhir (jumlah gambar chapter bisa berubah).
 */
export function resumeTarget(o: {
  hash: string;
  pageCount: number;
  stored?: { page: number; offset: number };
}): ResumeTarget | undefined {
  if (o.pageCount <= 0) return undefined;
  const last = o.pageCount - 1;
  const fromHash = parsePageHash(o.hash);
  if (fromHash !== undefined) {
    return fromHash > 0 ? { index: Math.min(fromHash, last), offset: 0, source: 'hash' } : undefined;
  }
  const s = o.stored;
  if (s && s.page > 0) {
    return { index: Math.min(s.page, last), offset: s.page > last ? 0 : clamp01(s.offset), source: 'progress' };
  }
  return undefined;
}

/** Teks toast setelah melompat; `index` 0-based. */
export const resumeToastText = (index: number): string => `Lanjut dari halaman ${index + 1}`;

/* ----------------------------------------------------- halaman yang dibaca */

/**
 * Halaman yang dilintasi garis `line` (px dari atas viewport) dan posisi 0..1 di dalamnya.
 * `rectAt(i)` memberi kotak halaman ke-i; urutan halaman menurun ke bawah, jadi cukup pencarian biner
 * (hanya ~log2(n) pembacaan layout per scroll). Garis di atas halaman pertama -> halaman 0, offset 0;
 * di bawah halaman terakhir -> halaman terakhir, offset 1.
 */
export function currentPage(
  count: number,
  rectAt: (i: number) => Rect,
  line: number,
): { index: number; offset: number } {
  if (count <= 0) return { index: 0, offset: 0 };
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rectAt(mid).top <= line) lo = mid;
    else hi = mid - 1;
  }
  const r = rectAt(lo);
  return { index: lo, offset: clamp01((line - r.top) / Math.max(r.height, 1)) };
}

/** Chapter yang sedang dibaca: yang halaman pertamanya sudah melewati garis; sebelum itu, yang pertama. */
export function sectionAt(firstTops: readonly number[], line: number): number {
  let at = 0;
  for (let i = 0; i < firstTops.length; i++) if (firstTops[i] <= line) at = i;
  return at;
}

/** Bagian chapter yang sudah dibaca, 0..1 (halaman + posisi di dalamnya). */
export const fractionRead = (index: number, offset: number, count: number): number =>
  count > 0 ? Math.min(1, (index + offset) / count) : 0;

/* --------------------------------------------------------- pemuatan gambar */

/** Berapa tinggi viewport di atas/bawah yang boleh mulai memuat gambar; lebih hemat saat saveData/2G. */
export const lookahead = (saver: boolean): { up: number; down: number } =>
  saver ? { up: 0.5, down: 1 } : { up: 1, down: 3 };

/** `rootMargin` IntersectionObserver (atas kanan bawah kiri) dari `lookahead`. */
export const rootMargin = (l: { up: number; down: number }): string => `${l.up * 100}% 0px ${l.down * 100}% 0px`;

/**
 * Indeks gambar yang dimuat langsung saat chapter tampil: tiga pertama; saat melompat ke halaman
 * `target`, satu sebelum dan tiga sesudahnya (halaman di atasnya menyusul lewat observer).
 */
export function initialPages(count: number, target?: number): Set<number> {
  const from = target === undefined ? 0 : Math.max(0, target - 1);
  const to = target === undefined ? 2 : target + 3;
  const out = new Set<number>();
  for (let i = from; i <= to && i < count; i++) out.add(i);
  return out;
}

/* ------------------------------------------------ chapter berikutnya & DOM */

/** Jarak dasar chapter ke bawah viewport (dalam tinggi viewport) tempat chapter berikutnya mulai dimuat. */
export const APPEND_AHEAD = 1.5;

/** Dasar chapter terakhir (koordinat viewport) sudah dalam `factor` tinggi viewport di bawah layar? */
export const nearEnd = (bottom: number, viewportH: number, factor: number = APPEND_AHEAD): boolean =>
  bottom - viewportH <= viewportH * factor;

/** Jumlah chapter maksimum di DOM. */
export const MAX_SECTIONS = 3;

/**
 * Berapa chapter tertua yang dibuang agar jumlahnya <= `max`: hanya yang seluruhnya sudah di atas
 * viewport (`bottom <= 0`), berurutan dari yang tertua, dan tidak pernah chapter yang sedang dibaca.
 */
export function sectionsToDrop(
  boxes: readonly { bottom: number }[],
  currentIndex: number,
  max: number = MAX_SECTIONS,
): number {
  let n = 0;
  while (boxes.length - n > max && n < currentIndex && boxes[n].bottom <= 0) n++;
  return n;
}

/** Selisih scroll agar elemen jangkar tetap di titik viewport yang sama setelah konten di atasnya dibuang. */
export const scrollCompensation = (anchorTopBefore: number, anchorTopAfter: number): number =>
  anchorTopAfter - anchorTopBefore;

/* ------------------------------------------------------------ pengaturan */

/** `mr:reader:autonext`: aktif kecuali nilainya persis "0". */
export const parseAutoNext = (raw: string | null): boolean => raw !== '0';
