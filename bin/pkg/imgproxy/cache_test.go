package imgproxy

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
)

// cachedServer is testServer with the disk cache switched on in a fresh dir.
func cachedServer(t *testing.T, maxBytes int64) (*Proxy, *echo.Echo, string) {
	t.Helper()
	dir := t.TempDir()
	p := New(Config{
		HMACKey:       randKey(t),
		AllowedHosts:  []string{"127.0.0.1"},
		CacheDir:      dir,
		CacheMaxBytes: maxBytes,
	})
	if p.cache == nil {
		t.Fatal("the cache must be enabled")
	}
	p.client = newClient(p, nil)
	e := echo.New()
	p.Mount(e)
	return p, e, dir
}

// cacheFiles lists every regular file below dir, as paths relative to dir.
func cacheFiles(t *testing.T, dir string) []string {
	t.Helper()
	var names []string
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		names = append(names, rel)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return names
}

func fileSize(t *testing.T, path string) int64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Size()
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// age backdates a cache entry so eviction order does not depend on the clock
// resolution of the file system.
func age(t *testing.T, path string, by time.Duration) {
	t.Helper()
	when := time.Now().Add(-by)
	if err := os.Chtimes(path, when, when); err != nil {
		t.Fatal(err)
	}
}

// waitFor polls cond: eviction runs in its own goroutine.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// settled waits until no eviction is running and returns the accounted size.
func settled(t *testing.T, c *diskCache) int64 {
	t.Helper()
	var size int64
	waitFor(t, "eviction to finish", func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		size = c.size
		return !c.evicting
	})
	return size
}

func get(t *testing.T, e *echo.Echo, p *Proxy, rawURL string) *httptest.ResponseRecorder {
	t.Helper()
	return do(e, http.MethodGet, "/img/"+p.Token(rawURL), nil)
}

func TestCacheMissThenHit(t *testing.T) {
	img := make([]byte, 4096)
	rand.Read(img)
	up := newUpstream(t, img)
	p, e, dir := cachedServer(t, 1<<20)
	target := up.URL + "/ok.png"

	miss := get(t, e, p, target)
	if miss.Code != http.StatusOK || miss.Header().Get("X-Cache") != "MISS" {
		t.Fatalf("first request: status %d, X-Cache %q", miss.Code, miss.Header().Get("X-Cache"))
	}
	if up.hits.Load() != 1 {
		t.Fatalf("first request made %d upstream requests, want 1", up.hits.Load())
	}

	entry := p.cache.entryPath(cacheKey(target))
	if got := cacheFiles(t, dir); len(got) != 1 || got[0] != filepath.Join(cacheKey(target)[:2], cacheKey(target)) {
		t.Fatalf("cache files = %v, want the one sha256(url) entry in its two-hex shard", got)
	}
	if !exists(entry) {
		t.Fatalf("no entry at %s", entry)
	}

	hit := get(t, e, p, target)
	if hit.Code != http.StatusOK || hit.Header().Get("X-Cache") != "HIT" {
		t.Fatalf("second request: status %d, X-Cache %q", hit.Code, hit.Header().Get("X-Cache"))
	}
	if up.hits.Load() != 1 {
		t.Fatalf("the hit reached the upstream (%d requests)", up.hits.Load())
	}
	if string(hit.Body.Bytes()) != string(img) {
		t.Fatal("cached body differs from the upstream image")
	}
	for _, k := range []string{
		"Content-Type", "Content-Length", "Cache-Control", "Etag", "Last-Modified",
		"X-Content-Type-Options", "Content-Security-Policy",
	} {
		if hit.Header().Get(k) == "" || hit.Header().Get(k) != miss.Header().Get(k) {
			t.Errorf("%s: hit %q, miss %q", k, hit.Header().Get(k), miss.Header().Get(k))
		}
	}
	if hit.Header().Get("Set-Cookie") != "" {
		t.Error("upstream Set-Cookie leaked from the cache")
	}
}

