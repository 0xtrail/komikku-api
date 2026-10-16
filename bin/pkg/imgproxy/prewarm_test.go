package imgproxy

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
)

// prewarmServer is cachedServer with prewarming on. The per-host pause is off so
// tests do not wait; workers only run once the test calls start.
func prewarmServer(t *testing.T, workers, queue int) (*Proxy, *echo.Echo, string) {
	t.Helper()
	dir := t.TempDir()
	p := New(Config{
		HMACKey:            randKey(t),
		AllowedHosts:       []string{"127.0.0.1"},
		CacheDir:           dir,
		CacheMaxBytes:      1 << 30,
		PrewarmConcurrency: workers,
		PrewarmQueue:       queue,
	})
	if !p.PrewarmEnabled() {
		t.Fatal("prewarming must be enabled")
	}
	p.client = newClient(p, nil)
	p.prewarm.gate.interval, p.prewarm.gate.jitter = 0, 0
	e := echo.New()
	p.Mount(e)
	return p, e, dir
}

// start runs the workers and joins them when the test ends.
func start(t *testing.T, p *Proxy) context.CancelFunc {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	p.Start(ctx)
	t.Cleanup(func() {
		cancel()
		done := make(chan struct{})
		go func() {
			p.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("the prewarm workers did not stop after the context was cancelled")
		}
	})
	return cancel
}

// captureStdLog collects what the package logs through the standard logger.
func captureStdLog(t *testing.T) func() string {
	t.Helper()
	var mu sync.Mutex
	var buf bytes.Buffer
	log.SetOutput(writerFunc(func(b []byte) (int, error) {
		mu.Lock()
		defer mu.Unlock()
		return buf.Write(b)
	}))
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	return func() string {
		mu.Lock()
		defer mu.Unlock()
		return buf.String()
	}
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(b []byte) (int, error) { return f(b) }

func urls(base string, n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("%s/ok.png?n=%d", base, i)
	}
	return out
}

func TestPrewarmFillsTheCacheSoTheNextRequestIsAHit(t *testing.T) {
	img := make([]byte, 2048)
	rand.Read(img)
	up := newUpstream(t, img)
	p, e, dir := prewarmServer(t, 3, 0)
	start(t, p)

	list := urls(up.URL, 5)
	p.Prewarm(list)
	waitFor(t, "the prewarm to fill 5 entries", func() bool { return p.stats.filled.Load() == 5 })

	if n := up.hits.Load(); n != 5 {
		t.Fatalf("%d upstream requests for 5 images", n)
	}
	for _, u := range list {
		rec := get(t, e, p, u)
		if rec.Code != http.StatusOK || rec.Header().Get("X-Cache") != "HIT" || string(rec.Body.Bytes()) != string(img) {
			t.Fatalf("%s: status %d, X-Cache %q, body intact %v", u, rec.Code, rec.Header().Get("X-Cache"), string(rec.Body.Bytes()) == string(img))
		}
	}
	if n := up.hits.Load(); n != 5 {
		t.Errorf("the requests reached the upstream again (%d hits)", n)
	}
	if p.stats.hit.Load() != 5 || p.stats.miss.Load() != 0 {
		t.Errorf("stats hit=%d miss=%d, want 5 and 0", p.stats.hit.Load(), p.stats.miss.Load())
	}
	for _, f := range cacheFiles(t, dir) {
		if strings.HasSuffix(f, tempSuffix) {
			t.Errorf("temp file left behind: %s", f)
		}
	}
}

