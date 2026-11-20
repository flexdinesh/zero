# 0185: Title band in every desktop window

- Status: Accepted
- Date: 2026-11-20
- Revises: [0119](0119-desktop-title-band-on-macos.md) (the traffic lights'
  place; Linux follows the theme's light or dark)
- Extends: [0184](0184-browser-view-and-in-page-comments.md) (the window of
  native UI)

## Context

0119's band takes its height from `--mygo-titlebar-height` and its insets from
`--mygo-titlebar-inset-left` and `-right`, which mygo sets in the page of a
page window. With experimental features on (0184), a connection's window is a
window of native UI holding Zero's page in a web view. mygo v0.7.4 tells no
such page the room of the window's controls (`sendTitleBar` returns for a
window with `Content`; a web view reports none), and v0.9.1 does the same. On
macOS the band lost its height and the traffic lights covered the activity
bar.

0119 also moved the traffic lights to (12, 8) to center them in a 32px band,
and kept Linux in the OS appearance.

## Decision

- **The band draws wherever the platform hides the title bar**, in page
  windows and windows of native UI alike. Priorities: the bar takes Zero's
  theme where it can; where it cannot, the system title bar stays; otherwise
  mygo's defaults.
- **The app tells the page what mygo does not.** A window of native UI reads
  the room of its controls in its view (`ui.Context.TitleBar`) and sends it to
  Zero's page in CSS pixels at the page's zoom, as the Zero event
  `zero:title-bar`: when it changes (full screen), on each load of the page,
  and after a zoom. Only a window that hides its title bar sends it. The
  preload of a window of native UI writes it to the same `--mygo-titlebar-*`
  variables, so the band, the layout, dialogs, and the proxy's drag strip need
  no change. Page windows keep mygo's own delivery.
- **The traffic lights stay where mygo puts them.** No `TrafficLightPosition`:
  the band is as tall as the room mygo reports (macOS's hidden title bar), and
  collapses in full screen, as 0119's did.
- **The title stays as built**: the window title (the active tab, then Zero),
  centered on the window, clear of the controls, dimmed in background windows.
- **Linux follows the theme's light or dark.** It keeps its native title bar,
  which Zero cannot draw in the theme's colors, but `setAppearance` now applies
  there too: `Theme.SetSource` has GTK's title bar and menus follow the theme's
  polarity where the desktop draws GTK's. A compositor that draws its own bar
  (KWin, Hyprland, Sway) keeps its look.

## Consequences

- The macOS band is the height of macOS's own title bar, a little shorter
  than 0119's 32px.
- The preload writes variables named for mygo. When mygo tells a web view's
  page the room of its window's controls, the event and the preload's handler
  go.
- On Linux, `Theme.SetSource` also sets `prefers-color-scheme` in pages,
  the Browser tab's guest included, as it already did on macOS.
- Dragging and double-clicking the band from a web view in a window of native
  UI on macOS is checked by hand, as 0184's window is.

## Follow-up

- In a window of native UI, the title dims while the Browser tab's guest has
  the keyboard: Zero's page hears `blur` though the window is active.
