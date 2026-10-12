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
src/pages/index.astro    beranda — di-render server saat build (Manga Populer)
src/pages/search.astro   shell pencarian — hasil diambil client-side
src/pages/view.astro     shell untuk /manga/* dan /chapter/*
src/lib/api.ts           satu-satunya modul pemanggil API
src/lib/client.ts        render halaman detail & chapter di browser
src/lib/boot.ts          dispatcher yang memilih halaman
public/_redirects        rewrite 200 /manga/* dan /chapter/* -> /view.html
```

### Kenapa halaman detail di-render di browser

Astro `output: 'static'` menolak route dinamis (`[slug].astro`) tanpa
`getStaticPaths()`. `getStaticPaths()` butuh daftar slug saat build, sedangkan
data di sini dinamis dari API — dan `prerender = false` butuh adapter, yang
dilarang. Karena itu `/manga/<slug>` dan `/chapter/<slug>` dilayani oleh satu
shell statis (`view.astro`) lewat rewrite 200 di `public/_redirects`, lalu diisi
di browser.

> Rewrite hanya berlaku di Cloudflare Pages. Host statis lain perlu aturan
> setara; kalau tidak, `/manga/...` akan 404 di host tersebut.