func TestPrewarmSkipsWhatIsCachedQueuedOrInFlight(t *testing.T) {
	up := newUpstream(t, make([]byte, 512))
	p, e, _ := prewarmServer(t, 2, 0)

	// Already cached by a real request: not queued, no upstream request.
	cached := up.URL + "/ok.png?n=cached"
	get(t, e, p, cached)
	before := up.hits.Load()
	p.Prewarm([]string{cached})
	if len(p.prewarm.queue) != 0 || p.stats.skipped.Load() != 1 {
		t.Fatalf("a cached image was queued (queue %d, skipped %d)", len(p.prewarm.queue), p.stats.skipped.Load())
	}

	// The same URL again and again, before the workers run: queued once.
	dup := up.URL + "/ok.png?n=dup"
	p.Prewarm([]string{dup, dup, dup})
	p.Prewarm([]string{dup})
	if len(p.prewarm.queue) != 1 || len(p.prewarm.pending) != 1 {
		t.Fatalf("queue %d, pending %d, want 1 each", len(p.prewarm.queue), len(p.prewarm.pending))
	}

	start(t, p)
	waitFor(t, "the one queued image", func() bool { return p.stats.filled.Load() == 1 })
	waitFor(t, "the worker to release the URL", func() bool {
		p.prewarm.mu.Lock()
		defer p.prewarm.mu.Unlock()
		return len(p.prewarm.pending) == 0
	})
	if n := up.hits.Load() - before; n != 1 {
		t.Errorf("%d upstream requests for one queued URL, want 1", n)
	}
}

func TestPrewarmIsOffWithoutTheCacheOrConcurrency(t *testing.T) {
	up := newUpstream(t, make([]byte, 512))
	tests := map[string]Config{
		"cache off":        {HMACKey: randKey(t), AllowedHosts: []string{"127.0.0.1"}, PrewarmConcurrency: 3},
		"concurrency 0":    {HMACKey: randKey(t), AllowedHosts: []string{"127.0.0.1"}, CacheDir: t.TempDir()},
		"proxy has no key": {AllowedHosts: []string{"127.0.0.1"}, CacheDir: t.TempDir(), PrewarmConcurrency: 3},
	}
	for name, cfg := range tests {
		p := New(cfg)
		p.client = newClient(p, nil)
		if p.PrewarmEnabled() {
			t.Errorf("%s: PrewarmEnabled() is true", name)
		}
		p.Prewarm(urls(up.URL, 3))
		ctx, cancel := context.WithCancel(context.Background())
		p.Start(ctx)
		cancel()
		p.Wait() // must return at once: no workers
	}
	time.Sleep(50 * time.Millisecond)
	if n := up.hits.Load(); n != 0 {
		t.Fatalf("%d upstream requests although prewarming is off", n)
	}
}

func TestPrewarmQueueIsBoundedAndDropsTheNewest(t *testing.T) {
	up := newUpstream(t, make([]byte, 512))
	p, _, _ := prewarmServer(t, 2, 3)
	logs := captureStdLog(t)

	list := urls(up.URL, 10)
	p.Prewarm(list)
	if len(p.prewarm.queue) != 3 {
		t.Fatalf("queue holds %d, want the bound of 3", len(p.prewarm.queue))
	}
	if p.stats.dropped.Load() != 7 {
		t.Errorf("dropped %d, want 7", p.stats.dropped.Load())
	}
	if n := strings.Count(logs(), "prewarm queue is full"); n != 1 {
		t.Errorf("the overflow was logged %d times, want once per burst", n)
	}

	start(t, p)
	waitFor(t, "the queued images", func() bool { return p.stats.filled.Load() == 3 })
	time.Sleep(50 * time.Millisecond)
	if n := up.hits.Load(); n != 3 {
		t.Errorf("%d upstream requests, want only the 3 that were queued", n)
	}
	for i, u := range list {
		if got, want := p.cache.has(cacheKey(u)), i < 3; got != want {
			t.Errorf("URL %d cached = %v, want %v (the newest are dropped)", i, got, want)
		}
	}
}

