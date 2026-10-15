/**
 * Reader chapter (`/chapter/<slug>/`): satu atau beberapa chapter berurutan dalam satu halaman.
 *
 * Model: `sections` = chapter yang ada di DOM (urut ke bawah, maksimum MAX_SECTIONS); `current` = yang
 * sedang dibaca (halaman pertamanya sudah melewati garis baca di 30% tinggi layar). Semua yang bergantung
 * pada "chapter yang sedang dibaca" — URL, judul tab, header, bar navigasi, penunjuk halaman, target
 * keyboard — diperbarui di `enter()`. Slot di bawah chapter terakhir (`[data-append-slot]`) mengurus
 * chapter berikutnya: tautan manual, memuat, galat, atau navigasi akhir klasik.
 *
 * Manga induk TIDAK bisa ditebak dari slug chapter. Sumber utama: `manga_endpoint`/`prev_endpoint`/
 * `next_endpoint` dari API chapter; tebakan dari slug (API lama) baru dipercaya setelah info manga
 * ternyata memuat chapter ini. Logika murninya ada di readerlogic.ts (diuji di Node).
 */
import { get, paths, peek, type ChapterDetail, type MangaInfo } from './api';
import { chapterHref } from './routes';
import { getHistory, getProgress, markChapterRead, saveProgress } from './library';
import { appEl, setTitle } from './page';
import { prefetchAllowed, prefetchPath } from './prefetch';
import { showError } from './errorstate';
import { loadView } from './client';
import { skelReader } from './views';
import {
  MAX_SECTIONS,
  currentPage,
  eqSlug,
  fractionRead,
  initialPages,
  listHasChapter,
  listName,
  mangaRefOf,
  nameFromSlug,
  nearEnd,
  parseAutoNext,
  parsePageHash,
  resolveSteps,
  resumeTarget,
  scrollCompensation,
  sectionAt,
  sectionsToDrop,
  type MangaRef,
  type Rect,
  type Step,
} from './readerlogic';
import {
  chapterSectionHtml,
  readerHeadHtml,
  readerNavHtml,
  readerShellHtml,
  readerTitle,
  slotHtml,
  type ReaderCtx,
  type SlotState,
} from './readerview';
import { createImageLoader, warmImages } from './readerimg';
import { showResumeToast, startResume, type ResumeHandle } from './readerresume';
import { mountReaderChrome } from './readerui';

const AUTONEXT_KEY = 'mr:reader:autonext';
/** Garis baca: halaman yang melewatinya dianggap sedang dibaca. */
const LINE = 0.3;
/** Simpan posisi paling sering sekali per detik. */
const SAVE_EVERY_MS = 1000;
/** Bagian chapter yang dibaca sebelum JSON chapter berikutnya dipanaskan, lalu gambar-gambar pertamanya. */
const PREFETCH_AT = 0.5;
const WARM_AT = 0.7;

const readAutoNext = (): boolean => {
  try {
    return parseAutoNext(localStorage.getItem(AUTONEXT_KEY));
  } catch {
    return true;
  }
};

const writeAutoNext = (on: boolean): void => {
  try {
    localStorage.setItem(AUTONEXT_KEY, on ? '1' : '0');
  } catch {
    /* storage penuh/diblokir: pilihan hanya berlaku selama halaman ini terbuka */
  }
};

interface Section {
  slug: string;
  ch: ChapterDetail;
  el: HTMLElement;
  /** `.pages`: atasnya = atas halaman pertama. */
  pagesEl: HTMLElement;
  pages: HTMLImageElement[];
  readMarked: boolean;
  prefetched: boolean;
  warmed: boolean;
}

const adopt = (el: HTMLElement, slug: string, ch: ChapterDetail): Section => ({
  slug,
  ch,
  el,
  pagesEl: el.querySelector<HTMLElement>('.pages') ?? el,
  pages: [...el.querySelectorAll<HTMLImageElement>('img.page')],
  readMarked: false,
  prefetched: false,
  warmed: false,
});

/** Kotak halaman ke-i; gambar yang gagal dimuat disembunyikan, jadi tombol coba lagi-nya yang dipakai. */
function pageBox(s: Section, i: number): HTMLElement | undefined {
  const img = s.pages[i];
  if (!img) return undefined;
  const retry = img.classList.contains('is-broken') ? img.nextElementSibling : null;
  return retry instanceof HTMLElement ? retry : img;
}

