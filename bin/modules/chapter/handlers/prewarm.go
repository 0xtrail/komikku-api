package handlers

import (
	"log"
	"time"

	chapterM "komikku-api/bin/modules/chapter/models/domain"
	"komikku-api/bin/pkg/prewarm"
)

const (
	// onDemandWindow is how long a chapter that was just prewarmed is left alone.
	onDemandWindow = 30 * time.Minute
	// nextChapterSlots bounds the background scrapes of "the next chapter" that
	// run at once. A burst of readers beyond it simply skips the lookahead: the
	// images are fetched on demand as before.
	nextChapterSlots = 2
)

// prewarmChapters preloads the chapter a reader just opened and the one they are
// most likely to open next, so the images are already in the disk cache when the
// browser asks for them. It never delays the response: the images of this chapter
// are only queued (the proxy fetches them in the background), and the next
// chapter's page is scraped on its own goroutine.
//
// It must run on the original upstream URLs, which is why it is called before
// proxyImages turns them into tokens. It does nothing while prewarming is off.
func (c *ChapterHandler) prewarmChapters(endpoint string, data interface{}) {
	if c.prewarm == nil || !c.prewarm.PrewarmEnabled() {
		return
	}
	detail, ok := data.(chapterM.ChapterDetail)
	if !ok {
		return
	}

	if c.recent.Claim(prewarm.ChapterKey(endpoint), onDemandWindow) {
		c.prewarm.Prewarm(detail.Image)
	}
	if detail.NextEndpoint != "" {
		go c.prewarmNext(detail.NextEndpoint)
	}
}

// prewarmNext scrapes the next chapter and queues its images. A failure releases
// the claim so the following reader of the previous chapter tries again.
func (c *ChapterHandler) prewarmNext(next string) {
	key := prewarm.ChapterKey(next)
	if !c.recent.Claim(key, onDemandWindow) {
		return
	}
	// This goroutine is outside the Recover middleware: a surprise here must not
	// take the whole API down, and must not leave the chapter claimed.
	defer func() {
		if r := recover(); r != nil {
			log.Printf("prewarm: next chapter %s: %v", next, r)
			c.recent.Forget(key)
		}
	}()
	select {
	case c.nextSlots <- struct{}{}:
		defer func() { <-c.nextSlots }()
	default:
		c.recent.Forget(key)
		return
	}

	result := c.chapterCommandUsecase.GetChapterDetail(next)
	detail, ok := result.Data.(chapterM.ChapterDetail)
	if result.Error != nil || !ok || len(detail.Image) == 0 {
		c.recent.Forget(key)
		return
	}
	c.prewarm.Prewarm(detail.Image)
}
