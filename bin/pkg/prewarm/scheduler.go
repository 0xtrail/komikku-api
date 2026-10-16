package prewarm

import (
	"context"
	"log"
	"time"
)

// Source is where the scheduler finds chapters. It is implemented on top of the
// scraper in main; every method makes live requests to the upstream site.
type Source interface {
	// Titles returns the endpoints of the titles worth preloading (the first page
	// of the newest and of the popular listing). It may return titles together
	// with an error when only part of the listings could be read.
	Titles() ([]string, error)
	// LatestChapter returns the endpoint of a title's newest chapter, or "" when
	// the title lists none.
	LatestChapter(title string) (string, error)
	// ChapterImages returns the original upstream image URLs of a chapter, the
	// ones the image proxy rewrites into tokens.
	ChapterImages(chapter string) ([]string, error)
}

// Scheduler periodically preloads the images of the latest chapter of each
// title on the newest and popular listings, which is what readers open first.
type Scheduler struct {
	Source Source
	Out    Enqueuer
	Recent *Recent

	// Interval is the time between cycles; a cycle that is still running delays
	// the next one rather than overlapping it.
	Interval time.Duration
	// StartDelay postpones the first cycle so a restart does not scrape at once.
	StartDelay time.Duration
	// MaxChapters caps the chapters one cycle prewarms. Chapters skipped as
	// recent do not count.
	MaxChapters int
	// Skip is how long a prewarmed chapter is left alone.
	Skip time.Duration
	// Pause separates two titles, so a cycle does not hit the upstream in a burst.
	Pause time.Duration
}

// Cycle is what one RunOnce did.
type Cycle struct {
	Titles   int // distinct titles looked at
	Chapters int // chapters whose images were queued
	Images   int // image URLs handed to the proxy
	Skipped  int // chapters left alone because they were prewarmed lately
	Failed   int // titles or chapters that could not be read
}

// Run runs a cycle every Interval until ctx is cancelled. It returns at once
// when prewarming is off (no interval, no chapters, or the proxy cannot do it).
func (s *Scheduler) Run(ctx context.Context) {
	if s.Interval <= 0 || s.MaxChapters <= 0 || !s.Out.PrewarmEnabled() {
		return
	}
	if !sleep(ctx, s.StartDelay) {
		return
	}
	for {
		c := s.RunOnce(ctx)
		if ctx.Err() != nil {
			return
		}
		log.Printf("prewarm: cycle done: titles=%d chapters=%d images=%d skipped=%d failed=%d", c.Titles, c.Chapters, c.Images, c.Skipped, c.Failed)
		if !sleep(ctx, s.Interval) {
			return
		}
	}
}

// RunOnce makes one pass over the listings. It stops early when ctx is
// cancelled or MaxChapters chapters were queued.
func (s *Scheduler) RunOnce(ctx context.Context) Cycle {
	var c Cycle

	titles, err := s.Source.Titles()
	if err != nil {
		log.Printf("prewarm: reading the listings failed: %v", err)
		c.Failed++
	}

	seen := make(map[string]struct{}, len(titles))
	for _, title := range titles {
		if ctx.Err() != nil || c.Chapters >= s.MaxChapters {
			break
		}
		if _, dup := seen[title]; dup || title == "" {
			continue
		}
		seen[title] = struct{}{}
		c.Titles++

		if c.Titles > 1 && !sleep(ctx, s.Pause) {
			break
		}
		s.prewarmLatest(title, &c)
	}
	return c
}

// prewarmLatest queues the images of title's newest chapter, unless that chapter
// was prewarmed lately.
func (s *Scheduler) prewarmLatest(title string, c *Cycle) {
	chapter, err := s.Source.LatestChapter(title)
	if err != nil {
		log.Printf("prewarm: latest chapter of %s: %v", title, err)
		c.Failed++
		return
	}
	if chapter == "" {
		return
	}

	key := ChapterKey(chapter)
	if !s.Recent.Claim(key, s.Skip) {
		c.Skipped++
		return
	}
	images, err := s.Source.ChapterImages(chapter)
	if err != nil || len(images) == 0 {
		// Nothing was queued, so let the next cycle try this chapter again.
		s.Recent.Forget(key)
		if err != nil {
			log.Printf("prewarm: images of %s: %v", chapter, err)
		}
		c.Failed++
		return
	}
	s.Out.Prewarm(images)
	c.Chapters++
	c.Images += len(images)
}

// sleep waits for d or until ctx is cancelled, and reports whether the full
// time passed.
func sleep(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
