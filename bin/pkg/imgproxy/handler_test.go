package imgproxy

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/labstack/echo/v4"
)

// upstream is a fake CDN on 127.0.0.1. Tests that use it swap in a client
// without the dial guard (the guard would, correctly, refuse loopback).
type upstream struct {
	*httptest.Server
	hits atomic.Int32

	mu      sync.Mutex
	lastHdr http.Header
}

func (u *upstream) last() http.Header {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.lastHdr
}

func newUpstream(t *testing.T, img []byte) *upstream {
	t.Helper()
	u := &upstream{}
	mux := http.NewServeMux()
	record := func(r *http.Request) {
		u.hits.Add(1)
		u.mu.Lock()
		u.lastHdr = r.Header.Clone()
		u.mu.Unlock()
	}
	mux.HandleFunc("/ok.png", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Content-Length", strconv.Itoa(len(img)))
		w.Header().Set("ETag", `"abc123"`)
		w.Header().Set("Last-Modified", "Tue, 15 Nov 1994 12:45:26 GMT")
		w.Header().Set("Set-Cookie", "session=upstream-secret")
		w.Write(img)
	})
	mux.HandleFunc("/page.html", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte("<html>upstream-secret-page</html>"))
	})
	mux.HandleFunc("/missing.png", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		http.NotFound(w, r)
	})
	mux.HandleFunc("/boom.png", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		http.Error(w, "boom", http.StatusInternalServerError)
	})
	mux.HandleFunc("/huge-declared.png", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Content-Length", "100000")
		w.Write(img)
	})
	mux.HandleFunc("/huge-chunked.png", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		w.Header().Set("Content-Type", "image/png")
		for i := 0; i < 8; i++ {
			w.Write(make([]byte, 512))
			w.(http.Flusher).Flush()
		}
	})
	mux.HandleFunc("/redir/", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		n, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/redir/"))
		if n <= 0 {
			w.Header().Set("Content-Type", "image/png")
			w.Write(img)
			return
		}
		http.Redirect(w, r, fmt.Sprintf("/redir/%d", n-1), http.StatusFound)
	})
	mux.HandleFunc("/to-internal", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		http.Redirect(w, r, "http://169.254.169.254/latest/meta-data/", http.StatusFound)
	})
	mux.HandleFunc("/to-localhost", func(w http.ResponseWriter, r *http.Request) {
		record(r)
		http.Redirect(w, r, "http://localhost:1/x.png", http.StatusFound)
	})
	u.Server = httptest.NewServer(mux)
	t.Cleanup(u.Close)
	return u
}

// testServer returns an echo app with the proxy mounted. The proxy allows
// 127.0.0.1 and has an unguarded client so the fake upstream is reachable.
func testServer(t *testing.T) (*Proxy, *echo.Echo) {
	t.Helper()
	p := newTestProxy(t, "127.0.0.1")
	p.client = newClient(p, nil)
	e := echo.New()
	p.Mount(e)
	return p, e
}

func do(e *echo.Echo, method, path string, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec
}

