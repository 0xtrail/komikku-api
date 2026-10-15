/**
 * Pustaka pribadi di localStorage: bookmark, riwayat baca, dan posisi terakhir
 * (chapter + halaman di dalam chapter). Per browser, tanpa akun.
 *
 * Satu kunci (`mr:lib:v1`) berisi seluruh data. Salinan kerja ada di memori
 * (`state`), jadi membaca tidak menyentuh storage dan `saveProgress` (dipanggil
 * sering oleh reader) hanya satu `setItem`. Storage dibaca ulang hanya saat
 * event `storage` dari tab lain atau saat halaman dipulihkan dari bfcache.
 *
 * ATURAN: modul ini tidak boleh menyentuh `window`/`localStorage` saat di-import —
 * `views.ts` (yang diimpor di Node saat build) hanya mengimpor TIPE-nya. Semua
 * akses storage dibungkus try/catch; kalau storage tak tersedia atau melempar,
 * data tetap hidup di memori untuk sesi ini. Modul sengaja tanpa import dan hanya
 * memakai sintaks TypeScript yang bisa di-strip (agar bisa diuji langsung di Node).
 */

export interface MangaMeta {
  /** Slug manga seperti di `/manga/<slug>/`. */
  slug: string;
  title: string;
  cover: string;
  type?: string;
}

export interface Bookmark extends MangaMeta {
  addedAt: number;
}

export interface ChapterMark {
  slug: string;
  name: string;
}

export interface Progress extends MangaMeta {
  chapter: ChapterMark;
  /** Indeks 0-based gambar halaman yang sedang dibaca. */
  page: number;
  pageCount: number;
  /** 0..1: posisi vertikal di dalam halaman itu. */
  offset: number;
  updatedAt: number;
  /** Slug chapter (huruf kecil) yang sudah dibuka; yang terbaru di akhir. */
  read: string[];
}

export interface ProgressInput {
  manga: MangaMeta;
  chapter: ChapterMark;
  page: number;
  pageCount: number;
  offset: number;
}

const KEY = 'mr:lib:v1';
const BACKUP_KEY = 'mr:lib:v1:corrupt';

/** Riwayat tertua dibuang bila melewati batas ini. */
export const HISTORY_MAX = 300;
/** Chapter terlama dibuang dari `read` bila melewati batas ini. */
export const READ_MAX = 2000;

interface State {
  bookmarks: Map<string, Bookmark>;
  progress: Map<string, Progress>;
}

/** Salinan kerja; `undefined` = belum dibaca / harus dibaca ulang dari storage. */
let state: State | undefined;

const emptyState = (): State => ({ bookmarks: new Map(), progress: new Map() });

/** localStorage bisa melempar (diblokir) atau tidak ada (build Node). */
function ls(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------- validation */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.length <= max ? v : undefined;

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Cap waktu (ms) yang masih bisa jadi `Date` valid: `toISOString()` melempar di luar rentang ini. */
const stamp = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n >= 0 && n <= 8.64e15 ? n : undefined;
};

const nat = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
};

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Sampul: kosong, URL http(s) atau path situs. Skema lain (javascript:, data:) ditolak. */
const isCover = (v: string): boolean => v.length <= 2048 && (v === '' || /^(https?:\/\/|\/)/i.test(v));

/** Slug chapter dibandingkan tanpa membedakan huruf besar/kecil. */
const norm = (s: string): string => s.toLowerCase();

function parseMeta(v: Record<string, unknown>): MangaMeta | undefined {
  const slug = str(v.slug, 200);
  const title = str(v.title, 300);
  const cover = str(v.cover, 2048);
  if (!slug || !title || cover === undefined || !isCover(cover)) return undefined;
  if (v.type === undefined) return { slug, title, cover };
  const type = str(v.type, 24);
  return type === undefined ? undefined : { slug, title, cover, type };
}

