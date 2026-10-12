/**
 * Dispatcher tunggal untuk semua halaman. `view.astro` dilayani untuk
 * /manga/*, /chapter/*, /genre/*, /populer/*, /terbaru/* (lihat `nginx.conf`
 * dan `public/_redirects`); `/` dan `/search/` adalah file nyata. Semuanya
 * memanggil modul ini, dan `parseRoute` yang menentukan apa yang dirender.
 */
import './site';
import {
  mountChapter,
  mountHome,
  mountListing,
  mountMangaDetail,
  mountSearch,
  mountUnknown,
} from './client';
import { parseRoute } from './routes';

const route = parseRoute(new URL(location.href));

switch (route.kind) {
  case 'home':
    mountHome();
    break;
  case 'search':
    mountSearch(route.q);
    break;
  case 'manga':
    mountMangaDetail(route.slug);
    break;
  case 'chapter':
    mountChapter(route.slug);
    break;
  case 'genre':
  case 'popular':
  case 'newest':
    mountListing(route);
    break;
  default:
    mountUnknown();
}
