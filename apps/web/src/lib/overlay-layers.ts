import { useEffect, useState, useSyncExternalStore, type SyntheticEvent } from "react"

// Overlay layers (decision 0184): the surfaces of Zero's that draw above its
// content: dialogs, palettes, menus, popovers, drawers. The desktop app
// places a Browser tab's page above Zero's own, so the tab hides that page
// while any layer is open. Each layer counts itself in while it shows.

let open = 0
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

// openOverlayLayer counts one layer in and returns its release, which
// counts it out once however often it is called.
export function openOverlayLayer(): () => void {
  open++
  emit()
  let released = false
  return () => {
    if (released) return
    released = true
    open--
    emit()
  }
}

// overlayOpen reports whether any layer is open now.
export function overlayOpen(): boolean {
  return open > 0
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// useOverlayLayer counts a layer in while shown.
export function useOverlayLayer(shown: boolean) {
  useEffect(() => shown ? openOverlayLayer() : undefined, [shown])
}

// useOverlayOpen reads whether any layer is open.
export function useOverlayOpen(): boolean {
  return useSyncExternalStore(subscribe, overlayOpen, () => false)
}

// OverlayLayer counts a layer in while mounted: a child of a popup that
// mounts only while it is open, such as a Base UI menu's.
export function OverlayLayer() {
  useOverlayLayer(true)
  return null
}

// useDisclosureLayer counts a details panel in while it is open; it returns
// the panel's onToggle.
export function useDisclosureLayer(): (event: SyntheticEvent<HTMLDetailsElement>) => void {
  const [shown, setShown] = useState(false)
  useOverlayLayer(shown)
  return (event) => setShown(event.currentTarget.open)
}
