/**
 * Dispatcher tunggal untuk semua halaman. `view.astro` dilayani untuk
 * /manga/*, /chapter/*, /genre/*, /populer/*, /terbaru/* (lihat `nginx.conf`
 * dan `public/_redirects`); `/`, `/search/`, `/daftar/`, dan `/pustaka/` adalah
 * file nyata. Semuanya memanggil modul ini, dan `parseRoute` yang menentukan
 * apa yang dirender. Perenderan menunggu jurnal posisi baca dipulihkan (lihat bawah).
 */
import './site';
import { mountHome, mountListing, mountSearch, mountUnknown } from './client';
import { mountMangaDetail } from './detail';
import { mountChapter } from './reader';
import { mountLibrary } from './pustaka';
import { installJournal, recoverFromJournal } from './progressjournal';
import { parseRoute } from './routes';

function mount(): void {
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
    case 'list':
      mountListing(route);
      break;
    case 'library':
      mountLibrary(route.tab);
      break;
    default:
      mountUnknown();
  }
}

// Riwayat baca di localStorage bisa tertinggal bila browser dimatikan paksa: jurnal IndexedDB (satu catatan terakhir)
// dimasukkan kembali SEBELUM halaman membaca posisi (Pustaka, "Lanjutkan" di detail, lanjut baca di reader).
// Menunggu satu pembacaan IndexedDB, paling lama 400 ms; gagal atau lambat tetap lanjut merender.
installJournal();
recoverFromJournal().then(mount, mount);
