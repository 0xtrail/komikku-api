/** Pembantu halaman yang dipakai bersama client.ts, detail.ts, dan pustaka.ts (di modul sendiri agar tidak saling impor). */

const BRAND = 'Panel';

export const setTitle = (t?: string) => {
  document.title = t ? `${t} — ${BRAND}` : `${BRAND} — Baca manga, manhwa & manhua`;
};

export const appEl = (): HTMLElement | null => document.getElementById('app');
