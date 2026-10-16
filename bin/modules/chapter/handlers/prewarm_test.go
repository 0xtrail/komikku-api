package handlers

// config.init() panics unless PORT and BASE_URL are set, so run these tests with:
//
//	PORT=0 BASE_URL=https://komiku.org/ go test ./bin/modules/chapter/handlers

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
	chapterM "komikku-api/bin/modules/chapter/models/domain"
	httpError "komikku-api/bin/pkg/http-error"
	"komikku-api/bin/pkg/imgproxy"
	"komikku-api/bin/pkg/prewarm"
	"komikku-api/bin/pkg/utils"
)

// fakeUsecase serves chapter details from a map, optionally blocking or failing.
type fakeUsecase struct {
	mu       sync.Mutex
	chapters map[string]chapterM.ChapterDetail
	failing  map[string]bool
	gate     map[string]chan struct{} // a chapter waits for its channel to close
	calls    []string
}

func (f *fakeUsecase) GetChapterDetail(endpoint string) utils.Result {
	f.mu.Lock()
	f.calls = append(f.calls, endpoint)
	gate := f.gate[endpoint]
	failing := f.failing[endpoint]
	detail, ok := f.chapters[endpoint]
	f.mu.Unlock()

	if gate != nil {
		<-gate
	}
	if failing || !ok {
		// What the real usecase wraps a failed scrape in.
		err := httpError.NewNotFound()
		err.Message = "upstream down"
		return utils.Result{Error: err}
	}
	return utils.Result{Data: detail}
}

func (f *fakeUsecase) total() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func (f *fakeUsecase) called(endpoint string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == endpoint {
			n++
		}
	}
	return n
}

type fakeEnqueuer struct {
	mu      sync.Mutex
	off     bool
	batches [][]string
}

func (e *fakeEnqueuer) PrewarmEnabled() bool { return !e.off }

func (e *fakeEnqueuer) Prewarm(urls []string) {
	e.mu.Lock()
	e.batches = append(e.batches, urls)
	e.mu.Unlock()
}

func (e *fakeEnqueuer) snapshot() [][]string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([][]string(nil), e.batches...)
}

func chapter(slug, next string, n int) chapterM.ChapterDetail {
	d := chapterM.ChapterDetail{Title: slug, NextEndpoint: next}
	for i := 1; i <= n; i++ {
		d.Image = append(d.Image, "https://img.komiku.org/"+slug+"/"+string(rune('0'+i))+".jpg")
	}
	return d
}

func newHandler(uc *fakeUsecase, enq *fakeEnqueuer) *ChapterHandler {
	return &ChapterHandler{
		chapterCommandUsecase: uc,
		imgProxy:              imgproxy.New(imgproxy.Config{}),
		prewarm:               enq,
		recent:                prewarm.NewRecent(100),
		nextSlots:             make(chan struct{}, nextChapterSlots),
	}
}

