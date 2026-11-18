# 0170: Window sidebar result lists

- Status: Accepted
- Date: 2026-11-19
- Extends: [0020](0020-activity-bar-and-search-view.md), [0040](0040-source-control-panes-and-review-files-rail.md), [0168](0168-sidebar-and-picker-visibility.md)

Search can display 2,000 matches plus file headers. Source Control accumulates
loaded commit pages and can show 5,000 flat file changes. Mounting their rows
made each view's presentation work scale with its result set.

- For lists above 32 rows, mount the viewport, one viewport of overscan in
  each direction, and the rows needed for focus. Report logical positions and
  sizes to assistive technology. The full list still drives navigation,
  selection, expansion, and pagination.
- Use the existing scrollers, including Source Control's shared phone scroller.
  Use the row tokens for size estimates and measure expanded commit details as
  their contents and width change. Keep the visible row anchored when geometry
  above it changes. Keep the last valid geometry through sidebar hiding.
- Scroll a keyboard target into view before focusing it. Search stepping reveals
  the selected match and moves focus within the results when they own it.
  Keyboard access to commit pagination stays in the same scroll area as history.

The window is a presentation concern. Search workers, file and commit fetching,
and Pierre tree and diff virtualization keep their existing owners. Native
browser Find covers mounted rows.
