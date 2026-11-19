# Feedback fb-3k2q8m
Branch feature/greeting · /home/user/markdown · 3 threads awaiting you

Reply: zero feedback reply fb-3k2q8m <thread> -m "<what you did>" [--resolve | --wontfix]

## Thread 1 · open · code/main.go:7
```go
	fmt.Println("hello from zero") // go-search-token
```
**user** · 2026-11-10 09:12 UTC
Keep the greeting in a constant so the CLI and tests share it.

## Thread 2 · resolved · code/app.js:4-5 (moved from 2-3)
```js
const root = document.querySelector("#app")
root.textContent = "hello"
```
**user** · 2026-11-10 09:14 UTC
Guard against a missing `#app` element.

**agent (claude)** · 2026-11-10 09:30 UTC · resolved
Added an early return when the element is missing.

## Thread 3 · open · config/zero.toml:4 (old side) · outdated, code no longer present
```toml
depth = 3
```
**user** · 2026-11-10 09:16 UTC
Why did the default depth change?

## Thread 4 · won't fix · guides/getting-started.md (file)
**user** · 2026-11-10 09:18 UTC
Split this guide into install and first run.

**agent** · 2026-11-10 09:31 UTC · won't fix
Out of scope for this branch; the guide is rewritten in the docs redesign.

## Thread 5 · open · screenshot · http://localhost:5173/settings?tab=billing&session=REDACTED#plan
Page: "Settings · Acme" · viewport 1440×900 CSS px at 2× · scrolled 0,1320
Localhost: the reviewer's machine, not this one; the port may not reach the project
Region: image 96,96 420×96 of 612×288 · CSS 605,320 210×48 · document 605,1640
Element: button "Save changes" · main form > button[data-testid="save"]
Code at: 4e1d8c2b7a9f0e3d5c6b1a2f8e7d9c0b3a4f5e6d
Screenshot: zero feedback attachment fb-3k2q8m at-7hq2mx4kpa [--crop -o region.png]

**user** · 2026-11-12 14:02 UTC
Save overlaps the card edge at 1440 px. Keep it inside the card padding.

## Thread 6 · resolved · screenshot (removed)
Region: image 300,200 240×60 of 1280×720
Code at: 4e1d8c2b7a9f0e3d5c6b1a2f8e7d9c0b3a4f5e6d
Screenshot: removed to stay within the storage budget

**user** · 2026-11-18 10:00 UTC
This empty state has no call to action.

**agent (claude)** · 2026-11-18 10:20 UTC · resolved
Added a "New project" button to the empty state.