func TestPrewarmNeverFetchesWhatIsNotAllowed(t *testing.T) {
	up := newUpstream(t, make([]byte, 512))
	p, _, dir := prewarmServer(t, 2, 0)
	start(t, p)

	// localhost reaches the same fake CDN, but only 127.0.0.1 is on the allowlist.
	other := strings.Replace(up.URL, "127.0.0.1", "localhost", 1)
	bad := []string{
		other + "/ok.png",
		"file:///etc/passwd",
		"ftp://127.0.0.1/x.png",
		"http://user:pw@127.0.0.1/x.png",
		"/relative.png",
		"https://evil.example/x.png",
		"",
	}
	p.Prewarm(bad)
	for _, raw := range bad {
		p.prewarmOne(context.Background(), raw) // the worker re-checks as well
	}
	time.Sleep(50 * time.Millisecond)

	if n := up.hits.Load(); n != 0 {
		t.Fatalf("%d upstream requests for URLs that are not allowed", n)
	}
	if len(p.prewarm.queue) != 0 || len(cacheFiles(t, dir)) != 0 {
		t.Error("a disallowed URL was queued or cached")
	}

	// An allowed URL that redirects off the allowlist is refused by the same
	// redirect check a real request uses.
	p.Prewarm([]string{up.URL + "/to-localhost"})
	waitFor(t, "the failed prewarm", func() bool { return p.stats.failed.Load() == 1 })
	if len(cacheFiles(t, dir)) != 0 {
		t.Error("a redirect to a disallowed host left something in the cache")
	}
}

// Prewarming caches only what a real request would have served and cached.
func TestPrewarmCachesNothingThatIsNotACompleteImage(t *testing.T) {
	up := newUpstream(t, make([]byte, 2000))
	p, _, dir := prewarmServer(t, 2, 0)
	p.maxBody = 1024
	start(t, p)

	paths := []string{"/page.html", "/missing.png", "/boom.png", "/huge-declared.png", "/huge-chunked.png"}
	var list []string
	for _, path := range paths {
		list = append(list, up.URL+path)
	}
	p.Prewarm(list)
	waitFor(t, "every prewarm to finish", func() bool { return p.stats.failed.Load() == int64(len(paths)) })

	if files := cacheFiles(t, dir); len(files) != 0 {
		t.Errorf("the cache holds %v, want nothing", files)
	}
	// The failed URLs are released: a later attempt may queue them again.
	waitFor(t, "the pending set to drain", func() bool {
		p.prewarm.mu.Lock()
		defer p.prewarm.mu.Unlock()
		return len(p.prewarm.pending) == 0
	})
}

func TestPrewarmStopsWhenTheContextIsCancelled(t *testing.T) {
	var started, aborted atomic.Int32
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Content-Length", "1000000")
		w.Write(make([]byte, 100))
		w.(http.Flusher).Flush()
		started.Add(1)
		<-r.Context().Done() // hold the body open until the client goes away
		aborted.Add(1)
	}))
	defer slow.Close()

	p, _, dir := prewarmServer(t, 3, 0)
	cancel := start(t, p)

	p.Prewarm(urls(slow.URL, 8))
	waitFor(t, "3 fetches in flight", func() bool { return started.Load() == 3 })

	cancel()
	done := make(chan struct{})
	go func() {
		p.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the workers did not stop after the context was cancelled")
	}

	waitFor(t, "the in-flight requests to be aborted", func() bool { return aborted.Load() == 3 })
	if started.Load() != 3 {
		t.Errorf("%d fetches started, the other queued URLs must stay untouched", started.Load())
	}
	if files := cacheFiles(t, dir); len(files) != 0 {
		t.Errorf("an aborted fetch left %v in the cache", files)
	}
}

func TestHostGateSpacesRequestsPerHost(t *testing.T) {
	g := hostGate{next: map[string]time.Time{}, interval: 100 * time.Millisecond}
	now := time.Now()

	var waits []time.Duration
	for i := 0; i < 3; i++ {
		waits = append(waits, g.reserve("a.example", now))
	}
	if waits[0] != 0 || waits[1] != 100*time.Millisecond || waits[2] != 200*time.Millisecond {
		t.Errorf("waits for one host = %v, want 0, 100ms, 200ms", waits)
	}
	if w := g.reserve("b.example", now); w != 0 {
		t.Errorf("another host waited %v", w)
	}
	if w := g.reserve("a.example", now.Add(time.Hour)); w != 0 {
		t.Errorf("a slot in the past still waited %v", w)
	}

	g.jitter = 50 * time.Millisecond
	g.reserve("c.example", now)
	if w := g.reserve("c.example", now); w < 100*time.Millisecond || w >= 150*time.Millisecond {
		t.Errorf("jittered gap %v outside [100ms, 150ms)", w)
	}
}

