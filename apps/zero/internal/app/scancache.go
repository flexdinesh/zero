package app

import (
	"sync"

	"github.com/flexdinesh/zero/internal/files"
)

// scanCacheLimit bounds the project indexes kept at once; the least
// recently used goes first (decision 0192).
const scanCacheLimit = 4

// scanCache keeps a project's index while live updates follow its tree, so
// opening files in a large folder does not rescan it (decision 0192). An
// index is reused only when its scan began while the project was followed
// at open level and no tree change was delivered since; any other scan is
// served but not kept. Concurrent scans of one root share one walk.
type scanCache struct {
	// generation is the watch hub's tree generation; ok is false while the
	// hub does not follow root's tree.
	generation func(root string) (generation uint64, ok bool)
	scan       func(root string) (*files.Index, error)
	limit      int

	mu      sync.Mutex
	entries map[string]*scanEntry
	flights map[string]*scanFlight
	clock   uint64
}

type scanEntry struct {
	generation uint64
	index      *files.Index
	used       uint64
}

// scanFlight is a scan in progress, shared by requests for the same root
// and generation.
type scanFlight struct {
	generation uint64
	followed   bool
	done       chan struct{}
	index      *files.Index
	err        error
}

func newScanCache(limit int, generation func(string) (uint64, bool), scan func(string) (*files.Index, error)) *scanCache {
	return &scanCache{
		generation: generation,
		scan:       scan,
		limit:      limit,
		entries:    map[string]*scanEntry{},
		flights:    map[string]*scanFlight{},
	}
}

// get returns root's index: kept, joined, or scanned now.
func (c *scanCache) get(root string) (*files.Index, error) {
	c.mu.Lock()
	c.prune()
	generation, followed := c.generation(root)
	if entry, ok := c.entries[root]; ok && followed && entry.generation == generation {
		c.clock++
		entry.used = c.clock
		c.mu.Unlock()
		return entry.index, nil
	}
	if flight, ok := c.flights[root]; ok && flight.generation == generation && flight.followed == followed {
		c.mu.Unlock()
		<-flight.done
		return flight.index, flight.err
	}
	flight := &scanFlight{generation: generation, followed: followed, done: make(chan struct{})}
	c.flights[root] = flight
	c.mu.Unlock()

	flight.index, flight.err = c.scan(root)

	c.mu.Lock()
	if c.flights[root] == flight {
		delete(c.flights, root)
	}
	if flight.err == nil && followed {
		// Keep it only if nothing changed while it was read.
		if now, still := c.generation(root); still && now == generation {
			c.clock++
			c.entries[root] = &scanEntry{generation: generation, index: flight.index, used: c.clock}
			c.evict()
		}
	}
	c.mu.Unlock()
	close(flight.done)
	return flight.index, flight.err
}

// prune drops the indexes whose project changed or is no longer followed.
func (c *scanCache) prune() {
	for root, entry := range c.entries {
		if generation, ok := c.generation(root); !ok || generation != entry.generation {
			delete(c.entries, root)
		}
	}
}

// evict drops the least recently used indexes past the limit.
func (c *scanCache) evict() {
	for len(c.entries) > c.limit {
		oldest := ""
		for root, entry := range c.entries {
			if oldest == "" || entry.used < c.entries[oldest].used {
				oldest = root
			}
		}
		delete(c.entries, oldest)
	}
}
