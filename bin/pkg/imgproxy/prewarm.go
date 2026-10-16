package imgproxy

// Background prewarming: fetch upstream images into the disk cache before a
// client asks for them, so the first view of a chapter is a cache HIT instead of
// a slow origin fetch. Prewarm only queues URLs; a small, bounded pool of
// workers does the fetching through the same fetch/stream path a real request
// uses (allowlist, redirect checks, dial guard, size cap, image/* only, atomic
// fill), just with no client attached.

import (
	"context"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/url"
	"sync"
	"sync/atomic"
	"time"
)

const (
	defaultPrewarmQueue = 2000
	statsEvery          = time.Minute

	// Between two prewarm requests to one host: polite to the CDN, and it keeps
	// a burst of a whole chapter from looking like a flood.
	prewarmHostInterval = 150 * time.Millisecond
	prewarmHostJitter   = 100 * time.Millisecond
)

// PrewarmEnabled reports whether Prewarm does anything: the proxy has a key, the
// disk cache is on, and prewarming was not switched off.
func (p *Proxy) PrewarmEnabled() bool {
	return p.Enabled() && p.cache != nil && p.prewarm != nil
}

// Prewarm queues upstream image URLs to be fetched into the disk cache in the
// background and returns at once. A URL that is not allowed, is already cached,
// or is already queued or in flight is skipped. When the queue is full the
// newest URLs are dropped (one log line per burst). The URLs must be the
// original upstream ones, the same strings Rewrite turns into tokens.
func (p *Proxy) Prewarm(urls []string) {
	if !p.PrewarmEnabled() {
		return
	}
	for _, raw := range urls {
		if u, err := url.Parse(raw); err != nil || !p.allowedURL(u) {
			continue
		}
		if p.cache.has(cacheKey(raw)) {
			p.stats.skipped.Add(1)
			continue
		}
		switch p.prewarm.enqueue(raw) {
		case enqueueFullFirst:
			log.Printf("imgproxy: prewarm queue is full (%d), dropping new URLs until it drains", cap(p.prewarm.queue))
			fallthrough
		case enqueueFull:
			p.stats.dropped.Add(1)
		}
	}
}

// Start launches the prewarm workers. They stop when ctx is cancelled, which
// aborts the fetches in flight (a half-written entry is removed). Call Wait to
// join them. It does nothing when prewarming is off, and only the first call
// counts.
func (p *Proxy) Start(ctx context.Context) {
	if !p.PrewarmEnabled() {
		return
	}
	p.prewarm.start.Do(func() {
		for i := 0; i < p.prewarm.workers; i++ {
			p.prewarm.wg.Add(1)
			go p.prewarmWorker(ctx)
		}
	})
}

// Wait blocks until the workers started by Start have exited.
func (p *Proxy) Wait() {
	if p != nil && p.prewarm != nil {
		p.prewarm.wg.Wait()
	}
}

func (p *Proxy) prewarmWorker(ctx context.Context) {
	defer p.prewarm.wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case raw := <-p.prewarm.queue:
			p.prewarmOne(ctx, raw)
			p.prewarm.finish(raw)
			p.logStats()
		}
	}
}

// prewarmOne fetches one queued URL into the cache. The allowlist is checked
// again here and the redirect checks run inside fetch, exactly as for a request.
func (p *Proxy) prewarmOne(ctx context.Context, raw string) {
	u, err := url.Parse(raw)
	if err != nil || !p.allowedURL(u) {
		return
	}
	if p.cache.has(cacheKey(raw)) { // a real request got there first
		p.stats.skipped.Add(1)
		return
	}
	if err := p.prewarm.gate.wait(ctx, u.Hostname()); err != nil {
		return
	}

	resp, ferr := p.fetch(ctx, raw)
	if ferr != nil {
		p.stats.fail(ferr)
		return
	}
	defer resp.Body.Close()

	if p.stream(io.Discard, resp, metaFromResponse(resp), raw) {
		p.stats.filled.Add(1)
		return
	}
	p.stats.failed.Add(1)
}

type enqueueResult int

const (
	enqueued enqueueResult = iota
	enqueueDuplicate
	enqueueFull
	enqueueFullFirst // the first drop of a burst
)