const rectOf = (s: Section) => (i: number): Rect => {
  const r = pageBox(s, i)?.getBoundingClientRect();
  return { top: r?.top ?? 0, height: r?.height ?? 0 };
};

export function mountChapter(slug: string): void {
  const host = appEl();
  if (!host) return;
  const el: HTMLElement = host; // fungsi bersarang di bawah tidak mewarisi penyempitan tipe `const`
  try {
    history.scrollRestoration = 'manual'; // posisi dipulihkan reader sendiri (lanjut baca), bukan browser
  } catch {
    /* tidak bisa diatur: browser memulihkan sendiri, reader tetap menimpanya */
  }

  const loader = createImageLoader();
  const sections: Section[] = [];
  let current = 0;
  let pos = { index: 0, offset: 0 };
  let autoNext = readAutoNext();
  let manga: MangaRef = mangaRefOf({}, slug);
  let resume: ResumeHandle | undefined;

  /* ------------------------------------------------------------ info manga */

  const infos = new Map<string, MangaInfo>();
  const asked = new Set<string>();
  const failed = new Set<string>();
  const info = (): MangaInfo | undefined => (manga.slug ? infos.get(manga.slug) : undefined);

  /** Ambil info sebuah manga sekali; paralel dengan chapter (tebakan) atau setelah chapter tiba (slug asli). */
  const wantInfo = (m: string | undefined): void => {
    if (!m || asked.has(m)) return;
    asked.add(m);
    const hit = peek<MangaInfo>(paths.info(m));
    if (hit) {
      infos.set(m, hit);
      return;
    }
    get<MangaInfo>(paths.info(m))
      .then((i) => infos.set(m, i))
      .catch(() => failed.add(m))
      .finally(() => onInfo(m));
  };

  const nameFor = (s: Pick<Section, 'slug' | 'ch'>): string =>
    listName(info()?.chapter_list, s.slug) ?? (s.ch.title || nameFromSlug(s.slug));

  /** Tebakan slug manga menjadi pasti bila daftar chapter-nya memuat chapter ini. */
  const confirm = (): void => {
    const list = info()?.chapter_list;
    if (!manga.confirmed && list && listHasChapter(list, slug)) manga = { ...manga, confirmed: true };
  };

  /** Keadaan navigasi untuk sebuah chapter. */
  const ctxFor = (s: Pick<Section, 'slug' | 'ch'>): ReaderCtx => {
    const base = { title: s.ch.title, autoNext };
    if (!manga.slug) return { ...base, state: 'none' };
    if (!manga.confirmed) {
      // Tebakan (API lama): tunggu info. Gagal / chapter tak ada di daftarnya = bukan manga ini.
      return !info() && !failed.has(manga.slug) ? { ...base, state: 'pending', back: manga.slug } : { ...base, state: 'none' };
    }
    const i = info();
    const steps = resolveSteps(s.slug, s.ch, i?.chapter_list);
    return {
      ...base,
      state: 'ready',
      back: manga.slug,
      mangaTitle: s.ch.manga_title || i?.title || undefined,
      cover: i?.thumbnail || undefined,
      current: listName(i?.chapter_list, s.slug),
      prev: steps.prev,
      next: steps.next,
      latest: steps.latest,
    };
  };

  /* ---------------------------------------------------------------- navigasi */

  let stepLinks: { prev?: string; next?: string } = {};
  let shown = ''; // teks penunjuk halaman yang sedang tampil
  let slotState: SlotState | 'error' = 'idle';
  let slotNext: Step | undefined; // chapter setelah chapter terakhir yang dimuat

  const slotFor = (c: ReaderCtx): SlotState => (!c.next ? 'end' : autoNext && c.state === 'ready' ? 'idle' : 'off');

  const slotEl = (): HTMLElement | null => el.querySelector<HTMLElement>('[data-append-slot]');

  /** Isi slot bawah dari chapter terakhir; keadaan memuat/galat dimiliki alur append. */
  const settleSlot = (): void => {
    if (slotState === 'loading' || slotState === 'error') return;
    const c = ctxFor(sections[sections.length - 1]);
    slotNext = c.next;
    slotState = slotFor(c);
    const slot = slotEl();
    if (!slot) return;
    slot.dataset.state = slotState;
    slot.innerHTML = slotHtml(slotState, c);
  };

  const paintProgress = (): void => {
    const s = sections[current];
    if (!s?.pages.length) return;
    const text = `${pos.index + 1} / ${s.pages.length}`;
    if (text === shown) return;
    shown = text;
    el.querySelectorAll('[data-read-progress]').forEach((n) => (n.textContent = text));
  };

  /** Judul tab, tautan keyboard, dan penunjuk halaman mengikuti chapter yang sedang dibaca. */
  const afterNav = (c: ReaderCtx): void => {
    setTitle(c.mangaTitle ? `${c.mangaTitle} — ${readerTitle(c)}` : readerTitle(c));
    stepLinks = {
      prev: c.prev ? chapterHref(c.prev.slug) : undefined,
      next: c.next ? chapterHref(c.next.slug) : undefined,
    };
    shown = '';
    paintProgress();
  };

  /** Header + bar atas/bawah dari chapter yang sedang dibaca, lalu slot bawah. */
  const applyNav = (): void => {
    const c = ctxFor(sections[current]);
    const put = (name: string, html: string) => {
      const slot = el.querySelector(`[data-rnav-slot="${name}"]`);
      if (slot) slot.innerHTML = html;
    };
    put('head', readerHeadHtml(c));
    put('top', readerNavHtml(c, 'top'));
    put('fixed', readerNavHtml(c, 'fixed'));
    afterNav(c);
    settleSlot();
  };

  /** Info manga tiba (atau gagal): nama chapter, tebakan slug, navigasi, dan posisi tersimpan ikut diperbarui. */
  function onInfo(m: string): void {
    if (m !== manga.slug || !sections.length) return;
    confirm();
    for (const s of sections) {
      s.el.dataset.chapterName = nameFor(s);
      const label = s.el.querySelector('.chapter-divider-name');
      if (label) label.textContent = nameFor(s);
    }
    applyNav();
    scheduleSave();
    measure();
  }

  /* ------------------------------------------------------------- pustaka */

  let saveTimer = 0;
  let lastSave = 0;

  /** Catat posisi baca. Ditahan selama lanjut-baca belum selesai (posisi awal akan menimpa posisi lama). */
  function saveNow(): void {
    window.clearTimeout(saveTimer);
    saveTimer = 0;
    const s = sections[current];
    if (!s || resume?.active() || !manga.confirmed || !manga.slug) return;
    const i = info();
    const title = s.ch.manga_title || i?.title;
    if (!title) return; // judul manga belum diketahui; disusul begitu info tiba
    const prior = getProgress(manga.slug);
    saveProgress({
      manga: { slug: manga.slug, title, cover: i?.thumbnail ?? prior?.cover ?? '', type: i?.type ?? prior?.type },
      chapter: { slug: s.slug, name: nameFor(s) },
      page: pos.index,
      pageCount: s.pages.length,
      offset: pos.offset,
    });
    lastSave = Date.now();
  }

  function scheduleSave(): void {
    if (saveTimer) return;
    saveTimer = window.setTimeout(saveNow, Math.max(0, SAVE_EVERY_MS - (Date.now() - lastSave)));
  }

  /* ------------------------------------------------------- posisi & chapter */

  /** Pindah ke chapter yang kini sedang dibaca: URL, judul, navigasi, dan penanda baca. */
  function enter(at: number): void {
    const prev = sections[current];
    if (at > current && prev && manga.confirmed && manga.slug) {
      markChapterRead(manga.slug, prev.slug); // lanjut ke chapter berikutnya = chapter sebelumnya selesai
      prev.readMarked = true;
    }
    current = at;
    pos = { index: 0, offset: 0 };
    try {
      history.replaceState(history.state, '', chapterHref(sections[at].slug));
    } catch {
      /* URL tidak bisa diganti: hanya tampilan yang tetap benar */
    }
    applyNav();
    scheduleSave();
  }

  let lastSig = '';

  /** Dipanggil (rAF) tiap scroll/resize/gambar dimuat: chapter & halaman yang dibaca, serta pemicu lain. */
  function measure(): void {
    if (!sections.length) return;
    const line = window.innerHeight * LINE;
    const at = sectionAt(
      sections.map((s) => s.pagesEl.getBoundingClientRect().top),
      line,
    );
    if (at !== current) enter(at);
    const s = sections[current];
    pos = currentPage(s.pages.length, rectOf(s), line);
    paintProgress();

    const sig = `${current}:${pos.index}:${pos.offset.toFixed(2)}`;
    if (sig !== lastSig) {
      lastSig = sig;
      scheduleSave();
    }
    if (s.pages.length && pos.index === s.pages.length - 1 && !s.readMarked && !resume?.active() && manga.confirmed && manga.slug) {
      saveNow();
      markChapterRead(manga.slug, s.slug);
      s.readMarked = true;
    }

    const isLast = current === sections.length - 1;
    if (isLast && slotNext) {
      const frac = fractionRead(pos.index, pos.offset, s.pages.length);
      if (frac >= PREFETCH_AT && !s.prefetched) {
        s.prefetched = true;
        prefetchPath(paths.chapter(slotNext.slug), 'high');
      }
      if (frac >= WARM_AT && !s.warmed) {
        s.warmed = true;
        warmNext(slotNext.slug);
      }
    }
    if (slotState === 'idle' && autoNext && nearEnd(sections[sections.length - 1].el.getBoundingClientRect().bottom, window.innerHeight)) {
      appendNext();
    }
    trim();
  }

  /** Hangatkan gambar-gambar pertama chapter berikutnya (JSON-nya sudah/ sedang diprefetch). */
  function warmNext(next: string): void {
    if (!prefetchAllowed()) return;
    get<ChapterDetail>(paths.chapter(next))
      .then((ch) => warmImages(next, ch.image))
      .catch(() => {
        /* pemanasan hanyalah bonus */
      });
  }

  /** Buang chapter tertua yang sudah seluruhnya di atas layar; posisi baca dijaga tetap (tanpa lompatan terlihat). */
  function trim(): void {
    if (sections.length <= MAX_SECTIONS) return;
    const n = sectionsToDrop(
      sections.map((s) => ({ bottom: s.el.getBoundingClientRect().bottom })),
      current,
    );
    if (!n) return;
    const anchor = sections[n].el;
    const root = document.documentElement;
    root.classList.add('is-trimming'); // matikan scroll anchoring browser selama ini: kompensasinya kita yang hitung
    const before = anchor.getBoundingClientRect().top;
    for (const s of sections.splice(0, n)) {
      loader.forget(s.pages);
      s.el.remove();
    }
    current -= n;
    const delta = scrollCompensation(before, anchor.getBoundingClientRect().top);
    if (delta) window.scrollBy({ top: delta, behavior: 'instant' });
    requestAnimationFrame(() => root.classList.remove('is-trimming'));
  }

  /* ---------------------------------------------------- chapter berikutnya */

  function addSection(next: Step, ch: ChapterDetail): void {
    const holder = el.querySelector<HTMLElement>('[data-chapters]');
    if (!holder) return;
    const name = nameFor({ slug: next.slug, ch });
    holder.insertAdjacentHTML(
      'beforeend',
      chapterSectionHtml({ slug: next.slug, name, images: ch.image, eager: initialPages(ch.image.length), divider: true }),
    );
    const sectionEl = holder.lastElementChild;
    if (!(sectionEl instanceof HTMLElement)) return;
    const sec = adopt(sectionEl, next.slug, ch);
    sections.push(sec);
    loader.observe(sec.pages);
  }

  let appending = false;

  function appendNext(): void {
    const next = slotNext;
    if (appending || !next || slotState !== 'idle') return;
    appending = true;
    slotState = 'loading';
    const slot = slotEl();
    if (slot) {
      slot.dataset.state = 'loading';
      slot.innerHTML = slotHtml('loading', ctxFor(sections[sections.length - 1]));
    }
    get<ChapterDetail>(paths.chapter(next.slug))
      .then((ch) => {
        appending = false;
        slotState = 'idle';
        if (autoNext) addSection(next, ch); // dimatikan sambil menunggu: chapter sudah di cache, tautan "berikutnya" instan
        settleSlot();
        measure();
      })
      .catch((e: unknown) => {
        appending = false;
        slotState = 'error';
        const target = slotEl();
        if (!target) return;
        target.dataset.state = 'error';
        showError(target, e, retryAppend, true);
      });
  }

  function retryAppend(): void {
    slotState = 'idle';
    if (autoNext) appendNext();
    else settleSlot();
  }

  /* ------------------------------------------------------------------ render */

  const resumeDone = (): void => {
    try {
      if (location.hash) history.replaceState(history.state, '', location.pathname + location.search); // `#p<N>` sudah terpakai
    } catch {
      /* hash tertinggal: tidak berbahaya */
    }
    measure();
    scheduleSave();
  };

  const render = (ch: ChapterDetail): void => {
    if (sections.length) return;
    manga = mangaRefOf(ch, slug);
    wantInfo(manga.slug);
    confirm();

    const count = ch.image.length;
    const saved = getHistory().find((p) => eqSlug(p.chapter.slug, slug));
    const target = resumeTarget({
      hash: location.hash,
      pageCount: count,
      stored: saved && { page: saved.page, offset: saved.offset },
    });
    const first = { slug, ch };
    const c = ctxFor(first);
    slotNext = c.next;
    slotState = slotFor(c);
    el.innerHTML = readerShellHtml({
      ctx: c,
      sections: chapterSectionHtml({
        slug,
        name: nameFor(first),
        images: ch.image,
        eager: initialPages(count, target?.index),
        priority: target?.index ?? 0,
      }),
      slot: slotHtml(slotState, c),
      slotState,
    });
    const sectionEl = el.querySelector<HTMLElement>('section.chapter');
    if (!sectionEl) return;
    const sec = adopt(sectionEl, slug, ch);
    sections.push(sec);
    afterNav(c);

    if (target) {
      resume = startResume({
        root: el,
        target,
        pageEl: () => pageBox(sec, target.index),
        affects: (img) => img.closest('section.chapter') === sec.el && Number(img.dataset.page) - 1 <= target.index,
        line: () => window.innerHeight * LINE,
        onDone: resumeDone,
      });
      showResumeToast(el, target.index, () => window.scrollTo({ top: 0, behavior: 'instant' }));
    }
    loader.observe(sec.pages); // setelah lompat: kalau tidak, halaman 1-3 ikut dimuat padahal di luar layar
    measure();
  };

  /* ---------------------------------------------------------------- pemicu */

  // Info manga dimuat PARALEL dengan chapter. Selama slug asli belum diketahui, tebakan dari slug chapter
  // yang dicoba (hanya bila JSON chapter belum di cache); hasilnya baru dipakai bila chapter ini ada di daftarnya.
  if (!peek<ChapterDetail>(paths.chapter(slug))) wantInfo(manga.slug);

  loadView<ChapterDetail>(el, {
    path: paths.chapter(slug),
    skeleton: skelReader(),
    revalidate: false, // render ulang akan mereset posisi baca
    render,
  });

  let ticking = false;
  const tick = (): void => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      measure();
    });
  };
  window.addEventListener('scroll', tick, { passive: true });
  window.addEventListener('resize', tick);
  // Gambar yang selesai dimuat mengubah tinggi halaman (placeholder -> ukuran asli): ukur ulang.
  document.addEventListener(
    'load',
    (e) => {
      if (e.target instanceof HTMLImageElement && e.target.classList.contains('page')) tick();
    },
    true,
  );

  const flush = (): void => {
    measure();
    saveNow();
  };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  window.addEventListener('hashchange', () => {
    const i = parsePageHash(location.hash);
    const s = sections[current];
    if (i !== undefined && s) pageBox(s, Math.min(i, s.pages.length - 1))?.scrollIntoView({ block: 'start', behavior: 'instant' });
  });

  el.addEventListener('click', (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('[data-autonext-toggle]')) return;
    autoNext = !autoNext;
    writeAutoNext(autoNext);
    el.querySelectorAll('[data-autonext-toggle]').forEach((b) => b.setAttribute('aria-pressed', String(autoNext)));
    if (slotState === 'error') slotState = 'idle'; // pilihan baru menggantikan galat sebelumnya
    settleSlot();
    measure();
  });

  mountReaderChrome(el); // bar atas/bawah: sembunyi saat gulir turun, tampil saat gulir naik atau diketuk

  // Pintasan keyboard: ← chapter sebelumnya, → berikutnya (dari chapter yang sedang dibaca).
  document.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const href = e.key === 'ArrowLeft' ? stepLinks.prev : e.key === 'ArrowRight' ? stepLinks.next : undefined;
    if (href) location.assign(href);
  });
}
