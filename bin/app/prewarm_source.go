package main

import (
	"errors"
	"fmt"

	chapterM "komikku-api/bin/modules/chapter/models/domain"
	chapterQ "komikku-api/bin/modules/chapter/repositories/queries"
	mangaM "komikku-api/bin/modules/manga/models/domain"
	mangaQ "komikku-api/bin/modules/manga/repositories/queries"
	"komikku-api/bin/pkg/utils"
)

// scraperSource lets the prewarm scheduler read the site through the same
// queries the API uses. It goes to the query layer, not the usecases: the
// usecase for a title's info scrapes the page twice (once for the info, once for
// the chapter list) and the scheduler only needs the list.
type scraperSource struct {
	manga   mangaQ.MangaQuery
	chapter chapterQ.ChapterQuery
}

// Titles returns the first page of the newest and of the popular listing,
// interleaved so a small per-cycle cap still covers both.
func (s scraperSource) Titles() ([]string, error) {
	var lists [][]string
	var errs []error
	for _, l := range []struct {
		name string
		page func(int) utils.Result
	}{
		{"newest", s.manga.GetNewestManga},
		{"popular", s.manga.GetPopularManga},
	} {
		res := l.page(1)
		if res.Error != nil {
			errs = append(errs, fmt.Errorf("%s: %v", l.name, res.Error))
			continue
		}
		comics, ok := res.Data.([]mangaM.Comic)
		if !ok {
			errs = append(errs, fmt.Errorf("%s: unexpected listing result %T", l.name, res.Data))
			continue
		}
		endpoints := make([]string, 0, len(comics))
		for _, c := range comics {
			endpoints = append(endpoints, c.Endpoint)
		}
		lists = append(lists, endpoints)
	}
	return interleave(lists), errors.Join(errs...)
}

// LatestChapter returns the endpoint of the first chapter in the title's chapter
// list, the newest one, or "" when the list is empty.
func (s scraperSource) LatestChapter(title string) (string, error) {
	res := s.chapter.GetListChapter(title)
	if res.Error != nil {
		return "", fmt.Errorf("%v", res.Error)
	}
	chapters, ok := res.Data.([]chapterM.Chapter)
	if !ok {
		return "", fmt.Errorf("unexpected chapter list result %T", res.Data)
	}
	if len(chapters) == 0 {
		return "", nil
	}
	return chapters[0].Endpoint, nil
}

// ChapterImages returns the original upstream image URLs of a chapter.
func (s scraperSource) ChapterImages(chapter string) ([]string, error) {
	res := s.chapter.DetailChapter(chapter)
	if res.Error != nil {
		return nil, fmt.Errorf("%v", res.Error)
	}
	detail, ok := res.Data.(chapterM.ChapterDetail)
	if !ok {
		return nil, fmt.Errorf("unexpected chapter result %T", res.Data)
	}
	return detail.Image, nil
}

// interleave takes one item from each list in turn.
func interleave(lists [][]string) []string {
	var out []string
	for i := 0; ; i++ {
		took := false
		for _, l := range lists {
			if i < len(l) {
				out = append(out, l[i])
				took = true
			}
		}
		if !took {
			return out
		}
	}
}
