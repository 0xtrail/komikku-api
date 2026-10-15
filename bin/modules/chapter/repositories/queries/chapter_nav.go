package queries

import (
	"cmp"
	"net/url"
	"strings"

	"github.com/gocolly/colly"
	"komikku-api/bin/modules/chapter/models/domain"
)

// chapterMarker is what every chapter slug contains: "<series>-chapter-<number>".
const chapterMarker = "-chapter-"

// applyChapterNav fills the series link and the neighbouring chapters of detail
// from a chapter page; e is the document root.
//
// The page is the source of truth: the series slug cannot be derived from the
// chapter slug ("solo-leveling-ragnarok-chapter-66" belongs to
// /manga/alone-leveling-ragnarok/). The prev/list/next bar appears twice (top
// and bottom) and the first one is used. Each value takes the first candidate
// that passes validation, so a link that is not a series or chapter path never
// wins over a valid fallback and an absent link stays an empty string.
func applyChapterNav(e *colly.HTMLElement, detail *domain.ChapterDetail) {
	detail.MangaEndpoint = cmp.Or(
		mangaEndpoint(e.ChildAttr(`a[aria-label="List"][rel="tag"]`, "href")),
		mangaEndpoint(e.ChildAttr(`span[itemprop="isPartOf"] meta[itemprop="url"]`, "content")),
	)
	// The itemprop name has to be scoped to isPartOf: the page also carries the
	// chapter, author and publisher names under the same itemprop.
	detail.MangaTitle = cmp.Or(
		collapseSpaces(e.ChildAttr(`span[itemprop="isPartOf"] meta[itemprop="name"]`, "content")),
		collapseSpaces(e.ChildAttr(`a[aria-label="List"]`, "title")),
	)
	detail.PrevEndpoint = chapterEndpoint(e.ChildAttr(`a[aria-label="Prev"]`, "href"))
	detail.NextEndpoint = cmp.Or(
		chapterEndpoint(e.ChildAttr(`a[aria-label="Next"]`, "href")),
		chapterEndpoint(e.ChildAttr("div.nextch", "data")),
	)
}

func collapseSpaces(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// pathSegments returns the non-empty segments of the path of href. The host,
// query and fragment are ignored, so an absolute href and a relative one give
// the same result. A href that is not a site path (no leading slash once the
// host is gone, unparsable, "javascript:...") gives nil.
func pathSegments(href string) []string {
	u, err := url.Parse(strings.TrimSpace(href))
	if err != nil {
		return nil
	}
	path := u.EscapedPath()
	if !strings.HasPrefix(path, "/") {
		return nil
	}
	return strings.FieldsFunc(path, func(r rune) bool { return r == '/' })
}

// chapterEndpoint turns href into "/<series>-chapter-<n>/", or "" when it is not
// a chapter path: exactly one segment containing "-chapter-" with something on
// both sides. A series page such as /manga/re-zero-alternative-chapter-one-shot/
// therefore never passes for a chapter.
func chapterEndpoint(href string) string {
	segments := pathSegments(href)
	if len(segments) != 1 {
		return ""
	}
	i := strings.Index(segments[0], chapterMarker)
	if i <= 0 || i+len(chapterMarker) >= len(segments[0]) {
		return ""
	}
	return "/" + segments[0] + "/"
}

// mangaEndpoint turns href into "/manga/<slug>/", or "" when it is not a series path.
func mangaEndpoint(href string) string {
	segments := pathSegments(href)
	if len(segments) != 2 || segments[0] != "manga" {
		return ""
	}
	return "/manga/" + segments[1] + "/"
}
