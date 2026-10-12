/**
 * Satu-satunya titik akses ke API Go.
 * Semua halaman WAJIB lewat sini — jangan hardcode URL API di tempat lain.
 */

export interface Manga {
  title: string;
  image: string;
  desc?: string;
  type?: string;
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
  chapter_list?: ChapterRef[];
}

export interface ChapterDetail {
  title: string;
  image: string[];
}

/** Envelope tetap dari API: {success, data, message, code} */
interface Envelope<T> {
  success: boolean;
  data: T;
  message: string;
  code: number;
}

const BASE = (import.meta.env.PUBLIC_API_URL || 'https://img2.kremlit.dev').replace(/\/+$/, '');

/** Scrape live bisa lambat; 20s sesuai spesifikasi. */
const TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  constructor(message: string, readonly code = 0) {
    super(message);
    this.name = 'ApiError';
  }
}

async function get<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const timeout = e instanceof Error && e.name === 'TimeoutError';
    throw new ApiError(
      timeout
        ? `API tidak merespons dalam ${TIMEOUT_MS / 1000} detik`
        : 'Tidak dapat menghubungi API',
    );
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
 * `endpoint` dari API sudah memuat segmen `manga/`
 * (`/manga/black-clover-indonesia/`). Yang dipakai sebagai URL halaman kita
 * slug-nya saja; awalan `manga/` dibangun ulang saat memanggil info.
 * Diverifikasi: `/api/comic/info/manga/manga/<slug>` -> 404, `.../manga/<slug>` -> 200.
 */
export const slugOf = (endpoint: string): string =>
  endpoint
    .replace(/^\/+|\/+$/g, '')
    .replace(/^manga\//, '');

export const getPopular = (page = 1) => get<Manga[]>(`/api/comic/popular/page/${page}`);

export const search = (q: string) => get<Manga[]>(`/api/comic/search/${encodeURIComponent(q)}`);

/** Segmen terakhir saja — chapter endpoint tidak punya awalan `manga/`. */
const chapterSlug = (endpoint: string) => endpoint.replace(/^\/+|\/+$/g, '');

export const getInfo = (slug: string) => get<MangaInfo>(`/api/comic/info/manga/${slugOf(slug)}`);

export const getChapter = (slug: string) => get<ChapterDetail>(`/api/comic/chapter/${chapterSlug(slug)}`);
