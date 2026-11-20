package main

// zoomSteps are the page zooms the View menu steps through, as mygo's own
// zoom items do in a page window.
var zoomSteps = []float64{0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5}

// nextZoom is the step after current in direction (1 in, -1 out); the ends
// stay.
func nextZoom(current float64, direction int) float64 {
	if direction > 0 {
		for _, step := range zoomSteps {
			if step > current+0.001 {
				return step
			}
		}
		return zoomSteps[len(zoomSteps)-1]
	}
	for index := len(zoomSteps) - 1; index >= 0; index-- {
		if zoomSteps[index] < current-0.001 {
			return zoomSteps[index]
		}
	}
	return zoomSteps[0]
}
