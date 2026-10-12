/**
 * Dispatcher: view.html dilayani untuk /manga/* dan /chapter/* (lihat
 * `public/_redirects`). Router client-side ini yang decides halaman mana.
 */
import { mountMangaDetail, mountChapter } from './client';

const kind = location.pathname.split('/').filter(Boolean)[0];

if (kind === 'chapter') mountChapter();
else if (kind === 'manga') mountMangaDetail();
