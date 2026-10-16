// Package imgproxy rewrites image URLs to opaque /img/<token> URLs and serves
// them back by streaming the image from the origin, so clients never talk to
// the upstream CDN hosts directly and never even see their names.
//
// Token format (authenticated encryption, deterministic per URL):
//
//	encKey   = HMAC-SHA256(master, "komikku-imgproxy enc v1")
//	nonceKey = HMAC-SHA256(master, "komikku-imgproxy nonce v1")
//	nonce    = HMAC-SHA256(nonceKey, url)[:12]
//	token    = base64url_nopad(nonce || AES-256-GCM(encKey, nonce, url, aad="komikku-imgproxy v1"))
//
// The nonce is a keyed hash of the URL (a synthetic IV), so the same URL always
// gives the same token, which keeps browser and CDN caches stable, while two
// different URLs never share a nonce under the same key. The nonce is keyed on
// purpose: an unkeyed hash would let anyone confirm a guessed URL from a token.
// GCM authenticates the ciphertext, so a token can only come from this API, and
// Verify additionally recomputes the nonce from the decrypted URL.
package imgproxy

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
)

const (
	// KeyLen is the length in bytes the master key must decode to.
	KeyLen = 32

	// RoutePrefix is the path the rewritten URLs live under.
	RoutePrefix = "/img/"

	nonceLen    = 12   // AES-GCM standard nonce size
	tagLen      = 16   // AES-GCM tag size
	maxTokenLen = 4096 // longer tokens are rejected before any crypto
)

var (
	encLabel   = []byte("komikku-imgproxy enc v1")
	nonceLabel = []byte("komikku-imgproxy nonce v1")
	tokenAAD   = []byte("komikku-imgproxy v1")
)

// Config is the plain-data configuration of a Proxy. It deliberately does not
// import the app config package, which panics on missing env vars at init time.
type Config struct {
	// HMACKey is the master key (PROXY_HMAC_KEY): standard base64 that decodes to
	// exactly 32 bytes. Empty or invalid disables the proxy.
	HMACKey string
	// AllowedHosts are host patterns: "*.example.com" matches example.com and any
	// subdomain, "host.tld" matches exactly. Case-insensitive.
	AllowedHosts []string
	// PublicURL is the absolute base of rewritten URLs. Empty derives it per
	// request from the scheme and Host of the incoming request.
	PublicURL string
	// CacheDir enables the on-disk image cache (PROXY_CACHE_DIR) in that
	// directory. Empty, or a directory that cannot be created and written (one
	// warning is logged), leaves the cache off.
	CacheDir string
	// CacheMaxBytes caps the cache (PROXY_CACHE_MAX_MB); zero or negative means
	// 1 GiB.
	CacheMaxBytes int64
	// PrewarmConcurrency is how many background workers fill the disk cache
	// ahead of requests (PROXY_PREWARM_CONCURRENCY). Zero turns prewarming off;
	// it also needs the disk cache.
	PrewarmConcurrency int
	// PrewarmQueue bounds the URLs waiting to be prewarmed; zero or negative
	// means 2000.
	PrewarmQueue int
}

// Proxy encrypts, decrypts and serves proxied image URLs. A Proxy with no valid
// key is disabled: Rewrite returns its input unchanged and the handler answers 404.
type Proxy struct {
	aead      cipher.AEAD // built once, safe for concurrent use
	nonceKey  []byte
	hosts     hostMatcher
	publicURL string

	client  *http.Client
	maxBody int64
	cache   *diskCache // nil when the disk cache is off
	prewarm *prewarmer // nil when prewarming is off
	stats   stats
}

