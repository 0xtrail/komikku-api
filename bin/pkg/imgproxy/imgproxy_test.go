package imgproxy

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
)

// randKey returns a fresh master key in the PROXY_HMAC_KEY format: standard
// base64 of 32 random bytes. No key is ever hardcoded in tests.
func randKey(t testing.TB) string {
	t.Helper()
	b := make([]byte, KeyLen)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(b)
}

func newTestProxy(t testing.TB, hosts ...string) *Proxy {
	t.Helper()
	if len(hosts) == 0 {
		hosts = []string{"*.komiku.to", "*.komiku.org"}
	}
	p := New(Config{HMACKey: randKey(t), AllowedHosts: hosts})
	if !p.Enabled() {
		t.Fatal("proxy with a valid key must be enabled")
	}
	return p
}

const sampleURL = "https://thumbnail.komiku.to/img/upload/a_revenge_guide_for_the_terminally/img_68958eb08bd664.81717823.jpg"

func TestParseKey(t *testing.T) {
	b32 := make([]byte, 32)
	rand.Read(b32)
	urlSafe := bytes.Repeat([]byte{0xfb}, 32) // URL-safe base64 of this contains '-'

	tests := []struct {
		name string
		in   string
		ok   bool
	}{
		{"32 bytes", base64.StdEncoding.EncodeToString(b32), true},
		{"32 bytes with surrounding whitespace", "  " + base64.StdEncoding.EncodeToString(b32) + "\n", true},
		{"16 bytes", base64.StdEncoding.EncodeToString(b32[:16]), false},
		{"31 bytes", base64.StdEncoding.EncodeToString(b32[:31]), false},
		{"33 bytes", base64.StdEncoding.EncodeToString(append(append([]byte{}, b32...), 1)), false},
		{"not base64", "short", false},
		{"not base64 punctuation", strings.Repeat("!", 44), false},
		{"url-safe alphabet", base64.URLEncoding.EncodeToString(urlSafe), false},
		{"empty", "", false},
		{"whitespace only", "   ", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			key, err := ParseKey(tt.in)
			if (err == nil) != tt.ok {
				t.Fatalf("ParseKey ok=%v, want %v (err=%v)", err == nil, tt.ok, err)
			}
			if tt.ok && len(key) != KeyLen {
				t.Fatalf("key length %d", len(key))
			}
			if k := strings.TrimSpace(tt.in); err != nil && k != "" && strings.Contains(err.Error(), k) {
				t.Fatalf("error leaks the key: %v", err)
			}

			p := New(Config{HMACKey: tt.in, AllowedHosts: []string{"*.komiku.to"}})
			if p.Enabled() != tt.ok {
				t.Fatalf("Enabled()=%v, want %v", p.Enabled(), tt.ok)
			}
			if !tt.ok {
				if got := p.Rewrite("https://api.test", sampleURL); got != sampleURL {
					t.Fatalf("disabled proxy rewrote the URL: %q", got)
				}
				if _, ok := p.Verify("anything"); ok {
					t.Fatal("disabled proxy verified a token")
				}
			}
		})
	}
}

func TestTokenRoundtrip(t *testing.T) {
	p := newTestProxy(t)
	for _, u := range []string{
		sampleURL,
		"https://image2.komiku.to/upload5/a-revenge-guide-for-the-terminally/1/2025-08-08/1.jpg",
		"http://img.komiku.org/x.png?resize=450,235&quality=60",
		"https://komiku.to/ü ñ/ space.jpg",
		"x",
	} {
		tok := p.Token(u)
		got, ok := p.Verify(tok)
		if !ok || got != u {
			t.Fatalf("roundtrip of %q failed: got %q ok=%v", u, got, ok)
		}
		if strings.ContainsAny(tok, "./+= ") {
			t.Fatalf("token %q is not plain base64url without padding", tok)
		}
	}
}

func TestTokenDeterministicAndDistinct(t *testing.T) {
	p := newTestProxy(t)
	if a, b := p.Token(sampleURL), p.Token(sampleURL); a != b {
		t.Fatalf("same URL gave different tokens:\n%s\n%s", a, b)
	}
	// A second Proxy with the same key (a restart) gives the same token too.
	key := randKey(t)
	p1 := New(Config{HMACKey: key, AllowedHosts: []string{"*.komiku.to"}})
	p2 := New(Config{HMACKey: key, AllowedHosts: []string{"*.komiku.to"}})
	if p1.Token(sampleURL) != p2.Token(sampleURL) {
		t.Fatal("token is not stable across proxies sharing a key")
	}
	if u, ok := p2.Verify(p1.Token(sampleURL)); !ok || u != sampleURL {
		t.Fatal("token from one proxy does not verify on another with the same key")
	}

	seen := map[string]string{}
	nonces := map[string]string{}
	for i := 0; i < 500; i++ {
		u := sampleURL + "?n=" + strings.Repeat("a", i%7) + string(rune('a'+i%26)) + url.QueryEscape(string(rune(0x100+i)))
		tok := p.Token(u)
		if prev, dup := seen[tok]; dup && prev != u {
			t.Fatalf("token collision between %q and %q", prev, u)
		}
		seen[tok] = u
		raw, _ := base64.RawURLEncoding.DecodeString(tok)
		n := string(raw[:nonceLen])
		if prev, dup := nonces[n]; dup && prev != u {
			t.Fatalf("nonce reuse for different URLs %q and %q", prev, u)
		}
		nonces[n] = u
	}
}

