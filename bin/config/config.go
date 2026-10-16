package config

import (
	"github.com/joho/godotenv"
	"log"
	"math"
	"os"
	"strconv"
	"strings"
	"time"
)

type Env struct {
	RootApp        string
	HTTPPort       uint16
	BaseURL        string
	APIURL         string
	AllowedOrigins []string

	// Image proxy (all optional, see bin/pkg/imgproxy). Raw values: the proxy
	// itself validates the key and logs why it is disabled.
	ProxyHMACKey      string
	ProxyAllowedHosts []string
	ProxyPublicURL    string

	// Optional on-disk cache of proxied images. ProxyCacheDir empty means off;
	// ProxyCacheMaxMB is always positive.
	ProxyCacheDir   string
	ProxyCacheMaxMB int

	// Background cache preloading (needs the disk cache): the number of
	// prewarm workers (0 = off), the time between scheduled cycles (0 = no
	// schedule) and the chapters one cycle may prewarm.
	ProxyPrewarmConcurrency int
	ProxyPrewarmInterval    time.Duration
	ProxyPrewarmMaxChapters int
}

var GlobalEnv Env

func init() {
	err := godotenv.Load()

	if err != nil {
		log.Println(err)
	}

	var ok bool

	path, err := os.Getwd()
	if err != nil {
		log.Println(err)
	}

	rootApp := strings.TrimSuffix(path, "/bin/config")
	os.Setenv("APP_PATH", rootApp)
	GlobalEnv.RootApp = rootApp

	if port, err := strconv.Atoi(os.Getenv("PORT")); err != nil {
		panic("missing HTTP_PORT environment")
	} else {
		GlobalEnv.HTTPPort = uint16(port)
	}

	GlobalEnv.BaseURL, ok = os.LookupEnv("BASE_URL")
	if !ok {
		panic("missing BASE_URL environment")
	}
	GlobalEnv.BaseURL = withTrailingSlash(GlobalEnv.BaseURL)

	// API_URL is optional: the host that serves the htmx listing partials.
	apiURL := strings.TrimSpace(os.Getenv("API_URL"))
	if apiURL == "" {
		apiURL = defaultAPIURL
	}
	GlobalEnv.APIURL = withTrailingSlash(apiURL)

	// ALLOWED_ORIGINS is optional and comma separated. An empty value keeps the
	// previous wildcard behaviour, but it is logged because it means any browser
	// on the internet may call this API.
	GlobalEnv.AllowedOrigins = splitOrigins(os.Getenv("ALLOWED_ORIGINS"))
	if len(GlobalEnv.AllowedOrigins) == 0 {
		log.Println("ALLOWED_ORIGINS is not set, CORS is open to every origin")
		GlobalEnv.AllowedOrigins = []string{"*"}
	}

	// Image proxy. PROXY_HMAC_KEY is the master key, standard base64 of exactly
	// 32 bytes; empty or invalid leaves the proxy disabled (never a panic).
	// PROXY_ALLOWED_HOSTS is comma separated, PROXY_PUBLIC_URL an optional
	// absolute base for the rewritten URLs.
	GlobalEnv.ProxyHMACKey = strings.TrimSpace(os.Getenv("PROXY_HMAC_KEY"))
	GlobalEnv.ProxyAllowedHosts = splitList(os.Getenv("PROXY_ALLOWED_HOSTS"))
	if len(GlobalEnv.ProxyAllowedHosts) == 0 {
		GlobalEnv.ProxyAllowedHosts = splitList(defaultProxyAllowedHosts)
	}
	GlobalEnv.ProxyPublicURL = strings.TrimRight(strings.TrimSpace(os.Getenv("PROXY_PUBLIC_URL")), "/")

	// Image cache on disk: PROXY_CACHE_DIR (empty = off) and PROXY_CACHE_MAX_MB.
	// The proxy itself reports a directory it cannot use and falls back to off.
	GlobalEnv.ProxyCacheDir = strings.TrimSpace(os.Getenv("PROXY_CACHE_DIR"))
	GlobalEnv.ProxyCacheMaxMB = parseCacheMaxMB(os.Getenv("PROXY_CACHE_MAX_MB"))

	// Cache preloading. It only does anything when the proxy and the disk cache
	// are on, so these stay harmless defaults otherwise.
	GlobalEnv.ProxyPrewarmConcurrency = parseBoundedInt("PROXY_PREWARM_CONCURRENCY", os.Getenv("PROXY_PREWARM_CONCURRENCY"), defaultPrewarmConcurrency, maxPrewarmConcurrency)
	GlobalEnv.ProxyPrewarmInterval = parsePrewarmInterval(os.Getenv("PROXY_PREWARM_INTERVAL"))
	GlobalEnv.ProxyPrewarmMaxChapters = parseBoundedInt("PROXY_PREWARM_MAX_CHAPTERS", os.Getenv("PROXY_PREWARM_MAX_CHAPTERS"), defaultPrewarmMaxChapters, maxPrewarmMaxChapters)
}

