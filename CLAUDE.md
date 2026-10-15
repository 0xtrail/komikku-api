# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Upstream migration (done): komiku.org + api.komiku.org

Komiku moved off `komiku.id` / `data.komiku.id`. `data.komiku.id` is completely dead (connection
failure), and `komiku.id` only 301s to `komiku.org` (paths are preserved, so an old `BASE_URL` still
works through the redirect, but it must not be relied on). The scraper now targets:

- `https://komiku.org/` (`BASE_URL`) for full pages: all-comics list, genre index, comic info page
  (which also carries the chapter list), and the chapter reader.
- `https://api.komiku.org/` (`API_URL`) for the htmx listing partials (`div.bge` cards): search,
  popular, recommended, newest and by-genre.

`.env` must contain `BASE_URL=https://komiku.org/`; `API_URL` is optional and defaults to
`https://api.komiku.org/`. Both are normalized to end in exactly one `/`.

`https://01.komiku.asia/` was also considered and rejected: it is a different (Next.js) frontend and
`/daftar-komik/` returns a "Halaman tidak ditemukan" page there. Do not point the scraper at it.

No hostnames are hardcoded in `*_query_impl.go` any more; every URL is built from
`config.GlobalEnv.BaseURL` or `config.GlobalEnv.APIURL`.

## What this is

A stateless REST API that scrapes an Indonesian manga site (Komiku) and re-serves it as JSON.
No database, no cache, no build step beyond `go build`. Every request is a live HTTP scrape.

Stack: Go 1.16 module `komikku-api`, Echo v4 for HTTP, Colly for scraping, logrus for logging.

## Commands

```bash
make build                              # go build -tags musl -o main ./bin/app
make start                              # ./main
go run ./bin/app/main.go                # same as build+start, no binary left behind
make install                            # go mod download
```

Tests: `bin/pkg/imgproxy` needs no environment (`go test ./bin/pkg/imgproxy`); `bin/config` and
`bin/modules/manga/repositories/queries` import `config`, whose `init()` panics without `PORT` and
`BASE_URL`, so run everything as `PORT=0 BASE_URL=https://komiku.org/ go test ./...`. There is no
linter config and no `gofmt` target in the Makefile. `go vet ./...` and `gofmt -l .` are the only static checks available. Many
files predate gofmt and are listed by `gofmt -l .`; keep new files gofmt-clean and do not reformat old ones. The `docker-compose`/`up`/`down` targets target
a local daemon — do not run those on the Mac (see the host rules in `~/.claude/CLAUDE.md`).

**Run from the repo root.** `config.init()` calls `godotenv.Load()` (cwd-relative) and derives
`RootApp` by stripping the literal suffix `/bin/config` from `os.Getwd()`. Running from anywhere
else panics or mis-sets `RootApp`.

`config.init()` panics unless `PORT` and `BASE_URL` are set; `.env` supplies both. `API_URL` is
optional (default `https://api.komiku.org/`).

## Layout: sources live under `bin/`

`bin/` is not a build-output dir — it holds every `.go` file. Import paths therefore all begin
`komikku-api/bin/...`. Do not "clean up" this into `cmd/`/`pkg/` as a drive-by change; the
`/bin/config` suffix in `config.go` is load-bearing.

```
bin/app/main.go                 echo wiring, one Mount() per module
bin/config/config.go            godotenv -> GlobalEnv (RootApp, HTTPPort, BaseURL, APIURL)
bin/modules/<m>/handlers/       HTTP layer: Mount(*echo.Echo) + one method per route
bin/modules/<m>/usecases/       usecase.go (interface) + query_usecase.go (impl)
bin/modules/<m>/repositories/queries/   query.go (interface) + *_impl.go (colly scraping)
bin/modules/<m>/models/domain/  response DTOs with json tags
bin/pkg/utils/wrapper.go        Result envelope, Response(), ResponseError(), logging
bin/pkg/http-error/error.go     typed error constructors (BadRequest, NotFound, BadGateway, ...)
bin/pkg/imgproxy/               image proxy: token crypto, allowlist, rewrite, GET /img/:token handler
bin/pkg/middlewares/log.go      JSON-ish echo request logger
```

Modules: `manga` (list, info, search, genres, popular/recommended/newest, by-genre) and `chapter`
(reader image list). `manga` depends on `chapter`'s query to fill `ComicInfo.ChapterList`.

## The one return convention: `utils.Result`

No method in this codebase returns `(T, error)`. Every usecase and query method returns
`utils.Result{Data interface{}, Error interface{}`.

