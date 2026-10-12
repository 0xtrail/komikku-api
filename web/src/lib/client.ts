/**
 * Render sisi-klien untuk rute yang tidak bisa di-prerender: /manga/<slug>,
 * /chapter/<slug>, /genre/<slug>, /populer, /terbaru, /search, serta hidrasi
 * beranda (yang sudah di-prerender saat build).
 *
 * Kenapa klien, bukan server: output `static` tidak bisa punya route dinamis
 * tanpa getStaticPaths() (data API, bukan daftar tetap) DAN tidak bisa
 * `prerender = false` tanpa adapter. Jadi HTML-nya statis, isinya diambil
 * di browser. URL tetap rapi lewat rewrite 200 (`nginx.conf` / `public/_redirects`).
 *
 * Pola render (`loadView`): cache dulu (sinkron, tanpa state loading) -> kalau
 * kosong tampilkan skeleton -> data datang -> render. Cache yang agak tua
 * divalidasi ulang di latar belakang dan hanya dirender ulang bila berubah.
 */
import {
  ApiError,
  STALE_MS,
  PAGE_SIZE,
  chapterSlug,
  get,
  paths,
  peek,
  peekEntry,
  type ChapterDetail,
  type Genre,
  type Manga,
  type MangaInfo,
} from './api';
import { genreHref, listHref, mangaSlugOfChapter, type Route } from './routes';
import { observeCards, prefetchPath } from './prefetch';
import {
  SR_LOADING,
  cardHtml,
  detailHtml,
  esc,
  genreCloud,
  gridHtml,
  railHtml,
  readerHtml,
  readerHeadHtml,
  readerNavHtml,
  readerTitle,
  sig,
  skelChips,
  skelDetail,
  skelGrid,
  skelListing,
  skelRail,
  skelReader,
  type ReaderCtx,
} from './views';

const BRAND = 'Panel';

const msg = (e: unknown): string => {
  if (e instanceof ApiError && e.code === 404) return 'Konten yang diminta tidak ditemukan (404).';
  return e instanceof ApiError || e instanceof Error ? e.message : 'Terjadi kesalahan';
};

const setTitle = (t?: string) => {
  document.title = t ? `${t} — ${BRAND}` : `${BRAND} — Baca manga, manhwa & manhua`;
};

const appEl = (): HTMLElement | null => document.getElementById('app');

function showError(el: HTMLElement, e: unknown, retry: () => void): void {
  el.setAttribute('aria-busy', 'false');
  el.innerHTML = `<div class="notice" role="alert">
    <p class="notice-title">Gagal memuat</p>
    <p>${esc(msg(e))}</p>
    <button type="button" class="btn btn-primary" data-retry>Coba lagi</button>
  </div>`;
  el.querySelector('[data-retry]')?.addEventListener('click', retry);
}

interface LoadOpts<T> {
  path: string;
  /** Pengambil data khusus; default `get(path)`. `force` = lewati cache (validasi ulang). */
  fetcher?: (force: boolean) => Promise<T>;
  skeleton: string;
  render: (data: T) => void;
  /** false = jangan validasi ulang di latar belakang (mis. reader: render ulang akan mereset scroll). */
  revalidate?: boolean;
}

function loadView<T>(el: HTMLElement, o: LoadOpts<T>): void {
  let shown = '';
  const show = (data: T) => {
    shown = JSON.stringify(data);
    el.setAttribute('aria-busy', 'false');
    o.render(data);
  };
  const fetchIt = (force: boolean) => (o.fetcher ? o.fetcher(force) : get<T>(o.path, { force }));
  const retry = () => loadView(el, o);

  const hit = peekEntry<T>(o.path);
  if (hit) {
    try {
      show(hit.data);
    } catch (e) {
      showError(el, e, retry);
      return;
    }
    if (o.revalidate !== false && hit.age > STALE_MS) {
      fetchIt(true)
        .then((fresh) => {
          if (JSON.stringify(fresh) !== shown) show(fresh);
        })
        .catch(() => {
          /* data lama sudah tampil dan valid; kegagalan validasi ulang tidak perlu mengganggu pengguna */
        });
    }
    return;
  }

  el.setAttribute('aria-busy', 'true');
  el.innerHTML = o.skeleton;
  fetchIt(false)
    .then(show)
    .catch((e) => showError(el, e, retry));
}

/* ----------------------------------------------------------------- search */

