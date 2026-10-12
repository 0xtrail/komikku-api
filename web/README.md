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
src/pages/view.astro       shell untuk /manga/*, /chapter/*, /genre/*, /populer/*, /terbaru/*
src/layouts/Base.astro     <head>, tema, header, <main>, tab bar bawah
src/components/            Nav.astro (header), TabBar.astro (navigasi bawah ponsel)
src/lib/api.ts             satu-satunya modul pemanggil API + cache (memori + sessionStorage)
src/lib/routes.ts          URL halaman -> rute -> path API (dipakai boot & prefetch)
src/lib/views.ts           template HTML (string) — dipakai build time DAN browser
src/lib/client.ts          render halaman dari cache/skeleton, hidrasi beranda
src/lib/prefetch.ts        prefetch (IntersectionObserver, sentuh, hover) dengan antrean terbatas
src/lib/boot.ts            dispatcher: memilih halaman dari URL
src/lib/site.ts            perilaku header: tema, menu aktif, cari
public/_redirects          rewrite 200 ke /view/index.html (Cloudflare Pages)
nginx.conf                 rewrite yang sama untuk image Docker
```

Prefix rute dinamis (`manga|chapter|genre|populer|terbaru`) harus sama di
`nginx.conf` (regex `location ~ ^/(...)/`) dan `public/_redirects`.

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
   memanaskan chapter berikutnya setelah ~50% scroll.
3. **Skeleton** hanya muncul bila cache kosong (kunjungan pertama ke sebuah data).
4. **Beranda** di-prerender saat build sebagai paint pertama, lalu data terbaru
   ditukar di latar belakang hanya bila berbeda (`data-sig`). Markup sama persis
   karena dibuat oleh `views.ts` di kedua sisi.

Kunjungan pertama tanpa cache tetap menunggu latensi API; penyelesaian
sebenarnya adalah cache di sisi server Go.
