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
}

const defaultAPIURL = "https://api.komiku.org/"

// withTrailingSlash makes sure the URL ends with exactly one "/".
func withTrailingSlash(u string) string {
	return strings.TrimRight(strings.TrimSpace(u), "/") + "/"
}

// splitOrigins parses the comma separated ALLOWED_ORIGINS value, trimming
// whitespace and dropping empty entries. Echo turns a "*" in an entry into a
// regexp wildcard, so "https://*.pages.dev" matches any Pages preview host.
func splitOrigins(v string) []string {
	var origins []string
	for _, origin := range strings.Split(v, ",") {
		if origin = strings.TrimSpace(origin); origin != "" {
			origins = append(origins, origin)
		}
	}
	return origins
}