```go
func (g MangaQueryImpl) SearchManga(query string) utils.Result   // repo layer: raw error
func (m mangaCommandUsecase) GetComicInfo(e string) utils.Result // usecase layer: wraps error in httpError.NotFound{}
func (m *MangaHandler) GetComicInfo(c echo.Context) error        // handler: unwraps into JSON
```

`Data` is always an untyped `interface{}`; the usecase layer type-asserts it
(`queryRes.Data.([]mangaM.Comic)`). A wrong assertion here panics rather than erroring.

Error mapping: the query layer puts a bare `error` in `Result.Error`; the usecase layer converts it
to an `httpError.*` struct so `utils.ResponseError` can map it to an HTTP status. Handler code checks
`result.Error != nil` and calls `utils.ResponseError(result.Error, c)`, else
`utils.Response(result.Data, "<message>", http.StatusOK, c)`.

Every successful response has the shape `{success, data, message, code}` (`utils.BaseWrapperModel`).

## Scraper URL construction and selectors

Every URL is built from `config.GlobalEnv.BaseURL` (site) or `config.GlobalEnv.APIURL` (listing
partials) through the unexported `joinURL` helper, which never produces a `//` (endpoints may arrive
as `manga/<slug>/` or `/manga/<slug>/`). Verified live state of the upstream:

| Endpoint | Live URL | Markup |
| --- | --- | --- |
| all / filter | `komiku.org/daftar-komik/` (`?tipe=manga\|manhwa\|manhua`, `?halaman=N`) | `article.manga-card`, `h4`, `a[href]`, `img[data-src]` (src is a lazy placeholder), `p.meta` |
| info | `komiku.org/manga/<slug>/` | `table.inftable` rows matched by label, `ul.genre li.genre`, `div.ims img[src]`, synopsis in `p.desc` (fallback: first `p` of the hidden `section#Sinopsis`) |
| chapter list | same page, `tbody._3Rsjq` rows with `td.judulseries a` | chapter href is `/<slug>-chapter-N/`, **not** `/ch/...`; the header row only has `th.judulseries` |
| chapter detail | `komiku.org/<slug>-chapter-N/` | `#Baca_Komik img.klazy[src]`, `#Judul h1` (ids, not `section`/`header`) |
| genre list | `komiku.org/p/daftar-genre/` | `a.gnr` with `<b>` title and `/genre/<slug>/` href |
| search | `api.komiku.org/?post_type=manga&s=<q>` | `div.bge` |
| popular | `api.komiku.org/other/hot/` (`page/N/`) | `div.bge` |
| recommended | `api.komiku.org/other/rekomendasi/` (`page/N/`) | `div.bge` |
| newest | `api.komiku.org/manga/` (`page/N/`) | `div.bge` (the old `data.komiku.id/pustaka/` is this page; no `?orderby=`) |
| by genre | `api.komiku.org/genre/<slug>/` (`page/N/`) | `div.bge` |

All listing partials return 10 cards per page; `/daftar-komik/` returns 50 cards per page (about 158
pages), so `GET /api/comic/list` accepts an optional `?page=N` (default 1, anything invalid or below 1
means page 1) together with the existing `?filter=`.

The `div.bge` listings are loaded by htmx from `api.komiku.org`; the outer HTML page on
`komiku.org` renders an empty `div.daftar`. Scraping `komiku.org/genre/<x>/` directly yields no
cards, so the api host must be used. The five listing methods share one `scrapeCards` helper. In
those partials the thumbnail is in `img[src]` (there is no `data-src`); the helper falls back to
`data-src` only if `src` is empty. The last element of each partial is an htmx `<span hx-get=...>`
for the next page, which is not a card.

Selector drift is the normal failure mode here, and it is silent: a selector that stops matching
produces an empty result, not an error. Image CDN hosts have also moved around
(`thumbnail.komiku.org`, `thumbnail.komiku.to`, `image2.komiku.to`).

Normalization rules applied to listing results:

- `Comic.Endpoint` is always the site-relative path with a leading slash (`/manga/<slug>/`), taken
  from the href with `net/url` (`endpointPath`), whether upstream hands back an absolute or a relative
  href. This is the contract documented in the README.
- Thumbnail URLs go through `stripQuery`, which drops everything from the first `?`. The resize
  suffix differs per host (`?resize=450,235&quality=60`, `?resize=160,220`, `?w=500`), so a literal
  `TrimSuffix` is not enough. Chapter page images are deliberately left untouched.
- Search: the Echo param may arrive raw or still percent-encoded (`one%20punch`); it is
  `url.PathUnescape`d (raw value on error) and then `url.QueryEscape`d into the URL.

