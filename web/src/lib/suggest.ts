/**
 * Autocomplete kolom cari header — combobox WAI-ARIA 1.2 (pola "list autocomplete").
 *
 * Alur ketikan: >= 2 karakter -> judul dari pustaka (bookmark + riwayat) muncul
 * SEKETIKA, hasil API menyusul setelah jeda 250 ms lewat `get(paths.search(q))`.
 * Itu kunci cache yang sama dengan halaman /search/, jadi Enter sesudahnya
 * dirender dari cache tanpa menunggu. Jawaban yang bukan untuk ketikan terakhir
 * dibuang (`seq`); request-nya tetap selesai dan mengisi cache.
 *
 * Opsi adalah tautan internal `<a role="option" href="/manga/<slug>/">`: prefetch
 * hover/pointerdown di prefetch.ts bekerja otomatis. Tanpa JS, form tetap GET biasa
 * ke /search/ — atribut ARIA combobox baru dipasang di sini, bukan di markup.
 */
import { ApiError, errorKind, get, paths, peek, slugOf, type ErrorKind, type Manga } from './api';
import { whenOnline } from './errorstate';
import { errorTitle } from './errorview';
import { getBookmarks, getHistory } from './library';
import { esc, suggestOptionHtml } from './views';

const DEBOUNCE_MS = 250;
const MIN_CHARS = 2;
const MAX_LIBRARY = 3;
const MAX_API = 8;

type Status = 'loading' | 'ready' | 'error';

interface Opt {
  slug: string;
  title: string;
  cover: string;
  type?: string;
}

/** Judul pustaka (bookmark dulu, lalu riwayat) yang mengandung `q`; satu slug satu kali. */
function libraryMatches(q: string): Opt[] {
  const needle = q.toLowerCase();
  const seen = new Set<string>();
  const out: Opt[] = [];
  for (const e of [...getBookmarks(), ...getHistory()]) {
    if (seen.has(e.slug) || !e.title.toLowerCase().includes(needle)) continue;
    seen.add(e.slug);
    out.push(e);
    if (out.length === MAX_LIBRARY) break;
  }
  return out;
}

