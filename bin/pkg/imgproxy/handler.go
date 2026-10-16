package imgproxy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/labstack/echo/v4"
	httpError "komikku-api/bin/pkg/http-error"
	"komikku-api/bin/pkg/utils"
)

const (
	defaultMaxBody = 25 << 20 // 25 MiB
	fetchTimeout   = 30 * time.Second
	maxRedirects   = 3

	cacheControl = "public, max-age=2592000, immutable"

	// A plain browser User-Agent: some CDNs refuse the default Go one.
	userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

var (
	errTooManyRedirects   = errors.New("imgproxy: too many redirects")
	errRedirectNotAllowed = errors.New("imgproxy: redirect target not allowed")
	errBlockedAddress     = errors.New("imgproxy: connection to a non-public address refused")
)

// Mount registers GET and HEAD /img/:token. The route lives outside /api.
func (p *Proxy) Mount(router *echo.Echo) {
	router.GET(RoutePrefix+":token", p.Serve)
	router.HEAD(RoutePrefix+":token", p.Serve)
}

// Serve verifies the token and streams the image from the origin.
//
// Every rejection before the upstream request (proxy disabled, bad token, host
// not allowed) is the same 404 as any unknown route, so a caller cannot tell a
// forged token from a valid token for a host that is no longer allowed.
// Upstream problems are 404 (origin 404) or 502.
//
// With the disk cache on, the token and the allowlist are still checked first;
// only then is the cache consulted, and X-Cache says HIT or MISS. With the cache
// off the response is exactly what it was before the cache existed.
func (p *Proxy) Serve(c echo.Context) error {
	if !p.Enabled() {
		return utils.ResponseError(httpError.NewNotFound(), c)
	}

	target, ok := p.Verify(c.Param("token"))
	if !ok {
		return utils.ResponseError(httpError.NewNotFound(), c)
	}
	if u, err := url.Parse(target); err != nil || !p.allowedURL(u) {
		return utils.ResponseError(httpError.NewNotFound(), c)
	}

	if p.cache != nil {
		if img, ok := p.cache.open(cacheKey(target)); ok {
			defer img.Close()
			return p.serveCached(c, img)
		}
	}

	resp, ferr := p.fetch(c.Request().Context(), target)
	if ferr != nil {
		if ferr.notFound {
			return utils.ResponseError(httpError.NewNotFound(), c)
		}
		utils.LogError(ferr.detail, ferr.msg)
		return utils.ResponseError(httpError.NewBadGateway(), c)
	}
	defer resp.Body.Close()

	meta := metaFromResponse(resp)
	setImageHeaders(c.Response().Header(), meta, resp.ContentLength)
	if p.cache != nil {
		c.Response().Header().Set("X-Cache", "MISS")
		p.stats.miss.Add(1)
		p.logStats()
	}
	c.Response().WriteHeader(http.StatusOK)

	if c.Request().Method == http.MethodHead {
		return nil
	}

	p.stream(c.Response(), resp, meta, target)
	return nil
}

// upstreamError is why an upstream fetch produced nothing usable.
type upstreamError struct {
	notFound bool // the origin said 404, or the URL could not even be requested
	msg      string
	detail   interface{}
}

// fetch requests target from the origin the way every request does, whether a
// client is waiting or the prewarmer is filling the cache: a fresh request with
// a fixed header set (client cookies, Authorization and Referer are never
// forwarded), through the guarded client, and only a 2xx image within the size
// cap comes back. The caller closes the body.
func (p *Proxy) fetch(ctx context.Context, target string) (*http.Response, *upstreamError) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, &upstreamError{notFound: true}
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, &upstreamError{msg: "imgproxy: upstream request failed", detail: err.Error()}
	}
	if fail := p.vet(resp); fail != nil {
		resp.Body.Close()
		return nil, fail
	}
	return resp, nil
}