func TestTokenHidesHost(t *testing.T) {
	p := newTestProxy(t)
	tok := p.Token(sampleURL)
	raw, err := base64.RawURLEncoding.DecodeString(tok)
	if err != nil {
		t.Fatal(err)
	}
	for _, needle := range []string{"komiku", "thumbnail", "https", "upload", ".jpg"} {
		if bytes.Contains(raw, []byte(needle)) || strings.Contains(tok, needle) {
			t.Fatalf("token reveals %q", needle)
		}
	}
	if want := nonceLen + len(sampleURL) + tagLen; len(raw) != want {
		t.Fatalf("token has %d bytes, want %d", len(raw), want)
	}
}

func TestTokenRejectsTampering(t *testing.T) {
	p := newTestProxy(t)
	tok := p.Token(sampleURL)
	raw, _ := base64.RawURLEncoding.DecodeString(tok)

	// One flipped bit in every single byte: nonce, ciphertext and tag.
	for i := range raw {
		mut := append([]byte{}, raw...)
		mut[i] ^= 0x01
		if _, ok := p.Verify(base64.RawURLEncoding.EncodeToString(mut)); ok {
			t.Fatalf("flipped byte %d was accepted", i)
		}
	}

	// A one-character change of the encoded string, at every position.
	for i := 0; i < len(tok); i++ {
		alt := byte('A')
		if tok[i] == 'A' {
			alt = 'B'
		}
		mut := tok[:i] + string(alt) + tok[i+1:]
		if got, ok := p.Verify(mut); ok && mut != tok {
			t.Fatalf("one-char change at %d accepted, decrypts to %q", i, got)
		}
	}

	for name, bad := range map[string]string{
		"empty":            "",
		"garbage":          "not-a-token!!",
		"dot":              ".",
		"legacy format":    base64.RawURLEncoding.EncodeToString([]byte(sampleURL)) + ".AAAAAAAAAAAAAAAAAAAAAA",
		"truncated by one": tok[:len(tok)-1],
		"truncated half":   tok[:len(tok)/2],
		"nonce only":       base64.RawURLEncoding.EncodeToString(raw[:nonceLen]),
		"too short":        base64.RawURLEncoding.EncodeToString(raw[:nonceLen+tagLen]),
		"extra byte":       base64.RawURLEncoding.EncodeToString(append(append([]byte{}, raw...), 0)),
		"too long":         strings.Repeat("A", maxTokenLen+1),
		"plain url":        sampleURL,
	} {
		if _, ok := p.Verify(bad); ok {
			t.Errorf("%s: token accepted", name)
		}
	}
}

func TestTokenRejectsOtherKey(t *testing.T) {
	a, b := newTestProxy(t), newTestProxy(t)
	if _, ok := b.Verify(a.Token(sampleURL)); ok {
		t.Fatal("token made with a different master key was accepted")
	}
}

// A token that GCM accepts but whose nonce is not HMAC(nonceKey, url) must be
// rejected: this is the synthetic-IV check.
func TestVerifyEnforcesSyntheticNonce(t *testing.T) {
	p := newTestProxy(t)
	nonce := make([]byte, nonceLen)
	if _, err := rand.Read(nonce); err != nil {
		t.Fatal(err)
	}
	forged := p.aead.Seal(append([]byte{}, nonce...), nonce, []byte(sampleURL), tokenAAD)
	tok := base64.RawURLEncoding.EncodeToString(forged)
	if _, ok := p.Verify(tok); ok {
		t.Fatal("token with a random nonce was accepted")
	}

	// Sanity check: with the proper nonce the same construction is accepted.
	good := p.nonce(sampleURL)
	ok := p.aead.Seal(append([]byte{}, good...), good, []byte(sampleURL), tokenAAD)
	if _, valid := p.Verify(base64.RawURLEncoding.EncodeToString(ok)); !valid {
		t.Fatal("hand-built token with the proper nonce was rejected")
	}

	// And the AAD is bound: the same bytes sealed with another AAD must fail.
	wrongAAD := p.aead.Seal(append([]byte{}, good...), good, []byte(sampleURL), []byte("other"))
	if _, valid := p.Verify(base64.RawURLEncoding.EncodeToString(wrongAAD)); valid {
		t.Fatal("token sealed with a different AAD was accepted")
	}
}

