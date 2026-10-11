package queries

import (
	"fmt"
	"github.com/gocolly/colly"
	"komikku-api/bin/config"
	"komikku-api/bin/modules/manga/models/domain"
	"komikku-api/bin/pkg/utils"
	"net/url"
	"strconv"
	"strings"
)

type MangaQueryImpl struct {
	URL			string
	Collector	*colly.Collector
}

func NewMangaQuery(url string, collector *colly.Collector) MangaQuery {
	return &MangaQueryImpl{
		URL: url,
		Collector: collector,
	}
}

// joinURL joins a base URL and a path without producing a double slash.
func joinURL(base, path string) string {
	return strings.TrimRight(base, "/") + "/" + strings.TrimLeft(path, "/")
}

// pagedPath appends "page/N/" to a listing path (which must end in "/") for
// every page after the first.
func pagedPath(path string, page int) string {
	if page > 1 {
		return fmt.Sprintf("%spage/%d/", path, page)
	}
	return path
}

// stripQuery drops the CDN resize query string (?resize=..., ?w=...) from a
// thumbnail URL. The suffix differs per host, so everything from the first "?"
// is removed instead of matching a literal.
func stripQuery(src string) string {
	src = strings.TrimSpace(src)
	if i := strings.Index(src, "?"); i >= 0 {
		return src[:i]
	}
	return src
}

// endpointPath turns an absolute or relative href into a site-relative path
// with a leading slash (e.g. "/manga/one-punch-man/").
func endpointPath(href string) string {
	href = strings.TrimSpace(href)
	if href == "" {
		return ""
	}
	path := href
	if u, err := url.Parse(href); err == nil {
		path = u.Path
	}
	return "/" + strings.TrimLeft(path, "/")
}

// normalizeLabel lowercases an info-table label and strips spaces and the
// trailing colon ("Judul:" -> "judul").
func normalizeLabel(label string) string {
	return strings.ToLower(strings.TrimSpace(strings.TrimRight(strings.TrimSpace(label), ":")))
}

// scrapeCards visits pageURL with c and parses every div.bge listing card.
// c must be a collector private to the calling request.
func scrapeCards(c *colly.Collector, pageURL string) utils.Result {
	var result []domain.Comic

	c.AllowURLRevisit = true
	c.OnHTML("div.bge", func(e *colly.HTMLElement) {
		var comic domain.Comic
		comic.Title = e.ChildText("div.kan h3")
		comic.Desc = strings.TrimSpace(e.DOM.Find("div.kan > p").First().Text())
		comic.Type = e.ChildText("div.bgei b")

		img := e.ChildAttr("div.bgei img", "src")
		if img == "" {
			img = e.ChildAttr("div.bgei img", "data-src")
		}
		comic.Image = stripQuery(img)

		href := e.ChildAttr("div.bgei a", "href")
		if href == "" {
			href = e.ChildAttr("div.kan a", "href")
		}
		comic.Endpoint = endpointPath(href)

		result = append(result, comic)
	})

	if err := c.Visit(pageURL); err != nil {
		return utils.Result{
			Error: err,
		}
	}

	return utils.Result{
		Data: result,
	}
}

func (g MangaQueryImpl) GetAllComic(filter string, page int) utils.Result {
	var output utils.Result
	var result []domain.Comic
	c := g.Collector.Clone()

	g.URL = joinURL(config.GlobalEnv.BaseURL, "daftar-komik/")
	params := url.Values{}
	if filter != "" {
		params.Set("tipe", filter)
	}
	if page > 1 {
		params.Set("halaman", strconv.Itoa(page))
	}
	if encoded := params.Encode(); encoded != "" {
		g.URL += "?" + encoded
	}

	c.AllowURLRevisit = true
	c.OnHTML("article.manga-card", func(e *colly.HTMLElement) {
		var comic domain.Comic
		comic.Endpoint = endpointPath(e.ChildAttr("a", "href"))
		comic.Title = e.ChildText("h4")

		// src is a lazy-load placeholder here, the real image is in data-src
		img := e.ChildAttr("img", "data-src")
		if img == "" {
			img = e.ChildAttr("img", "src")
		}
		comic.Image = stripQuery(img)

		// p.meta reads "Manhwa • Drama<br> Status: Ongoing"
		if meta := e.ChildText("p.meta"); strings.Contains(meta, "•") {
			comic.Type = strings.TrimSpace(meta[:strings.Index(meta, "•")])
		}

		result = append(result, comic)
	})
	err := c.Visit(g.URL)
	if err != nil {
		output = utils.Result{
			Error: err,
		}

		return output
	}

	output = utils.Result{
		Data: result,
	}

	return output
}

