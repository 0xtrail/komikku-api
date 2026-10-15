/**
 * Satu-satunya titik akses ke API Go.
 * Semua halaman WAJIB lewat sini — jangan hardcode URL API di tempat lain.
 *
 * Lapisan cache (lihat `get`/`peek`): API men-scrape situs sumber secara live
 * di setiap panggilan (0,5-3 detik), jadi kecepatan navigasi ditentukan oleh
 * seberapa sering kita TIDAK perlu bertanya ke API.
 *   1. `inflight`  — pemanggil bersamaan untuk path yang sama berbagi satu request.
 *   2. `mem`       — Map di memori (hidup selama halaman terbuka).
 *   3. sessionStorage — bertahan antar-halaman dalam satu tab, sehingga halaman
 *      berikutnya bisa dirender sinkron dari cache tanpa state loading.
 * Hanya respons sukses yang disimpan. Semua akses storage dibungkus try/catch.
 */

export interface Manga {
  title: string;
  image: string;
  desc?: string;
  type?: string;
  endpoint: string;
}

export interface Genre {
  title: string;
  endpoint: string;
}

export interface ChapterRef {
  name: string;
  endpoint: string;
}

export interface MangaInfo {
  thumbnail: string;
  title: string;
  type?: string;
  author?: string;
  status?: string;
  rating?: string;
  genre?: string[];
  /** Paragraf dipisah baris kosong ("\n\n"). Belum ada di API lama: tampilan menyembunyikan bagiannya. */
  synopsis?: string;
  /** `null` untuk seri tanpa chapter (bukan array kosong): selalu pakai `?? []` atau `?.`. */
  chapter_list?: ChapterRef[] | null;
}

export interface ChapterDetail {
  title: string;
  image: string[];
  /**
   * Dari API yang lebih baru (aditif; string kosong bila tidak ada, `undefined` di API lama):
   * manga induk (`/manga/<slug>/`) dan tetangga chapter. Sumber utama untuk reader — slug manga
   * TIDAK bisa ditebak dari slug chapter (`solo-leveling-ragnarok-chapter-66` -> `/manga/alone-leveling-ragnarok/`).
   */
  manga_endpoint?: string;
  manga_title?: string;
  prev_endpoint?: string;
  next_endpoint?: string;
}

/** Envelope tetap dari API: {success, data, message, code} */
interface Envelope<T> {
  success: boolean;
  data: T;
  message: string;
  code: number;
}

// `env?.`: di Node polos (tes) `import.meta.env` tidak ada; di Vite/Astro selalu ada dan nilainya diganti saat build.
export const API_BASE = (import.meta.env?.PUBLIC_API_URL || 'https://img2.kremlit.dev').replace(
  /\/+$/,
  '',
);

/** Scrape live bisa lambat; 20s sesuai spesifikasi. */
const TIMEOUT_MS = 20_000;

/** Isi cache dianggap usang (dibuang) setelah 10 menit. */
const TTL_MS = 10 * 60 * 1000;

/**
 * Cache yang lebih tua dari ini masih dirender langsung, tetapi pemanggil
 * disarankan memvalidasi ulang di latar belakang (`peekEntry().age`).
 * Dengan begitu navigasi bolak-balik tidak memicu scrape tiap kali.
 */
export const STALE_MS = 30 * 1000;

/** Ukuran halaman daftar (popular/recommended/newest/genre) di API. */
export const PAGE_SIZE = 10;

/** `/api/comic/list` (Daftar Komik) memberi 50 judul per halaman; halaman terakhir lebih pendek. */
export const LIST_PAGE_SIZE = 50;

/** Filter jenis untuk Daftar Komik; '' = semua jenis (tanpa parameter `filter`). */
export type ListTipe = '' | 'manga' | 'manhwa' | 'manhua';

const STORE_PREFIX = 'mr:v1:';
const MEM_MAX = 200;

/**
 * Jenis kegagalan untuk tampilan (`errorview.ts` memilih pesan & tombol dari sini); `message`
 * ApiError hanya untuk log/debug, tidak pernah ditampilkan ke pengguna.
 *  - notfound : 404/410 dari API (judul/halaman tidak ada)
 *  - timeout  : tidak merespons dalam TIMEOUT_MS, atau 408/504
 *  - offline  : fetch gagal saat `navigator.onLine === false`
 *  - server   : sisanya — 5xx, respons bukan JSON, atau fetch gagal padahal browser online (API mati/ditolak)
 *  - unknown  : bukan ApiError (mis. exception saat render)
 */