function parseBookmark(v: unknown, slug: string): Bookmark | undefined {
  if (!isObj(v) || v.slug !== slug) return undefined;
  const meta = parseMeta(v);
  const addedAt = stamp(v.addedAt);
  return meta && addedAt !== undefined ? { ...meta, addedAt } : undefined;
}

function parseProgress(v: unknown, slug: string): Progress | undefined {
  if (!isObj(v) || v.slug !== slug || !isObj(v.chapter) || !Array.isArray(v.read)) return undefined;
  const meta = parseMeta(v);
  const chSlug = str(v.chapter.slug, 200);
  const chName = str(v.chapter.name, 300);
  const page = nat(v.page);
  const pageCount = nat(v.pageCount);
  const offset = num(v.offset);
  const updatedAt = stamp(v.updatedAt);
  if (!meta || !chSlug || chName === undefined) return undefined;
  if (page === undefined || pageCount === undefined || offset === undefined || updatedAt === undefined) return undefined;
  const read: string[] = [];
  for (const r of v.read) {
    const s = str(r, 200);
    if (!s) return undefined;
    read.push(norm(s));
  }
  return {
    ...meta,
    chapter: { slug: chSlug, name: chName },
    page,
    pageCount,
    offset: clamp01(offset),
    updatedAt,
    read: capRead([...new Set(read)]),
  };
}

/**
 * Data mentah -> State. `strict` (impor): bentuk salah atau SATU entri tidak valid
 * melempar Error ramah, tanpa mengubah apa pun. Longgar (baca storage): entri rusak dibuang.
 */
function parseState(data: unknown, strict: boolean): State {
  if (!isObj(data) || !isObj(data.bookmarks) || !isObj(data.progress)) {
    throw new Error('Berkas ini bukan data pustaka Panel.');
  }
  if (data.v !== 1) throw new Error('Versi data pustaka tidak didukung.');
  const out = emptyState();
  for (const [slug, raw] of Object.entries(data.bookmarks)) {
    const b = parseBookmark(raw, slug);
    if (b) out.bookmarks.set(slug, b);
    else if (strict) throw new Error(`Data bookmark "${slug.slice(0, 60)}" tidak valid.`);
  }
  for (const [slug, raw] of Object.entries(data.progress)) {
    const p = parseProgress(raw, slug);
    if (p) out.progress.set(slug, p);
    else if (strict) throw new Error(`Data riwayat "${slug.slice(0, 60)}" tidak valid.`);
  }
  return out;
}

/** Metadata dari pemanggil -> bentuk yang pasti lolos validasi (agar ekspor selalu bisa diimpor). */
function cleanMeta(m: MangaMeta): MangaMeta | undefined {
  return parseMeta({
    slug: m.slug,
    title: (m.title || m.slug).slice(0, 300),
    cover: isCover(m.cover) ? m.cover : '',
    type: m.type ? m.type.slice(0, 24) : undefined,
  });
}

/* ----------------------------------------------------------------- storage */

const serialize = (st: State): string =>
  JSON.stringify({ v: 1, bookmarks: Object.fromEntries(st.bookmarks), progress: Object.fromEntries(st.progress) });

/** Salin data yang tak terbaca ke kunci cadangan (sekali saja) supaya tidak hilang saat ditimpa. */
function backupCorrupt(raw: string): void {
  try {
    const s = ls();
    if (s && s.getItem(BACKUP_KEY) === null) s.setItem(BACKUP_KEY, raw);
  } catch {
    /* abaikan */
  }
}

function load(): State {
  if (state) return state;
  let raw: string | null = null;
  try {
    raw = ls()?.getItem(KEY) ?? null;
  } catch {
    raw = null;
  }
  state = emptyState();
  if (raw !== null) {
    try {
      state = parseState(JSON.parse(raw), false);
    } catch {
      backupCorrupt(raw); // JSON rusak / bentuk atau versi tak dikenal: mulai kosong, data asli diselamatkan
    }
  }
  return state;
}

