/**
 * Sub-menu "Daftar" di header desktop: pola disclosure (WAI-ARIA), bukan role=menu.
 * Tombol `[data-menu-toggle]` membuka/menutup daftar tautan `[data-menu-list]`.
 * Tutup lewat Esc (fokus kembali ke tombol), klik di luar, atau fokus keluar.
 * Panah bawah pada tombol membuka menu dan memindahkan fokus ke item pertama;
 * panah atas/bawah/Home/End berpindah antar item.
 */
export function initNavMenu(): void {
  const wrap = document.querySelector<HTMLElement>('[data-menu]');
  const toggle = wrap?.querySelector<HTMLButtonElement>('[data-menu-toggle]');
  const list = wrap?.querySelector<HTMLElement>('[data-menu-list]');
  if (!wrap || !toggle || !list) return;

  const items = () => Array.from(list.querySelectorAll<HTMLAnchorElement>('a'));

  const setOpen = (open: boolean) => {
    list.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };

  const openAndFocus = (i: number) => {
    setOpen(true);
    const all = items();
    all[(i + all.length) % all.length]?.focus();
  };

  toggle.addEventListener('click', () => setOpen(list.hidden));

  toggle.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      openAndFocus(0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openAndFocus(-1);
    }
  });

  list.addEventListener('keydown', (e) => {
    const all = items();
    const i = all.indexOf(document.activeElement as HTMLAnchorElement);
    const move = (to: number) => {
      e.preventDefault();
      all[(to + all.length) % all.length]?.focus();
    };
    if (e.key === 'ArrowDown') move(i + 1);
    else if (e.key === 'ArrowUp') move(i - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(-1);
  });

  wrap.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || list.hidden) return;
    e.preventDefault();
    setOpen(false);
    toggle.focus();
  });

  document.addEventListener('pointerdown', (e) => {
    if (!list.hidden && e.target instanceof Node && !wrap.contains(e.target)) setOpen(false);
  });
  // Fokus keyboard pindah ke luar menu (Tab): tutup.
  wrap.addEventListener('focusout', (e) => {
    if (e.relatedTarget instanceof Node && !wrap.contains(e.relatedTarget)) setOpen(false);
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) setOpen(false);
  });
}
