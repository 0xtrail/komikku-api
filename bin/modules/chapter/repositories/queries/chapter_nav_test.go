package queries

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/gocolly/colly"
	"komikku-api/bin/config"
	"komikku-api/bin/modules/chapter/models/domain"
)

// The queries package imports config, whose init() panics unless PORT and
// BASE_URL are set, so run these tests with:
//
//	PORT=0 BASE_URL=https://komiku.org/ go test ./bin/modules/chapter/...
func TestChapterEndpoint(t *testing.T) {
	tests := []struct {
		href string
		want string
	}{
		{"https://komiku.org/solo-leveling-ragnarok-chapter-65/", "/solo-leveling-ragnarok-chapter-65/"},
		{"/solo-leveling-ragnarok-chapter-65/", "/solo-leveling-ragnarok-chapter-65/"},
		{"solo-leveling-ragnarok-chapter-65", ""}, // relative to the page, so not a site path
		{"//komiku.org/one-piece-chapter-1196/", "/one-piece-chapter-1196/"},
		{"https://other.example:8080/one-piece-chapter-1196", "/one-piece-chapter-1196/"},
		{"https://komiku.org/one-piece-chapter-1196/?utm=x#top", "/one-piece-chapter-1196/"},
		{" /one-piece-chapter-2/ ", "/one-piece-chapter-2/"},
		{"/solo-leveling-ragnarok-chapter-00-15/", "/solo-leveling-ragnarok-chapter-00-15/"},
		{"", ""},
		{"https://komiku.org/", ""},
		{"/manga/one-piece/", ""},
		{"/manga/re-zero-alternative-chapter-one-shot/", ""}, // a series whose slug contains -chapter-
		{"/genre/action/", ""},
		{"/-chapter-5/", ""},
		{"/one-piece-chapter-/", ""},
		{"/a/b-chapter-1/", ""},
		{"/one-piece-chapter-1/extra/", ""}, // more than the chapter itself
		{"javascript:void(0)", ""},
		{"#", ""},
		{"http://[::1", ""},
	}
	for _, tt := range tests {
		if got := chapterEndpoint(tt.href); got != tt.want {
			t.Errorf("chapterEndpoint(%q) = %q, want %q", tt.href, got, tt.want)
		}
	}
}

func TestMangaEndpoint(t *testing.T) {
	tests := []struct {
		href string
		want string
	}{
		{"/manga/alone-leveling-ragnarok/", "/manga/alone-leveling-ragnarok/"},
		{"https://komiku.org/manga/alone-leveling-ragnarok/", "/manga/alone-leveling-ragnarok/"},
		{"https://komiku.org/manga/alone-leveling-ragnarok", "/manga/alone-leveling-ragnarok/"},
		{"/manga/komik-one-piece-indo/?x=1", "/manga/komik-one-piece-indo/"},
		{"", ""},
		{"/manga/", ""},
		{"/manga", ""},
		{"/genre/action/", ""},
		{"/solo-leveling-ragnarok-chapter-65/", ""},
		{"/manga/a/b/", ""},
		{"https://komiku.org/", ""},
	}
	for _, tt := range tests {
		if got := mangaEndpoint(tt.href); got != tt.want {
			t.Errorf("mangaEndpoint(%q) = %q, want %q", tt.href, got, tt.want)
		}
	}
}

// navBlock is the prev/list/next bar of a chapter page. Every page carries it
// twice (top and bottom), which is why the same block appears twice below.
func navBlock(list, prev, next string) string {
	out := ""
	if list != "" {
		out += `<a href="` + list + `" title="Series" class="btn" aria-label="List" rel="tag"><svg></svg></a>`
	}
	if prev != "" {
		out += `<a href="` + prev + `" title="Prev" class="btn" aria-label="Prev"><svg></svg></a>`
	}
	if next != "" {
		out += `<a href="` + next + `" title="Next" class="btn" aria-label="Next"><svg></svg></a>`
	}
	return `<div class="nav">` + out + `</div>`
}

const (
	isPartOf = `<span itemprop="isPartOf" itemscope itemtype="http://schema.org/CreativeWorkSeries">` +
		`<meta itemprop="name" content="Solo Leveling: Ragnarok"><meta itemprop="url" content="https://komiku.org/manga/alone-leveling-ragnarok/"></span>`

	// the page also carries unrelated itemprop names (chapter, author, publisher)
	otherMeta = `<meta itemprop="name" content="Solo Leveling: Ragnarok Chapter 66"><meta itemprop="url" content="https://komiku.org/solo-leveling-ragnarok-chapter-66/">` +
		`<span itemprop="author"><meta itemprop="name" content="Chugong"></span>`

	reader = `<div id="Judul"><h1>  Komik Solo Leveling:
 Ragnarok Chapter 66 </h1></div><div id="Baca_Komik"><img class="klazy" src="https://img.example/1.jpg"><img class="klazy" src="https://img.example/2.jpg"></div>`
)