export function mountSearch(q: string): void {
  const el = appEl();
  if (!el) return;
  setTitle(q ? `Cari: ${q}` : 'Cari manga');
  if (!q) {
    el.setAttribute('aria-busy', 'false');
    el.innerHTML = `<div class="page-head"><h1>Cari manga</h1></div>
      <p class="empty">Ketik judul di kolom pencarian di atas untuk mulai mencari.</p>`;
    return;
  }
  loadView<Manga[]>(el, {
    path: paths.search(q),
    skeleton: `<div class="page-head" aria-hidden="true"><span class="sk sk-title"></span></div>${skelGrid(12)}${SR_LOADING}`,
    render: (results) => {
      el.innerHTML = `<div class="page-head"><h1>Hasil untuk “${esc(q)}”</h1>${
        results.length ? `<p class="muted">${results.length} judul ditemukan</p>` : ''
      }</div>${
        results.length
          ? gridHtml(results)
          : `<p class="empty">Tidak ada hasil untuk “${esc(q)}”. Coba kata kunci lain.</p>`
      }`;
      observeCards(el);
    },
  });
}

/* ----------------------------------------------------------- manga detail */

export function mountMangaDetail(slug: string): void {
  const el = appEl();
  if (!el) return;
  loadView<MangaInfo>(el, {
    path: paths.info(slug),
    skeleton: skelDetail(),
    render: (info) => {
      // Render ulang karena data berubah: pertahankan filter & posisi scroll daftar.
      const prevFilter = el.querySelector<HTMLInputElement>('[data-filter]')?.value ?? '';
      const prevScroll = el.querySelector<HTMLElement>('.chapter-list')?.scrollTop ?? 0;

      el.innerHTML = detailHtml(info);
      setTitle(info.title);
      wireChapterFilter(el, prevFilter);
      const list = el.querySelector<HTMLElement>('.chapter-list');
      if (list) list.scrollTop = prevScroll;

      // Halaman berikutnya yang paling mungkin dibuka: chapter pertama & terbaru.
      const chapters = info.chapter_list ?? [];
      if (chapters.length) {
        prefetchPath(paths.chapter(chapterSlug(chapters[chapters.length - 1].endpoint)), 'low');
        prefetchPath(paths.chapter(chapterSlug(chapters[0].endpoint)), 'low');
      }
    },
  });
}

function wireChapterFilter(el: HTMLElement, initial: string): void {
  const input = el.querySelector<HTMLInputElement>('[data-filter]');
  const items = Array.from(el.querySelectorAll<HTMLElement>('.chapter-list > li'));
  const empty = el.querySelector<HTMLElement>('[data-empty]');
  const count = el.querySelector<HTMLElement>('[data-count]');
  if (!input) return;

  const apply = () => {
    const q = input.value.trim().toLowerCase();
    let shown = 0;
    for (const li of items) {
      const ok = !q || (li.textContent ?? '').toLowerCase().includes(q);
      li.hidden = !ok;
      if (ok) shown++;
    }
    if (empty) empty.hidden = shown > 0;
    if (count) count.textContent = q ? `${shown} dari ${items.length} chapter` : `${items.length} chapter`;
  };
  input.addEventListener('input', apply);
  if (initial) {
    input.value = initial;
    apply();
  }
}

/* ----------------------------------------------------------------- reader */

