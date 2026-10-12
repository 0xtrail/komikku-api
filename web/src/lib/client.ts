/**
 * Router sisi-klien untuk rute yang tidak bisa di-prerender:
 * /manga/<endpoint> dan /chapter/<endpoint>.
 *
 * Kenapa klien, bukan server: output `static` tidak bisa punya route dinamis
 * tanpa getStaticPaths() (data API, bukan daftar tetap) DAN tidak bisa
 * `prerender = false` tanpa adapter. Jadi HTML-nya statis, isinya diambil
 * di browser. URL tetap rapi lewat rewrite 200 di `public/_redirects`.
 */
import { getInfo, getChapter, search, slugOf, ApiError, type Manga } from './api';

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

const msg = (e: unknown) =>
  e instanceof ApiError || e instanceof Error ? e.message : 'Terjadi kesalahan';

/** /manga/black-clover-indonesia/ -> black-clover-indonesia */
function slugFromPath(): string {
  const rest = location.pathname.split('/').filter(Boolean).slice(1).join('/');
  return decodeURIComponent(rest.replace(/\/+$/, ''));
}

async function mount(id: string, render: (el: HTMLElement) => Promise<void>): Promise<void> {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = '<p class="muted">Memuat…</p>';
  try {
    await render(el);
  } catch (e) {
    el.innerHTML = `<p class="err">Gagal memuat: ${esc(msg(e))}</p>`;
  }
}

/** Kartu manga yang dipakai ulang di halaman detail/daftar. */
const card = (m: Manga) => `
  <a class="card" href="/manga/${esc(slugOf(m.endpoint))}/">
    <img src="${esc(m.image)}" alt="${esc(m.title)}" loading="lazy" />
    <span class="card-title">${esc(m.title)}</span>
  </a>`;

export function mountSearch(): void {
  const params = new URLSearchParams(location.search);
  const q = (params.get('q') ?? '').trim();
  const input = document.getElementById('q') as HTMLInputElement | null;
  if (input && q) input.value = q;

  void mount('app', async (el) => {
    if (!q) {
      el.innerHTML = '<p class="muted">Masukkan kata kunci untuk mulai mencari manga.</p>';
      return;
    }
    const results = await search(q);
    el.innerHTML = results.length
      ? `<h2>Hasil untuk “${esc(q)}”</h2><div class="grid">${results.map(card).join('')}</div>`
      : `<p class="muted">Tidak ada hasil untuk “${esc(q)}”.</p>`;
  });
}

export function mountMangaDetail(): void {
  void mount('app', async (el) => {
    const info = await getInfo(slugFromPath());
    const genres = (info.genre ?? [])
      .map((g) => `<span class="tag">${esc(g)}</span>`)
      .join('');
    const chapters = (info.chapter_list ?? [])
      .map(
        (c) => `<li><a href="/chapter/${esc(slugOf(c.endpoint))}/">${esc(c.name)}</a></li>`,
      )
      .join('');

    el.innerHTML = `
      <article class="detail">
        <img class="cover" src="${esc(info.thumbnail)}" alt="${esc(info.title)}" />
        <div>
          <h1>${esc(info.title)}</h1>
          <ul class="meta">
            <li><b>Tipe</b> ${esc(info.type ?? '-')}</li>
            <li><b>Pengarang</b> ${esc(info.author ?? '-')}</li>
            <li><b>Status</b> ${esc(info.status ?? '-')}</li>
            <li><b>Rating</b> ${esc(info.rating ?? '-')}</li>
          </ul>
          <div class="tags">${genres || '<span class="muted">Tanpa genre</span>'}</div>
        </div>
      </article>
      <h2>Daftar Chapter</h2>
      <ul class="chapters">${chapters || '<li class="muted">Belum ada chapter.</li>'}</ul>`;
  });
}

export function mountChapter(): void {
  void mount('app', async (el) => {
    const chapter = await getChapter(slugFromPath());
    const pages = chapter.image
      .map((src, i) => `<img src="${esc(src)}" alt="Halaman ${i + 1}" loading="lazy" />`)
      .join('');
    el.innerHTML = `<h1>${esc(chapter.title)}</h1><div class="pages">${pages}</div>`;
  });
}
