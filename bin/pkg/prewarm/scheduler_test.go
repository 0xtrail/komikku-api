package prewarm

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

type fakeSource struct {
	mu sync.Mutex

	titles    []string
	titlesErr error
	latest    map[string]string // title -> chapter ("" or missing: no chapters)
	latestErr map[string]error
	images    map[string][]string // chapter -> image URLs
	imagesErr map[string]error

	latestCalls []string
	imageCalls  []string
}

func (f *fakeSource) Titles() ([]string, error) { return f.titles, f.titlesErr }

func (f *fakeSource) LatestChapter(title string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.latestCalls = append(f.latestCalls, title)
	return f.latest[title], f.latestErr[title]
}

func (f *fakeSource) ChapterImages(chapter string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.imageCalls = append(f.imageCalls, chapter)
	return f.images[chapter], f.imagesErr[chapter]
}

type fakeOut struct {
	mu      sync.Mutex
	off     bool
	batches [][]string
}

func (o *fakeOut) PrewarmEnabled() bool { return !o.off }

func (o *fakeOut) Prewarm(urls []string) {
	o.mu.Lock()
	o.batches = append(o.batches, urls)
	o.mu.Unlock()
}

func (o *fakeOut) count() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.batches)
}

// library builds n titles t1..tn, each with a latest chapter c<i> of two images.
func library(n int) *fakeSource {
	f := &fakeSource{
		latest:    map[string]string{},
		latestErr: map[string]error{},
		images:    map[string][]string{},
		imagesErr: map[string]error{},
	}
	for i := 1; i <= n; i++ {
		title := fmt.Sprintf("/manga/t%d/", i)
		chapter := fmt.Sprintf("/t%d-chapter-9/", i)
		f.titles = append(f.titles, title)
		f.latest[title] = chapter
		f.images[chapter] = []string{
			fmt.Sprintf("https://img.komiku.org/t%d/1.jpg", i),
			fmt.Sprintf("https://img.komiku.org/t%d/2.jpg", i),
		}
	}
	return f
}

func scheduler(src Source, out Enqueuer, max int) *Scheduler {
	return &Scheduler{Source: src, Out: out, Recent: NewRecent(100), Interval: time.Hour, MaxChapters: max, Skip: 6 * time.Hour}
}

func TestRunOncePrewarmsTheLatestChapterOfEachTitle(t *testing.T) {
	src, out := library(3), &fakeOut{}
	c := scheduler(src, out, 20).RunOnce(context.Background())

	if c.Titles != 3 || c.Chapters != 3 || c.Images != 6 || c.Skipped != 0 || c.Failed != 0 {
		t.Fatalf("cycle = %+v", c)
	}
	if out.count() != 3 || out.batches[1][0] != "https://img.komiku.org/t2/1.jpg" {
		t.Fatalf("batches = %v", out.batches)
	}
}

func TestRunOnceReadsATitleListedTwiceOnce(t *testing.T) {
	src, out := library(2), &fakeOut{}
	src.titles = append(src.titles, src.titles[0], src.titles[1], "") // newest and popular overlap

	c := scheduler(src, out, 20).RunOnce(context.Background())
	if c.Titles != 2 || len(src.latestCalls) != 2 || out.count() != 2 {
		t.Fatalf("cycle = %+v, latest calls %v, batches %d", c, src.latestCalls, out.count())
	}
}

func TestRunOnceStopsAtMaxChapters(t *testing.T) {
	src, out := library(10), &fakeOut{}
	c := scheduler(src, out, 4).RunOnce(context.Background())

	if c.Chapters != 4 || out.count() != 4 {
		t.Fatalf("cycle = %+v, batches %d, want 4", c, out.count())
	}
	if len(src.latestCalls) != 4 {
		t.Fatalf("%d titles were read after the cap was reached, want 4", len(src.latestCalls))
	}
}

// A chapter prewarmed lately costs no scrape of its pages and does not use up
// the cap, so the next cycle moves on to chapters not yet done.
func TestRunOnceSkipsRecentChaptersWithoutCountingThem(t *testing.T) {
	src, out := library(6), &fakeOut{}
	s := scheduler(src, out, 3)

	first := s.RunOnce(context.Background())
	second := s.RunOnce(context.Background())

	if first.Chapters != 3 {
		t.Fatalf("first cycle = %+v", first)
	}
	if second.Chapters != 3 || second.Skipped != 3 {
		t.Fatalf("second cycle = %+v, want the 3 untouched chapters and 3 skips", second)
	}
	if got := len(src.imageCalls); got != 6 {
		t.Fatalf("%d chapter pages scraped across both cycles, want 6 (no repeats)", got)
	}

	third := s.RunOnce(context.Background())
	if third.Chapters != 0 || third.Skipped != 6 || out.count() != 6 {
		t.Fatalf("third cycle = %+v, batches %d", third, out.count())
	}
}

func TestRunOnceSkipsChaptersAnOnDemandRequestJustDid(t *testing.T) {
	src, out := library(2), &fakeOut{}
	s := scheduler(src, out, 20)
	s.Recent.Claim(ChapterKey("t1-chapter-9"), time.Minute) // the request path, no slashes

	c := s.RunOnce(context.Background())
	if c.Skipped != 1 || c.Chapters != 1 {
		t.Fatalf("cycle = %+v", c)
	}
}