export function mountChapter(slug: string): void {
  const el = appEl();
  if (!el) return;

  const mangaSlug = mangaSlugOfChapter(slug);
  const infoPath = mangaSlug ? paths.info(mangaSlug) : undefined;
  let info: MangaInfo | undefined = infoPath ? peek<MangaInfo>(infoPath) : undefined;
  let infoFailed = false;
  let chTitle = ''; // judul dari API chapter: cadangan bila nama chapter tak diketahui
  let ctx: ReaderCtx = { title: '', state: 'none' };
  const stepLinks: { prev?: string; next?: string } = {};

  /** Susun keadaan navigasi dari info manga (kalau sudah ada) + slug chapter ini. */
  const buildCtx = (): ReaderCtx => {
    if (!mangaSlug) return { title: chTitle, state: 'none' };
    const base: ReaderCtx = { title: chTitle, state: 'ready', back: mangaSlug };
    if (infoFailed) return base;
    if (!info) return { ...base, state: 'pending' };
    const list = info.chapter_list ?? [];
    const i = list.findIndex((c) => chapterSlug(c.endpoint).toLowerCase() === slug.toLowerCase());
    const step = (c?: { name: string; endpoint: string }) =>
      c ? { slug: chapterSlug(c.endpoint), name: c.name } : undefined;
    // chapter_list urut terbaru -> terlama: indeks lebih besar = chapter lebih awal.
    return i < 0
      ? { ...base, mangaTitle: info.title }
      : { ...base, mangaTitle: info.title, current: list[i].name, prev: step(list[i + 1]), next: step(list[i - 1]) };
  };

  /** Perbarui header + semua bar navigasi (dipanggil saat chapter selesai dirender dan saat info tiba). */
  const applyNav = () => {
    ctx = buildCtx();
    const put = (pos: string, html: string) => {
      const slot = el.querySelector(`[data-rnav-slot="${pos}"]`);
      if (slot) slot.innerHTML = html;
    };
    put('head', readerHeadHtml(ctx));
    put('top', readerNavHtml(ctx, 'top'));
    put('end', readerNavHtml(ctx, 'end'));
    put('fixed', readerNavHtml(ctx, 'fixed'));
    setTitle(ctx.mangaTitle ? `${ctx.mangaTitle} — ${readerTitle(ctx)}` : readerTitle(ctx));
    stepLinks.prev = el.querySelector<HTMLAnchorElement>('a[rel="prev"]')?.href;
    stepLinks.next = el.querySelector<HTMLAnchorElement>('a[rel="next"]')?.href;
    bar = el.querySelector<HTMLElement>('.fixbar');
    syncBar();
  };

  /* Bar bawah: sembunyi saat scroll turun, muncul saat scroll naik / di awal chapter / (disembunyikan) di akhir chapter. */
  let bar: HTMLElement | null = null;
  let lastY = window.scrollY;
  let scrollHidden = false;
  const syncBar = () => {
    if (!bar) return;
    const y = window.scrollY;
    const dy = y - lastY;
    if (Math.abs(dy) >= 4) {
      lastY = y; // akumulasi: scroll pelan tetap terdeteksi
      if (dy > 0) scrollHidden = true;
      else scrollHidden = false;
    }
    if (y < 80) scrollHidden = false;
    const atEnd = y + window.innerHeight >= document.documentElement.scrollHeight - 80; // nav akhir chapter sudah terlihat
    bar.classList.toggle('is-hidden', scrollHidden || atEnd);
  };

  // Info manga (untuk prev/next & nama chapter) dimuat PARALEL dengan chapter, bukan setelahnya.
  if (infoPath && !info) {
    get<MangaInfo>(infoPath)
      .then((i) => {
        info = i;
        applyNav();
      })
      .catch(() => {
        infoFailed = true; // hanya tombol kembali; prev/next dihilangkan, judul pakai judul API
        applyNav();
      });
  }

  loadView<ChapterDetail>(el, {
    path: paths.chapter(slug),
    skeleton: skelReader(),
    revalidate: false, // render ulang akan mereset posisi baca
    render: (ch) => {
      chTitle = ch.title;
      ctx = buildCtx();
      el.innerHTML = readerHtml(ch, ctx);
      applyNav();
    },
  });

  // Satu listener scroll (rAF-throttled): bar bawah + prefetch chapter berikutnya di ~50% halaman.
  let ticking = false;
  let prefetched = false;
  window.addEventListener(
    'scroll',
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        syncBar();
        if (!prefetched && ctx.next) {
          const doc = document.documentElement;
          const progress = (window.scrollY + window.innerHeight) / Math.max(1, doc.scrollHeight);
          if (progress > 0.5) {
            prefetched = true;
            prefetchPath(paths.chapter(ctx.next.slug), 'high');
          }
        }
      });
    },
    { passive: true },
  );
  // Fokus keyboard ke bar yang tersembunyi: tampilkan.
  el.addEventListener('focusin', (e) => {
    if (e.target instanceof Element && e.target.closest('.fixbar')) bar?.classList.remove('is-hidden');
  });

  // Pintasan keyboard: ← chapter sebelumnya, → berikutnya.
  document.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const href = e.key === 'ArrowLeft' ? stepLinks.prev : e.key === 'ArrowRight' ? stepLinks.next : undefined;
    if (href) location.assign(href);
  });
}

/* ---------------------------------------------------------------- listing */

const prettySlug = (s: string) =>
  s
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/** Jarak (px) di bawah viewport tempat halaman berikutnya mulai dimuat. */
const FEED_MARGIN = 800;

/** Halaman berturut-turut tanpa satu kartu baru pun dianggap akhir daftar (cegah scrape tanpa henti). */
const FEED_STALL_MAX = 3;

