package main

import (
	"errors"
	"reflect"
	"testing"

	chapterM "komikku-api/bin/modules/chapter/models/domain"
	chapterQ "komikku-api/bin/modules/chapter/repositories/queries"
	mangaM "komikku-api/bin/modules/manga/models/domain"
	mangaQ "komikku-api/bin/modules/manga/repositories/queries"
	"komikku-api/bin/pkg/utils"
)

// The embedded interfaces stay nil: a call to a method the test did not set
// panics, which is what we want from an unexpected scrape.
type fakeManga struct {
	mangaQ.MangaQuery
	newest, popular utils.Result
	pages           []int
}

func (f *fakeManga) GetNewestManga(page int) utils.Result {
	f.pages = append(f.pages, page)
	return f.newest
}

func (f *fakeManga) GetPopularManga(page int) utils.Result {
	f.pages = append(f.pages, page)
	return f.popular
}

type fakeChapters struct {
	chapterQ.ChapterQuery
	list   utils.Result
	detail utils.Result
}

func (f fakeChapters) GetListChapter(string) utils.Result { return f.list }
func (f fakeChapters) DetailChapter(string) utils.Result  { return f.detail }

func comics(endpoints ...string) utils.Result {
	var out []mangaM.Comic
	for _, e := range endpoints {
		out = append(out, mangaM.Comic{Endpoint: e})
	}
	return utils.Result{Data: out}
}

func TestTitlesInterleavesNewestAndPopularFirstPageOnly(t *testing.T) {
	m := &fakeManga{newest: comics("/manga/n1/", "/manga/n2/", "/manga/n3/"), popular: comics("/manga/p1/", "/manga/p2/")}

	got, err := scraperSource{manga: m}.Titles()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"/manga/n1/", "/manga/p1/", "/manga/n2/", "/manga/p2/", "/manga/n3/"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("titles = %v, want %v", got, want)
	}
	if !reflect.DeepEqual(m.pages, []int{1, 1}) {
		t.Fatalf("pages asked for = %v, want page 1 of each", m.pages)
	}
}

func TestTitlesKeepsWhatItGotWhenOneListingFails(t *testing.T) {
	m := &fakeManga{newest: utils.Result{Error: errors.New("api.komiku.org down")}, popular: comics("/manga/p1/")}

	got, err := scraperSource{manga: m}.Titles()
	if err == nil || !reflect.DeepEqual(got, []string{"/manga/p1/"}) {
		t.Fatalf("titles = %v, err = %v", got, err)
	}
}

func TestTitlesReportsAWrongResultTypeInsteadOfPanicking(t *testing.T) {
	m := &fakeManga{newest: utils.Result{Data: "not a list"}, popular: utils.Result{}}

	got, err := scraperSource{manga: m}.Titles()
	if err == nil || len(got) != 0 {
		t.Fatalf("titles = %v, err = %v", got, err)
	}
}

func TestLatestChapterIsTheFirstOfTheList(t *testing.T) {
	list := []chapterM.Chapter{{Name: "Chapter 9", Endpoint: "/x-chapter-9/"}, {Name: "Chapter 8", Endpoint: "/x-chapter-8/"}}
	s := scraperSource{chapter: fakeChapters{list: utils.Result{Data: list}}}

	got, err := s.LatestChapter("/manga/x/")
	if err != nil || got != "/x-chapter-9/" {
		t.Fatalf("got %q, err %v", got, err)
	}
}

func TestLatestChapterOfATitleWithNoChapters(t *testing.T) {
	for name, data := range map[string]interface{}{
		"nil slice":   []chapterM.Chapter(nil),
		"empty slice": []chapterM.Chapter{},
	} {
		s := scraperSource{chapter: fakeChapters{list: utils.Result{Data: data}}}
		if got, err := s.LatestChapter("/manga/x/"); err != nil || got != "" {
			t.Errorf("%s: got %q, err %v", name, got, err)
		}
	}
}

func TestLatestChapterErrors(t *testing.T) {
	s := scraperSource{chapter: fakeChapters{list: utils.Result{Error: errors.New("404")}}}
	if _, err := s.LatestChapter("/manga/x/"); err == nil {
		t.Error("a failed scrape was not reported")
	}
	s = scraperSource{chapter: fakeChapters{list: utils.Result{}}}
	if _, err := s.LatestChapter("/manga/x/"); err == nil {
		t.Error("a result of the wrong type was not reported")
	}
}

func TestChapterImages(t *testing.T) {
	detail := chapterM.ChapterDetail{Image: []string{"https://img.komiku.org/1.jpg", "https://img.komiku.org/2.jpg"}}
	s := scraperSource{chapter: fakeChapters{detail: utils.Result{Data: detail}}}

	got, err := s.ChapterImages("/x-chapter-9/")
	if err != nil || !reflect.DeepEqual(got, detail.Image) {
		t.Fatalf("got %v, err %v", got, err)
	}

	s = scraperSource{chapter: fakeChapters{detail: utils.Result{Error: errors.New("404")}}}
	if _, err := s.ChapterImages("/x-chapter-9/"); err == nil {
		t.Error("a failed scrape was not reported")
	}
	s = scraperSource{chapter: fakeChapters{detail: utils.Result{Data: 7}}}
	if _, err := s.ChapterImages("/x-chapter-9/"); err == nil {
		t.Error("a result of the wrong type was not reported")
	}
}

func TestInterleave(t *testing.T) {
	got := interleave([][]string{{"a", "b", "c"}, nil, {"x"}})
	if want := []string{"a", "x", "b", "c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("interleave = %v, want %v", got, want)
	}
	if got := interleave(nil); len(got) != 0 {
		t.Fatalf("interleave(nil) = %v", got)
	}
}