func TestPrewarmWorkersPauseBetweenRequestsToOneHost(t *testing.T) {
	up := newUpstream(t, make([]byte, 256))
	p, _, _ := prewarmServer(t, 3, 0)
	p.prewarm.gate.interval = 60 * time.Millisecond
	start(t, p)

	began := time.Now()
	p.Prewarm(urls(up.URL, 4))
	waitFor(t, "4 fills", func() bool { return p.stats.filled.Load() == 4 })
	// Three workers could finish at once; the gate forces 3 intervals in between.
	if elapsed := time.Since(began); elapsed < 150*time.Millisecond {
		t.Errorf("4 requests to one host took %v: no pause between them", elapsed)
	}
}

func TestStatsLineIsRateLimitedAndSkipsQuietPeriods(t *testing.T) {
	up := newUpstream(t, make([]byte, 256))
	p, e, _ := prewarmServer(t, 1, 0)
	logs := captureStdLog(t)

	// A fresh proxy does not log at once: the first line comes after an interval.
	p.logStats()
	if strings.Contains(logs(), "imgproxy: cache last") {
		t.Fatal("a stats line was written before the interval elapsed")
	}

	p.stats.every = time.Hour
	get(t, e, p, up.URL+"/ok.png") // MISS
	get(t, e, p, up.URL+"/ok.png") // HIT
	p.stats.filled.Add(2)
	p.stats.dropped.Add(1)
	p.stats.sample = "upstream 404"

	p.stats.lastLog.Store(time.Now().Add(-2 * time.Hour).UnixNano())
	p.logStats()
	p.logStats() // inside the interval: no second line
	out := logs()
	if n := strings.Count(out, "imgproxy: cache last"); n != 1 {
		t.Fatalf("%d stats lines, want 1:\n%s", n, out)
	}
	for _, want := range []string{"hit=1", "miss=1", "filled=2", "dropped=1", "(last failure: upstream 404)"} {
		if !strings.Contains(out, want) {
			t.Errorf("stats line misses %q:\n%s", want, out)
		}
	}

	// Nothing happened since: the next interval stays quiet.
	p.stats.lastLog.Store(time.Now().Add(-2 * time.Hour).UnixNano())
	p.logStats()
	if n := strings.Count(logs(), "imgproxy: cache last"); n != 1 {
		t.Errorf("a quiet period wrote a line (%d lines)", n)
	}
}

// endsWith is a response body that yields data and then fails with err instead of
// io.EOF, the way an HTTP/2 body does when the request was cancelled before the
// end of the stream was read.
type endsWith struct {
	data []byte
	err  error
}

func (b *endsWith) Read(p []byte) (int, error) {
	if len(b.data) == 0 {
		return 0, b.err
	}
	n := copy(p, b.data)
	b.data = b.data[n:]
	return n, nil
}

func (b *endsWith) Close() error { return nil }

func TestStreamCachesAnImageWhoseClientHungUpAfterTheLastByte(t *testing.T) {
	img := make([]byte, 3000)
	rand.Read(img)
	target := "https://img.komiku.org/late-cancel.png"

	tests := []struct {
		name      string
		body      []byte
		err       error
		published bool
	}{
		{"every declared byte copied, then the cancel", img, context.Canceled, true},
		{"cancelled before the last byte", img[:2999], context.Canceled, false},
		{"another read error after every byte", img, errors.New("connection reset"), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p, _, dir := cachedServer(t, 1<<20)
			resp := &http.Response{
				StatusCode:    http.StatusOK,
				ContentLength: int64(len(img)),
				Body:          &endsWith{data: tt.body, err: tt.err},
			}
			meta := entryMeta{ContentType: "image/png", Size: int64(len(img))}

			var sent bytes.Buffer
			got := p.stream(&sent, resp, meta, target)

			if got != tt.published {
				t.Fatalf("published = %v, want %v", got, tt.published)
			}
			if files := cacheFiles(t, dir); got != (len(files) == 1) {
				t.Fatalf("published = %v but the cache holds %d files", got, len(files))
			}
		})
	}
}