export function initSuggest(): void {
  const input = document.getElementById('q') as HTMLInputElement | null;
  const box = document.getElementById('suggest');
  const live = document.getElementById('suggest-live');
  const form = input?.form;
  if (!input || !box || !form) return;

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', box.id);
  input.setAttribute('aria-expanded', 'false');

  let seq = 0;
  let timer = 0;
  let options: HTMLAnchorElement[] = [];
  let active = -1;
  let shown: { q: string; api?: Manga[]; status: Status; failure?: ErrorKind } | undefined;

  const announce = (text: string) => {
    if (live) live.textContent = text;
  };

  const setActive = (i: number) => {
    options[active]?.setAttribute('aria-selected', 'false');
    active = i;
    const opt = options[i];
    if (opt) {
      opt.setAttribute('aria-selected', 'true');
      input.setAttribute('aria-activedescendant', opt.id);
      opt.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };

  const setOpen = (open: boolean) => {
    box.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    if (!open) setActive(-1);
  };


  /** Gambar ulang dari `shown`; opsi yang sedang aktif dipertahankan (cocokkan lewat href). */
  const render = () => {
    if (!shown) return;
    const { q, status, failure = 'unknown' } = shown;
    const lib = libraryMatches(q);
    const inLib = new Set(lib.map((o) => o.slug));
    const fromApi: Opt[] = (shown.api ?? [])
      .map((m) => ({ slug: slugOf(m.endpoint), title: m.title, cover: m.image, type: m.type }))
      .filter((o) => !inLib.has(o.slug))
      .slice(0, MAX_API);
    const nothing = !lib.length && !fromApi.length;

    const keep = options[active]?.getAttribute('href');
    let n = 0;
    const group = (id: string, label: string, list: Opt[]) =>
      list.length
        ? `<div role="group" aria-labelledby="sg-h-${id}"><div class="sg-head" id="sg-h-${id}" role="presentation">${label}</div>${list
            .map((o) => suggestOptionHtml(o, q, n++))
            .join('')}</div>`
        : '';
    const note = (text: string, spin = false, kind?: ErrorKind) =>
      `<div class="sg-note" aria-hidden="true"${kind ? ` data-error-state data-error-kind="${kind}"` : ''}>${spin ? '<span class="feed-spinner"></span>' : ''}<span>${text}</span></div>`;

    let html = group('lib', 'Dari pustaka', lib) + group('api', 'Hasil pencarian', fromApi);
    if (status === 'loading') html += note('Mencari…', true);
    else if (status === 'error') html += note(errorTitle(failure), false, failure);
    else if (nothing) html += note('Tidak ada judul yang cocok');
    // Tautan ke halaman hasil selalu ada, kecuali bila sudah pasti kosong.
    if (!(status === 'ready' && nothing)) {
      html += `<a class="sg-opt sg-all" role="option" id="sg-${n++}" aria-selected="false" tabindex="-1" href="/search/?q=${encodeURIComponent(q)}">Lihat semua hasil untuk “${esc(q)}”</a>`;
    }

    box.innerHTML = html;
    options = Array.from(box.querySelectorAll<HTMLAnchorElement>('[role="option"]'));
    active = -1;
    setActive(keep ? options.findIndex((o) => o.getAttribute('href') === keep) : -1);
    setOpen(true);

    announce(
      status === 'loading'
        ? 'Mencari…'
        : status === 'error'
          ? errorTitle(failure)
          : nothing
            ? 'Tidak ada judul yang cocok'
            : `${lib.length + fromApi.length} saran tersedia`,
    );
  };

  const show = (q: string, api: Manga[] | undefined, status: Status, failure?: ErrorKind) => {
    shown = { q, api, status, failure };
    render();
  };

  const onInput = () => {
    const q = input.value.trim();
    window.clearTimeout(timer);
    const mine = ++seq;
    if (q.length < MIN_CHARS) {
      shown = undefined;
      setOpen(false);
      return;
    }
    const cached = peek<Manga[]>(paths.search(q));
    if (cached) {
      show(q, cached, 'ready');
      return;
    }
    show(q, undefined, 'loading'); // pustaka langsung, API menyusul
    timer = window.setTimeout(() => {
      get<Manga[]>(paths.search(q)).then(
        (data) => {
          if (mine === seq) show(q, data, 'ready');
        },
        (e) => {
          if (mine !== seq) return;
          // Tanpa hasil, API menjawab 404 "Data not found": itu daftar kosong, bukan kegagalan.
          if (e instanceof ApiError && e.code === 404) show(q, [], 'ready');
          else {
            const failure = errorKind(e);
            show(q, undefined, 'error', failure);
            // Offline: cari lagi sendiri begitu koneksi kembali, selama ketikannya belum berubah.
            if (failure === 'offline') {
              whenOnline(() => {
                if (shown?.status === 'error' && shown.q === input.value.trim()) onInput();
              });
            }
          }
        },
      );
    }, DEBOUNCE_MS);
  };

  const cancel = () => {
    window.clearTimeout(timer);
    seq++;
  };

  input.addEventListener('input', onInput);

  input.addEventListener('focus', () => {
    if (shown && shown.q === input.value.trim()) setOpen(true);
  });

  input.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (box.hidden && shown) setOpen(true);
        if (box.hidden || !options.length) return;
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        setActive(active < 0 ? (dir > 0 ? 0 : options.length - 1) : (active + dir + options.length) % options.length);
        break;
      }
      case 'Enter': {
        const opt = options[active];
        if (!box.hidden && opt) {
          e.preventDefault(); // buka opsi aktif, bukan kirim form
          location.assign(opt.href);
        }
        break;
      }
      case 'Escape':
        if (!box.hidden) {
          e.preventDefault();
          setOpen(false);
        } else if (input.value) {
          e.preventDefault();
          input.value = '';
          cancel();
          shown = undefined;
        }
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  });

  // mousedown di daftar tidak boleh memindahkan fokus dari input, atau klik pada opsi hilang.
  box.addEventListener('mousedown', (e) => e.preventDefault());

  document.addEventListener('pointerdown', (e) => {
    if (!box.hidden && e.target instanceof Node && !form.contains(e.target)) setOpen(false);
  });
  // Fokus pindah ke elemen lain di luar form (Tab/klik): tutup. relatedTarget null (jendela
  // kehilangan fokus) sengaja diabaikan.
  form.addEventListener('focusout', (e) => {
    if (e.relatedTarget instanceof Node && !form.contains(e.relatedTarget)) setOpen(false);
  });
  form.addEventListener('submit', () => {
    cancel();
    setOpen(false);
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) setOpen(false);
  });
}
