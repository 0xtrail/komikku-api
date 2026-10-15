/**
 * Kontrol mengambang reader (presentasi saja; tidak menyentuh pemuatan gambar atau posisi baca).
 * Bar atas dan bar bawah bersembunyi saat menggulir turun, lalu muncul lagi saat menggulir naik, saat
 * area halaman diketuk/diklik, atau saat fokus keyboard masuk ke salah satu bar. Keadaannya satu kelas di
 * `[data-reader]` (`is-chrome-hidden`), jadi render ulang slot navigasi (`[data-rnav-slot]`) tidak
 * menghapusnya. `is-at-end` menyembunyikan bar bawah di dasar halaman: navigasi akhir chapter sudah terlihat.
 * Saat pertama kali bar bersembunyi, sebuah pil petunjuk tampil sebentar.
 */
/** Gulir turun (px, terakumulasi) sebelum bar disembunyikan, dan gulir naik sebelum ditampilkan lagi. */
const HIDE_AFTER = 12;
const SHOW_AFTER = 8;
/** Di dekat awal halaman bar selalu tampak. */
const TOP_ZONE = 80;
/** Jarak ke dasar halaman yang dianggap "sudah di akhir". */
const END_ZONE = 80;
const HINT_MS = 2500;

/** Klik pada elemen interaktif tidak boleh mengganti tampil/sembunyi bar. */
const INTERACTIVE = 'a, button, input, select, textarea, label, nav, header';

export function mountReaderChrome(host: HTMLElement): void {
  const root = (): HTMLElement | null => host.querySelector<HTMLElement>('[data-reader]');
  let lastY = window.scrollY;
  let travel = 0; // gulir terakumulasi searah; berbalik arah memulai lagi dari nol
  let ticking = false;
  let hinted = false;

  const showHint = (r: HTMLElement): void => {
    if (hinted) return;
    hinted = true;
    const hint = document.createElement('div');
    hint.className = 'reader-hint';
    hint.setAttribute('aria-hidden', 'true'); // petunjuk visual; bar tetap terjangkau keyboard (fokus menampilkannya)
    hint.textContent = 'Ketuk untuk menampilkan kontrol';
    r.append(hint);
    window.setTimeout(() => hint.remove(), HINT_MS);
  };

  const setHidden = (hide: boolean): void => {
    const r = root();
    if (!r || r.classList.contains('is-chrome-hidden') === hide) return;
    r.classList.toggle('is-chrome-hidden', hide);
    if (hide) showHint(r);
  };

  const sync = (): void => {
    ticking = false;
    const r = root();
    if (!r) return;
    const y = window.scrollY;
    const dy = y - lastY;
    lastY = y;
    // Pembuangan chapter lama memindahkan scroll untuk kompensasi: bukan gerakan pembaca.
    if (!dy || document.documentElement.classList.contains('is-trimming')) return;
    travel = Math.sign(dy) === Math.sign(travel) ? travel + dy : dy;
    if (y < TOP_ZONE) setHidden(false);
    else if (travel > HIDE_AFTER) setHidden(true);
    else if (travel < -SHOW_AFTER) setHidden(false);
    r.classList.toggle('is-at-end', y + window.innerHeight >= document.documentElement.scrollHeight - END_ZONE);
  };

  window.addEventListener(
    'scroll',
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(sync);
    },
    { passive: true },
  );

  host.addEventListener('click', (e) => {
    const r = root();
    const t = e.target;
    if (!r || !(t instanceof Element) || !r.contains(t) || t.closest(INTERACTIVE)) return;
    if (window.getSelection()?.toString()) return; // memilih teks bukan ketukan
    setHidden(!r.classList.contains('is-chrome-hidden'));
  });

  // Fokus keyboard masuk ke bar yang tersembunyi: tampilkan.
  host.addEventListener('focusin', (e) => {
    if (e.target instanceof Element && e.target.closest('.reader-head, .fixbar')) setHidden(false);
  });
}