// simp: tulis ulang seluruh data tiap perubahan; batas 300 riwayat membuatnya murah. Bila kuota
// storage penuh (read besar), tulisan dilewati dan data hanya hidup di memori sesi ini.
function persist(): void {
  try {
    ls()?.setItem(KEY, serialize(load()));
  } catch {
    /* storage penuh/diblokir: data tetap di memori */
  }
}

/* ------------------------------------------------------------------ events */

/**
 * Jenis perubahan pada event `library:change` (`detail.kind`):
 *  - bookmark : bookmark ditambah/dihapus
 *  - progress : posisi baca, tanda sudah dibaca, atau satu riwayat dihapus
 *  - clear    : seluruh riwayat dihapus
 *  - import   : data diganti sekaligus — hasil impor, perubahan dari tab lain, atau kembali dari bfcache
 */
export type LibraryChange = 'bookmark' | 'progress' | 'import' | 'clear';

export const CHANGE_EVENT = 'library:change';

const listeners = new Set<(kind: LibraryChange) => void>();
let watching = false;

/** Kabari pendengar `subscribe` dan pasang event `library:change` di `window` (bila ada). */
function emit(kind: LibraryChange): void {
  for (const fn of [...listeners]) {
    try {
      fn(kind);
    } catch (e) {
      console.error(e); // satu pendengar rusak tidak boleh menghentikan yang lain
    }
  }
  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { kind } }));
  }
}

/** Pasang pendengar lintas-tab/bfcache sekali (bukan saat import). Dipanggil `subscribe` dan `startSync`. */
function watch(): void {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  window.addEventListener('storage', (e) => {
    if (e.key !== null && e.key !== KEY) return;
    state = undefined; // tab lain menulis: baca ulang saat dibutuhkan
    emit('import');
  });
  // Kembali dari bfcache: halaman lama muncul tanpa menjalankan ulang skrip, datanya mungkin sudah usang.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    state = undefined;
    emit('import');
  });
}

/**
 * Hidupkan sinkronisasi lintas-tab tanpa pendengar callback: setelah ini `library:change` juga
 * terbit untuk perubahan dari tab lain. Untuk yang cukup mendengar event dan tidak memakai `subscribe`.
 */
export const startSync = watch;

/** Berlangganan perubahan (lokal dan dari tab lain). Mengembalikan fungsi berhenti. */
export function subscribe(fn: (kind: LibraryChange) => void): () => void {
  listeners.add(fn);
  watch();
  return () => {
    listeners.delete(fn);
  };
}

function mutate(kind: LibraryChange, fn: (st: State) => void): void {
  fn(load());
  persist();
  emit(kind);
}

/* -------------------------------------------------------------- bookmarks */

export function getBookmarks(): Bookmark[] {
  return [...load().bookmarks.values()].sort((a, b) => b.addedAt - a.addedAt);
}

export const isBookmarked = (slug: string): boolean => load().bookmarks.has(slug);

/** Tambah/hapus bookmark. Mengembalikan keadaan barunya (true = tersimpan). */
export function toggleBookmark(entry: MangaMeta): boolean {
  const had = load().bookmarks.has(entry.slug);
  const meta = cleanMeta(entry);
  if (!had && !meta) return false; // slug tak valid: tidak ada yang disimpan
  mutate('bookmark', (st) => {
    if (had) st.bookmarks.delete(entry.slug);
    else if (meta) st.bookmarks.set(meta.slug, { ...meta, addedAt: Date.now() });
  });
  return !had;
}

export function removeBookmark(slug: string): void {
  if (!load().bookmarks.has(slug)) return;
  mutate('bookmark', (st) => st.bookmarks.delete(slug));
}

/* ---------------------------------------------------------------- progress */

function capRead(read: string[]): string[] {
  return read.length > READ_MAX ? read.slice(read.length - READ_MAX) : read;
}