func open(t *testing.T, h *ChapterHandler, endpoint string) *httptest.ResponseRecorder {
	t.Helper()
	e := echo.New()
	rec := httptest.NewRecorder()
	c := e.NewContext(httptest.NewRequest(http.MethodGet, "/api/comic/chapter/"+endpoint, nil), rec)
	c.SetParamNames("endpoint")
	c.SetParamValues(endpoint)
	if err := h.GetChapterDetail(c); err != nil {
		t.Fatalf("GetChapterDetail: %v", err)
	}
	return rec
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func TestOpeningAChapterPrewarmsItAndTheNextOne(t *testing.T) {
	uc := &fakeUsecase{chapters: map[string]chapterM.ChapterDetail{
		"one-chapter-1":   chapter("one-1", "/one-chapter-2/", 3),
		"/one-chapter-2/": chapter("one-2", "/one-chapter-3/", 2),
	}}
	enq := &fakeEnqueuer{}
	h := newHandler(uc, enq)

	if rec := open(t, h, "one-chapter-1"); rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	eventually(t, "both chapters to be queued", func() bool { return len(enq.snapshot()) == 2 })

	got := enq.snapshot()
	if strings.Join(got[0], ",") != strings.Join(uc.chapters["one-chapter-1"].Image, ",") {
		t.Errorf("the opened chapter queued %v", got[0])
	}
	if strings.Join(got[1], ",") != strings.Join(uc.chapters["/one-chapter-2/"].Image, ",") {
		t.Errorf("the next chapter queued %v", got[1])
	}
	if uc.called("/one-chapter-2/") != 1 {
		t.Errorf("the next chapter was scraped %d times, want 1", uc.called("/one-chapter-2/"))
	}
}

// The queue gets the upstream URLs, the same strings the proxy turns into
// tokens; handing it the tokens would fetch nothing.
func TestPrewarmGetsTheOriginalUrlsNotTheRewrittenOnes(t *testing.T) {
	key := make([]byte, 32)
	rand.Read(key)
	uc := &fakeUsecase{chapters: map[string]chapterM.ChapterDetail{"one-chapter-1": chapter("one-1", "", 2)}}
	enq := &fakeEnqueuer{}
	h := newHandler(uc, enq)
	h.imgProxy = imgproxy.New(imgproxy.Config{
		HMACKey:      base64.StdEncoding.EncodeToString(key),
		AllowedHosts: []string{"*.komiku.org"},
		PublicURL:    "https://api.example.test",
	})

	rec := open(t, h, "one-chapter-1")
	var body struct {
		Data chapterM.ChapterDetail `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	for _, img := range body.Data.Image {
		if !strings.HasPrefix(img, "https://api.example.test/img/") {
			t.Fatalf("the response was not rewritten to the proxy: %q", img)
		}
	}
	got := enq.snapshot()
	if len(got) != 1 || got[0][0] != "https://img.komiku.org/one-1/1.jpg" {
		t.Fatalf("queued %v, want the original upstream URLs", got)
	}
}

// Scraping the next chapter takes a while; the reader must not wait for it.
func TestTheNextChapterIsScrapedOffTheRequestPath(t *testing.T) {
	release := make(chan struct{})
	uc := &fakeUsecase{
		chapters: map[string]chapterM.ChapterDetail{
			"one-chapter-1":   chapter("one-1", "/one-chapter-2/", 2),
			"/one-chapter-2/": chapter("one-2", "", 2),
		},
		gate: map[string]chan struct{}{"/one-chapter-2/": release},
	}
	enq := &fakeEnqueuer{}
	h := newHandler(uc, enq)

	done := make(chan *httptest.ResponseRecorder)
	go func() { done <- open(t, h, "one-chapter-1") }()
	select {
	case rec := <-done:
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d", rec.Code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the response waited for the next chapter")
	}
	if n := len(enq.snapshot()); n != 1 {
		t.Fatalf("%d batches before the next chapter loaded, want only this chapter's", n)
	}

	close(release)
	eventually(t, "the next chapter to be queued", func() bool { return len(enq.snapshot()) == 2 })
}

func TestAChapterIsPrewarmedOncePerWindow(t *testing.T) {
	uc := &fakeUsecase{chapters: map[string]chapterM.ChapterDetail{
		"one-chapter-1":   chapter("one-1", "/one-chapter-2/", 2),
		"/one-chapter-2/": chapter("one-2", "", 2),
	}}
	enq := &fakeEnqueuer{}
	h := newHandler(uc, enq)

	for i := 0; i < 4; i++ {
		open(t, h, "one-chapter-1")
	}
	eventually(t, "the first round to finish", func() bool { return len(enq.snapshot()) == 2 })
	time.Sleep(50 * time.Millisecond) // a stray extra batch would show up by now

	if n := len(enq.snapshot()); n != 2 {
		t.Fatalf("%d batches after four views, want 2", n)
	}
	if uc.called("/one-chapter-2/") != 1 {
		t.Fatalf("the next chapter was scraped %d times, want 1", uc.called("/one-chapter-2/"))
	}

	// Reading on: chapter 2 was prewarmed as "next", so opening it queues nothing
	// new for itself, only its own next if it has one.
	uc.chapters["two"] = chapter("one-2", "", 2)
	open(t, h, "one-chapter-2")
	time.Sleep(50 * time.Millisecond)
	if n := len(enq.snapshot()); n != 2 {
		t.Fatalf("%d batches after opening the chapter that was already prewarmed, want 2", n)
	}
}

func TestAFailedNextChapterIsRetriedByTheNextReader(t *testing.T) {
	uc := &fakeUsecase{
		chapters: map[string]chapterM.ChapterDetail{
			"one-chapter-1":   chapter("one-1", "/one-chapter-2/", 2),
			"/one-chapter-2/": chapter("one-2", "", 2),
		},
		failing: map[string]bool{"/one-chapter-2/": true},
	}
	enq := &fakeEnqueuer{}
	h := newHandler(uc, enq)

	open(t, h, "one-chapter-1")
	eventually(t, "the first attempt", func() bool { return uc.called("/one-chapter-2/") == 1 })
	time.Sleep(20 * time.Millisecond)
	if n := len(enq.snapshot()); n != 1 {
		t.Fatalf("%d batches, want only the opened chapter's", n)
	}

	uc.mu.Lock()
	uc.failing["/one-chapter-2/"] = false
	uc.mu.Unlock()
	open(t, h, "one-chapter-1")
	eventually(t, "the retry to queue the next chapter", func() bool { return len(enq.snapshot()) == 2 })
}

func TestNoNextChapterMeansNoLookahead(t *testing.T) {
	uc := &fakeUsecase{chapters: map[string]chapterM.ChapterDetail{"one-chapter-9": chapter("one-9", "", 2)}}
	enq := &fakeEnqueuer{}
	h := newHandler(uc, enq)

	open(t, h, "one-chapter-9")
	time.Sleep(30 * time.Millisecond)
	if uc.total() != 1 || len(enq.snapshot()) != 1 {
		t.Fatalf("%d scrapes, batches %d", uc.total(), len(enq.snapshot()))
	}
}

func TestNothingHappensWhilePrewarmingIsOff(t *testing.T) {
	uc := &fakeUsecase{chapters: map[string]chapterM.ChapterDetail{"one-chapter-1": chapter("one-1", "/one-chapter-2/", 2)}}
	enq := &fakeEnqueuer{off: true}
	h := newHandler(uc, enq)

	if rec := open(t, h, "one-chapter-1"); rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	time.Sleep(30 * time.Millisecond)
	if uc.total() != 1 || len(enq.snapshot()) != 0 {
		t.Fatalf("%d scrapes, batches %d: prewarming ran while off", uc.total(), len(enq.snapshot()))
	}
}

func TestAFailedChapterPrewarmsNothing(t *testing.T) {
	uc := &fakeUsecase{failing: map[string]bool{"missing": true}}
	enq := &fakeEnqueuer{}
	h := newHandler(uc, enq)

	if rec := open(t, h, "missing"); rec.Code != http.StatusNotFound {
		t.Fatalf("status %d, want the usual error", rec.Code)
	}
	time.Sleep(30 * time.Millisecond)
	if len(enq.snapshot()) != 0 || uc.total() != 1 {
		t.Fatalf("batches %d, %d scrapes", len(enq.snapshot()), uc.total())
	}
}

// Readers cannot make the server run an unbounded number of background scrapes.
func TestLookaheadIsBoundedAndAnOverflowCanBeRetried(t *testing.T) {
	release := make(chan struct{})
	uc := &fakeUsecase{chapters: map[string]chapterM.ChapterDetail{}, gate: map[string]chan struct{}{}}
	for _, n := range []string{"a", "b", "c"} {
		uc.chapters[n] = chapter(n, "", 1)
		uc.gate[n] = release
	}
	enq := &fakeEnqueuer{}
	h := newHandler(uc, enq)

	for _, n := range []string{"a", "b", "c"} {
		go h.prewarmNext(n)
	}
	eventually(t, "the two slots to fill", func() bool { return len(h.nextSlots) == nextChapterSlots })
	time.Sleep(30 * time.Millisecond)
	if uc.total() != nextChapterSlots {
		t.Fatalf("%d scrapes running, limit %d", uc.total(), nextChapterSlots)
	}

	close(release)
	eventually(t, "the slots to drain", func() bool { return len(h.nextSlots) == 0 })

	// The one that found no free slot was released and may be tried again.
	var dropped string
	for _, n := range []string{"a", "b", "c"} {
		if uc.called(n) == 0 {
			dropped = n
		}
	}
	if dropped == "" {
		t.Fatal("every chapter was scraped; the bound did nothing")
	}
	h.prewarmNext(dropped)
	if uc.called(dropped) != 1 {
		t.Fatalf("the dropped chapter %q was not retried", dropped)
	}
}

func TestLookaheadSurvivesAPanicInTheUsecase(t *testing.T) {
	h := newHandler(&fakeUsecase{}, &fakeEnqueuer{})
	h.chapterCommandUsecase = panicUsecase{}
	h.prewarmNext("/boom/") // must return, not crash the test binary
	if len(h.nextSlots) != 0 {
		t.Fatal("a slot leaked after the panic")
	}
	if !h.recent.Claim(prewarm.ChapterKey("/boom/"), time.Hour) {
		t.Fatal("the claim was kept after the panic")
	}
}

type panicUsecase struct{}

func (panicUsecase) GetChapterDetail(string) utils.Result { panic("wrong assertion") }