// vet rejects an upstream response that must not be served or cached.
func (p *Proxy) vet(resp *http.Response) *upstreamError {
	if resp.StatusCode == http.StatusNotFound {
		return &upstreamError{notFound: true}
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return &upstreamError{msg: "imgproxy: upstream returned a non-2xx status", detail: resp.StatusCode}
	}
	if contentType := resp.Header.Get("Content-Type"); !isImageType(contentType) {
		return &upstreamError{msg: "imgproxy: upstream content type is not an image", detail: contentType}
	}
	if resp.ContentLength > p.maxBody {
		return &upstreamError{msg: "imgproxy: upstream image is larger than the size cap", detail: resp.ContentLength}
	}
	return nil
}

func metaFromResponse(resp *http.Response) entryMeta {
	return entryMeta{
		ContentType:     resp.Header.Get("Content-Type"),
		LastModified:    resp.Header.Get("Last-Modified"),
		ETag:            resp.Header.Get("ETag"),
		ContentEncoding: resp.Header.Get("Content-Encoding"),
	}
}

// serveCached answers from a cache entry with the headers of an upstream success.
func (p *Proxy) serveCached(c echo.Context, img *cachedImage) error {
	setImageHeaders(c.Response().Header(), img.meta, img.meta.Size)
	c.Response().Header().Set("X-Cache", "HIT")
	p.stats.hit.Add(1)
	p.logStats()
	c.Response().WriteHeader(http.StatusOK)

	if c.Request().Method == http.MethodHead {
		return nil
	}
	if _, err := io.Copy(c.Response(), img.body()); err != nil {
		utils.LogError(err.Error(), "imgproxy: streaming the cached image failed")
	}
	return nil
}

// stream copies the upstream body to dst (the client, or io.Discard for the
// prewarmer), capped at maxBody. It is streamed straight through, never buffered
// whole. For a client the headers are already sent, so a failure from here on
// can only abort the transfer.
//
// With the cache on, a 200 body is also written to a cache entry, which is
// published only if the whole image arrived (see bodyComplete) and the copy to
// dst did not fail. It reports whether an entry was published.
func (p *Proxy) stream(dst io.Writer, resp *http.Response, meta entryMeta, target string) bool {
	out := dst
	var fill *cacheFill
	if p.cache != nil && resp.StatusCode == http.StatusOK {
		var err error
		if fill, err = p.cache.newFill(cacheKey(target)); err != nil {
			utils.LogError(err.Error(), "imgproxy: cannot start a cache entry")
		} else {
			out = io.MultiWriter(dst, fill) // dst first: a failed write stops the copy
		}
	}

	n, err := io.Copy(out, io.LimitReader(resp.Body, p.maxBody))
	if err != nil && errors.Is(err, context.Canceled) && resp.ContentLength >= 0 && n == resp.ContentLength {
		// A client that hangs up the moment it has the last byte cancels the request
		// before the upstream's end of stream was read (HTTP/2 reports it as an
		// error). Every declared byte was copied, so the image is complete.
		err = nil
	}
	if err != nil {
		utils.LogError(err.Error(), "imgproxy: streaming the image failed")
	}
	if fill == nil {
		return false
	}
	if err != nil || n == 0 || !p.bodyComplete(resp, n) {
		fill.abort()
		return false
	}
	if err := fill.commit(meta); err != nil {
		utils.LogError(err.Error(), "imgproxy: cannot cache the image")
		return false
	}
	return true
}

// bodyComplete reports whether the n bytes copied are the whole upstream body
// and not a prefix cut by the size cap.
func (p *Proxy) bodyComplete(resp *http.Response, n int64) bool {
	if resp.ContentLength >= 0 {
		return n == resp.ContentLength
	}
	if n < p.maxBody {
		return true // the limited reader stopped because upstream ended
	}
	// Exactly at the cap with no declared length: complete only if nothing follows.
	var next [1]byte
	_, err := io.ReadFull(resp.Body, next[:])
	return errors.Is(err, io.EOF)
}