func TestCacheHead(t *testing.T) {
	img := make([]byte, 1024)
	up := newUpstream(t, img)
	p, e, dir := cachedServer(t, 1<<20)
	tok := "/img/" + p.Token(up.URL+"/ok.png")

	rec := do(e, http.MethodHead, tok, nil)
	if rec.Code != http.StatusOK || rec.Body.Len() != 0 || rec.Header().Get("X-Cache") != "MISS" {
		t.Fatalf("HEAD miss: status %d, %d body bytes, X-Cache %q", rec.Code, rec.Body.Len(), rec.Header().Get("X-Cache"))
	}
	if n := len(cacheFiles(t, dir)); n != 0 {
		t.Fatalf("a HEAD request filled the cache (%d files)", n)
	}

	if rec := do(e, http.MethodGet, tok, nil); rec.Header().Get("X-Cache") != "MISS" {
		t.Fatalf("GET after HEAD: X-Cache %q, want MISS", rec.Header().Get("X-Cache"))
	}
	before := up.hits.Load()

	rec = do(e, http.MethodHead, tok, nil)
	if rec.Code != http.StatusOK || rec.Body.Len() != 0 || rec.Header().Get("X-Cache") != "HIT" {
		t.Fatalf("HEAD hit: status %d, %d body bytes, X-Cache %q", rec.Code, rec.Body.Len(), rec.Header().Get("X-Cache"))
	}
	if rec.Header().Get("Content-Type") != "image/png" || rec.Header().Get("Content-Length") != "1024" {
		t.Errorf("HEAD hit headers: %v", rec.Header())
	}
	if up.hits.Load() != before {
		t.Fatal("the HEAD hit reached the upstream")
	}
}

// Nothing that is not a complete image may be cached.
func TestCacheSkipsWhatIsNotACompleteImage(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		maxBody int64 // 0 keeps the default
		status  int
	}{
		{"body cut by the size cap", "/huge-chunked.png", 1024, http.StatusOK},
		{"upstream ends before its Content-Length", "/huge-declared.png", 1 << 20, http.StatusOK},
		{"declared size above the cap", "/huge-declared.png", 1024, http.StatusBadGateway},
		{"not an image", "/page.html", 0, http.StatusBadGateway},
		{"upstream 404", "/missing.png", 0, http.StatusNotFound},
		{"upstream 500", "/boom.png", 0, http.StatusBadGateway},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			up := newUpstream(t, make([]byte, 2000))
			p, e, dir := cachedServer(t, 1<<20)
			if tt.maxBody > 0 {
				p.maxBody = tt.maxBody
			}

			for i := 0; i < 2; i++ {
				if rec := get(t, e, p, up.URL+tt.path); rec.Code != tt.status {
					t.Fatalf("request %d: status %d, want %d", i+1, rec.Code, tt.status)
				} else if tt.status != http.StatusOK && rec.Header().Get("X-Cache") != "" {
					t.Errorf("error response carries X-Cache %q", rec.Header().Get("X-Cache"))
				}
			}
			if n := up.hits.Load(); n != 2 {
				t.Errorf("%d upstream requests for 2 client requests: something was served from the cache", n)
			}
			if files := cacheFiles(t, dir); len(files) != 0 {
				t.Errorf("cache holds %v, want nothing (not even a temp file)", files)
			}
		})
	}
}

// A chunked body has no declared size, so "complete" means upstream ended
// exactly at (or before) the cap, not just that the cap was reached.
func TestCacheChunkedBodyAtTheCap(t *testing.T) {
	tests := []struct {
		maxBody int64
		cached  bool
	}{
		{4096 + 1, true}, // 8 x 512 bytes arrive, upstream ended before the cap
		{4096, true},     // upstream ended exactly at the cap
		{4096 - 1, false},
	}
	for _, tt := range tests {
		up := newUpstream(t, nil)
		p, e, dir := cachedServer(t, 1<<20)
		p.maxBody = tt.maxBody

		get(t, e, p, up.URL+"/huge-chunked.png")
		if got := len(cacheFiles(t, dir)) == 1; got != tt.cached {
			t.Errorf("maxBody %d: cached = %v, want %v", tt.maxBody, got, tt.cached)
		}
	}
}

// failingWriter hands failAfter bytes to the client and then reports it as
// gone: the write that crosses that count takes what fits and returns an error.
type failingWriter struct {
	http.ResponseWriter
	failAfter int
	sent      int
}

var errClientGone = errors.New("client went away")

func (w *failingWriter) Write(b []byte) (int, error) {
	if w.sent+len(b) < w.failAfter {
		w.sent += len(b)
		return len(b), nil
	}
	n := w.failAfter - w.sent
	w.sent = w.failAfter
	return n, errClientGone
}

