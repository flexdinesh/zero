package main

import "testing"

func TestNextZoom(t *testing.T) {
	cases := []struct {
		current   float64
		direction int
		want      float64
	}{
		{1, 1, 1.1},
		{1, -1, 0.9},
		{1.1, -1, 1},
		{5, 1, 5},
		{0.25, -1, 0.25},
		{1.2, 1, 1.25},
		{1.2, -1, 1.1},
	}
	for _, c := range cases {
		if got := nextZoom(c.current, c.direction); got != c.want {
			t.Errorf("nextZoom(%v, %d) = %v, want %v", c.current, c.direction, got, c.want)
		}
	}
}
