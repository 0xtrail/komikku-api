package imgproxy

import (
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

	// A fresh request with a fixed header set: client cookies, Authorization and
	// Referer are never forwarded.
	req, err := http.NewRequestWithContext(c.Request().Context(), http.MethodGet, target, nil)
	if err != nil {
		return utils.ResponseError(httpError.NewNotFound(), c)
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")

	resp, err := p.client.Do(req)
	if err != nil {
		utils.LogError(err.Error(), "imgproxy: upstream request failed")
		return utils.ResponseError(httpError.NewBadGateway(), c)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return utils.ResponseError(httpError.NewNotFound(), c)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		utils.LogError(resp.StatusCode, "imgproxy: upstream returned a non-2xx status")
		return utils.ResponseError(httpError.NewBadGateway(), c)
	}

	contentType := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(contentType)), "image/") {
		utils.LogError(contentType, "imgproxy: upstream content type is not an image")
		return utils.ResponseError(httpError.NewBadGateway(), c)
	}
	if resp.ContentLength > p.maxBody {
		utils.LogError(resp.ContentLength, "imgproxy: upstream image is larger than the size cap")
		return utils.ResponseError(httpError.NewBadGateway(), c)
	}

	h := c.Response().Header()
	h.Set("Content-Type", contentType)
	if resp.ContentLength >= 0 {
		h.Set("Content-Length", strconv.FormatInt(resp.ContentLength, 10))
	}
	for _, name := range []string{"Last-Modified", "ETag", "Content-Encoding"} {
		if v := resp.Header.Get(name); v != "" {
			h.Set(name, v)
		}
	}
	h.Set("Cache-Control", cacheControl)
	// The bytes are served from our origin: never let a browser sniff or run them
	// as a document if someone opens the URL directly.
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	c.Response().WriteHeader(http.StatusOK)

	if c.Request().Method == http.MethodHead {
		return nil
	}

	// Streamed straight to the client: no disk, no full buffering. The headers
	// are already sent, so a failure from here on can only abort the transfer.
	if _, err := io.Copy(c.Response(), io.LimitReader(resp.Body, p.maxBody)); err != nil {
		utils.LogError(err.Error(), "imgproxy: streaming the image failed")
	}
	return nil
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