// The client may drop mid-body or only on the write that completes the body
// (every byte was handed over, so the byte count alone looks complete). Either
// way the entry must not be kept.
func TestCacheSkipsWhenTheClientDisconnects(t *testing.T) {
	const size = 4096
	for _, failAfter := range []int{100, size} {
		up := newUpstream(t, make([]byte, size))
		p, e, dir := cachedServer(t, 1<<20)

		req := httptest.NewRequest(http.MethodGet, "/img/x", nil)
		c := e.NewContext(req, &failingWriter{ResponseWriter: httptest.NewRecorder(), failAfter: failAfter})
		c.SetParamNames("token")
		c.SetParamValues(p.Token(up.URL + "/ok.png"))
		if err := p.Serve(c); err != nil {
			t.Fatal(err)
		}

		if files := cacheFiles(t, dir); len(files) != 0 {
			t.Fatalf("client failed after %d bytes: %v left in the cache", failAfter, files)
		}
	}
}

func TestCacheDisabledKeepsResponsesUnchanged(t *testing.T) {
	up := newUpstream(t, make([]byte, 512))
	p, e := testServer(t)
	if p.cache != nil {
		t.Fatal("no cache dir configured, yet a cache exists")
	}
	tok := "/img/" + p.Token(up.URL+"/ok.png")

	for _, method := range []string{http.MethodGet, http.MethodGet, http.MethodHead} {
		rec := do(e, method, tok, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d", method, rec.Code)
		}
		if _, ok := rec.Header()["X-Cache"]; ok {
			t.Errorf("%s: X-Cache header present with the cache off: %v", method, rec.Header()["X-Cache"])
		}
	}
	if n := up.hits.Load(); n != 3 {
		t.Errorf("%d upstream requests for 3 client requests, want 3", n)
	}
}

func TestCacheStillRejectsForgedTokens(t *testing.T) {
	up := newUpstream(t, make([]byte, 512))
	p, e, dir := cachedServer(t, 1<<20)
	good := p.Token(up.URL + "/ok.png")
	raw, err := base64.RawURLEncoding.DecodeString(good)
	if err != nil {
		t.Fatal(err)
	}
	raw[len(raw)-1] ^= 0x80
	get(t, e, p, up.URL+"/ok.png") // fills the cache
	before := up.hits.Load()

	for _, tok := range []string{
		good[:len(good)-4],
		base64.RawURLEncoding.EncodeToString(raw),
		"garbage",
		randKeyToken(t),
		cacheKey(up.URL + "/ok.png"), // the file name is not a way in
	} {
		assertEnvelope(t, do(e, http.MethodGet, "/img/"+tok, nil), http.StatusNotFound)
	}
	if up.hits.Load() != before || len(cacheFiles(t, dir)) != 1 {
		t.Fatal("a forged token reached the upstream or changed the cache")
	}
}

func randKeyToken(t *testing.T) string {
	t.Helper()
	other := newTestProxy(t, "127.0.0.1")
	return other.Token("http://127.0.0.1/x.png")
}

// A host that left the allowlist stays refused even while its image is cached.
func TestCacheDoesNotBypassTheAllowlist(t *testing.T) {
	up := newUpstream(t, make([]byte, 512))
	p, e, dir := cachedServer(t, 1<<20)
	get(t, e, p, up.URL+"/ok.png")
	if len(cacheFiles(t, dir)) != 1 {
		t.Fatal("the image was not cached")
	}

	p2 := New(Config{HMACKey: randKey(t), AllowedHosts: []string{"*.komiku.to"}, CacheDir: dir})
	p2.aead, p2.nonceKey = p.aead, p.nonceKey // same key, narrower allowlist
	e2 := echo.New()
	p2.Mount(e2)

	assertEnvelope(t, do(e2, http.MethodGet, "/img/"+p.Token(up.URL+"/ok.png"), nil), http.StatusNotFound)
}