func TestRunOnceSurvivesFailuresAndRetriesThemNextCycle(t *testing.T) {
	src, out := library(4), &fakeOut{}
	src.latestErr["/manga/t1/"] = errors.New("info page down")
	src.latest["/manga/t2/"] = "" // no chapters listed
	src.imagesErr["/t3-chapter-9/"] = errors.New("reader down")
	s := scheduler(src, out, 20)

	c := s.RunOnce(context.Background())
	if c.Chapters != 1 || c.Failed != 2 || out.count() != 1 {
		t.Fatalf("cycle = %+v, batches %d", c, out.count())
	}

	// The reader recovers: the chapter that failed is not locked out for 6 hours.
	delete(src.imagesErr, "/t3-chapter-9/")
	c = s.RunOnce(context.Background())
	if c.Chapters != 1 || out.count() != 2 {
		t.Fatalf("second cycle = %+v, batches %d, want the failed chapter done", c, out.count())
	}
}

func TestRunOnceTreatsAChapterWithoutImagesAsFailed(t *testing.T) {
	src, out := library(1), &fakeOut{}
	src.images["/t1-chapter-9/"] = nil
	s := scheduler(src, out, 20)

	if c := s.RunOnce(context.Background()); c.Failed != 1 || c.Chapters != 0 || out.count() != 0 {
		t.Fatalf("cycle = %+v, batches %d", c, out.count())
	}
	if !s.Recent.Claim("t1-chapter-9", time.Hour) {
		t.Fatal("an empty chapter stayed claimed")
	}
}

func TestRunOnceKeepsGoingWhenOnlyOneListingFailed(t *testing.T) {
	src, out := library(2), &fakeOut{}
	src.titlesErr = errors.New("popular listing down")

	c := scheduler(src, out, 20).RunOnce(context.Background())
	if c.Chapters != 2 || c.Failed != 1 {
		t.Fatalf("cycle = %+v", c)
	}
}

func TestRunOnceStopsWhenTheContextIsCancelled(t *testing.T) {
	src, out := library(10), &fakeOut{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	c := scheduler(src, out, 20).RunOnce(ctx)
	if c.Chapters != 0 || len(src.latestCalls) != 0 {
		t.Fatalf("cycle = %+v, %d titles read after cancel", c, len(src.latestCalls))
	}
}

func TestRunOncePausesBetweenTitlesAndHonoursCancelDuringThePause(t *testing.T) {
	src, out := library(5), &fakeOut{}
	s := scheduler(src, out, 20)
	s.Pause = time.Hour

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan Cycle)
	go func() { done <- s.RunOnce(ctx) }()

	deadline := time.After(5 * time.Second)
	for {
		src.mu.Lock()
		n := len(src.latestCalls)
		src.mu.Unlock()
		if n == 1 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("the first title was never read")
		case <-time.After(time.Millisecond):
		}
	}
	cancel()

	select {
	case c := <-done:
		if c.Chapters != 1 || len(src.latestCalls) != 1 {
			t.Fatalf("cycle = %+v, %d titles read, want only the first", c, len(src.latestCalls))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RunOnce kept waiting in the pause after the context was cancelled")
	}
}

func TestRunDoesNothingWhenOffOrDisabled(t *testing.T) {
	cases := map[string]func(*Scheduler, *fakeOut){
		"no interval":  func(s *Scheduler, _ *fakeOut) { s.Interval = 0 },
		"no chapters":  func(s *Scheduler, _ *fakeOut) { s.MaxChapters = 0 },
		"proxy cannot": func(_ *Scheduler, o *fakeOut) { o.off = true },
	}
	for name, mutate := range cases {
		src, out := library(2), &fakeOut{}
		s := scheduler(src, out, 20)
		mutate(s, out)

		done := make(chan struct{})
		go func() { s.Run(context.Background()); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatalf("%s: Run kept running", name)
		}
		if len(src.latestCalls) != 0 || out.count() != 0 {
			t.Errorf("%s: scraped %d titles and queued %d batches", name, len(src.latestCalls), out.count())
		}
	}
}

func TestRunRepeatsEveryIntervalAndStopsOnCancel(t *testing.T) {
	src, out := library(1), &fakeOut{}
	s := scheduler(src, out, 20)
	s.Interval = 20 * time.Millisecond
	s.Skip = time.Nanosecond // every cycle counts again

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.Run(ctx); close(done) }()

	deadline := time.After(5 * time.Second)
	for out.count() < 3 {
		select {
		case <-deadline:
			t.Fatalf("only %d cycles ran", out.count())
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop after the context was cancelled")
	}
}

func TestRunWaitsForTheStartDelay(t *testing.T) {
	src, out := library(1), &fakeOut{}
	s := scheduler(src, out, 20)
	s.StartDelay = time.Hour

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.Run(ctx); close(done) }()

	time.Sleep(50 * time.Millisecond)
	if out.count() != 0 || len(src.latestCalls) != 0 {
		t.Fatal("a cycle ran before the start delay")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop during the start delay")
	}
}