/** Buang riwayat tertua di atas HISTORY_MAX. */
function trimHistory(st: State): void {
  const extra = st.progress.size - HISTORY_MAX;
  if (extra <= 0) return;
  const oldest = [...st.progress.values()].sort((a, b) => a.updatedAt - b.updatedAt).slice(0, extra);
  for (const p of oldest) st.progress.delete(p.slug);
}

/** Riwayat, yang terakhir dibaca di depan. */
export function getHistory(): Progress[] {
  return [...load().progress.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export const getProgress = (slug: string): Readonly<Progress> | undefined => load().progress.get(slug);

/** Catat posisi baca. Chapter-nya ikut masuk `read` bila belum ada. Murah: satu tulis, tanpa baca balik. */
export function saveProgress(p: ProgressInput): void {
  const meta = cleanMeta(p.manga);
  if (!meta || !p.chapter.slug) return;
  mutate('progress', (st) => {
    const read = st.progress.get(meta.slug)?.read ?? [];
    const key = norm(p.chapter.slug);
    st.progress.set(meta.slug, {
      ...meta,
      chapter: { slug: p.chapter.slug.slice(0, 200), name: p.chapter.name.slice(0, 300) },
      page: nat(Math.floor(p.page)) ?? 0,
      pageCount: nat(Math.floor(p.pageCount)) ?? 0,
      offset: Number.isFinite(p.offset) ? clamp01(p.offset) : 0,
      updatedAt: Date.now(),
      read: read.includes(key) ? read : capRead([...read, key]),
    });
    trimHistory(st);
  });
}

/** Tandai chapter terbaca tanpa menggeser posisi baca. Tidak berbuat apa-apa bila manga belum punya riwayat. */
export function markChapterRead(mangaSlug: string, chapterSlug: string): void {
  const prev = load().progress.get(mangaSlug);
  const key = norm(chapterSlug);
  if (!prev || prev.read.includes(key)) return;
  mutate('progress', (st) => st.progress.set(mangaSlug, { ...prev, read: capRead([...prev.read, key]) }));
}

export const isChapterRead = (mangaSlug: string, chapterSlug: string): boolean =>
  load().progress.get(mangaSlug)?.read.includes(norm(chapterSlug)) ?? false;

export function removeHistory(slug: string): void {
  if (!load().progress.has(slug)) return;
  mutate('progress', (st) => st.progress.delete(slug));
}

export function clearHistory(): void {
  if (!load().progress.size) return;
  mutate('clear', (st) => st.progress.clear());
}

/* ----------------------------------------------------------- export/import */

export const exportJSON = (): string => serialize(load());

/** Gabungkan dua catatan manga yang sama: yang `updatedAt`-nya lebih baru menang, `read` disatukan. */
function mergeProgress(cur: Progress, inc: Progress): Progress {
  const [win, lose] = inc.updatedAt > cur.updatedAt ? [inc, cur] : [cur, inc];
  const kept = new Set(win.read);
  return { ...win, read: capRead([...lose.read.filter((r) => !kept.has(r)), ...win.read]) };
}

/**
 * Impor hasil `exportJSON` dan gabungkan ke data yang ada (bookmark: gabungan, yang `addedAt`-nya
 * lebih baru menang; riwayat: `updatedAt` terbaru menang, `read` disatukan). Atomik: bentuk atau
 * satu entri yang salah melempar Error berbahasa Indonesia dan tidak mengubah apa pun.
 */
export function importJSON(text: string): { bookmarks: number; history: number } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Berkas bukan JSON yang valid.');
  }
  const inc = parseState(data, true);
  mutate('import', (st) => {
    for (const [slug, b] of inc.bookmarks) {
      const cur = st.bookmarks.get(slug);
      if (!cur || b.addedAt > cur.addedAt) st.bookmarks.set(slug, b);
    }
    for (const [slug, p] of inc.progress) {
      const cur = st.progress.get(slug);
      st.progress.set(slug, cur ? mergeProgress(cur, p) : p);
    }
    trimHistory(st);
  });
  return { bookmarks: inc.bookmarks.size, history: inc.progress.size };
}
