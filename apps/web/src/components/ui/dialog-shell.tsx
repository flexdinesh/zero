import { cn } from "cn"
import { useCallback, type DialogHTMLAttributes, type Ref } from "react"

import { openOverlayLayer } from "../../lib/overlay-layers.ts"

interface DialogShellProps extends DialogHTMLAttributes<HTMLDialogElement> {
  // palette: top-anchored quick pick; panel: centered settings or details;
  // viewer: full-bleed content such as a diagram; drawer: full-height sheet
  // at the inline start, such as the mobile sidebar; sheet: a bottom sheet
  // for a phone's secondary list, such as a review's files.
  variant?: "palette" | "panel" | "viewer" | "drawer" | "sheet"
  backdrop?: "transparent" | "overlay"
  ref?: Ref<HTMLDialogElement>
}

// DialogShell styles a native dialog. Callers own opening, closing, and focus
// restore; the shell owns the overlay surface, and counts itself among the
// overlay layers while the dialog is open (decision 0184).
export function DialogShell({ variant = "panel", backdrop = "overlay", className, ref, ...props }: DialogShellProps) {
  const attach = useCallback((element: HTMLDialogElement) => {
    const detach = typeof ref === "function" ? ref(element) : undefined
    if (ref && typeof ref !== "function") ref.current = element
    let release: (() => void) | null = null
    const sync = () => {
      if (element.open && !release) release = openOverlayLayer()
      else if (!element.open && release) {
        release()
        release = null
      }
    }
    // Callers open and close the dialog themselves; its attribute tells.
    const observer = new MutationObserver(sync)
    observer.observe(element, { attributes: true, attributeFilter: ["open"] })
    sync()
    return () => {
      observer.disconnect()
      release?.()
      if (typeof detach === "function") detach()
      else if (typeof ref === "function") ref(null)
      else if (ref) ref.current = null
    }
  }, [ref])
  return (
    <dialog ref={attach} className={cn("ui-dialog", className)} data-variant={variant} data-backdrop={backdrop} {...props} />
  )
}
