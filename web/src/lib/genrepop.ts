/**
 * Popover "Genre" di Daftar Komik (markup: `genrePopHtml` di views.ts). Tombol `[data-genre-toggle]`
 * membuka panel `[data-genre-panel]` berisi semua genre (tautan ke /genre/<slug>/); daftarnya diambil
 * dari cache `getGenres()` saat pertama dibuka. Pola disclosure: `aria-expanded` di tombol, Esc menutup
 * (fokus kembali ke tombol), klik/fokus di luar menutup.
 *
 * Semua pendengar delegated pada `host` (atau document) dan mencari elemennya setiap kali, jadi tetap
 * jalan setelah halaman daftar digambar ulang (innerHTML membuang popover lama).
 */
import { chapterSlug, errorKind, getGenres } from './api';
import { errorTitle } from './errorview';
import { genreHref } from './routes';
import { esc } from './views';

const POP = '[data-genre-pop]';

export function mountGenrePop(host: HTMLElement): void {
  const parts = () => {
    const pop = host.querySelector<HTMLElement>(POP);
    return {
      pop,
      toggle: pop?.querySelector<HTMLButtonElement>('[data-genre-toggle]'),
      panel: pop?.querySelector<HTMLElement>('[data-genre-panel]'),
      body: pop?.querySelector<HTMLElement>('[data-genre-body]'),
    };
  };

  const setOpen = (open: boolean, refocus = false) => {
    const { toggle, panel } = parts();
    if (!toggle || !panel) return;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) load();
    else if (refocus) toggle.focus();
  };

  /** Isi panel dari cache (atau jaringan): memuat -> daftar | galat + coba lagi. Sekali per elemen panel. */
  const load = (force = false) => {
    const { body } = parts();
    if (!body || (body.dataset.state === 'ready' && !force)) return;
    body.dataset.state = 'loading';
    body.innerHTML = '<p class="pop-note"><span class="feed-spinner" aria-hidden="true"></span>Memuat genre…</p>';
    getGenres()
      .then((list) => {
        if (!body.isConnected) return;
        body.dataset.state = 'ready';
        body.innerHTML = `<ul class="chips" role="list">${list
          .map((g) => `<li><a class="chip" href="${esc(genreHref(chapterSlug(g.endpoint)))}">${esc(g.title)}</a></li>`)
          .join('')}</ul>`;
      })
      .catch((e: unknown) => {
        if (!body.isConnected) return;
        body.dataset.state = 'error';
        body.innerHTML = `<p class="pop-note">${esc(errorTitle(errorKind(e)))}</p><button type="button" class="btn btn-sm" data-genre-retry>Coba lagi</button>`;
      });
  };

  host.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest('[data-genre-toggle]')) {
      setOpen(parts().panel?.hidden === true);
    } else if (t?.closest('[data-genre-retry]')) {
      load(true);
    }
  });

  host.addEventListener('keydown', (e) => {
    const { panel } = parts();
    if (e.key !== 'Escape' || !panel || panel.hidden) return;
    e.preventDefault();
    setOpen(false, true);
  });

  document.addEventListener('pointerdown', (e) => {
    const { pop, panel } = parts();
    if (pop && panel && !panel.hidden && e.target instanceof Node && !pop.contains(e.target)) setOpen(false);
  });

  // Tab keluar dari popover: tutup.
  host.addEventListener('focusout', (e) => {
    const { pop, panel } = parts();
    if (pop && panel && !panel.hidden && e.relatedTarget instanceof Node && !pop.contains(e.relatedTarget)) setOpen(false);
  });
}