interface FeedOpts {
  /** `<ul class="grid">` yang sudah berisi halaman awal; halaman berikutnya ditambahkan ke sini. */
  grid: HTMLElement;
  /** Elemen di bawah grid: sentinel scroll sekaligus tempat status. */
  status: HTMLElement;
  /** Nomor halaman awal dan isinya (sudah ada di `grid`). */
  start: number;
  first: Manga[];
  pathFor: (page: number) => string;
  /** Jumlah halaman yang tercatat terakhir kali dimuat (back/reload); dipulihkan dari cache. */
  restore: number;
}

interface Feed {
  /** Jumlah halaman yang sudah tampil, termasuk halaman awal. */
  pages: () => number;
  /** Lepas observer. Setelah ini feed tidak menyentuh DOM lagi. */
  stop: () => void;
}

/**
 * Daftar tanpa akhir: saat sentinel mendekati viewport, halaman berikutnya
 * diambil (`get` -> cache, dedupe request, prefetch ikut terpakai) dan kartunya
 * ditambahkan ke grid yang sama lewat `insertAdjacentHTML` — DOM yang ada tidak
 * dibangun ulang, jadi posisi scroll tidak bergeser.
 *
 * Halaman ke-n selalu `start + loaded`, jadi tidak perlu penghitung terpisah.
 * Keadaan: idle (siap/tombol manual) -> loading -> idle | error | end. Hanya
 * satu request berjalan; error tidak diulang otomatis (tombol "Coba lagi").
 */
function startFeed(o: FeedOpts): Feed {
  const { grid, status, start, pathFor } = o;
  const seen = new Set<string>(); // endpoint: daftar upstream bisa bergeser antar halaman (mis. terbaru)
  for (const m of o.first) seen.add(m.endpoint);
  let loaded = 1;
  let stall = 0;
  let state: 'idle' | 'loading' | 'error' | 'end' = o.first.length < PAGE_SIZE ? 'end' : 'idle';
  let stopped = false;
  let io: IntersectionObserver | undefined;

  const paint = () => {
    status.dataset.state = state;
    status.innerHTML =
      state === 'loading'
        ? `<span class="feed-spinner" aria-hidden="true"></span><span>Memuat halaman ${start + loaded}…</span>`
        : state === 'error'
          ? '<p>Gagal memuat halaman berikutnya.</p><button type="button" class="btn" data-feed-retry>Coba lagi</button>'
          : state === 'end'
            ? '<p>Sudah sampai akhir daftar.</p>'
            : '<button type="button" class="btn" data-feed-more>Muat lagi</button>';
  };

  /** Tambahkan kartu yang belum pernah tampil; kembalikan jumlahnya. */
  const append = (list: Manga[]): number => {
    const items = list.filter((m) => {
      if (seen.has(m.endpoint)) return false;
      seen.add(m.endpoint);
      return true;
    });
    if (items.length) {
      grid.insertAdjacentHTML('beforeend', items.map((m) => `<li>${cardHtml(m)}</li>`).join(''));
      observeCards(grid);
    }
    return items.length;
  };

  /** Catat jumlah halaman di entri history (URL tidak berubah) agar back/reload bisa memulihkannya. */
  const record = () => {
    try {
      history.replaceState({ ...history.state, feedPages: loaded }, '');
    } catch {
      /* history tidak bisa ditulis: pemulihan saja yang hilang */
    }
  };

  /** Halaman `loaded` baru saja tampil (`added` kartu baru): akhir daftar atau masih ada lagi? */
  const advance = (list: Manga[], added: number) => {
    stall = added ? 0 : stall + 1;
    state = list.length < PAGE_SIZE || stall >= FEED_STALL_MAX ? 'end' : 'idle';
  };

  /** Tampilkan keadaan sekarang; bila masih ada halaman, hangatkan berikutnya dan minta IO menilai ulang. */
  const settle = () => {
    paint();
    if (state === 'end') {
      io?.disconnect();
      return;
    }
    prefetchPath(pathFor(start + loaded), 'low');
    // IO tidak menembak lagi bila sentinel tidak pernah keluar dari zona (halaman penuh duplikat,
    // layar tinggi). Observe ulang mengirim entri awal baru, sehingga muat berlanjut sampai zona terisi.
    if (io) {
      io.unobserve(status);
      io.observe(status);
    }
  };

  const load = async () => {
    if (stopped || state === 'loading' || state === 'end') return;
    const n = start + loaded;
    state = 'loading';
    paint();
    let list: Manga[];
    try {
      // Melewati halaman terakhir, API menjawab 404: itu "habis", bukan error.
      list = await get<Manga[]>(pathFor(n)).catch((e) => {
        if (e instanceof ApiError && e.code === 404) return [] as Manga[];
        throw e;
      });
    } catch {
      if (stopped) return;
      state = 'error';
      io?.unobserve(status); // tanpa percobaan ulang otomatis; lanjut hanya lewat tombol
      paint();
      return;
    }
    if (stopped) return;
    if (list.length) {
      loaded++;
      advance(list, append(list));
      record();
      settle();
    } else {
      state = 'end';
      paint();
      io?.disconnect();
    }
  };

  // Pulihkan halaman yang tadinya sudah dimuat, hanya dari cache dan sinkron, supaya
  // restorasi scroll browser mendarat di tempat yang benar. Berhenti di halaman pertama yang tidak ada di cache.
  while (state === 'idle' && loaded < o.restore) {
    const cached = peek<Manga[]>(pathFor(start + loaded));
    if (!cached?.length) break;
    loaded++;
    advance(cached, append(cached));
  }
  if (o.restore > 1) record();

  if (typeof IntersectionObserver !== 'undefined' && state === 'idle') {
    io = new IntersectionObserver(
      (entries) => {
        if (state === 'idle' && entries.some((e) => e.isIntersecting)) void load();
      },
      { rootMargin: `0px 0px ${FEED_MARGIN}px 0px` },
    );
  }
  settle(); // tanpa IO: tombol "Muat lagi" jadi satu-satunya pemicu

  status.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('[data-feed-more], [data-feed-retry]')) void load();
  });

  return {
    pages: () => loaded,
    stop: () => {
      stopped = true;
      io?.disconnect();
    },
  };
}

