// Package prewarm decides what to preload into the image cache and when. The
// image proxy does the fetching (imgproxy.Proxy.Prewarm); this package keeps
// track of which chapters were handled lately (Recent) and finds the chapters
// worth preloading on a timer (Scheduler). It depends on neither the scraper
// nor the proxy: both are small interfaces, wired in main.
package prewarm

import (
	"strings"
	"sync"
	"time"
)

// Enqueuer is the part of the image proxy the prewarmers use.
type Enqueuer interface {
	PrewarmEnabled() bool
	Prewarm(urls []string)
}

// ChapterKey is the key a chapter is remembered by. The endpoint arrives as
// "/slug-chapter-3/" from the chapter page and as "slug-chapter-3" from a
// request path; both mean the same chapter.
func ChapterKey(endpoint string) string {
	return strings.Trim(strings.TrimSpace(endpoint), "/")
}

// Recent remembers which keys were claimed lately, so a chapter that was
// prewarmed a moment ago is not scraped and queued again. It holds at most max
// keys; when full, the oldest claim is forgotten first.
type Recent struct {
	mu   sync.Mutex
	seen map[string]time.Time
	max  int
	now  func() time.Time
}

// NewRecent returns a Recent that remembers up to max keys (at least 1).
func NewRecent(max int) *Recent {
	if max < 1 {
		max = 1
	}
	return &Recent{seen: make(map[string]time.Time), max: max, now: time.Now}
}

// Claim reports whether the caller should handle key: true when it was not
// claimed within the last `within`, in which case the claim is recorded now. A
// false answer means someone handled it recently and leaves the earlier claim
// untouched, so the window does not slide while a key keeps being asked for.
func (r *Recent) Claim(key string, within time.Duration) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := r.now()
	if at, ok := r.seen[key]; ok && now.Sub(at) < within {
		return false
	}
	if _, ok := r.seen[key]; !ok && len(r.seen) >= r.max {
		r.dropOldest()
	}
	r.seen[key] = now
	return true
}

// Forget releases a claim, for the caller that claimed key but could not finish
// the work: the next Claim succeeds at once.
func (r *Recent) Forget(key string) {
	r.mu.Lock()
	delete(r.seen, key)
	r.mu.Unlock()
}

func (r *Recent) dropOldest() {
	var oldest string
	var at time.Time
	first := true
	for k, t := range r.seen {
		if first || t.Before(at) {
			oldest, at, first = k, t, false
		}
	}
	delete(r.seen, oldest)
}