// chapterPages are chapter pages as the upstream serves them, keyed by path.
var chapterPages = map[string]string{
	// absolute prev/next, relative list link; the bottom bar must be ignored
	"/solo-leveling-ragnarok-chapter-66/": otherMeta + isPartOf +
		navBlock("/manga/alone-leveling-ragnarok/", "https://komiku.org/solo-leveling-ragnarok-chapter-65/", "https://komiku.org/solo-leveling-ragnarok-chapter-67/") +
		reader +
		navBlock("/manga/bottom-bar/", "https://komiku.org/bottom-chapter-1/", "https://komiku.org/bottom-chapter-3/") +
		`<div class="nextch" data="https://komiku.org/bottom-chapter-3/"></div>`,
	// relative hrefs everywhere, a foreign host, a query string and no trailing slash
	"/relative-chapter-5/": isPartOf + navBlock("https://other.example/manga/rel/?x=1", "/relative-chapter-4/", "//cdn.example/relative-chapter-6") + reader,
	// first chapter: there is no Prev link
	"/first-chapter-1/": isPartOf + navBlock("/manga/first/", "", "https://komiku.org/first-chapter-2/") +
		`<div class="nextch" data="https://komiku.org/first-chapter-2/"></div>` + reader,
	// latest chapter: no Next link and no div.nextch
	"/latest-chapter-9/": isPartOf + navBlock("/manga/latest/", "https://komiku.org/latest-chapter-8/", "") + reader,
	// no aria-label links at all: itemprop for the series, div.nextch for next, nothing for prev
	"/fallback-chapter-3/": otherMeta + isPartOf + reader +
		`<div class="nextch" data="https://komiku.org/fallback-chapter-4/"></div>`,
	// an invalid aria-label link must not win over a valid fallback
	"/bad-aria-chapter-3/": isPartOf + navBlock("/genre/action/", "/manga/not-a-chapter/", "https://komiku.org/") + reader +
		`<div class="nextch" data="/bad-aria-chapter-4/"></div>`,
	// nothing usable anywhere: every href is rejected, never turned into a bad URL
	"/garbage-chapter-1/": `<span itemprop="isPartOf"><meta itemprop="name" content="Some Series"><meta itemprop="url" content="https://komiku.org/solo-chapter-1/"></span>` +
		navBlock("/genre/action/", "/manga/re-zero-alternative-chapter-one-shot/", "javascript:void(0)") + reader +
		`<div class="nextch" data="https://komiku.org/"></div>`,
	// the title only comes from the link's title attribute
	"/title-attr-chapter-1/": `<a href="/manga/x/" title="Fallback &amp; Title" class="btn" aria-label="List" rel="tag"></a>` + reader,
	// no navigation block at all
	"/bare-chapter-1/": reader,
}

func TestDetailChapterNavigation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page, ok := chapterPages[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, "<html><body>"+page+"</body></html>")
	}))
	defer srv.Close()

	oldBase := config.GlobalEnv.BaseURL
	config.GlobalEnv.BaseURL = srv.URL + "/"
	defer func() { config.GlobalEnv.BaseURL = oldBase }()

	type nav struct{ mangaEndpoint, mangaTitle, prev, next string }
	tests := []struct {
		name     string
		endpoint string
		want     nav
	}{
		{"middle chapter, first bar wins", "/solo-leveling-ragnarok-chapter-66/",
			nav{"/manga/alone-leveling-ragnarok/", "Solo Leveling: Ragnarok", "/solo-leveling-ragnarok-chapter-65/", "/solo-leveling-ragnarok-chapter-67/"}},
		{"relative hrefs, foreign hosts, no trailing slash", "/relative-chapter-5/",
			nav{"/manga/rel/", "Solo Leveling: Ragnarok", "/relative-chapter-4/", "/relative-chapter-6/"}},
		{"first chapter has no prev", "/first-chapter-1/",
			nav{"/manga/first/", "Solo Leveling: Ragnarok", "", "/first-chapter-2/"}},
		{"latest chapter has no next", "/latest-chapter-9/",
			nav{"/manga/latest/", "Solo Leveling: Ragnarok", "/latest-chapter-8/", ""}},
		{"itemprop and div.nextch fallbacks", "/fallback-chapter-3/",
			nav{"/manga/alone-leveling-ragnarok/", "Solo Leveling: Ragnarok", "", "/fallback-chapter-4/"}},
		{"an invalid aria link falls through to the fallbacks", "/bad-aria-chapter-3/",
			nav{"/manga/alone-leveling-ragnarok/", "Solo Leveling: Ragnarok", "", "/bad-aria-chapter-4/"}},
		{"nothing valid yields empty strings", "/garbage-chapter-1/",
			nav{"", "Some Series", "", ""}},
		{"series title from the link title attribute", "/title-attr-chapter-1/",
			nav{"/manga/x/", "Fallback & Title", "", ""}},
		{"no navigation block", "/bare-chapter-1/", nav{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := NewChapterQuery("", colly.NewCollector()).DetailChapter(tt.endpoint)
			if res.Error != nil {
				t.Fatalf("unexpected error: %v", res.Error)
			}
			detail, ok := res.Data.(domain.ChapterDetail)
			if !ok {
				t.Fatalf("Data is %T, want domain.ChapterDetail", res.Data)
			}
			got := nav{detail.MangaEndpoint, detail.MangaTitle, detail.PrevEndpoint, detail.NextEndpoint}
			if got != tt.want {
				t.Errorf("navigation = %+v, want %+v", got, tt.want)
			}

			// the pre-existing fields are untouched
			if detail.Title != "Komik Solo Leveling: Ragnarok Chapter 66" {
				t.Errorf("Title = %q", detail.Title)
			}
			if want := []string{"https://img.example/1.jpg", "https://img.example/2.jpg"}; !reflect.DeepEqual(detail.Image, want) {
				t.Errorf("Image = %v, want %v", detail.Image, want)
			}
		})
	}
}

func TestDetailChapterUnknownSlugIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()

	oldBase := config.GlobalEnv.BaseURL
	config.GlobalEnv.BaseURL = srv.URL + "/"
	defer func() { config.GlobalEnv.BaseURL = oldBase }()

	if res := NewChapterQuery("", colly.NewCollector()).DetailChapter("/nope-chapter-1/"); res.Error == nil {
		t.Fatal("an upstream 404 must come back as an error, not as empty data")
	}
}