export function mountListing(route: Extract<Route, { kind: 'genre' | 'popular' | 'newest' }>): void {
  const el = appEl();
  if (!el) return;
  const { page } = route;

  let pathFor: (p: number) => string;
  let knownTitle: string | undefined;
  let title: string;
  let hrefFor: (p: number) => string;
  if (route.kind === 'genre') {
    pathFor = (p) => paths.byGenre(route.slug, p);
    // Judul asli dari daftar genre bila sudah ada di cache; kalau belum, rapikan slug-nya.
    knownTitle = peek<Genre[]>(paths.genres())?.find((g) => chapterSlug(g.endpoint) === route.slug)?.title;
    title = `Genre: ${knownTitle ?? prettySlug(route.slug)}`;
    hrefFor = (p) => genreHref(route.slug, p);
  } else if (route.kind === 'popular') {
    pathFor = paths.popular;
    title = 'Manga Populer';
    hrefFor = (p) => listHref('populer', p);
  } else {
    pathFor = paths.newest;
    title = 'Rilis Terbaru';
    hrefFor = (p) => listHref('terbaru', p);
  }
  const path = pathFor(page);
  setTitle(page > 1 ? `${title} (halaman ${page})` : title);

  // Entri history ini mungkin mencatat berapa halaman yang sempat dimuat (back/reload).
  const recorded = Number((history.state as { feedPages?: unknown } | null)?.feedPages);
  let feed: Feed | undefined;

  loadView<Manga[]>(el, {
    path,
    // Melewati halaman terakhir, API menjawab 404: itu "habis", bukan error.
    fetcher: (force) =>
      get<Manga[]>(path, { force }).catch((e) => {
        if (e instanceof ApiError && e.code === 404 && page > 1) return [] as Manga[];
        throw e;
      }),
    skeleton: skelListing(),
    render: (list) => {
      // Validasi ulang di latar belakang memanggil render lagi. Bila pengguna sudah menambah halaman,
      // jangan timpa: feed terhapus dan scroll melompat. Selama baru halaman awal, render ulang aman.
      if (feed && feed.pages() > 1) return;
      feed?.stop();
      feed = undefined;

      const head = `<div class="page-head"><h1>${esc(title)}</h1>${
        page > 1
          ? `<p class="muted">Mulai dari halaman ${page} · <a href="${esc(hrefFor(page - 1))}">halaman sebelumnya</a></p>`
          : ''
      }</div>`;
      el.innerHTML = list.length
        ? `${head}${gridHtml(list)}<div class="feed-status" aria-live="polite"></div>`
        : `${head}<p class="empty">Tidak ada data lagi di halaman ini.</p>`;
      observeCards(el);

      const grid = el.querySelector<HTMLElement>('.grid');
      const status = el.querySelector<HTMLElement>('.feed-status');
      if (grid && status) {
        feed = startFeed({
          grid,
          status,
          start: page,
          first: list,
          pathFor,
          restore: Number.isFinite(recorded) ? recorded : 1,
        });
      }

      if (route.kind === 'genre' && !knownTitle) {
        // Daftar genre belum ada di cache: ambil, lalu ganti judul hasil rapikan-slug dengan nama aslinya.
        get<Genre[]>(paths.genres())
          .then((all) => {
            const g = all.find((x) => chapterSlug(x.endpoint) === route.slug);
            const h1 = el.querySelector('h1');
            if (g && h1) {
              h1.textContent = `Genre: ${g.title}`;
              setTitle(page > 1 ? `Genre: ${g.title} (halaman ${page})` : `Genre: ${g.title}`);
            }
          })
          .catch(() => {});
      }
    },
  });
}

