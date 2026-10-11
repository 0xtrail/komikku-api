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

There are no tests, no linter config, and no `gofmt` target in the Makefile. `go vet ./...` and
`gofmt -l .` are the only static checks available. The `docker-compose`/`up`/`down` targets target
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
bin/pkg/http-error/error.go     typed error constructors (BadRequest, NotFound, ...)
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
| info | `komiku.org/manga/<slug>/` | `table.inftable` rows matched by label, `ul.genre li.genre`, `div.ims img[src]` |
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

`handlers.New()` builds its own `colly.NewCollector()`, constructs the query impls with
`config.GlobalEnv.BaseURL`, and hands them to `CreateNewMangaUsecase`. `main.go` calls `New()` +
`Mount(e)` per module. Adding a module means touching `main.go` by hand.

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