// prewarmer is the bounded queue and the worker pool.
type prewarmer struct {
	workers int
	queue   chan string
	start   sync.Once
	wg      sync.WaitGroup
	gate    hostGate

	mu       sync.Mutex
	pending  map[string]struct{} // queued or in flight
	dropping bool                // the queue was full at the last enqueue
}

func newPrewarmer(workers, queue int) *prewarmer {
	if queue <= 0 {
		queue = defaultPrewarmQueue
	}
	return &prewarmer{
		workers: workers,
		queue:   make(chan string, queue),
		pending: make(map[string]struct{}),
		gate: hostGate{
			next:     make(map[string]time.Time),
			interval: prewarmHostInterval,
			jitter:   prewarmHostJitter,
		},
	}
}

func (w *prewarmer) enqueue(raw string) enqueueResult {
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, ok := w.pending[raw]; ok {
		return enqueueDuplicate
	}
	select {
	case w.queue <- raw:
		w.pending[raw] = struct{}{}
		w.dropping = false
		return enqueued
	default:
		first := !w.dropping
		w.dropping = true
		if first {
			return enqueueFullFirst
		}
		return enqueueFull
	}
}

// finish forgets raw so it can be queued again (it is cached by now, or failed).
func (w *prewarmer) finish(raw string) {
	w.mu.Lock()
	delete(w.pending, raw)
	w.mu.Unlock()
}

// hostGate spaces requests to one host: each caller reserves the next free slot
// for the host and waits for it.
type hostGate struct {
	mu       sync.Mutex
	next     map[string]time.Time
	interval time.Duration
	jitter   time.Duration
}

// reserve books the next slot for host and returns how long to wait for it.
func (g *hostGate) reserve(host string, now time.Time) time.Duration {
	g.mu.Lock()
	defer g.mu.Unlock()
	at := g.next[host]
	if at.Before(now) {
		at = now
	}
	gap := g.interval
	if g.jitter > 0 {
		gap += time.Duration(rand.Int63n(int64(g.jitter)))
	}
	g.next[host] = at.Add(gap)
	return at.Sub(now)
}

func (g *hostGate) wait(ctx context.Context, host string) error {
	d := g.reserve(host, time.Now())
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// stats counts cache traffic and prewarm outcomes for the periodic log line.
type stats struct {
	hit, miss                        atomic.Int64 // client requests
	filled, skipped, failed, dropped atomic.Int64 // prewarm outcomes
	every                            time.Duration
	lastLog                          atomic.Int64 // unix nanoseconds of the last line

	mu     sync.Mutex
	logged [6]int64 // the counters at the last line
	sample string   // one recent prewarm failure, for the next line
}

func (s *stats) fail(err *upstreamError) {
	s.failed.Add(1)
	s.mu.Lock()
	switch {
	case err.notFound:
		s.sample = "upstream 404"
	default:
		s.sample = fmt.Sprintf("%s (%v)", err.msg, err.detail)
	}
	s.mu.Unlock()
}

// logStats writes one line with what happened since the previous line, at most
// once per stats.every and only when something did. It is called from request
// and worker paths, so there is no timer goroutine to start or stop.
func (p *Proxy) logStats() {
	if p.cache == nil {
		return
	}
	s := &p.stats
	now := time.Now().UnixNano()
	last := s.lastLog.Load()
	if now-last < int64(s.every) || !s.lastLog.CompareAndSwap(last, now) {
		return
	}

	cur := [6]int64{s.hit.Load(), s.miss.Load(), s.filled.Load(), s.skipped.Load(), s.failed.Load(), s.dropped.Load()}
	s.mu.Lock()
	var d [6]int64
	for i := range cur {
		d[i] = cur[i] - s.logged[i]
	}
	s.logged = cur
	sample := s.sample
	s.sample = ""
	s.mu.Unlock()

	if d == [6]int64{} {
		return
	}
	queued := 0
	if p.prewarm != nil {
		queued = len(p.prewarm.queue)
	}
	window := time.Duration(now - last).Round(time.Second)
	line := fmt.Sprintf("imgproxy: cache last %s: hit=%d miss=%d | prewarm filled=%d skipped=%d failed=%d dropped=%d queued=%d | %d MiB on disk",
		window, d[0], d[1], d[2], d[3], d[4], d[5], queued, p.cache.usedBytes()>>20)
	if sample != "" {
		line += " (last failure: " + sample + ")"
	}
	log.Print(line)
}