`GetComicInfo` reads `table.inftable` by iterating `tr` rows and switching on the normalized label of
the first `td` (trimmed, trailing `:` removed, lowercased): `judul`, `tipe`, `author`/`pengarang`,
`status`, `rating`. Unknown rows (e.g. "Judul Alternatif", "Tema", "Cara Baca") are ignored. The old
positional `tr:nth-child(N)` parsing broke when upstream added the alternative-title row; do not go
back to positions.

`ComicInfo.Synopsis` (`synopsis`, an empty string when absent, never an error) comes from the first
non-empty `p.desc` / `p[itemprop=description]`, else from `section#Sinopsis p` (a `display:none` copy
of the same text). The two `OnHTML` callbacks run in registration order and share a guard so only the
first non-empty text is kept. Inside the callback read `e.DOM.Text()`, not `e.Text`: colly computes
`e.Text` before the callback runs, and `<br>` is turned into a newline first so words do not glue.
`normalizeSynopsis` (`synopsis.go`) trims, normalizes CRLF, splits paragraphs on whitespace-only lines,
collapses whitespace inside a paragraph and joins paragraphs with exactly `"\n\n"`. The tests in this
package need env vars because `config.init()` panics without them:
`PORT=0 BASE_URL=https://komiku.org/ go test ./bin/modules/manga/...`.

`GetAllGenre` takes the genre slug from the `/genre/<slug>/` **href**, not from `data-nama`:
`data-nama` is a display name for about 20 genres (`dark fantasy`, `shoujo(g)`, `girls&#039; love`) and
`/genre/dark%20fantasy/` is a 404 upstream, while `/genre/dark-fantasy/` works. `data-nama` is only a
fallback. Results are deduplicated by slug. That slug is exactly what `GetByGenre` takes as `:endpoint`.

## Errors are returned, not swallowed

A failed scrape must surface as an error. colly's `Visit` returns an error for non-2xx responses, so
an unknown slug (upstream 404) becomes `Result{Error: err}`, which the usecase wraps in
`httpError.NotFound` and the handler returns as HTTP 404 with `success:false`. Every query method
returns inside its `if err != nil` block. (Historically `GetAllComic`, `GetComicInfo` and
`GetListChapter` assigned the error and then overwrote it with `Data`, returning `success:true` with
empty data; do not reintroduce that pattern.) An empty-but-successful scrape is still handled by the
usecases (`Data not found` for the listings), not by the query layer.

## Wiring is manual, no DI container

`handlers.New(imgProxy)` builds its own `colly.NewCollector()`, constructs the query impls with
`config.GlobalEnv.BaseURL`, and hands them to `CreateNewMangaUsecase`. `main.go` builds one
`*imgproxy.Proxy`, calls `imgProxy.Mount(e)`, then `New(imgProxy)` + `Mount(e)` per module. Adding a module means touching `main.go` by hand.

One `*colly.Collector` is shared between the manga and chapter queries within a handler, but it is
only a template: every scraping method starts with `c := g.Collector.Clone()` (colly v1.2.0 copies the
configuration but not the callbacks) and registers its `OnHTML` callbacks and `Visit` on the clone,
setting `AllowURLRevisit = true` there. Do not register callbacks on the shared collector: callbacks
accumulate forever and, under concurrent HTTP requests, fire during other requests' visits and write
into their result slices. The clones share only the HTTP backend, cookie jar and lock, which colly
designs to be shared.

## Conventions

- Import aliases are inconsistent by design: `mangaQ`, `mangaU`, `chapterM`, `httpError`. Follow
  the local pattern rather than normalizing.
- Indentation is tabs, but gofmt alignment is off throughout. Match surrounding style; do not
  reformat a file you are only partially editing.
- Response `message` strings are part of the public API contract, and several were copy-pasted
  wrong (`GetPopularManga` returns `"Search manga"`). Preserve them when refactoring; changing them
  breaks existing clients.

## Image proxy (`bin/pkg/imgproxy`)

Clients must not load images from Komiku's CDN hosts (`thumbnail.komiku.to`, `image2.komiku.to`,
`img.komiku.org`, ...): hotlink protection would break every image and the hosts are exposed. When the
proxy is enabled, image URLs in responses become `<base>/img/<token>` and `GET|HEAD /img/:token`
(mounted in `main.go`, outside `/api`) verifies the token and streams the image from the origin.

- **Config** (all optional, none can panic): `PROXY_HMAC_KEY` (standard base64 of exactly 32 bytes,
  `openssl rand -base64 32`; empty or invalid logs one line, never the key, and disables the proxy),
  `PROXY_ALLOWED_HOSTS` (default `*.komiku.to,*.komiku.org`; `*.x.y` matches `x.y` and subdomains,
  a bare host matches exactly, hostname only, case-insensitive) and `PROXY_PUBLIC_URL` (absolute
  base; empty derives `c.Scheme()://Host` per request, `X-Forwarded-Proto` is honoured). The package
  never imports `config` (its `init()` panics without `PORT`/`BASE_URL`, which would break tests);
  `main.go` passes `config.GlobalEnv.Proxy*` in.
