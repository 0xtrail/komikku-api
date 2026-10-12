package config

import (
	"github.com/joho/godotenv"
	"log"
	"os"
	"strconv"
	"strings"
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
}

const defaultAPIURL = "https://api.komiku.org/"

// defaultProxyAllowedHosts is the image CDN allowlist used when
// PROXY_ALLOWED_HOSTS is not set. "*.x.y" matches x.y and every subdomain.
const defaultProxyAllowedHosts = "*.komiku.to,*.komiku.org"

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