func TestCacheEvictsLeastRecentlyUsedDownToNinetyPercent(t *testing.T) {
	up := newUpstream(t, make([]byte, 1000))
	p, e, dir := cachedServer(t, 1<<30)
	urls := make([]string, 6)
	for i := range urls {
		urls[i] = up.URL + "/ok.png?n=" + string(rune('a'+i))
	}

	get(t, e, p, urls[0])
	entry := fileSize(t, p.cache.entryPath(cacheKey(urls[0])))
	p.cache.maxBytes = entry*5 + entry/2 // 5.5 entries: the sixth overflows it

	for i := range urls {
		if i > 0 {
			get(t, e, p, urls[i])
		}
		if i < len(urls)-1 {
			age(t, p.cache.entryPath(cacheKey(urls[i])), time.Duration(len(urls)-i)*time.Hour)
		}
	}

	// 90% of 5.5 entries is 4.95: the two oldest go, four remain.
	waitFor(t, "the oldest entries to be evicted", func() bool { return len(cacheFiles(t, dir)) == 4 })
	for i, u := range urls {
		if got, want := exists(p.cache.entryPath(cacheKey(u))), i >= 2; got != want {
			t.Errorf("entry %d present = %v, want %v", i, got, want)
		}
	}
	if size := settled(t, p.cache); size != 4*entry {
		t.Errorf("accounted size %d, want %d", size, 4*entry)
	}
}

func TestCacheHitProtectsAnEntryFromEviction(t *testing.T) {
	up := newUpstream(t, make([]byte, 1000))
	p, e, _ := cachedServer(t, 1<<30)
	a, b, c := up.URL+"/ok.png?n=a", up.URL+"/ok.png?n=b", up.URL+"/ok.png?n=c"

	get(t, e, p, a)
	get(t, e, p, b)
	age(t, p.cache.entryPath(cacheKey(a)), 3*time.Hour)
	age(t, p.cache.entryPath(cacheKey(b)), 2*time.Hour)
	p.cache.maxBytes = fileSize(t, p.cache.entryPath(cacheKey(a)))*5/2 + 1 // room for two, not three

	if rec := get(t, e, p, a); rec.Header().Get("X-Cache") != "HIT" {
		t.Fatalf("X-Cache %q, want HIT", rec.Header().Get("X-Cache"))
	}
	get(t, e, p, c) // overflows: the entry nobody asked for lately must go

	waitFor(t, "an entry to be evicted", func() bool { return !exists(p.cache.entryPath(cacheKey(b))) })
	if !exists(p.cache.entryPath(cacheKey(a))) || !exists(p.cache.entryPath(cacheKey(c))) {
		t.Error("the entry that was just served, or the newest one, was evicted")
	}
}