// New builds a Proxy from cfg. It never fails and never logs the key.
func New(cfg Config) *Proxy {
	p := &Proxy{maxBody: defaultMaxBody}

	switch master, err := ParseKey(cfg.HMACKey); {
	case errors.Is(err, errKeyEmpty):
		log.Println("imgproxy: PROXY_HMAC_KEY is not set, image proxy disabled")
	case err != nil:
		log.Printf("imgproxy: PROXY_HMAC_KEY is invalid (%v), image proxy disabled", err)
	default:
		if err := p.setKey(master); err != nil {
			log.Printf("imgproxy: cannot initialise the cipher (%v), image proxy disabled", err)
		}
	}

	var ignored []string
	p.hosts, ignored = newHostMatcher(cfg.AllowedHosts)
	for _, pattern := range ignored {
		log.Printf("imgproxy: ignoring invalid allowed host pattern %q", pattern)
	}

	if raw := strings.TrimSpace(cfg.PublicURL); raw != "" {
		if u, err := url.Parse(raw); err == nil && isHTTP(u.Scheme) && u.Host != "" && u.User == nil {
			p.publicURL = strings.TrimRight(raw, "/")
		} else {
			log.Println("imgproxy: PROXY_PUBLIC_URL is not an absolute http(s) URL, deriving the base from each request instead")
		}
	}

	p.client = newClient(p, guardDial)

	// A disabled proxy never serves, so it never touches the disk either.
	if p.Enabled() {
		p.cache = newConfiguredCache(cfg)
		if p.cache != nil && cfg.PrewarmConcurrency > 0 {
			p.prewarm = newPrewarmer(cfg.PrewarmConcurrency, cfg.PrewarmQueue)
		}
	}
	p.stats.every = statsEvery
	p.stats.lastLog.Store(time.Now().UnixNano())
	return p
}

var errKeyEmpty = errors.New("empty")

// ParseKey decodes the master key: standard base64 of exactly KeyLen bytes. The
// returned error never contains the key itself.
func ParseKey(v string) ([]byte, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return nil, errKeyEmpty
	}
	key, err := base64.StdEncoding.DecodeString(v)
	if err != nil {
		return nil, errors.New("not valid standard base64")
	}
	if len(key) != KeyLen {
		return nil, fmt.Errorf("decodes to %d bytes, need exactly %d", len(key), KeyLen)
	}
	return key, nil
}

