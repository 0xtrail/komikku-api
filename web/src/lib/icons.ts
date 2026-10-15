/**
 * Ikon SVG inline (string murni, tanpa DOM): dipakai views.ts/readerview.ts (Node & browser) dan
 * komponen Astro. Semuanya dekoratif (`aria-hidden`): tombol/tautan pembawanya yang memberi nama.
 * Garis `currentColor`, jadi warnanya mengikuti teks; ukuran diatur CSS lewat kelas `.ic`.
 */
const ico = (body: string, cls = 'ic'): string =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICON_BOOKMARK = ico('<path d="M6.5 3.5h11a1 1 0 0 1 1 1V20.5l-6.5-4.4-6.5 4.4V4.5a1 1 0 0 1 1-1Z"/>');
export const ICON_STAR = ico('<path d="m12 3.5 2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.9l-5.3 2.7 1-5.8-4.2-4.1 5.9-.9L12 3.5Z"/>');
export const ICON_CLOCK = ico('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>');
export const ICON_FLAME = ico('<path d="M12 3c.8 3.4 5 5.4 5 10a5 5 0 0 1-10 0c0-2 .9-3.2 2-4.2.3 1.5 1 2.2 2 2.2 0-3-1-5 1-8Z"/>');
export const ICON_TAG = ico('<path d="M3.5 12.5V5A1.5 1.5 0 0 1 5 3.5h7.5l8 8-9 9-8-8Z"/><circle cx="8.2" cy="8.2" r="1.2"/>');
export const ICON_EYE = ico('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>');
export const ICON_PLUS_CIRCLE = ico('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>');
export const ICON_SEARCH = ico('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>');
export const ICON_MENU = ico('<path d="M4 7h16M4 12h16M4 17h16"/>');
export const ICON_CLOSE = ico('<path d="m6 6 12 12M18 6 6 18"/>');
export const ICON_CHEV_DOWN = ico('<path d="m6 9 6 6 6-6"/>', 'ic chev');
export const ICON_CHEV_LEFT = ico('<path d="m15 6-6 6 6 6"/>');
export const ICON_CHEV_RIGHT = ico('<path d="m9 6 6 6-6 6"/>');
export const ICON_ARROW_LEFT = ico('<path d="M19 12H5m6-6-6 6 6 6"/>');
export const ICON_SORT = ico('<path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3"/>');
export const ICON_IMAGE = ico('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-4.5 3.5 3 3-2.5 4.5 4"/>');
export const ICON_CHECK = ico('<path d="m5 12.5 4.5 4.5L19 7.5"/>', 'ch-check');
export const ICON_X = ico('<path d="m6 6 12 12M18 6 6 18"/>');

/** Tanda Panel (tiga kotak) untuk logo header & footer. Mengikuti warna teks pembawanya. */
export const PANEL_MARK =
  '<svg class="mark-ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="2" y="2" width="9" height="20" rx="2.5" fill="currentColor"/><rect x="13" y="2" width="9" height="9" rx="2.5" fill="currentColor"/><rect x="13" y="13" width="9" height="9" rx="2.5" fill="currentColor" opacity=".55"/></svg>';
