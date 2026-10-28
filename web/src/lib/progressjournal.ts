/**
 * Jurnal posisi baca di IndexedDB: satu catatan saja (yang TERAKHIR ditulis) sebagai cadangan localStorage.
 *
 * Kenapa: Chromium menulis localStorage ke disk dengan tertunda (5 detik, maksimum 60 kali per jam), jadi
 * bila browser dimatikan paksa (geser dari recents) posisi baca terakhir bisa hilang dan chapter dibuka
 * dari halaman 1. Transaksi IndexedDB ditulis ke disk saat transaksi selesai, jadi catatan di sini selamat.
 *
 *  - `installJournal()`   : pasang sink ke library.ts (`put` tiap posisi/tanda baca tersimpan, `drop` tiap
 *                           riwayat dihapus, supaya yang sudah dihapus tidak hidup lagi saat boot)
 *  - `recoverFromJournal` : baca catatan terakhir lalu `recoverProgress` (library.ts) menggabungkannya;
 *                           dipanggil boot.ts sebelum halaman dirender
 *
 * library.ts tetap sumber kebenaran (sinkron, di memori). Jurnal hanya tambahan: setiap kegagalan (tak ada
 * IndexedDB, mode privat, kuota, diblokir, versi berubah) ditelan dan tak pernah melempar atau menggantung.
 */
import { recoverProgress, setProgressSink, type Progress } from './library';

const DB_NAME = 'mr-journal';
const STORE = 'kv';
const KEY = 'last';

/** Koneksi yang sedang/ sudah dibuka; `undefined` = belum dicoba atau perlu dibuka ulang. Resolve `undefined` bila gagal. */
let conn: Promise<IDBDatabase | undefined> | undefined;

function open(): Promise<IDBDatabase | undefined> {
  if (conn) return conn;
  const pending: Promise<IDBDatabase | undefined> = new Promise((resolve) => {
    let settled = false;
    const settle = (db: IDBDatabase | undefined): void => {
      settled = true;
      resolve(db);
    };
    try {
      if (typeof indexedDB === 'undefined') return settle(undefined);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        try {
          req.result.createObjectStore(STORE);
        } catch {
          /* transaksi upgrade gagal: onerror/onsuccess yang menentukan */
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        if (settled) return db.close(); // sudah menyerah (diblokir): jangan bocorkan koneksi
        // Browser meminta koneksi dilepas (versi baru dibuka di tab lain) atau menutupnya sendiri: buka ulang saat dibutuhkan.
        const reset = (): void => {
          if (conn === pending) conn = undefined;
        };
        db.onversionchange = () => {
          db.close();
          reset();
        };
        db.onclose = reset;
        settle(db);
      };
      req.onerror = () => settle(undefined);
      req.onblocked = () => settle(undefined);
    } catch {
      settle(undefined); // mis. SecurityError saat storage diblokir
    }
  });
  conn = pending;
  return pending;
}

/**
 * Satu transaksi pada `kv`. `job` mendaftarkan request-nya dan boleh mengisi `out.value`; hasilnya keluar
 * setelah transaksi selesai. Gagal di mana pun -> `undefined`; tidak pernah melempar.
 */
async function tx<T>(mode: IDBTransactionMode, job: (store: IDBObjectStore, out: { value?: T }) => void): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise<T | undefined>((resolve) => {
    try {
      // `durability: 'strict'`: selesai berarti sudah di disk. Browser yang belum mengenalnya mengabaikan opsi ini.
      const t = mode === 'readwrite' ? db.transaction(STORE, mode, { durability: 'strict' }) : db.transaction(STORE, mode);
      const out: { value?: T } = {};
      t.oncomplete = () => resolve(out.value);
      t.onerror = () => resolve(undefined);
      t.onabort = () => resolve(undefined); // termasuk QuotaExceededError
      job(t.objectStore(STORE), out);
    } catch {
      resolve(undefined); // mis. InvalidStateError: koneksi sudah ditutup browser
      conn = undefined;
    }
  });
}

function put(p: Progress): void {
  void tx<void>('readwrite', (store) => {
    store.put(p, KEY);
  });
}

/** Hapus catatan terakhir bila itu milik `slug` (atau apa pun bila `slug` null); baca dan hapus dalam satu transaksi. */
function drop(slug: string | null): void {
  void tx<void>('readwrite', (store) => {
    if (slug === null) {
      store.delete(KEY);
      return;
    }
    const req = store.get(KEY);
    req.onsuccess = () => {
      const rec: unknown = req.result;
      if (typeof rec === 'object' && rec !== null && (rec as { slug?: unknown }).slug === slug) store.delete(KEY);
    };
  });
}

/** Mulai menjurnal setiap perubahan riwayat (dipanggil sekali oleh boot.ts). */
export function installJournal(): void {
  setProgressSink({ put, drop });
}

/**
 * Masukkan catatan jurnal ke pustaka sebelum halaman membaca posisi. Selalu resolve: setelah selesai, saat
 * gagal, atau setelah `timeoutMs` (hasil yang datang terlambat diabaikan). Tak pernah reject atau menggantung.
 */
export function recoverFromJournal(timeoutMs = 400): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    function finish(rec: unknown): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (rec !== undefined) recoverProgress(rec);
      } catch {
        /* recoverProgress tak melempar, tapi boot tak boleh bergantung pada itu */
      }
      resolve();
    }
    void tx<unknown>('readonly', (store, out) => {
      const req = store.get(KEY);
      req.onsuccess = () => {
        out.value = req.result;
      };
    }).then(finish, () => finish(undefined));
  });
}