// setImageHeaders sets the headers shared by an upstream success and a cache
// hit. A negative length leaves Content-Length unset.
func setImageHeaders(h http.Header, m entryMeta, length int64) {
	h.Set("Content-Type", m.ContentType)
	if length >= 0 {
		h.Set("Content-Length", strconv.FormatInt(length, 10))
	}
	for name, v := range map[string]string{
		"Last-Modified":    m.LastModified,
		"ETag":             m.ETag,
		"Content-Encoding": m.ContentEncoding,
	} {
		if v != "" {
			h.Set(name, v)
		}
	}
	h.Set("Cache-Control", cacheControl)
	// The bytes are served from our origin: never let a browser sniff or run them
	// as a document if someone opens the URL directly.
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
}

func isImageType(contentType string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(contentType)), "image/")
}

// newClient builds the dedicated upstream client. control, when not nil, runs
// for every connection attempt with the already-resolved IP, which is what
// defeats DNS rebinding (an allowed name that resolves to an internal address).
func newClient(p *Proxy, control func(network, address string, c syscall.RawConn) error) *http.Client {
	dialer := &net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
		Control:   control,
	}
	transport := &http.Transport{
		// No Proxy: environment proxy settings would make the dial guard see the
		// proxy address instead of the real destination.
		Proxy:                 nil,
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     true,
		DisableCompression:    true, // pass the bytes through untouched
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 15 * time.Second,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   16,
	}
	return &http.Client{
		Transport: transport,
		Timeout:   fetchTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > maxRedirects {
				return errTooManyRedirects
			}
			if !p.allowedURL(req.URL) {
				return errRedirectNotAllowed
			}
			// net/http adds a Referer on redirects; this proxy sends none.
			req.Header.Del("Referer")
			return nil
		},
	}
}

// guardDial is a net.Dialer.Control function that refuses non-public addresses.
func guardDial(network, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return fmt.Errorf("imgproxy: unparsable dial address: %w", err)
	}
	if blockedIP(ip) {
		return errBlockedAddress
	}
	return nil
}

// blockedPrefixes are ranges the standard netip predicates do not cover.
var blockedPrefixes = mustPrefixes(
	"0.0.0.0/8",       // "this network"
	"100.64.0.0/10",   // CGNAT
	"192.0.0.0/24",    // IETF protocol assignments
	"192.0.2.0/24",    // TEST-NET-1
	"198.18.0.0/15",   // benchmarking
	"198.51.100.0/24", // TEST-NET-2
	"203.0.113.0/24",  // TEST-NET-3
	"240.0.0.0/4",     // reserved, includes the broadcast address
	"::/96",           // deprecated IPv4-compatible addresses
	"64:ff9b::/96",    // NAT64, embeds an IPv4 address
	"64:ff9b:1::/48",  // local-use NAT64
	"100::/64",        // discard-only
	"2001:db8::/32",   // documentation
	"2002::/16",       // 6to4, embeds an IPv4 address
)

func mustPrefixes(cidrs ...string) []netip.Prefix {
	out := make([]netip.Prefix, len(cidrs))
	for i, cidr := range cidrs {
		out[i] = netip.MustParsePrefix(cidr)
	}
	return out
}

// blockedIP reports whether ip must not be dialled: loopback, private (RFC1918
// and fc00::/7), link-local (169.254/16, fe80::/10), unspecified, multicast,
// CGNAT and the other reserved ranges above. IPv4-mapped IPv6 is unwrapped first.
func blockedIP(ip netip.Addr) bool {
	ip = ip.Unmap().WithZone("")
	if !ip.IsValid() || ip.IsUnspecified() || ip.IsLoopback() || ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast() {
		return true
	}
	for _, prefix := range blockedPrefixes {
		if prefix.Contains(ip) {
			return true
		}
	}
	return false
}