- **Token**: authenticated encryption, deterministic per URL. `encKey = HMAC-SHA256(master, "komikku-imgproxy enc v1")`,
  `nonceKey = HMAC-SHA256(master, "komikku-imgproxy nonce v1")`, `nonce = HMAC-SHA256(nonceKey, url)[:12]`,
  `token = base64url_nopad(nonce || AES-256-GCM(encKey, nonce, url, aad="komikku-imgproxy v1"))`.
  The nonce is a keyed synthetic IV: the same URL always yields the same token (stable browser/CDN
  caches) and different URLs never share a nonce. Never replace it with an unkeyed hash (that would let
  anyone confirm a guessed URL) and never use a random nonce (tokens would change on every request).
  `Verify` also recomputes the nonce from the decrypted URL. Changing the key invalidates every token
  already handed out; there is no key rotation.
- **Rewrite location**: in the handlers, right before `utils.Response`, via `proxyImages` in
  `modules/{manga,chapter}/handlers/proxy_images.go` (type switch on `result.Data`: `[]Comic.Image`,
  `ComicInfo.Thumbnail`, `ChapterDetail.Image`). Usecase and query interfaces are untouched. Only
  absolute http(s) URLs on an allowed host are rewritten; anything else is returned as is. With the
  proxy disabled the output is byte-identical to before.
- **Serving**: every rejection before the upstream request (proxy disabled, bad token, host no longer
  allowed, non-http(s), userinfo) is the same 404 envelope as any unknown route, so a forged token
  looks like a missing one. Upstream 404 is 404; other upstream failures, a non-`image/*`
  Content-Type, or a declared size above 25 MiB are 502 (`httpError.BadGateway`). The body is streamed
  with `io.Copy` through a 25 MiB `LimitReader`, `Cache-Control: public, max-age=2592000, immutable`,
  plus `nosniff` and a sandbox CSP because the bytes are served from our origin.
- **SSRF guards**: the allowlist is applied to the decrypted URL and again to every redirect hop (at
  most 3). The dedicated `http.Client` dials through a `net.Dialer.Control` that checks the already
  resolved IP and refuses loopback, RFC1918, fc00::/7, link-local, unspecified, multicast, CGNAT
  100.64/10 and other reserved ranges (so an allowed name that resolves internally still fails). No
  environment proxy, no client cookies/Authorization/Referer forwarded, fixed browser User-Agent.
- **Tests**: `go test ./bin/pkg/imgproxy` covers token crypto (every byte tampered, wrong key,
  determinism), key parsing, allowlist, IP blocking, rewrite and the handler against a local fake CDN.
  Handler tests swap in a client without the dial guard because the fake CDN is on loopback.
  `cache_test.go` covers miss/hit, HEAD, nothing cached for truncated/non-image/404/502 or a client
  that drops, eviction order and the 90% target, startup scan, corrupt entries, concurrent misses and
  the cache-off headers; run it with `-race`.
- `PROXY_PUBLIC_URL` should be set in production: without it the base comes from the request `Host`
  header.
- **Disk cache** (`cache.go`, opt-in via `PROXY_CACHE_DIR` for the binary, but the Dockerfile defaults it to
  `/data/imgcache` so the image has it on; `PROXY_CACHE_MAX_MB`, default 1024, invalid
  or <=0 logs one line and means the default; unusable dir logs one warning and runs with the cache off,
  and a proxy without a valid key never touches the disk): key = hex SHA-256 of the decrypted upstream
  URL, sharded by its first 2 hex chars, one file per entry laid out `<body><meta JSON><4-byte meta
  length>` (the metadata trails because it is only known after streaming; one rename publishes, one
  unlink evicts). Only a complete `200` `image/*` body is cached: the copy must not error (client
  disconnect included) and must not be cut by the 25 MiB cap; HEAD never fills it. Token and allowlist
  checks run before the lookup. `X-Cache: HIT|MISS` is set only when the cache is on (the cache-off
  response is byte-identical to before). Eviction is LRU by mtime (hits `Chtimes`) in one background
  goroutine, down to 90% of the limit; only files named like entries are ever deleted. The image creates
  `/data/imgcache` (runs as root); mount a persistent volume there (e.g. a Dokploy volume) or the cache is
  lost on every redeploy. An empty `PROXY_CACHE_DIR=` in the container env overrides the image default and
  turns the cache off.
