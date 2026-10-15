// Tes template beranda (src/lib/homeview.ts): strip Sorotan, Update Terbaru, daftar peringkat, tabel HOME_VIEWS.
// Jalankan dari web/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as h from '../src/lib/homeview.ts';

const EVIL = `One Piece <img src=x onerror=alert(1)> "q" 'a' & <script>alert(2)</script>`;
const EVIL_ESCAPED = 'One Piece &lt;img src=x onerror=alert(1)&gt; &quot;q&quot; &#39;a&#39; &amp; &lt;script&gt;alert(2)&lt;/script&gt;';

const list = Array.from({ length: 10 }, (_, i) => ({
  title: `Judul ${i + 1}`,
  image: `https://img.example/${i + 1}.jpg`,
  type: i % 2 ? 'Manhwa' : 'Manga',
  desc: i === 0 ? 'Sinopsis pendek.' : undefined,
  endpoint: `/manga/judul-${i + 1}/`,
}));

/** Tidak ada markup yang berasal dari judul uji (teks tampil sebagai teks, atribut tak bisa ditutup dini). */
function assertInert(html: string, label: string): void {
  assert.ok(!html.includes('<img src=x') && !html.includes('<script'), `${label}: markup mentah`);
  for (const tag of html.match(/<[^>]*>/g) ?? []) {
    assert.ok(!/\son[a-z]+\s*=/i.test(tag.replace(/"[^"]*"/g, '""')), `${label}: handler hidup di ${tag.slice(0, 80)}`);
  }
  assert.ok(html.includes(EVIL_ESCAPED), `${label}: judul tampil sebagai teks`);
}

test('heroHtml: sampul 3/4 dengan judul di atasnya, tautan ke halaman manga, enam gambar pertama tanpa lazy', () => {
  const html = h.heroHtml(list);
  assert.ok(html.startsWith('<ol class="hero-track" role="list">'));
  assert.equal((html.match(/class="card hero-item"/g) ?? []).length, 10);
  assert.ok(html.includes('href="/manga/judul-1/"') && html.includes('alt="Sampul Judul 1"'));
  assert.equal((html.match(/loading="lazy"/g) ?? []).length, 4, 'enam pertama langsung, sisanya lazy');
  assert.ok(html.includes('<span class="hero-title card-title">Judul 1</span>'));
  assert.ok(html.includes('badge-manhwa') && html.includes('badge-manga'));
  assert.equal(h.heroHtml([]), '', 'tanpa data: tanpa strip');
  assert.ok(!h.heroHtml([{ ...list[0], image: '' }]).includes('<img'), 'tanpa sampul: tanpa <img>');
});

test('updatesHtml: baris dengan sampul 64x86, judul, jenis, dan desc dua baris bila ada', () => {
  const html = h.updatesHtml(list);
  assert.ok(html.startsWith('<ul class="updates" role="list">'));
  assert.equal((html.match(/<li>/g) ?? []).length, 10);
  assert.ok(html.includes('width="64" height="86"') && html.includes('class="card row"'));
  assert.equal((html.match(/class="row-desc"/g) ?? []).length, 1, 'desc hanya bila API memberinya');
  assert.ok(html.includes('<span class="row-desc">Sinopsis pendek.</span>'));
  assert.ok(!html.includes('data-bm'), 'baris tanpa tombol bookmark');
  assert.ok(!h.updatesHtml([{ ...list[0], desc: '-' }]).includes('row-desc'), 'desc "-" dari API = kosong');
  assert.ok(h.updatesHtml([]).includes('class="empty"'));
});

test('rankedHtml: nomor 1..N menimpa sampul 60x80; daftar berurutan sesuai data', () => {
  const html = h.rankedHtml(list);
  assert.ok(html.startsWith('<ol class="ranked" role="list">'));
  for (let i = 1; i <= 10; i++) assert.ok(html.includes(`<span class="rk-num" aria-hidden="true">${i}</span>`), `peringkat ${i}`);
  assert.ok(html.includes('width="60" height="80"'));
  assert.ok(html.indexOf('Judul 1<') < html.indexOf('Judul 2<') && html.indexOf('Judul 9<') < html.indexOf('Judul 10<'));
});

test('regresi escape: judul, desc, sampul, jenis dari API tidak pernah menjadi markup di beranda', () => {
  const evil = { title: EVIL, image: 'https://x/"><script>.jpg', type: 'Manga"><b>', desc: EVIL, endpoint: '/manga/e/' };
  assertInert(h.heroHtml([evil]), 'heroHtml');
  assertInert(h.updatesHtml([evil]), 'updatesHtml');
  assertInert(h.rankedHtml([evil]), 'rankedHtml');
});

test('HOME_VIEWS: satu render + skeleton untuk tiap section; skeleton sebentuk isinya', () => {
  assert.deepEqual(Object.keys(h.HOME_VIEWS).sort(), ['genre', 'hero', 'newest', 'rank-popular', 'rank-recommended', 'recommended']);
  for (const [key, view] of Object.entries(h.HOME_VIEWS)) {
    assert.equal(typeof view.render, 'function', key);
    assert.ok(view.skeleton.includes('aria-hidden="true"'), `${key}: skeleton tak dibaca pembaca layar`);
  }
  assert.ok(h.HOME_VIEWS.hero.skeleton.includes('class="hero-track"'));
  assert.ok(h.HOME_VIEWS.newest.skeleton.includes('class="updates"') && h.HOME_VIEWS['rank-popular'].skeleton.includes('class="ranked"'));
  assert.ok(h.HOME_VIEWS.recommended.skeleton.includes('class="rail"'));
  // Rekomendasi: baris tanpa peringkat (peringkat ada di sidebar).
  assert.ok(!h.HOME_VIEWS.recommended.render(list).includes('class="rank"'));
  assert.ok(h.HOME_VIEWS.hero.render(list) === h.heroHtml(list));
});