/* ------------------------------------------------------------------- home */

interface HomeSection {
  key: string;
  path: string;
  render: (data: never) => string;
  skeleton: string;
}

const HOME_SECTIONS: HomeSection[] = [
  { key: 'popular', path: paths.popular(1), render: railHtml, skeleton: skelRail() },
  { key: 'recommended', path: paths.recommended(1), render: gridHtml, skeleton: skelGrid(12) },
  { key: 'newest', path: paths.newest(1), render: gridHtml, skeleton: skelGrid(12) },
  { key: 'genre', path: paths.genres(), render: genreCloud, skeleton: skelChips() },
];

/**
 * Beranda sudah berisi data hasil prerender (build time). Di sini kita ambil
 * data terbaru di latar belakang dan menukar isi section HANYA bila berbeda
 * (`data-sig`). Markup identik, jadi tidak ada layout jump. Section yang gagal
 * di-prerender (`data-sig` kosong) menampilkan skeleton lalu diisi di sini.
 */
export function mountHome(): void {
  for (const sec of HOME_SECTIONS) {
    const body = document.querySelector<HTMLElement>(`[data-sec="${sec.key}"] [data-body]`);
    if (!body) continue;

    const apply = (data: unknown) => {
      body.setAttribute('aria-busy', 'false');
      const s = sig(data);
      if (body.dataset.sig === s) return;
      body.innerHTML = sec.render(data as never);
      body.dataset.sig = s;
      observeCards(body);
    };

    const fail = (e: unknown) => {
      if (body.dataset.sig) return; // data lama masih tampil dan valid
      showError(body, e, () => {
        body.setAttribute('aria-busy', 'true');
        body.innerHTML = sec.skeleton + SR_LOADING;
        refresh();
      });
    };

    const refresh = () => {
      get<unknown>(sec.path, { force: true }).then(apply).catch(fail);
    };

    const hit = peekEntry<unknown>(sec.path);
    if (hit) {
      apply(hit.data);
      if (hit.age <= STALE_MS) continue;
    }
    refresh();
  }

  // "Semua genre": handler delegated supaya tetap jalan setelah section ditukar.
  document.querySelector('[data-sec="genre"]')?.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest<HTMLButtonElement>('[data-more-genres]') : null;
    if (!btn) return;
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.closest('[data-body]')
      ?.querySelectorAll<HTMLElement>('[data-more]')
      .forEach((li) => (li.hidden = !open));
    btn.setAttribute('aria-expanded', String(open));
    btn.textContent = open ? 'Tampilkan lebih sedikit' : `Semua genre (${btn.closest('[data-body]')?.querySelectorAll('.chip').length ?? ''})`;
  });

  // Tombol geser baris Populer (untuk mouse tanpa trackpad).
  document.querySelectorAll<HTMLButtonElement>('[data-rail-btn]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const rail = document.querySelector<HTMLElement>('[data-sec="popular"] .rail');
      if (!rail) return;
      const dir = btn.dataset.railBtn === 'next' ? 1 : -1;
      rail.scrollBy({ left: dir * rail.clientWidth * 0.85, behavior: 'smooth' });
    });
  });
}

/* -------------------------------------------------------------- not found */

export function mountUnknown(): void {
  const el = appEl();
  if (!el) return;
  el.setAttribute('aria-busy', 'false');
  setTitle('Halaman tidak ditemukan');
  el.innerHTML = `<div class="notice"><p class="notice-title">Halaman tidak ditemukan</p>
    <p>Alamat yang kamu buka tidak dikenal.</p><a class="btn btn-primary" href="/">Kembali ke beranda</a></div>`;
}
