/**
 * Perilaku header: panel navigasi dan baris cari di ponsel (< 768px), serta pintasan keyboard
 * `/` dan Cmd/Ctrl+K yang memfokuskan kolom cari. Markup di Nav.astro; tampilan buka/tutup ada di CSS
 * lewat atribut `data-nav-open` / `data-search-open` pada `.site-header`.
 * Di desktop navigasi dan kolom cari selalu tampak, jadi hanya pintasan yang berlaku.
 */
const MOBILE = '(max-width: 767px)';

type Panel = 'nav' | 'search';

/** Elemen yang menerima ketikan: pintasan `/` tidak boleh mencurinya. */
const isEditable = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function initHeader(): void {
  const header = document.querySelector<HTMLElement>('.site-header');
  const burger = header?.querySelector<HTMLButtonElement>('[data-nav-toggle]');
  const searchBtn = header?.querySelector<HTMLButtonElement>('[data-search-toggle]');
  const input = document.getElementById('q') as HTMLInputElement | null;
  if (!header || !burger || !searchBtn || !input) return;

  const mobile = window.matchMedia(MOBILE);
  const button = (p: Panel) => (p === 'nav' ? burger : searchBtn);

  const set = (p: Panel, open: boolean) => {
    header.toggleAttribute(`data-${p}-open`, open);
    button(p).setAttribute('aria-expanded', String(open));
  };
  const closeAll = () => {
    set('nav', false);
    set('search', false);
  };
  const toggle = (p: Panel) => {
    const open = !header.hasAttribute(`data-${p}-open`);
    closeAll(); // satu panel terbuka sekaligus: keduanya menumpuk di bawah bar
    set(p, open);
    if (open && p === 'search') input.focus();
  };

  burger.addEventListener('click', () => toggle('nav'));
  searchBtn.addEventListener('click', () => toggle('search'));

  // Menekan tautan di panel menutupnya (tautan `/#genre` di beranda tidak memuat ulang halaman).
  header.querySelector('.primary-nav')?.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('a')) closeAll();
  });
  document.addEventListener('pointerdown', (e) => {
    if (e.target instanceof Node && !header.contains(e.target)) closeAll();
  });
  document.addEventListener('keydown', (e) => {
    // Saran pencarian yang sedang terbuka menangani Esc lebih dulu (preventDefault); jangan tutup panel ikut.
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    const open = (['nav', 'search'] as const).find((p) => header.hasAttribute(`data-${p}-open`));
    if (!open) return;
    const hadFocus = header.contains(document.activeElement);
    closeAll();
    if (hadFocus) button(open).focus();
  });
  mobile.addEventListener('change', closeAll);
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) closeAll();
  });

  // Petunjuk pintasan sesuai platform.
  const hint = header.querySelector<HTMLElement>('[data-search-kbd]');
  if (hint && !/Mac|iPhone|iPad/.test(navigator.platform)) hint.textContent = 'Ctrl K';

  // `/` dan Cmd/Ctrl+K: fokus ke kolom cari. Header tersembunyi (reader) = biarkan tombolnya bekerja seperti biasa.
  document.addEventListener('keydown', (e) => {
    if (e.altKey || e.shiftKey) return;
    const combo = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k';
    const slash = e.key === '/' && !e.ctrlKey && !e.metaKey && !isEditable(e.target);
    if (!combo && !slash) return;
    if (header.getClientRects().length === 0) return;
    e.preventDefault();
    if (mobile.matches) {
      closeAll();
      set('search', true);
    }
    input.focus();
    input.select();
  });
}