func assertEnvelope(t *testing.T, rec *httptest.ResponseRecorder, code int) {
	t.Helper()
	if rec.Code != code {
		t.Fatalf("status = %d, want %d (body %q)", rec.Code, code, rec.Body.String())
	}
	var env struct {
		Success bool            `json:"success"`
		Data    json.RawMessage `json:"data"`
		Message string          `json:"message"`
		Code    int             `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("body is not the error envelope: %v (%q)", err, rec.Body.String())
	}
	if env.Success || env.Code != code || env.Message == "" {
		t.Fatalf("unexpected envelope %+v", env)
	}
}

func TestServeStreamsImage(t *testing.T) {
	img := make([]byte, 4096)
	rand.Read(img)
	up := newUpstream(t, img)
	p, e := testServer(t)

	rec := do(e, http.MethodGet, "/img/"+p.Token(up.URL+"/ok.png"), map[string]string{
		"Cookie":        "sid=client-secret",
		"Authorization": "Bearer client-secret",
		"Referer":       "https://frontend.example/",
		"Origin":        "https://frontend.example",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if string(rec.Body.Bytes()) != string(img) {
		t.Fatal("body differs from the upstream image")
	}
	h := rec.Header()
	for k, want := range map[string]string{
		"Content-Type":            "image/png",
		"Content-Length":          strconv.Itoa(len(img)),
		"Cache-Control":           "public, max-age=2592000, immutable",
		"Etag":                    `"abc123"`,
		"Last-Modified":           "Tue, 15 Nov 1994 12:45:26 GMT",
		"X-Content-Type-Options":  "nosniff",
		"Content-Security-Policy": "default-src 'none'; sandbox",
	} {
		if got := h.Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	if h.Get("Set-Cookie") != "" {
		t.Error("upstream Set-Cookie leaked to the client")
	}

	got := up.last()
	for _, k := range []string{"Cookie", "Authorization", "Referer", "Origin"} {
		if v := got.Get(k); v != "" {
			t.Errorf("client header %s was forwarded upstream: %q", k, v)
		}
	}
	if ua := got.Get("User-Agent"); !strings.HasPrefix(ua, "Mozilla/5.0") {
		t.Errorf("User-Agent = %q", ua)
	}
}

func TestServeHead(t *testing.T) {
	img := make([]byte, 1024)
	up := newUpstream(t, img)
	p, e := testServer(t)

	rec := do(e, http.MethodHead, "/img/"+p.Token(up.URL+"/ok.png"), nil)
	if rec.Code != http.StatusOK || rec.Body.Len() != 0 {
		t.Fatalf("HEAD: status %d, body %d bytes", rec.Code, rec.Body.Len())
	}
	if rec.Header().Get("Content-Type") != "image/png" || rec.Header().Get("Content-Length") != "1024" {
		t.Errorf("HEAD headers: %v", rec.Header())
	}
}

func TestServeDisabled(t *testing.T) {
	up := newUpstream(t, []byte("x"))
	issuer := newTestProxy(t, "127.0.0.1")
	tok := issuer.Token(up.URL + "/ok.png")

	disabled := New(Config{AllowedHosts: []string{"127.0.0.1"}})
	disabled.client = newClient(disabled, nil)
	e := echo.New()
	disabled.Mount(e)

	assertEnvelope(t, do(e, http.MethodGet, "/img/"+tok, nil), http.StatusNotFound)
	if up.hits.Load() != 0 {
		t.Fatal("disabled proxy made an upstream request")
	}
}

func TestServeRejectsBadTokensWithoutUpstreamRequest(t *testing.T) {
	up := newUpstream(t, []byte("x"))
	p, e := testServer(t)
	good := p.Token(up.URL + "/ok.png")
	raw, _ := base64.RawURLEncoding.DecodeString(good)

	flip := func(i int) string {
		m := append([]byte{}, raw...)
		m[i] ^= 0x80
		return base64.RawURLEncoding.EncodeToString(m)
	}
	other := newTestProxy(t, "127.0.0.1") // different key

	for _, tok := range map[string]string{
		"flipped nonce":      flip(0),
		"flipped ciphertext": flip(nonceLen + 3),
		"flipped tag":        flip(len(raw) - 1),
		"truncated":          good[:len(good)-4],
		"garbage":            "garbage",
		"other key":          other.Token(up.URL + "/ok.png"),
		"unsigned url":       base64.RawURLEncoding.EncodeToString([]byte(up.URL + "/ok.png")),
	} {
		assertEnvelope(t, do(e, http.MethodGet, "/img/"+tok, nil), http.StatusNotFound)
	}
	if n := up.hits.Load(); n != 0 {
		t.Fatalf("%d upstream requests for rejected tokens", n)
	}
}

// Correctly encrypted tokens for URLs the proxy must never fetch.
func TestServeRejectsDisallowedTargets(t *testing.T) {
	up := newUpstream(t, []byte("x"))
	p, e := testServer(t)

	for _, target := range []string{
		"http://169.254.169.254/latest/meta-data/",
		"https://evil.example.com/x.jpg",
		"http://localhost:18090/",
		"file:///etc/passwd",
		"ftp://127.0.0.1/x.png",
		"http://user:pw@127.0.0.1/x.png",
		"/relative.png",
		"http://127.0.0.1.evil.test/x.png",
	} {
		assertEnvelope(t, do(e, http.MethodGet, "/img/"+p.Token(target), nil), http.StatusNotFound)
	}

	// Valid when issued, but the allowlist no longer covers the host.
	p2, e2 := testServer(t)
	p2.hosts, _ = newHostMatcher([]string{"*.komiku.to"})
	p2.aead, p2.nonceKey = p.aead, p.nonceKey // same key, narrower allowlist
	assertEnvelope(t, do(e2, http.MethodGet, "/img/"+p.Token(up.URL+"/ok.png"), nil), http.StatusNotFound)

	if n := up.hits.Load(); n != 0 {
		t.Fatalf("%d upstream requests for disallowed targets", n)
	}
}

func TestServeUpstreamFailures(t *testing.T) {
	up := newUpstream(t, make([]byte, 2000))
	p, e := testServer(t)
	p.maxBody = 1024

	tests := []struct {
		path string
		want int
	}{
		{"/missing.png", http.StatusNotFound},
		{"/boom.png", http.StatusBadGateway},
		{"/page.html", http.StatusBadGateway},
		{"/huge-declared.png", http.StatusBadGateway},
		{"/to-internal", http.StatusBadGateway},
		{"/to-localhost", http.StatusBadGateway},
		{"/redir/4", http.StatusBadGateway},
	}
	for _, tt := range tests {
		rec := do(e, http.MethodGet, "/img/"+p.Token(up.URL+tt.path), nil)
		assertEnvelope(t, rec, tt.want)
		if strings.Contains(rec.Body.String(), "upstream-secret") {
			t.Errorf("%s: upstream body leaked", tt.path)
		}
	}

	// Port that nothing listens on: connection error, not a hang or a panic.
	assertEnvelope(t, do(e, http.MethodGet, "/img/"+p.Token("http://127.0.0.1:1/x.png"), nil), http.StatusBadGateway)
}

func TestServeBodyCap(t *testing.T) {
	up := newUpstream(t, nil)
	p, e := testServer(t)
	p.maxBody = 1024

	rec := do(e, http.MethodGet, "/img/"+p.Token(up.URL+"/huge-chunked.png"), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	if rec.Body.Len() != 1024 {
		t.Fatalf("streamed %d bytes, the cap is 1024", rec.Body.Len())
	}
}

func TestServeRedirects(t *testing.T) {
	img := make([]byte, 256)
	up := newUpstream(t, img)
	p, e := testServer(t)

	rec := do(e, http.MethodGet, "/img/"+p.Token(up.URL+"/redir/3"), nil)
	if rec.Code != http.StatusOK || rec.Body.Len() != len(img) {
		t.Fatalf("3 redirects must be followed: status %d, %d bytes", rec.Code, rec.Body.Len())
	}
	if ref := up.last().Get("Referer"); ref != "" {
		t.Errorf("Referer sent on redirect: %q", ref)
	}

	before := up.hits.Load()
	assertEnvelope(t, do(e, http.MethodGet, "/img/"+p.Token(up.URL+"/redir/4"), nil), http.StatusBadGateway)
	if n := up.hits.Load() - before; n != 4 {
		t.Errorf("4 redirects: %d requests reached upstream, want 4 (the 5th must not be made)", n)
	}
}

// The real client, built by New, must refuse to connect to a loopback address
// even though the host name passes the allowlist.
func TestServeDialGuardBlocksLoopback(t *testing.T) {
	up := newUpstream(t, []byte("x"))
	p := New(Config{HMACKey: randKey(t), AllowedHosts: []string{"127.0.0.1"}})
	e := echo.New()
	p.Mount(e)

	assertEnvelope(t, do(e, http.MethodGet, "/img/"+p.Token(up.URL+"/ok.png"), nil), http.StatusBadGateway)
	if n := up.hits.Load(); n != 0 {
		t.Fatalf("dial guard let %d requests through to loopback", n)
	}
}