export type ErrorKind = 'notfound' | 'server' | 'timeout' | 'offline' | 'unknown';

const kindOfStatus = (status: number): ErrorKind =>
  status === 404 || status === 410 ? 'notfound' : status === 408 || status === 504 ? 'timeout' : 'server';

// Properti ditulis eksplisit (bukan parameter property) agar berkas ini bisa di-strip dan dijalankan Node apa adanya.
export class ApiError extends Error {
  readonly code: number;
  readonly kind: ErrorKind;
  constructor(message: string, code = 0, kind: ErrorKind = kindOfStatus(code)) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.kind = kind;
  }
}

export const errorKind = (e: unknown): ErrorKind => (e instanceof ApiError ? e.kind : 'unknown');

/* ------------------------------------------------------------------ cache */

interface Entry<T = unknown> {
  t: number;
  data: T;
}

const mem = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

/** sessionStorage bisa melempar (mode privat, storage diblokir) atau tidak ada (build Node). */
function store(): Storage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

function readStored(path: string): Entry | undefined {
  try {
    const raw = store()?.getItem(STORE_PREFIX + path);
    if (!raw) return undefined;
    const e = JSON.parse(raw) as Entry;
    return typeof e?.t === 'number' && e.data !== undefined ? e : undefined;
  } catch {
    return undefined;
  }
}

function dropStored(path: string): void {
  try {
    store()?.removeItem(STORE_PREFIX + path);
  } catch {
    /* abaikan */
  }
}

/** Bersihkan entri kedaluwarsa; kalau tidak ada yang kedaluwarsa, buang sepertiga yang paling lama. */
function prune(s: Storage): void {
  try {
    const now = Date.now();
    const rows: Array<[string, number]> = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k || !k.startsWith(STORE_PREFIX)) continue;
      let t = 0;
      try {
        t = (JSON.parse(s.getItem(k) ?? '{}') as Entry).t || 0;
      } catch {
        /* entri rusak: t = 0 -> ikut dibuang */
      }
      rows.push([k, t]);
    }
    const expired = rows.filter(([, t]) => now - t > TTL_MS);
    const victims = expired.length
      ? expired
      : rows.sort((a, b) => a[1] - b[1]).slice(0, Math.max(1, Math.ceil(rows.length / 3)));
    for (const [k] of victims) s.removeItem(k);
  } catch {
    /* abaikan */
  }
}

function persist(path: string, entry: Entry): void {
  const s = store();
  if (!s) return;
  let value: string;
  try {
    value = JSON.stringify(entry);
  } catch {
    return;
  }
  try {
    s.setItem(STORE_PREFIX + path, value);
    return;
  } catch {
    /* kemungkinan quota penuh: pangkas lalu coba sekali lagi */
  }
  prune(s);
  try {
    s.setItem(STORE_PREFIX + path, value);
  } catch {
    /* tetap gagal: lewati persist, cache memori tetap jalan */
  }
}

function remember<T>(path: string, data: T): void {
  // Daftar kosong biasanya hasil scrape yang gagal sebagian — jangan dibekukan.
  if (Array.isArray(data) && data.length === 0) return;
  const entry: Entry = { t: Date.now(), data };
  mem.delete(path);
  mem.set(path, entry);
  if (mem.size > MEM_MAX) {
    const oldest = mem.keys().next().value;
    if (oldest !== undefined) mem.delete(oldest);
  }
  persist(path, entry);
}

/** Cache (jika masih segar) beserta umurnya dalam ms. Sinkron. */
export function peekEntry<T>(path: string): { data: T; age: number } | undefined {
  let e = mem.get(path);
  if (!e) {
    e = readStored(path);
    if (e) mem.set(path, e);
  }
  if (!e) return undefined;
  const age = Math.max(0, Date.now() - e.t);
  if (age > TTL_MS) {
    mem.delete(path);
    dropStored(path);
    return undefined;
  }
  return { data: e.data as T, age };
}

/** Data cache jika ada, kalau tidak `undefined`. Sinkron — dipakai untuk render pertama tanpa loading. */
export const peek = <T>(path: string): T | undefined => peekEntry<T>(path)?.data;

/* ---------------------------------------------------------------- request */

