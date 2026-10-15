package queries

import (
	"github.com/gocolly/colly"
	"komikku-api/bin/config"
	"komikku-api/bin/modules/chapter/models/domain"
	"komikku-api/bin/pkg/utils"
	"strings"
)

type ChapterQueryImpl struct {
	URL			string
	Collector	*colly.Collector
}


func NewChapterQuery(url string, collector *colly.Collector) ChapterQuery {
	return &ChapterQueryImpl{
		URL: url,
		Collector: collector,
	}
}

// joinURL joins a base URL and a path without producing a double slash.
func joinURL(base, path string) string {
	return strings.TrimRight(base, "/") + "/" + strings.TrimLeft(path, "/")
}

func (c ChapterQueryImpl) GetListChapter(endpoint string) utils.Result {
	var output utils.Result
	var chapterList []domain.Chapter
	collector := c.Collector.Clone()

	c.URL = joinURL(config.GlobalEnv.BaseURL, endpoint)
	collector.AllowURLRevisit = true
	collector.OnHTML("tbody._3Rsjq", func(e *colly.HTMLElement) {
		e.ForEach("tr", func(i int, element *colly.HTMLElement) {
			var chapter domain.Chapter
			// the header row has th.judulseries only, so it is skipped here
			if element.ChildText("td.judulseries") != "" {
				chapter.Endpoint = element.ChildAttr("td.judulseries a", "href")
				chapter.Name = element.ChildText("td.judulseries")
				chapterList = append(chapterList, chapter)
			}
		})
	})
	err := collector.Visit(c.URL)
	if err != nil {
		output = utils.Result{
			Error: err,
		}

		return output
	}

	output = utils.Result{
		Data: chapterList,
	}

	return output
}

func (c ChapterQueryImpl) DetailChapter(endpoint string) utils.Result {
	var output utils.Result
	var chapter domain.ChapterDetail
	collector := c.Collector.Clone()

	c.URL = joinURL(config.GlobalEnv.BaseURL, endpoint)
	collector.AllowURLRevisit = true
	collector.OnHTML("#Baca_Komik", func(e *colly.HTMLElement) {
		imageList := e.ChildAttrs("img.klazy", "src")
		if len(imageList) == 0 {
			// fall back to every image except the promo banner
			for _, src := range e.ChildAttrs("img", "src") {
				if !strings.Contains(src, "komiku-promosi") {
					imageList = append(imageList, src)
				}
			}
		}
		chapter.Image = imageList
	})
	collector.OnHTML("#Judul h1", func(e *colly.HTMLElement) {
		if chapter.Title == "" {
			chapter.Title = strings.Join(strings.Fields(e.Text), " ")
		}
	})
	collector.OnHTML("html", func(e *colly.HTMLElement) {
		applyChapterNav(e, &chapter)
	})
	err := collector.Visit(c.URL)
	if err != nil {
		output = utils.Result{
			Error: err,
		}
		return output
	}
	output = utils.Result{
		Data: chapter,
	}
	return output
}
