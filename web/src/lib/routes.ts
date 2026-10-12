/**
 * Pemetaan URL halaman -> rute -> path API.
 * Dipakai bersama oleh `boot.ts` (halaman apa yang dirender) dan `prefetch.ts`
 * (data apa yang dipanaskan untuk sebuah link), supaya keduanya tidak pernah
 * berbeda pendapat soal data yang dibutuhkan sebuah halaman.
 */
import { paths } from './api';

export type Route =
  | { kind: 'home' }
  | { kind: 'search'; q: string }
  | { kind: 'manga'; slug: string }
  | { kind: 'chapter'; slug: string }
  | { kind: 'genre'; slug: string; page: number }
  | { kind: 'popular'; page: number }
  | { kind: 'newest'; page: number }
  | { kind: 'unknown' };

const pageOf = (u: URL): number => {
  const n = Number.parseInt(u.searchParams.get('page') ?? '1', 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 9999) : 1;
};

export function parseRoute(u: URL): Route {
  let parts: string[];
  try {
    parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return { kind: 'unknown' }; // %-escape rusak
  }
  const [head, ...rest] = parts;
  const tail = rest.join('/');

  switch (head) {
    case undefined:
      return { kind: 'home' };
    case 'search':
      return { kind: 'search', q: (u.searchParams.get('q') ?? '').trim() };
    case 'manga':
      return tail ? { kind: 'manga', slug: tail } : { kind: 'unknown' };
    case 'chapter':
      return tail ? { kind: 'chapter', slug: tail } : { kind: 'unknown' };
    case 'genre':
      return tail ? { kind: 'genre', slug: tail, page: pageOf(u) } : { kind: 'unknown' };
    case 'populer':
      return { kind: 'popular', page: pageOf(u) };
    case 'terbaru':
      return { kind: 'newest', page: pageOf(u) };
    default:
      return { kind: 'unknown' };
  }
}

/** Panggilan API utama yang dibuat halaman untuk rute ini (undefined = tidak ada yang bisa dipanaskan). */
export function apiPathFor(r: Route): string | undefined {
  switch (r.kind) {
    case 'manga':
      return paths.info(r.slug);
    case 'chapter':
      return paths.chapter(r.slug);
    case 'genre':
      return paths.byGenre(r.slug, r.page);
    case 'popular':
      return paths.popular(r.page);
    case 'newest':
      return paths.newest(r.page);
    default:
      return undefined;
  }
}

/** `/manga/<slug>/` */
export const mangaHref = (slug: string) => `/manga/${encodeURIComponent(slug)}/`;
/** `/chapter/<slug>/` */
export const chapterHref = (slug: string) => `/chapter/${encodeURIComponent(slug)}/`;
/** `/genre/<slug>/?page=N` (halaman 1 tanpa query) */
export const genreHref = (slug: string, page = 1) =>
  `/genre/${encodeURIComponent(slug)}/${page > 1 ? `?page=${page}` : ''}`;
/** `/populer/?page=N` | `/terbaru/?page=N` */
export const listHref = (base: 'populer' | 'terbaru', page = 1) =>
  `/${base}/${page > 1 ? `?page=${page}` : ''}`;

/** Slug chapter -> slug manga: semua sebelum `-chapter-` terakhir. `undefined` jika pola tidak cocok. */
export function mangaSlugOfChapter(chapter: string): string | undefined {
  const i = chapter.toLowerCase().lastIndexOf('-chapter-');
  return i > 0 ? chapter.slice(0, i) : undefined;
}

/** Nama genre dari API (`Slice of Life`, `Girls' Love`, `Shoujo(G)`) -> slug (`slice-of-life`, `girls-love`, `shoujog`). */
export const genreSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/['’()]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