async function request<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') {
      throw new ApiError(`API tidak merespons dalam ${TIMEOUT_MS / 1000} detik`, 0, 'timeout');
    }
    // fetch menolak dengan TypeError baik saat browser offline maupun saat API mati/ditolak;
    // hanya yang pertama boleh disebut "offline".
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    throw new ApiError(offline ? 'Tidak ada koneksi internet' : 'Tidak dapat menghubungi API', 0, offline ? 'offline' : 'server');
  }

  let body: Envelope<T>;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    throw new ApiError(`Respons API tidak valid (HTTP ${res.status})`, res.status);
  }

  if (!body.success) {
    throw new ApiError(body.message || `Permintaan gagal (HTTP ${res.status})`, body.code || res.status);
  }
  return body.data;
}

/**
 * GET dengan cache. Urutan: cache segar -> request yang sedang berjalan ->
 * request baru. `force` melewati cache (untuk validasi ulang) tapi tetap
 * berbagi request yang sedang berjalan. Error tidak pernah di-cache.
 */
export function get<T>(path: string, opts: { force?: boolean } = {}): Promise<T> {
  if (!opts.force) {
    const hit = peekEntry<T>(path);
    if (hit) return Promise.resolve(hit.data);
  }
  const pending = inflight.get(path) as Promise<T> | undefined;
  if (pending) return pending;

  const p = request<T>(path)
    .then((data) => {
      remember(path, data);
      return data;
    })
    .finally(() => {
      inflight.delete(path);
    });
  inflight.set(path, p);
  return p;
}

/* ------------------------------------------------------------------ paths */

/**
 * `endpoint` dari API sudah memuat segmen `manga/`
 * (`/manga/black-clover-indonesia/`). Yang dipakai sebagai URL halaman kita
 * slug-nya saja; awalan `manga/` dibangun ulang saat memanggil info.
 * Diverifikasi: `/api/comic/info/manga/manga/<slug>` -> 404, `.../manga/<slug>` -> 200.
 */
export const slugOf = (endpoint: string): string =>
  endpoint
    .replace(/^\/+|\/+$/g, '')
    .replace(/^manga\//, '');

/** Segmen terakhir saja — chapter endpoint tidak punya awalan `manga/`. */
export const chapterSlug = (endpoint: string) => endpoint.replace(/^\/+|\/+$/g, '');

/** Path API untuk setiap data yang dipakai halaman. Satu tempat, agar prefetch & halaman selalu sama. */
export const paths = {
  popular: (page = 1) => `/api/comic/popular/page/${page}`,
  recommended: (page = 1) => `/api/comic/recommended/page/${page}`,
  newest: (page = 1) => `/api/comic/newest/page/${page}`,
  genres: () => '/api/comic/genre',
  byGenre: (slug: string, page = 1) => `/api/comic/genres/${encodeURIComponent(slug)}/page/${page}`,
  /** Parameter default (tanpa filter, halaman 1) dihilangkan agar kunci cache sama dengan yang di-prefetch. */
  list: (tipe: ListTipe = '', page = 1) => {
    const q = [tipe && `filter=${tipe}`, page > 1 && `page=${page}`].filter(Boolean).join('&');
    return `/api/comic/list${q ? `?${q}` : ''}`;
  },
  search: (q: string) => `/api/comic/search/${encodeURIComponent(q)}`,
  info: (slug: string) => `/api/comic/info/manga/${encodeURIComponent(slugOf(slug))}`,
  chapter: (slug: string) => `/api/comic/chapter/${encodeURIComponent(chapterSlug(slug))}`,
};

export const getPopular = (page = 1) => get<Manga[]>(paths.popular(page));

export const getRecommended = (page = 1) => get<Manga[]>(paths.recommended(page));

export const getNewest = (page = 1) => get<Manga[]>(paths.newest(page));

export const getGenres = () => get<Genre[]>(paths.genres());

export const getByGenre = (slug: string, page = 1) => get<Manga[]>(paths.byGenre(slug, page));

export const getList = (tipe: ListTipe = '', page = 1) => get<Manga[]>(paths.list(tipe, page));

export const search = (q: string) => get<Manga[]>(paths.search(q));

export const getInfo = (slug: string) => get<MangaInfo>(paths.info(slug));

export const getChapter = (slug: string) => get<ChapterDetail>(paths.chapter(slug));