const defaultAPIURL = "https://api.komiku.org/"

// defaultProxyAllowedHosts is the image CDN allowlist used when
// PROXY_ALLOWED_HOSTS is not set. "*.x.y" matches x.y and every subdomain.
const defaultProxyAllowedHosts = "*.komiku.to,*.komiku.org"

// defaultProxyCacheMaxMB is the disk cache limit when PROXY_CACHE_MAX_MB is
// not set or not usable.
const defaultProxyCacheMaxMB = 1024

const (
	defaultPrewarmConcurrency = 3
	maxPrewarmConcurrency     = 16
	defaultPrewarmInterval    = 20 * time.Minute
	minPrewarmInterval        = time.Minute
	defaultPrewarmMaxChapters = 20
	maxPrewarmMaxChapters     = 200
)

// parseBoundedInt parses a whole number from 0 up to max. Empty means def
// silently; anything that is not a number, or is negative, logs one line and
// means def; a number above max means max. 0 is valid and switches the feature
// off.
func parseBoundedInt(name, v string, def, max int) int {
	v = strings.TrimSpace(v)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		log.Printf("%s %q is not a whole number of 0 or more, using %d", name, v, def)
		return def
	}
	if n > max {
		log.Printf("%s %d is above the limit, using %d", name, n, max)
		return max
	}
	return n
}

// parsePrewarmInterval parses PROXY_PREWARM_INTERVAL, a Go duration such as 20m
// or 1h. Empty means the default silently, 0 switches the schedule off, and a
// value below a minute is raised to a minute so the upstream is never polled in
// a tight loop. Anything unparseable or negative logs one line and means the
// default.
func parsePrewarmInterval(v string) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return defaultPrewarmInterval
	}
	d, err := time.ParseDuration(v)
	if err != nil || d < 0 {
		log.Printf("PROXY_PREWARM_INTERVAL %q is not a duration such as 20m or 1h, using %s", v, defaultPrewarmInterval)
		return defaultPrewarmInterval
	}
	if d > 0 && d < minPrewarmInterval {
		log.Printf("PROXY_PREWARM_INTERVAL %s is below the minimum, using %s", d, minPrewarmInterval)
		return minPrewarmInterval
	}
	return d
}

// parseCacheMaxMB parses PROXY_CACHE_MAX_MB, a positive number of MiB. Empty
// means the default silently; anything else that is not a positive integer
// (absurdly large values would overflow the byte count) logs one line and means
// the default.
func parseCacheMaxMB(v string) int {
	v = strings.TrimSpace(v)
	if v == "" {
		return defaultProxyCacheMaxMB
	}
	mb, err := strconv.Atoi(v)
	if err != nil || mb <= 0 || mb > math.MaxInt32 {
		log.Printf("PROXY_CACHE_MAX_MB %q is not a positive number of MiB, using %d", v, defaultProxyCacheMaxMB)
		return defaultProxyCacheMaxMB
	}
	return mb
}

// withTrailingSlash makes sure the URL ends with exactly one "/".
func withTrailingSlash(u string) string {
	return strings.TrimRight(strings.TrimSpace(u), "/") + "/"
}

// splitOrigins parses the comma separated ALLOWED_ORIGINS value, trimming
// whitespace and dropping empty entries. Echo turns a "*" in an entry into a
// regexp wildcard, so "https://*.pages.dev" matches any Pages preview host.
func splitOrigins(v string) []string {
	return splitList(v)
}

// splitList parses a comma separated value, trimming whitespace and dropping
// empty entries.
func splitList(v string) []string {
	var items []string
	for _, item := range strings.Split(v, ",") {
		if item = strings.TrimSpace(item); item != "" {
			items = append(items, item)
		}
	}
	return items
}
