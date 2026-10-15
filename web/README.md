# web/ — Frontend reader manga (Astro, static)

Frontend untuk API Go di root repo. Output **statis** — tanpa SSR, tanpa adapter,
tanpa database. Semua data diambil live dari API.

## Dev lokal

```sh
cp .env.example .env   # opsional, default sudah https://img2.kremlit.dev
npm install
npm run dev            # http://localhost:4321
```

## Build

```sh
npm run build          # hasil di dist/
npm run preview        # cek hasil build secara lokal
```

Build memanggil API untuk halaman beranda, jadi butuh jaringan. Kalau API gagal,
halaman beranda tetap ter-build dan menampilkan pesan error, bukan gagal total.

## Environment

`PUBLIC_API_URL` — base URL API Go. Default `https://img2.kremlit.dev` kalau kosong.
**Wajib di-set di Cloudflare Pages** (Settings → Environment variables) dan di
Dokploy bila di-deploy lewat sana. Prefix `PUBLIC_` diperlukan agar nilainya
tersedia di bundle browser.

## Struktur

```
src/pages/index.astro      beranda — di-prerender saat build (Populer, Rekomendasi, Terbaru, Genre)
src/pages/search.astro     shell pencarian — hasil diambil client-side
src/pages/daftar.astro     shell Daftar Komik (?tipe=manga|manhwa|manhua, ?page=) — scroll tanpa akhir
src/pages/pustaka.astro    shell Pustaka (?tab=riwayat|bookmark) — data dari localStorage
src/pages/view.astro       shell untuk /manga/*, /chapter/*, /genre/*, /populer/*, /terbaru/*
src/pages/404.astro        halaman 404 bermerek (dist/404.html) — statis, tanpa boot.ts
src/pages/50x.astro        halaman galat server bermerek (dist/50x/index.html) — statis, tanpa boot.ts
src/layouts/Base.astro     <head>, tema, header, <main>, tab bar bawah
src/components/            Nav.astro (header + sub-menu Daftar + kotak saran), TabBar.astro (navigasi bawah ponsel)
src/lib/api.ts             satu-satunya modul pemanggil API + cache (memori + sessionStorage)
src/lib/routes.ts          URL halaman -> rute -> path API (dipakai boot & prefetch)
src/lib/views.ts           template HTML (string) — dipakai build time DAN browser
src/lib/client.ts          render halaman dari cache/skeleton (`loadView`), feed tanpa akhir, hidrasi beranda
src/lib/reader.ts          reader chapter: chapter berurutan, posisi baca, lanjut baca, simpan ke pustaka
src/lib/readerlogic.ts     logika murni reader (manga/tetangga chapter, `#p<N>`, halaman yang dibaca, batas DOM) — diuji di Node
src/lib/readerview.ts      template reader (string murni): header + sakelar, bar navigasi, `section.chapter`, slot bawah, toast
src/lib/readerimg.ts       pemuat gambar halaman (data-src + IntersectionObserver) dan pemanasan gambar chapter berikutnya
src/lib/readerresume.ts    melompat ke posisi terakhir dan menahannya selama gambar dimuat + toast "Lanjut dari halaman N"
src/lib/detail.ts          halaman detail manga: sinopsis, Simpan, Lanjutkan, tanda chapter terbaca
src/lib/library.ts         pustaka di localStorage: bookmark, riwayat, posisi baca, ekspor/impor, event `library:change`
src/lib/bookmarks.ts       tombol bookmark `[data-bm]` di kartu/detail + lencana `[data-bm-count]` (satu pendengar klik)
src/lib/errorview.ts       markup keadaan galat (string murni): dipakai 404.astro, 50x.astro, dan aplikasi
src/lib/errorstate.ts      perilaku keadaan galat: tombol Coba lagi, ulang otomatis saat kembali online
src/lib/images.ts          gambar gagal dimuat: placeholder sampul + tombol "Coba lagi" untuk halaman reader
src/lib/pustaka.ts         UI pustaka: halaman /pustaka/ dan baris "Lanjutkan Membaca" di beranda
src/lib/suggest.ts         autocomplete kolom cari (combobox ARIA)
src/lib/navmenu.ts         sub-menu Daftar di header desktop (disclosure)
src/lib/page.ts            pembantu kecil bersama (judul dokumen, elemen #app)
src/lib/prefetch.ts        prefetch (IntersectionObserver, sentuh, hover) dengan antrean terbatas
src/lib/boot.ts            dispatcher: memilih halaman dari URL
src/lib/site.ts            perilaku header: tema, menu aktif, cari
public/_redirects          rewrite 200 ke /view/index.html (Cloudflare Pages)
nginx.conf                 rewrite yang sama untuk image Docker + halaman galat bermerek
tests/                     tes Node polos (`npm test`): library, views/escape, jenis galat, logika + template reader
```

Prefix rute dinamis (`manga|chapter|genre|populer|terbaru`) harus sama di
`nginx.conf` (regex `location ~ ^/(...)/`) dan `public/_redirects`. `/daftar/` dan
`/pustaka/` hanya butuh query string, jadi mereka file nyata seperti `/search/` dan
tidak perlu aturan rewrite.

### Pustaka (localStorage)

`library.ts` menyimpan semuanya di satu kunci, `mr:lib:v1`:
`{ v: 1, bookmarks: {<slug>: ...}, progress: {<slug>: ...} }`, slug = slug manga di
`/manga/<slug>/`. `progress` memuat chapter terakhir, indeks halaman (0-based) +
`offset` (0..1) di dalamnya, dan daftar slug chapter yang sudah dibuka (`read`).
Batas: 300 riwayat (yang tertua dibuang), 2000 chapter per manga. Salinan kerja ada
di memori; storage dibaca ulang hanya saat event `storage` (tab lain) atau saat
halaman dipulihkan dari bfcache. Bila storage melempar/tidak ada, data tetap hidup
di memori untuk sesi itu; JSON rusak dicadangkan sekali ke `mr:lib:v1:corrupt` lalu
pustaka mulai kosong. `views.ts` hanya mengimpor TIPE dari modul ini (ia dijalankan
juga di Node saat build), jadi data pustaka selalu dioper sebagai parameter template.

Halaman Pustaka punya ekspor (`panel-pustaka-YYYY-MM-DD.json`) dan impor; impor
menggabungkan (bookmark: gabungan; riwayat: `updatedAt` terbaru menang, `read`
disatukan) dan menolak berkas yang bentuknya salah tanpa mengubah apa pun.

### Bookmark di kartu dan lencana (hook untuk restyle)

Setiap kartu di grid/baris Populer/feed adalah `<li class="has-bm">` berisi tautan kartu
**dan**, sebagai saudaranya (bukan anak `<a>`), tombol
`<button type="button" class="card-bm" data-bm="<slug>" data-title data-cover data-type
aria-pressed="true|false" aria-label="Simpan <judul>">` dengan ikon dan `span.bm-label`
("Simpan"/"Tersimpan", disembunyikan secara visual di kartu). Tombol Simpan di halaman
detail memakai atribut yang sama (`data-bm`, selain `data-bookmark` lama). Satu pendengar
klik di `document` (`bookmarks.ts`) menyimpan/menghapus dan tidak pernah menavigasi.
`syncBookmarkButtons(root = document)` menyetel `aria-pressed` + `.bm-label` dari pustaka;
dipanggil setelah setiap render dan otomatis saat `library:change`.
`[data-bm-count]` (di tautan Pustaka header dan tab bar) berisi jumlah bookmark dan
`hidden` bila 0 (`syncBookmarkCount()`).

`library.ts` menembakkan `CustomEvent('library:change', { detail: { kind } })` di
`window` untuk setiap perubahan lokal: `kind` = `bookmark` | `progress` | `clear` | `import`
(`import` juga dipakai untuk perubahan dari tab lain dan pemulihan bfcache). `subscribe(fn)`
tetap ada dan menerima `kind` yang sama.

### Reader (`/chapter/<slug>/`)

Satu halaman bisa memuat beberapa chapter berurutan. Hook stabil (untuk restyle/tes):

- `[data-reader]` akar; `[data-chapters]` pembungkus chapter; `section.chapter[data-chapter="<slug>"]
  [data-chapter-name]` per chapter; `.chapter-divider` (+ `.chapter-divider-name`,
  `a.chapter-divider-link`) di awal chapter yang ditambahkan; `.pages` berisi `img.page[data-page="<1-based>"]`
  (tanpa `id`, jadi tidak pernah ganda antar-chapter).
- `[data-append-slot]` (= `[data-rnav-slot="end"]`) di bawah chapter terakhir dengan
  `data-state="idle|loading|end|off|error"`: tautan manual "Lanjut: <nama>", penunjuk memuat, navigasi akhir
  ("Ini chapter terbaru" bila pasti terbaru), navigasi akhir klasik (sakelar mati), atau galat ringkas
  dengan `[data-retry]`.
- `[data-autonext-toggle][aria-pressed]` sakelar "Lanjut otomatis" di header, tersimpan di
  `localStorage` kunci `mr:reader:autonext` (`"0"` = mati; selain itu aktif).
- `[data-read-progress]` ("12 / 69") di bar bawah (`.fix-pg`, ponsel) dan di pil mengambang pojok kanan
  bawah (`.reader-progress`, >= 860px karena bar bawah disembunyikan di desktop).
- `[data-reader-toast]` toast lanjut baca dengan `[data-toast-restart]` ("Mulai dari awal") dan `[data-toast-close]`.

**Manga induk tidak bisa ditebak dari slug chapter** (`solo-leveling-ragnarok-chapter-66` ada di
`/manga/alone-leveling-ragnarok/`). Sumber utama adalah field API chapter `manga_endpoint`, `manga_title`,
`prev_endpoint`, `next_endpoint` (string kosong = tidak ada; `undefined` = API lama). Tanpa field itu reader
jatuh ke tebakan dari slug, yang baru dipercaya setelah daftar chapter manga hasil tebakan itu memuat chapter
ini (sampai itu: tombol navigasi berupa placeholder, tanpa tautan balik, tanpa simpan posisi). Nama chapter
diambil dari daftar chapter info manga bila ada, kalau tidak dari `title`.

**Chapter yang sedang dibaca** = chapter yang halaman pertamanya sudah melewati garis di 30% tinggi layar;
**halaman yang dibaca** = gambar yang melintasi garis itu + posisi 0..1 di dalamnya. Saat chapter berganti
(turun atau naik): `history.replaceState` ke URL-nya (tanpa hash), judul tab, header, bar atas/bawah,
penunjuk halaman, dan target keyboard ←/→ ikut berganti.

**Gambar**: tiga halaman pertama (atau N-1..N+3 saat melompat ke halaman N) langsung punya `src`, yang pertama
`fetchpriority="high"`; sisanya hanya `data-src` dan diberi `src` oleh IntersectionObserver saat berada dalam
3 tinggi layar di bawah / 1 di atas (separuhnya saat `saveData`/2G). Pada ~50% chapter JSON chapter
berikutnya diprefetch, pada ~70% tiga gambar pertamanya dihangatkan (`new Image()`, prioritas rendah).

**Lanjut baca**: `#p<N>` (1-based) menang atas posisi tersimpan untuk chapter yang sama (halaman > 0);
`#p1` = dari awal. Reader melompat, lalu menghitung ulang posisi tiap gambar di atas/di halaman target
selesai dimuat, tiap ukuran dokumen berubah, dan saat layar diputar, sampai pembaca menyentuh (wheel,
sentuh, tombol, pointer) atau 10 detik lewat; selama itu posisi tidak disimpan. Toast "Lanjut dari halaman
N" bisa ditutup atau "Mulai dari awal". Posisi disimpan paling sering sekali per detik dan saat
`pagehide`/`visibilitychange`; chapter ditandai terbaca saat halaman terakhirnya tercapai atau pembaca
berlanjut ke chapter berikutnya.

**Chapter berikutnya**: bila sakelar aktif dan chapter berikutnya ada, saat dasar chapter terakhir kurang
dari ~1,5 tinggi layar di bawah layar, chapter itu diambil (`get`, memakai cache prefetch) dan ditambahkan
di bawah dengan pembatas. Maksimum 3 chapter di DOM: yang tertua dibuang bila sudah seluruhnya di atas layar
dan bukan yang sedang dibaca, dengan kompensasi scroll (`html.is-trimming` mematikan scroll anchoring
browser selama pembuangan). Gagal mengambil -> galat ringkas di slot dan tidak diulang otomatis (kecuali
offline -> saat kembali online); "Coba lagi" mengulang.

### Halaman dan keadaan galat

Tidak ada halaman galat bawaan yang tampil ke pengguna.

- **Statis**: `404.astro` -> `dist/404.html`, `50x.astro` -> `dist/50x/index.html` (Astro memakai
  format direktori, bukan `50x.html`). Keduanya memakai `Base`, tanpa `boot.ts` (hanya `site.ts`:
  header, tema, kolom cari), jalan tanpa JS (tautan biasa; "Coba lagi" di 50x adalah `<a href="">`).
  `nginx.conf`: `error_page 403 404 /404.html` dan `error_page 500 502 503 504 /50x/index.html`,
  lokasi `internal`, `server_tokens off`. Cloudflare Pages melayani `404.html` otomatis.
- **Di aplikasi**: `ApiError.kind` (`notfound` 404/410, `timeout` 408/504/AbortSignal,
  `offline` fetch gagal saat `navigator.onLine === false`, `server` sisanya, `unknown` bila
  bukan ApiError) menentukan teks; pesan mentah API/Go atau "HTTP 503" tidak pernah tampil.
  Fetch yang ditolak saat browser online (API mati/DNS/CORS) dihitung `server`, bukan `offline`.
  Markup: `[data-error-state][data-error-kind="notfound|server|timeout|offline|unknown"]`,
  tombol `[data-retry]`; jenis `offline` mengulang otomatis saat event `online`. Varian
  `.err--page` (halaman penuh) dan `.err--compact` (section beranda, status feed). `mountUnknown`
  memakai markup yang sama dengan `404.html`.
- **Gambar rusak** (`images.ts`, satu pendengar di fase capture): sampul -> `.cover.is-broken` +
  `.cover-ph[data-img-fallback]` berinisial judul; halaman reader (`img.page`, `alt="Halaman N"`) ->
  `img.is-broken[data-broken]` + `button.page-retry[data-img-retry]` "Halaman N gagal dimuat · Coba
  lagi" yang memasang ulang `src`. Reader cukup mempertahankan `class="page"` dan `alt`.

### Tes

```sh
npm test    # node --experimental-strip-types --test "tests/*.test.ts"
```

Node polos, tanpa dependensi tambahan (Node >= 22.12; mulai 22.18 flag-nya tidak diperlukan).
Berkas yang diuji (`library.ts`, `views.ts`, `routes.ts`, `api.ts`, `errorview.ts`, `images.ts`,
`readerlogic.ts`, `readerview.ts`)
hanya memakai sintaks TypeScript yang bisa di-strip (tanpa enum/parameter property) dan
import relatif dengan ekstensi `.ts` di modul yang diimpor tes. `tests/` dikecualikan dari
`tsconfig.json` (tanpa `@types/node`); cek tipe: `tsc --noEmit -p .`.

### Kenapa halaman detail di-render di browser

Astro `output: 'static'` menolak route dinamis (`[slug].astro`) tanpa
`getStaticPaths()`. `getStaticPaths()` butuh daftar slug saat build, sedangkan
data di sini dinamis dari API — dan `prerender = false` butuh adapter, yang
dilarang. Karena itu rute dinamis dilayani oleh satu shell statis (`view.astro`)
lewat rewrite 200, lalu diisi di browser.

> Rewrite hanya berlaku di Cloudflare Pages dan nginx image ini. Host statis lain
> perlu aturan setara; kalau tidak, `/manga/...` akan 404 di host tersebut.

### Kenapa tidak ada "Memuat…" saat pindah halaman

API men-scrape situs sumber secara live (0,5-3 dtk per panggilan), jadi yang
bisa dilakukan frontend adalah tidak menunggu API saat navigasi:

1. **Cache** (`api.ts`): request yang sama berbagi satu promise; hasil sukses
   disimpan di memori + `sessionStorage` (`mr:v1:<path>`, TTL 10 menit). `peek()`
   membaca cache secara sinkron, jadi halaman yang pernah/telah di-prefetch
   dirender pada frame pertama tanpa state loading. Cache > 30 dtk divalidasi
   ulang di latar belakang dan dirender ulang hanya bila datanya berubah.
2. **Prefetch** (`prefetch.ts`): kartu yang terlihat >= 50% selama 300 ms
   (maks 12 per halaman), sentuh/`pointerdown`, dan hover mouse (bonus) memanaskan
   cache. Maks 2 request berjalan bersamaan; mati total bila `saveData` aktif
   atau koneksi 2G. Halaman detail juga memanaskan chapter awal & terbaru; reader
   memanaskan chapter berikutnya setelah ~50% scroll (JSON) dan ~70% (gambar pertama).
3. **Skeleton** hanya muncul bila cache kosong (kunjungan pertama ke sebuah data).
4. **Beranda** di-prerender saat build sebagai paint pertama, lalu data terbaru
   ditukar di latar belakang hanya bila berbeda (`data-sig`). Markup sama persis
   karena dibuat oleh `views.ts` di kedua sisi.

Kunjungan pertama tanpa cache tetap menunggu latensi API; penyelesaian
sebenarnya adalah cache di sisi server Go.
