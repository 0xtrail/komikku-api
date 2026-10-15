/**
 * Gambar yang gagal dimuat (CDN sumber lambat/mati, token proxy kedaluwarsa), ditangani di satu
 * tempat lewat satu pendengar `error` di fase capture (event `error` pada <img> tidak bubble):
 *   - sampul (`img` di dalam `.cover`): blok netral dengan inisial judul (`.cover.is-broken` +
 *     `.cover-ph[data-img-fallback]`), bukan ikon gambar rusak bawaan browser;
 *   - halaman reader (`img.page`): gambar disembunyikan (`img.is-broken[data-broken]`) dan sebuah
 *     tombol `button.page-retry[data-img-retry]` "Halaman N gagal dimuat · Coba lagi" muncul
 *     tepat setelahnya; menekannya memasang ulang `src`.
 * Berlaku untuk markup yang dirender kapan pun (innerHTML, feed, prerender beranda) tanpa perlu
 * dipasang per gambar. Kontrak untuk reader: pertahankan `class="page"` dan `alt="Halaman N"`.
 */

/** Dua huruf awal dari dua kata pertama ("One Piece" -> "OP"); "?" bila tak ada huruf/angka. */
export function initials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const letters = words
    .slice(0, 2)
    .map((w) => Array.from(w.replace(/[^\p{L}\p{N}]/gu, ''))[0] ?? '')
    .join('');
  return (letters || '?').toUpperCase();
}

/** Judul untuk inisial: dari alt ("Sampul <judul>") atau dari judul kartu/baris di sekitarnya. */
function titleOf(img: HTMLImageElement): string {
  const alt = img.alt.replace(/^Sampul\s+/i, '').trim();
  if (alt) return alt;
  const host = img.closest('li, .card, .lib-row, article');
  return host?.querySelector('.card-title, .lib-title, h1')?.textContent ?? '';
}

function coverFallback(img: HTMLImageElement, cover: Element): void {
  if (cover.classList.contains('is-broken')) return;
  cover.classList.add('is-broken');
  const ph = document.createElement('span');
  ph.className = 'cover-ph';
  ph.setAttribute('data-img-fallback', '');
  ph.setAttribute('aria-hidden', 'true');
  ph.textContent = initials(titleOf(img));
  cover.prepend(ph);
}

const pageNumber = (img: HTMLImageElement): string => img.alt.replace(/\D+/g, '') || '?';

const retryLabel = (img: HTMLImageElement): string => `Halaman ${pageNumber(img)} gagal dimuat · Coba lagi`;

function pageFallback(img: HTMLImageElement): void {
  img.classList.add('is-broken');
  const flagged = img.dataset.broken;
  img.dataset.broken = 'failed';
  const next = img.nextElementSibling;
  if (flagged && next instanceof HTMLButtonElement && next.hasAttribute('data-img-retry')) {
    // Percobaan ulang gagal lagi: tombol yang sama kembali aktif.
    next.disabled = false;
    next.textContent = retryLabel(img);
    return;
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'page-retry';
  btn.setAttribute('data-img-retry', '');
  btn.textContent = retryLabel(img);
  img.after(btn);
}

function onError(e: Event): void {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  if (img.classList.contains('page')) pageFallback(img);
  else {
    const cover = img.closest('.cover');
    if (cover) coverFallback(img, cover);
  }
}

function onLoad(e: Event): void {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.broken) return;
  // Percobaan ulang berhasil: tombol dan penanda dibersihkan.
  img.classList.remove('is-broken');
  delete img.dataset.broken;
  const next = img.nextElementSibling;
  if (next instanceof HTMLButtonElement && next.hasAttribute('data-img-retry')) next.remove();
}

function onClick(e: MouseEvent): void {
  const btn = e.target instanceof Element ? e.target.closest<HTMLButtonElement>('button[data-img-retry]') : null;
  const img = btn?.previousElementSibling;
  if (!btn || !(img instanceof HTMLImageElement)) return;
  const src = img.getAttribute('src');
  if (!src) return;
  btn.disabled = true;
  btn.textContent = `Memuat halaman ${pageNumber(img)}…`;
  img.dataset.broken = 'retry';
  img.loading = 'eager'; // gambar ber-display:none tidak pernah dimuat bila masih lazy
  img.classList.remove('is-broken');
  img.removeAttribute('src');
  img.setAttribute('src', src);
}

/** Pasang penanganan sekali per halaman, lalu tangani gambar yang sudah terlanjur gagal sebelum JS jalan. */
export function initImageFallback(): void {
  document.addEventListener('error', onError, true);
  document.addEventListener('load', onLoad, true);
  document.addEventListener('click', onClick);
  document.querySelectorAll('img').forEach((img) => {
    if (img.complete && img.naturalWidth === 0 && img.currentSrc) {
      img.dispatchEvent(new Event('error'));
    }
  });
}