func TestHostAllowlist(t *testing.T) {
	m, ignored := newHostMatcher([]string{"*.komiku.to", " *.Komiku.ORG ", "cdn.example.net"})
	if len(ignored) != 0 {
		t.Fatalf("unexpected ignored patterns: %v", ignored)
	}
	tests := []struct {
		host string
		want bool
	}{
		{"thumbnail.komiku.to", true},
		{"komiku.to", true},
		{"image2.komiku.to", true},
		{"a.b.komiku.to", true},
		{"THUMBNAIL.KOMIKU.TO", true},
		{"img.komiku.org", true},
		{"komiku.org", true},
		{"cdn.example.net", true},
		{"x.cdn.example.net", false}, // bare entry is exact
		{"evil-komiku.to", false},
		{"komiku.to.evil.com", false},
		{"komiku.com", false},
		{"to", false},
		{"169.254.169.254", false},
		{"127.0.0.1", false},
		{"localhost", false},
		{".komiku.to", false},
		{"a..komiku.to", false},
		{"komiku.to.", false},
		{"", false},
		{"komiku.to:443", false}, // callers pass Hostname(), never a port
	}
	for _, tt := range tests {
		if got := m.match(tt.host); got != tt.want {
			t.Errorf("match(%q) = %v, want %v", tt.host, got, tt.want)
		}
	}

	_, ignored = newHostMatcher([]string{"*", "https://komiku.to", "komiku.to:443", "a*.com", "*.", "", "ok.com", "x/y"})
	if len(ignored) != 6 {
		t.Fatalf("ignored = %v, want the 6 invalid patterns", ignored)
	}
	m2, _ := newHostMatcher([]string{"*"})
	if m2.match("anything.example") {
		t.Fatal("a bare * must not allow every host")
	}
}

func TestAllowedURL(t *testing.T) {
	p := newTestProxy(t)
	for raw, want := range map[string]bool{
		"https://thumbnail.komiku.to/a.jpg":      true,
		"http://img.komiku.org/a.jpg":            true,
		"HTTPS://IMG.KOMIKU.ORG/a.jpg":           true,
		"https://img.komiku.org:8443/a.jpg":      true, // port is ignored
		"ftp://img.komiku.org/a.jpg":             false,
		"file:///etc/passwd":                     false,
		"//img.komiku.org/a.jpg":                 false,
		"/relative/a.jpg":                        false,
		"a.jpg":                                  false,
		"https://user:pw@img.komiku.org/a.jpg":   false,
		"https://evil.example.com/a.jpg":         false,
		"https://img.komiku.org.evil.com/a.jpg":  false,
		"http://169.254.169.254/latest/":         false,
		"http://localhost:18090/":                false,
		"https://evil.com/@img.komiku.org/a.jpg": false,
		"https://evil.com#@img.komiku.org/a.jpg": false,
		"mailto:a@komiku.to":                     false,
	} {
		u, err := url.Parse(raw)
		if err != nil {
			t.Fatalf("parse %q: %v", raw, err)
		}
		if got := p.allowedURL(u); got != want {
			t.Errorf("allowedURL(%q) = %v, want %v", raw, got, want)
		}
	}
	if p.allowedURL(nil) {
		t.Error("allowedURL(nil) = true")
	}
}

func TestBlockedIP(t *testing.T) {
	blocked := []string{
		"127.0.0.1", "127.1.2.3", "0.0.0.0", "10.0.0.1", "10.255.255.255",
		"172.16.0.1", "172.31.255.255", "192.168.1.1",
		"169.254.169.254", "169.254.0.1",
		"100.64.0.1", "100.127.255.255",
		"224.0.0.1", "239.255.255.250", "255.255.255.255", "240.0.0.1",
		"192.0.2.1", "198.18.0.1",
		"::1", "::", "fe80::1", "fe80::1%eth0", "fc00::1", "fd12:3456::1", "ff02::1",
		"::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
		"64:ff9b::7f00:1", "2002:7f00:1::1", "2001:db8::1",
	}
	for _, s := range blocked {
		if !blockedIP(netip.MustParseAddr(s)) {
			t.Errorf("%s must be blocked", s)
		}
	}
	allowed := []string{
		"8.8.8.8", "1.1.1.1", "104.16.0.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1",
		"192.169.0.1", "169.253.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8",
	}
	for _, s := range allowed {
		if blockedIP(netip.MustParseAddr(s)) {
			t.Errorf("%s must be allowed", s)
		}
	}
	if !blockedIP(netip.Addr{}) {
		t.Error("the zero Addr must be blocked")
	}
}

