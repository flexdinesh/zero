package app

import (
	"errors"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/flexdinesh/zero/internal/files"
)

// fakeScans is a scanCache over hand-set generations and counted scans.
type fakeScans struct {
	mu          sync.Mutex
	generations map[string]uint64
	// asked counts generation lookups.
	asked atomic.Int32
	scans atomic.Int32
	// during runs inside each scan, before it returns.
	during func(root string)
	err    error
}

func (f *fakeScans) follow(root string, generation uint64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.generations[root] = generation
}

func (f *fakeScans) unfollow(root string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.generations, root)
}

func (f *fakeScans) cache(limit int) *scanCache {
	return newScanCache(limit, func(root string) (uint64, bool) {
		f.asked.Add(1)
		f.mu.Lock()
		defer f.mu.Unlock()
		generation, ok := f.generations[root]
		return generation, ok
	}, func(root string) (*files.Index, error) {
		f.scans.Add(1)
		if f.during != nil {
			f.during(root)
		}
		if f.err != nil {
			return nil, f.err
		}
		return &files.Index{Files: []string{root}}, nil
	})
}

func newFakeScans() *fakeScans {
	return &fakeScans{generations: map[string]uint64{}}
}

func mustGet(t *testing.T, cache *scanCache, root string) *files.Index {
	t.Helper()
	index, err := cache.get(root)
	if err != nil {
		t.Fatal(err)
	}
	return index
}

func TestScanCacheRescansAnUnfollowedProject(t *testing.T) {
	scans := newFakeScans()
	cache := scans.cache(4)
	mustGet(t, cache, "/a")
	mustGet(t, cache, "/a")
	if got := scans.scans.Load(); got != 2 {
		t.Fatalf("scans = %d, want a scan per read while unfollowed", got)
	}
}

func TestScanCacheKeepsAFollowedProjectUntilItChanges(t *testing.T) {
	scans := newFakeScans()
	scans.follow("/a", 1)
	cache := scans.cache(4)
	first := mustGet(t, cache, "/a")
	if again := mustGet(t, cache, "/a"); again != first || scans.scans.Load() != 1 {
		t.Fatalf("scans = %d, want the kept index", scans.scans.Load())
	}
	scans.follow("/a", 2)
	if changed := mustGet(t, cache, "/a"); changed == first || scans.scans.Load() != 2 {
		t.Fatalf("scans = %d, want a rescan after a change", scans.scans.Load())
	}
	scans.unfollow("/a")
	mustGet(t, cache, "/a")
	if scans.scans.Load() != 3 {
		t.Fatalf("scans = %d, want a rescan once unfollowed", scans.scans.Load())
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if len(cache.entries) != 0 {
		t.Fatalf("entries = %d, want none kept for an unfollowed project", len(cache.entries))
	}
}

func TestScanCacheDropsAScanThatRacedAChange(t *testing.T) {
	scans := newFakeScans()
	scans.follow("/a", 1)
	scans.during = func(string) { scans.follow("/a", 2) }
	cache := scans.cache(4)
	mustGet(t, cache, "/a")
	scans.during = nil
	mustGet(t, cache, "/a")
	if got := scans.scans.Load(); got != 2 {
		t.Fatalf("scans = %d, want the raced index dropped", got)
	}
	mustGet(t, cache, "/a")
	if got := scans.scans.Load(); got != 2 {
		t.Fatalf("scans = %d, want the next index kept", got)
	}
}

func TestScanCacheSharesConcurrentScans(t *testing.T) {
	scans := newFakeScans()
	started, release := make(chan struct{}), make(chan struct{})
	scans.during = func(string) {
		close(started)
		<-release
	}
	cache := scans.cache(4)
	results := make(chan *files.Index, 2)
	go func() { results <- mustGet(t, cache, "/a") }()
	<-started
	go func() { results <- mustGet(t, cache, "/a") }()
	// The second read has looked up its generation under the cache's lock,
	// which it holds until it joins: the first scan cannot end before.
	for scans.asked.Load() < 2 {
		runtime.Gosched()
	}
	close(release)
	first, second := <-results, <-results
	if first != second || scans.scans.Load() != 1 {
		t.Fatalf("scans = %d, want one shared scan", scans.scans.Load())
	}
}

func TestScanCacheKeepsNoFailedScan(t *testing.T) {
	scans := newFakeScans()
	scans.follow("/a", 1)
	scans.err = errors.New("unreadable")
	cache := scans.cache(4)
	if _, err := cache.get("/a"); err == nil {
		t.Fatal("get succeeded on a failed scan")
	}
	scans.err = nil
	mustGet(t, cache, "/a")
	if got := scans.scans.Load(); got != 2 {
		t.Fatalf("scans = %d, want the failure not kept", got)
	}
}

func TestScanCacheEvictsTheLeastRecentlyUsed(t *testing.T) {
	scans := newFakeScans()
	for _, root := range []string{"/a", "/b", "/c"} {
		scans.follow(root, 1)
	}
	cache := scans.cache(2)
	mustGet(t, cache, "/a")
	mustGet(t, cache, "/b")
	mustGet(t, cache, "/a")
	mustGet(t, cache, "/c")
	before := scans.scans.Load()
	mustGet(t, cache, "/a")
	if scans.scans.Load() != before {
		t.Fatal("the recently used index was evicted")
	}
	mustGet(t, cache, "/b")
	if scans.scans.Load() != before+1 {
		t.Fatal("the least recently used index was kept past the limit")
	}
}
