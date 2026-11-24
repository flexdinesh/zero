package main

import "testing"

// A project's Browser tabs are guests of their own (decision 0195): two
// tabs of one project are kept apart, and past maxGuests the one shown
// longest ago leaves, whichever project it is.
func TestShellKeepsEachTabsGuest(t *testing.T) {
	s := newShell(false)
	first := &guest{key: guestKey{project: "/p", tab: 1}}
	second := &guest{key: guestKey{project: "/p", tab: 2}}
	if evicted := s.add(first); evicted != nil {
		t.Fatalf("add(first) evicted %+v", evicted.key)
	}
	if evicted := s.add(second); evicted != nil {
		t.Fatalf("add(second) evicted %+v", evicted.key)
	}
	if s.guest(first.key) != first || s.guest(second.key) != second {
		t.Fatalf("tabs of one project share a guest")
	}
	if s.guest(guestKey{project: "/p", tab: 3}) != nil || s.guest(guestKey{project: "/q", tab: 1}) != nil {
		t.Fatalf("a tab without a guest has one")
	}
	for tab := 3; tab <= maxGuests; tab++ {
		if evicted := s.add(&guest{key: guestKey{project: "/p", tab: tab}}); evicted != nil {
			t.Fatalf("add(tab %d) evicted %+v under the limit", tab, evicted.key)
		}
	}
	s.shown = first.key
	evicted := s.add(&guest{key: guestKey{project: "/q", tab: 1}})
	if evicted != second {
		t.Fatalf("past the limit, evicted %v, want the second tab: the first shows", evicted)
	}
	if s.guest(second.key) != nil || s.guest(first.key) != first {
		t.Fatalf("eviction kept the wrong guests")
	}
}