func TestGuardDial(t *testing.T) {
	for addr, wantErr := range map[string]bool{
		"127.0.0.1:80":               true,
		"10.1.2.3:443":               true,
		"169.254.169.254:80":         true,
		"[::1]:443":                  true,
		"[::ffff:127.0.0.1]:80":      true,
		"[fe80::1%en0]:80":           true,
		"8.8.8.8:443":                false,
		"[2606:4700:4700::1111]:443": false,
		"not-an-ip:80":               true,
		"no-port":                    true,
	} {
		err := guardDial("tcp", addr, nil)
		if (err != nil) != wantErr {
			t.Errorf("guardDial(%q) err=%v, wantErr=%v", addr, err, wantErr)
		}
	}
}

func TestRewrite(t *testing.T) {
	const base = "https://img2.example.test"
	p := newTestProxy(t)

	got := p.Rewrite(base, sampleURL)
	if !strings.HasPrefix(got, base+"/img/") {
		t.Fatalf("not rewritten: %q", got)
	}
	tok := strings.TrimPrefix(got, base+"/img/")
	if orig, ok := p.Verify(tok); !ok || orig != sampleURL {
		t.Fatalf("rewritten URL does not verify back to the original: %q ok=%v", orig, ok)
	}
	if strings.Contains(got, "komiku") {
		t.Fatalf("rewritten URL still names the origin: %q", got)
	}
	if p.Rewrite(base+"/", sampleURL) != got {
		t.Error("a trailing slash on the base changes the result")
	}
	if p.Rewrite(base, sampleURL) != got {
		t.Error("rewrite is not deterministic")
	}

	withQuery := "https://image2.komiku.to/upload/1.jpg?a=1&b=2"
	if orig, _ := p.Verify(strings.TrimPrefix(p.Rewrite(base, withQuery), base+"/img/")); orig != withQuery {
		t.Errorf("query not preserved: %q", orig)
	}

	for _, in := range []string{
		"",
		"/relative/path.jpg",
		"//thumbnail.komiku.to/a.jpg",
		"https://evil.example.com/a.jpg",
		"https://komiku.to.evil.com/a.jpg",
		"http://169.254.169.254/latest/meta-data/",
		"data:image/png;base64,AAAA",
		"not a url",
	} {
		if out := p.Rewrite(base, in); out != in {
			t.Errorf("Rewrite(%q) = %q, want it unchanged", in, out)
		}
	}
	if out := p.Rewrite("", sampleURL); out != sampleURL {
		t.Errorf("empty base must leave the URL unchanged, got %q", out)
	}

	disabled := New(Config{AllowedHosts: []string{"*.komiku.to"}})
	if out := disabled.Rewrite(base, sampleURL); out != sampleURL {
		t.Errorf("disabled proxy rewrote the URL: %q", out)
	}
	var nilProxy *Proxy
	if nilProxy.Enabled() || nilProxy.Rewrite(base, sampleURL) != sampleURL {
		t.Error("a nil Proxy must behave as disabled")
	}
}

func TestPublicBase(t *testing.T) {
	ctx := func(host string, hdr map[string]string) echo.Context {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Host = host
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		return echo.New().NewContext(req, httptest.NewRecorder())
	}
	key := randKey(t)

	derived := New(Config{HMACKey: key})
	if got := derived.PublicBase(ctx("api.example.test", nil)); got != "http://api.example.test" {
		t.Errorf("plain request: %q", got)
	}
	if got := derived.PublicBase(ctx("api.example.test", map[string]string{"X-Forwarded-Proto": "https"})); got != "https://api.example.test" {
		t.Errorf("forwarded proto: %q", got)
	}

	fixed := New(Config{HMACKey: key, PublicURL: " https://img2.example.test/ "})
	if got := fixed.PublicBase(ctx("ignored.example.test", nil)); got != "https://img2.example.test" {
		t.Errorf("PublicURL: %q", got)
	}

	for _, bad := range []string{"img2.example.test", "ftp://img2.example.test", "https://", "https://u:p@img2.example.test"} {
		p := New(Config{HMACKey: key, PublicURL: bad})
		if got := p.PublicBase(ctx("api.example.test", nil)); got != "http://api.example.test" {
			t.Errorf("invalid PublicURL %q was not ignored: %q", bad, got)
		}
	}
}