func (g MangaQueryImpl) GetComicInfo(endpoint string) utils.Result {
	var output utils.Result

	var comicInfo domain.ComicInfo
	c := g.Collector.Clone()

	g.URL = joinURL(config.GlobalEnv.BaseURL, endpoint)
	c.AllowURLRevisit = true
	c.OnHTML("table.inftable", func(e *colly.HTMLElement) {
		e.ForEach("tr", func(i int, row *colly.HTMLElement) {
			value := row.ChildText("td:nth-child(2)")
			switch normalizeLabel(row.ChildText("td:nth-child(1)")) {
			case "judul":
				comicInfo.Title = value
			case "tipe":
				comicInfo.Type = value
			case "author", "pengarang":
				comicInfo.Author = value
			case "status":
				comicInfo.Status = value
			case "rating":
				comicInfo.Rating = value
			}
		})
	})
	c.OnHTML("ul.genre", func(e *colly.HTMLElement) {
		e.ForEach("li.genre", func(i int, element *colly.HTMLElement) {
			comicInfo.Genre = append(comicInfo.Genre, strings.TrimSpace(element.Text))
		})
	})

	c.OnHTML("div.ims", func(e *colly.HTMLElement) {
		comicInfo.Thumbnail = stripQuery(e.ChildAttr("img", "src"))
	})
	err := c.Visit(g.URL)
	if err != nil {
		output = utils.Result{
			Error: err,
		}

		return output
	}

	output = utils.Result{
		Data: comicInfo,
	}

	return output
}

func (g MangaQueryImpl) SearchManga(query string) utils.Result {
	c := g.Collector.Clone()

	// the param may arrive raw or still percent-encoded
	if unescaped, err := url.PathUnescape(query); err == nil {
		query = unescaped
	}
	g.URL = joinURL(config.GlobalEnv.APIURL, "") + "?post_type=manga&s=" + url.QueryEscape(query)

	return scrapeCards(c, g.URL)
}

func (g MangaQueryImpl) GetAllGenre() utils.Result {
	var output utils.Result
	var result []domain.Genre
	c := g.Collector.Clone()
	seen := make(map[string]bool)

	g.URL = joinURL(config.GlobalEnv.BaseURL, "p/daftar-genre/")
	c.AllowURLRevisit = true
	c.OnHTML("a.gnr", func(e *colly.HTMLElement) {
		// the href slug is what GetByGenre needs: data-nama is a display name
		// ("dark fantasy") and does not resolve upstream, so it is only a fallback
		slug := strings.Trim(strings.TrimPrefix(strings.Trim(endpointPath(e.Attr("href")), "/"), "genre/"), "/")
		if slug == "" {
			slug = strings.TrimSpace(e.Attr("data-nama"))
		}
		if slug == "" || seen[slug] {
			return
		}
		seen[slug] = true

		var genre domain.Genre
		genre.Endpoint = slug
		genre.Title = e.ChildText("b")

		result = append(result, genre)
	})

	err := c.Visit(g.URL)
	if err != nil {
		output = utils.Result{
			Error: err,
		}

		return output
	}

	output = utils.Result{
		Data: result,
	}

	return output
}

func (g MangaQueryImpl) GetPopularManga(page int) utils.Result {
	c := g.Collector.Clone()
	g.URL = joinURL(config.GlobalEnv.APIURL, pagedPath("other/hot/", page))

	return scrapeCards(c, g.URL)
}

func (g MangaQueryImpl) GetRecommendedManga(page int) utils.Result {
	c := g.Collector.Clone()
	g.URL = joinURL(config.GlobalEnv.APIURL, pagedPath("other/rekomendasi/", page))

	return scrapeCards(c, g.URL)
}

func (g MangaQueryImpl) GetNewestManga(page int) utils.Result {
	c := g.Collector.Clone()
	g.URL = joinURL(config.GlobalEnv.APIURL, pagedPath("manga/", page))

	return scrapeCards(c, g.URL)
}

func (g MangaQueryImpl) GetByGenre(endpoint string, page int) utils.Result {
	c := g.Collector.Clone()

	// older clients still send the slug the way the previous GetAllGenre
	// produced it ("action/" or "genre/action/"), and Echo hands over a path
	// param that contains %2F still percent-encoded
	if unescaped, err := url.PathUnescape(endpoint); err == nil {
		endpoint = unescaped
	}
	slug := strings.Trim(strings.TrimPrefix(strings.Trim(endpoint, "/"), "genre/"), "/")
	g.URL = joinURL(config.GlobalEnv.APIURL, pagedPath("genre/"+url.PathEscape(slug)+"/", page))

	return scrapeCards(c, g.URL)
}