// setKey derives the AES-256 key and the nonce key from the master key.
func (p *Proxy) setKey(master []byte) error {
	block, err := aes.NewCipher(kdf(master, encLabel))
	if err != nil {
		return err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	p.aead = aead
	p.nonceKey = kdf(master, nonceLabel)
	return nil
}

// kdf is HMAC-SHA256(key, label), 32 bytes.
func kdf(key, label []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(label)
	return h.Sum(nil)
}

// Enabled reports whether the proxy has a usable key.
func (p *Proxy) Enabled() bool {
	return p != nil && p.aead != nil
}

// nonce is the synthetic IV: a keyed hash of the URL.
func (p *Proxy) nonce(rawURL string) []byte {
	h := hmac.New(sha256.New, p.nonceKey)
	h.Write([]byte(rawURL))
	return h.Sum(nil)[:nonceLen]
}

// Token returns the token for rawURL. The proxy must be enabled.
func (p *Proxy) Token(rawURL string) string {
	nonce := p.nonce(rawURL)
	out := make([]byte, 0, nonceLen+len(rawURL)+tagLen)
	out = append(out, nonce...)
	out = p.aead.Seal(out, nonce, []byte(rawURL), tokenAAD)
	return base64.RawURLEncoding.EncodeToString(out)
}

// Verify returns the original URL carried by token, or false when the token is
// malformed, was not produced with this key, or was altered in any way. It never
// makes a network request.
func (p *Proxy) Verify(token string) (string, bool) {
	if !p.Enabled() || token == "" || len(token) > maxTokenLen {
		return "", false
	}

	raw, err := base64.RawURLEncoding.Strict().DecodeString(token)
	if err != nil || len(raw) < nonceLen+tagLen+1 {
		return "", false
	}
	nonce, sealed := raw[:nonceLen], raw[nonceLen:]

	plain, err := p.aead.Open(nil, nonce, sealed, tokenAAD)
	if err != nil {
		return "", false
	}
	// Enforce the synthetic-IV construction: the nonce must be the keyed hash of
	// the URL it decrypts to.
	if !hmac.Equal(nonce, p.nonce(string(plain))) {
		return "", false
	}
	return string(plain), true
}

// Rewrite returns "<base>/img/<token>" for rawURL when the proxy is enabled and
// rawURL is an absolute http(s) URL on an allowed host. Anything else (empty,
// relative, foreign host, proxy disabled, empty base) is returned unchanged.
func (p *Proxy) Rewrite(base, rawURL string) string {
	if !p.Enabled() || base == "" || rawURL == "" {
		return rawURL
	}
	u, err := url.Parse(rawURL)
	if err != nil || !p.allowedURL(u) {
		return rawURL
	}
	return strings.TrimRight(base, "/") + RoutePrefix + p.Token(rawURL)
}

// PublicBase returns the base URL for rewritten links: PublicURL when set,
// otherwise scheme://host of the request (echo's Scheme honours
// X-Forwarded-Proto, which the reverse proxy sets).
func (p *Proxy) PublicBase(c echo.Context) string {
	if p.publicURL != "" {
		return p.publicURL
	}
	return c.Scheme() + "://" + c.Request().Host
}

// allowedURL is the single gate used both when rewriting and when fetching
// (including every redirect hop): http(s) only, no userinfo, and a hostname on
// the allowlist (the port is ignored).
func (p *Proxy) allowedURL(u *url.URL) bool {
	if u == nil || !isHTTP(u.Scheme) || u.Opaque != "" || u.User != nil {
		return false
	}
	return p.hosts.match(u.Hostname())
}

func isHTTP(scheme string) bool {
	scheme = strings.ToLower(scheme)
	return scheme == "http" || scheme == "https"
}

// hostMatcher holds normalized allowlist entries.
type hostMatcher struct {
	exact    map[string]struct{}
	suffixes []string // ".example.com" for the pattern "*.example.com"
}

// newHostMatcher builds a matcher from patterns. Patterns that are empty, carry
// a scheme/port/path, or use "*" anywhere but as a leading "*." are returned in
// ignored instead of being silently widened.
func newHostMatcher(patterns []string) (m hostMatcher, ignored []string) {
	m.exact = make(map[string]struct{})
	for _, pattern := range patterns {
		pattern = strings.ToLower(strings.TrimSpace(pattern))
		if pattern == "" {
			continue
		}

		wildcard := strings.HasPrefix(pattern, "*.")
		host := strings.TrimPrefix(pattern, "*.")
		if !validHost(host) {
			ignored = append(ignored, pattern)
			continue
		}

		// "*.example.com" matches example.com itself and every subdomain.
		m.exact[host] = struct{}{}
		if wildcard {
			m.suffixes = append(m.suffixes, "."+host)
		}
	}
	return m, ignored
}

// match reports whether host (hostname only, no port) is allowed.
func (m hostMatcher) match(host string) bool {
	host = strings.ToLower(host)
	if !validHost(host) {
		return false
	}
	if _, ok := m.exact[host]; ok {
		return true
	}
	for _, suffix := range m.suffixes {
		if strings.HasSuffix(host, suffix) {
			return true
		}
	}
	return false
}

// validHost accepts dotted hostnames and IPv4 literals made of letters, digits,
// '-' and '_' separated by single dots. Empty labels, '*', ':', '/' and '@' are
// rejected, so a malformed host can never match a wildcard suffix.
func validHost(h string) bool {
	if h == "" || len(h) > 253 {
		return false
	}
	for _, label := range strings.Split(h, ".") {
		if label == "" {
			return false
		}
		for i := 0; i < len(label); i++ {
			c := label[i]
			switch {
			case c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-', c == '_':
			default:
				return false
			}
		}
	}
	return true
}
