# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⚠️ Open work: the base URL no longer resolves

**The upstream source this API scrapes has moved. `BASE_URL=https://komiku.id/` is a dead path, and
every endpoint that depends on `config.GlobalEnv.BaseURL` is currently returning empty data.** This
is the highest-priority fix in the repo — see the URL table below for the verified live endpoints.
When asked to "fix the codebase", this is what is meant.

`komiku.id` root still 302s to `https://komiku.org/`, but the paths under it do not carry over
unchanged, and the listing subdomain `data.komiku.id` is **completely dead** (connection failure, no
DNS/TLS response). Two candidate hosts were reported — `https://01.komiku.asia/` and
`https://komiku.org/`. Verified:

- `https://komiku.org/` — live, same content and same HTML class names (`div.bge`, `table.inftable`,
  `div.ims`, `tbody._3Rsjq`, `div#Baca_Komik`, `div#Judul`). **This is the correct target.**
- `https://01.komiku.asia/` — live but is a *different frontend*: a Next.js/`_next` app on a
  domain that is not reachable from the scraper's expected paths (`/daftar-komik/` returns a
  "Halaman tidak ditemukan" page). Do not point the scraper here.

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

`config.init()` panics unless `PORT` and `BASE_URL` are set; `.env` supplies both.

## Layout: sources live under `bin/`

`bin/` is not a build-output dir — it holds every `.go` file. Import paths therefore all begin
`komikku-api/bin/...`. Do not "clean up" this into `cmd/`/`pkg/` as a drive-by change; the
`/bin/config` suffix in `config.go` is load-bearing.

```
bin/app/main.go                 echo wiring, one Mount() per module
bin/config/config.go            godotenv -> GlobalEnv (RootApp, HTTPPort, BaseURL)
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

## Scraper URL construction — the fragile part

`config.GlobalEnv.BaseURL` is the only base URL, but it is applied inconsistently: several methods
in `manga_query_impl.go` ignore it and hardcode other hosts (`data.komiku.id`, `komiku.id`). When
upstream changes host or path, the fix is not one variable — audit every literal in
`*_query_impl.go`. Verified current state of the upstream (Komiku migrated off `data.komiku.id`):

| Endpoint | Live URL | Card markup |
| --- | --- | --- |
| all / filter | `komiku.org/daftar-komik/` (`?tipe=`, `?halaman=N`) | `article.manga-card`, `h4 > a`, `img[data-src]` |
| info | `komiku.org/manga/<slug>/` | `table.inftable tr:nth-child(n) > td:nth-child(2)`, `ul.genre li.genre`, `div.ims img` |
| chapter list | same page, `tbody._3Rsjq td.judulseries a` | (chapter href is now `/<slug>-chapter-N/`, **not** `/ch/...`) |
| chapter detail | `komiku.org/<slug>-chapter-N/` | `div#Baca_Komik img`, `div#Judul h1` |
| search | `api.komiku.org/?post_type=manga&s=<q>` (HX partial) | `div.bge` |
| popular | `api.komiku.org/other/hot/` | `div.bge` |
| recommended | `api.komiku.org/other/rekomendasi/` | `div.bge` |
| newest | `api.komiku.org/manga/?orderby=date` | `div.bge` |
| by genre | `api.komiku.org/genre/<slug>/` (`/page/N/`) | `div.bge` |

The `div.bge` listings are loaded by htmx from `api.komiku.org`; the outer HTML page on
`komiku.org` renders an empty `div.daftar`. Scraping `komiku.org/genre/<x>/` directly yields no
cards — must hit the api host.

Selector drift is the normal failure mode here, and it is silent: a selector that stops matching
produces an empty result, not an error. `komiku.id` still 302s to `komiku.org`, and image CDN hosts
have moved to `thumbnail.komiku.org` / `thumbnail.komiku.to` / `image2.komiku.to`.

`GetComicInfo` reads `table.inftable` by hardcoded `tr:nth-child(N)` position, which is already
broken: the upstream table gained an "Judul Alternatif" row, so row 2 is now the alt title (read
into `Type`), row 4 is "Tema" (into `Author`), and so on. Match on the row label text, not index,
when fixing this.

Images are `?resize=...`/`?w=...`-suffixed CDN URLs stripped by hand with `strings.TrimSuffix`.
Keep that pattern; do not "simplify" it, the suffix is not stable across hosts.

## Known bug: errors are overwritten, not returned

In `GetAllComic`, `GetComicInfo` (manga) and `GetListChapter` (chapter) the sequence is:

```go
err := g.Collector.Visit(g.URL)
if err != nil {
    output = utils.Result{Error: err}   // assigned...
}
output = utils.Result{Data: result}     // ...then immediately clobbered
return output
```

A failed scrape returns `success:true` with empty data. The other methods `return output` inside the
`if err != nil` block and are correct. If touching this file, make the three broken methods match
the rest.

## Wiring is manual, no DI container

`handlers.New()` builds its own `colly.NewCollector()`, constructs the query impls with
`config.GlobalEnv.BaseURL`, and hands them to `CreateNewMangaUsecase`. `main.go` calls `New()` +
`Mount(e)` per module. Adding a module means touching `main.go` by hand.

One collector is shared between manga and chapter queries within a handler, and `AllowURLRevisit`
is set per call — fine as long as the collector stays single-goroutine, which it currently is.

## Conventions

- Import aliases are inconsistent by design: `mangaQ`, `mangaU`, `chapterM`, `httpError`. Follow
  the local pattern rather than normalizing.
- Indentation is tabs, but gofmt alignment is off throughout. Match surrounding style; do not
  reformat a file you are only partially editing.
- Response `message` strings are part of the public API contract, and several were copy-pasted
  wrong (`GetPopularManga` returns `"Search manga"`). Preserve them when refactoring; changing them
  breaks existing clients.