func TestCacheStartupScan(t *testing.T) {
	up := newUpstream(t, make([]byte, 1000))
	p, e, dir := cachedServer(t, 1<<30)
	one, two := up.URL+"/ok.png?n=1", up.URL+"/ok.png?n=2"
	get(t, e, p, one)
	get(t, e, p, two)
	total := fileSize(t, p.cache.entryPath(cacheKey(one))) + fileSize(t, p.cache.entryPath(cacheKey(two)))

	// A crashed run leaves a temp file; the directory may also hold unrelated files.
	stale := filepath.Join(dir, cacheKey(one)[:2], cacheKey(one)+".123456.tmp")
	foreign := []string{
		filepath.Join(dir, "README.txt"),
		filepath.Join(dir, cacheKey(one)[:2], "notes.txt"),
		filepath.Join(dir, "other", strings.Repeat("a", 64)),
	}
	for _, path := range append(foreign, stale) {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	again := New(Config{HMACKey: randKey(t), AllowedHosts: []string{"127.0.0.1"}, CacheDir: dir, CacheMaxBytes: 1 << 30})
	if again.cache == nil {
		t.Fatal("the cache did not start on an existing directory")
	}
	if again.cache.size != total {
		t.Fatalf("scanned size %d, want %d", again.cache.size, total)
	}
	if exists(stale) {
		t.Error("the stale temp file was not removed")
	}
	for _, path := range foreign {
		if !exists(path) {
			t.Errorf("unrelated file %s was touched", path)
		}
	}

	// A smaller limit than what is on disk evicts at startup, newest entry last.
	age(t, p.cache.entryPath(cacheKey(one)), time.Hour)
	small := New(Config{HMACKey: randKey(t), AllowedHosts: []string{"127.0.0.1"}, CacheDir: dir, CacheMaxBytes: total * 3 / 4})
	waitFor(t, "the startup eviction", func() bool { return !exists(p.cache.entryPath(cacheKey(one))) })
	if !exists(p.cache.entryPath(cacheKey(two))) {
		t.Error("the newest entry was evicted")
	}
	if size := settled(t, small.cache); size != total/2 {
		t.Errorf("size after startup eviction %d, want %d", size, total/2)
	}
}

func TestCacheIsOffWhenItCannotStart(t *testing.T) {
	blocker := filepath.Join(t.TempDir(), "afile")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	up := newUpstream(t, make([]byte, 512))

	p := New(Config{HMACKey: randKey(t), AllowedHosts: []string{"127.0.0.1"}, CacheDir: filepath.Join(blocker, "cache")})
	if !p.Enabled() || p.cache != nil {
		t.Fatalf("proxy enabled = %v, cache = %v: want a working proxy without a cache", p.Enabled(), p.cache)
	}
	p.client = newClient(p, nil)
	e := echo.New()
	p.Mount(e)
	rec := get(t, e, p, up.URL+"/ok.png")
	if rec.Code != http.StatusOK || rec.Header().Get("X-Cache") != "" {
		t.Fatalf("status %d, X-Cache %q", rec.Code, rec.Header().Get("X-Cache"))
	}

	// With no usable key the proxy is off, and it must not touch the disk either.
	untouched := filepath.Join(t.TempDir(), "never-created")
	New(Config{CacheDir: untouched})
	if exists(untouched) {
		t.Error("a disabled proxy created the cache dir")
	}
}

func TestCacheReplacesCorruptEntries(t *testing.T) {
	img := make([]byte, 2048)
	rand.Read(img)
	corrupt := map[string]func([]byte) []byte{
		"garbage":           func([]byte) []byte { return []byte("garbage") },
		"trailer cut off":   func(b []byte) []byte { return b[:len(b)-10] },
		"body shortened":    func(b []byte) []byte { return b[5:] },
		"empty":             func([]byte) []byte { return nil },
		"only a zero trail": func([]byte) []byte { return []byte{0, 0, 0, 0} },
	}
	for name, damage := range corrupt {
		t.Run(name, func(t *testing.T) {
			up := newUpstream(t, img)
			p, e, _ := cachedServer(t, 1<<20)
			target := up.URL + "/ok.png"
			get(t, e, p, target)
			path := p.cache.entryPath(cacheKey(target))
			valid, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, damage(valid), 0o600); err != nil {
				t.Fatal(err)
			}

			rec := get(t, e, p, target)
			if rec.Header().Get("X-Cache") != "MISS" || string(rec.Body.Bytes()) != string(img) {
				t.Fatalf("damaged entry: X-Cache %q, body intact %v", rec.Header().Get("X-Cache"), string(rec.Body.Bytes()) == string(img))
			}
			if rec := get(t, e, p, target); rec.Header().Get("X-Cache") != "HIT" || string(rec.Body.Bytes()) != string(img) {
				t.Fatalf("after the refill: X-Cache %q", rec.Header().Get("X-Cache"))
			}
		})
	}
}

// Concurrent misses for one URL may all fetch; the atomic rename keeps one
// good entry and the byte accounting must not double count it.
func TestCacheConcurrentMisses(t *testing.T) {
	img := make([]byte, 64<<10)
	rand.Read(img)
	up := newUpstream(t, img)
	p, e, dir := cachedServer(t, 1<<20)
	target := up.URL + "/ok.png"

	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := get(t, e, p, target)
			if rec.Code != http.StatusOK || string(rec.Body.Bytes()) != string(img) {
				t.Errorf("status %d, body intact %v", rec.Code, string(rec.Body.Bytes()) == string(img))
			}
		}()
	}
	wg.Wait()

	files := cacheFiles(t, dir)
	if len(files) != 1 || strings.HasSuffix(files[0], tempSuffix) {
		t.Fatalf("cache files = %v, want exactly the one entry", files)
	}
	if size := settled(t, p.cache); size != fileSize(t, p.cache.entryPath(cacheKey(target))) {
		t.Errorf("accounted size %d, file is %d bytes", size, fileSize(t, p.cache.entryPath(cacheKey(target))))
	}
}

func TestCacheConfigDefaults(t *testing.T) {
	dir := t.TempDir()
	p := New(Config{HMACKey: randKey(t), AllowedHosts: []string{"127.0.0.1"}, CacheDir: dir, CacheMaxBytes: -5})
	if p.cache == nil || p.cache.maxBytes != defaultCacheMaxBytes {
		t.Fatalf("cache %+v, want the default limit of %d bytes", p.cache, defaultCacheMaxBytes)
	}
}
