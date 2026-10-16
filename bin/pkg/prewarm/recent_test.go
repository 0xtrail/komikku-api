package prewarm

import (
	"testing"
	"time"
)

func fakeClock(r *Recent) *time.Time {
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	r.now = func() time.Time { return now }
	return &now
}

func TestChapterKeyTreatsPathAndEndpointAlike(t *testing.T) {
	for _, in := range []string{"/one-piece-chapter-5/", "one-piece-chapter-5", " /one-piece-chapter-5 ", "one-piece-chapter-5/"} {
		if got := ChapterKey(in); got != "one-piece-chapter-5" {
			t.Errorf("ChapterKey(%q) = %q", in, got)
		}
	}
}

func TestClaimIsGrantedOncePerWindow(t *testing.T) {
	r := NewRecent(10)
	now := fakeClock(r)

	if !r.Claim("a", 30*time.Minute) {
		t.Fatal("first claim refused")
	}
	if r.Claim("a", 30*time.Minute) {
		t.Fatal("a second claim inside the window was granted")
	}
	if !r.Claim("b", 30*time.Minute) {
		t.Fatal("another key was refused")
	}

	*now = now.Add(29 * time.Minute)
	if r.Claim("a", 30*time.Minute) {
		t.Fatal("claim granted before the window ended")
	}
	*now = now.Add(2 * time.Minute)
	if !r.Claim("a", 30*time.Minute) {
		t.Fatal("claim refused after the window ended")
	}
}

// A refused claim must not extend the window, or a chapter that keeps being
// opened would never be looked at again.
func TestRefusedClaimDoesNotSlideTheWindow(t *testing.T) {
	r := NewRecent(10)
	now := fakeClock(r)

	r.Claim("a", time.Hour)
	for i := 0; i < 5; i++ {
		*now = now.Add(11 * time.Minute)
		r.Claim("a", time.Hour)
	}
	// 55 minutes since the claim; 6 minutes more passes the hour.
	*now = now.Add(6 * time.Minute)
	if !r.Claim("a", time.Hour) {
		t.Fatal("repeated refused claims slid the window")
	}
}

// Each caller states its own window: the scheduler's 6 hours must not be cut
// short by a request path that only cares about 30 minutes, and the reverse.
func TestWindowsAreChosenPerCall(t *testing.T) {
	r := NewRecent(10)
	now := fakeClock(r)

	r.Claim("a", 30*time.Minute)
	*now = now.Add(time.Hour)
	if r.Claim("a", 6*time.Hour) {
		t.Fatal("a 6 hour claim was granted an hour after the first one")
	}
	if !r.Claim("a", 30*time.Minute) {
		t.Fatal("a 30 minute claim was refused an hour after the first one")
	}
}

func TestForgetLetsTheNextClaimThrough(t *testing.T) {
	r := NewRecent(10)
	fakeClock(r)

	r.Claim("a", time.Hour)
	r.Forget("a")
	if !r.Claim("a", time.Hour) {
		t.Fatal("claim refused after Forget")
	}
	r.Forget("never-claimed") // must not panic
}

func TestRecentIsBoundedAndDropsTheOldest(t *testing.T) {
	r := NewRecent(3)
	now := fakeClock(r)

	for _, k := range []string{"a", "b", "c"} {
		r.Claim(k, time.Hour)
		*now = now.Add(time.Minute)
	}
	r.Claim("d", time.Hour) // full: "a", the oldest, goes

	if len(r.seen) != 3 {
		t.Fatalf("holds %d keys, want 3", len(r.seen))
	}
	if !r.Claim("a", time.Hour) {
		t.Error(`"a" was still remembered after being the oldest in a full set`)
	}
	if r.Claim("d", time.Hour) {
		t.Error(`"d", the newest, was forgotten`)
	}
}

func TestRecentIsSafeForConcurrentUse(t *testing.T) {
	r := NewRecent(50)
	done := make(chan struct{})
	for g := 0; g < 8; g++ {
		go func() {
			defer func() { done <- struct{}{} }()
			for i := 0; i < 500; i++ {
				k := string(rune('a' + i%70))
				r.Claim(k, time.Minute)
				if i%7 == 0 {
					r.Forget(k)
				}
			}
		}()
	}
	for g := 0; g < 8; g++ {
		<-done
	}
	if len(r.seen) > 50 {
		t.Fatalf("holds %d keys, limit 50", len(r.seen))
	}
}
