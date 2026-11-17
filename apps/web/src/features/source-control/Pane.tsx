import { useCallback, useEffect, useRef, type PointerEvent, type ReactNode, type RefObject } from "react"

import { SectionToggle } from "../../components/ui/section-toggle.tsx"

interface PaneProps {
  title: string
  open: boolean
  // weight is the pane's share of the height open panes split.
  weight: number
  // mobile panes keep their natural height and the view scrolls.
  mobile: boolean
  onOpenChange(open: boolean): void
  // note follows the title: a count badge or a muted summary.
  note?: ReactNode
  // actions sit at the end of the open pane's header (decision 0130).
  actions?: ReactNode
  children: ReactNode
}

// Pane is one collapsible Source Control section (decisions 0040, 0123,
// 0130): a header that opens and closes it, with the open pane's actions at
// its end, then, when open, its body.
export function Pane({ actions, children, mobile, note, open, title, weight, onOpenChange }: PaneProps) {
  return (
    <section className="scm-pane" aria-label={title} data-open={open || undefined}
      style={open && !mobile ? { flexGrow: weight } : undefined}>
      {/* An accordion header: the heading holds the toggle, which spans it up
          to the actions; buttons cannot nest, so the actions are its sibling. */}
      <div className="scm-pane-header">
        <h3 className="scm-pane-heading">
          <SectionToggle className="scm-pane-toggle" expanded={open} onExpandedChange={onOpenChange}>
            <span className="scm-pane-title">{title}</span>
            {note}
          </SectionToggle>
        </h3>
        {open && actions && <div className="scm-pane-header-actions">{actions}</div>}
      </div>
      {open && <div className="scm-pane-body">{children}</div>}
    </section>
  )
}

const step = 0.05

interface PaneSashProps {
  // container holds the panes; its height is what open panes split.
  container: RefObject<HTMLDivElement | null>
  label: string
  // value is the pane above's share of the pair, for assistive technology.
  value: number
  onResize(delta: number): void
  onReset(): void
}

// PaneSash resizes the open panes on either side by pointer or arrow keys;
// double-click restores the default split.
export function PaneSash({ container, label, value, onResize, onReset }: PaneSashProps) {
  const dragging = useRef<{ pointer: number; element: HTMLDivElement; y: number } | null>(null)
  const finishResize = useCallback(() => {
    const drag = dragging.current
    dragging.current = null
    if (drag?.element.hasPointerCapture(drag.pointer)) drag.element.releasePointerCapture(drag.pointer)
  }, [])
  useEffect(() => {
    window.addEventListener("blur", finishResize)
    return () => {
      window.removeEventListener("blur", finishResize)
      finishResize()
    }
  }, [finishResize])
  function stopResize(event: PointerEvent<HTMLDivElement>) {
    if (dragging.current?.pointer === event.pointerId) finishResize()
  }
  return (
    <div className="scm-sash" role="separator" aria-orientation="horizontal" aria-label={label}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} tabIndex={0}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
        event.preventDefault()
        onResize(event.key === "ArrowUp" ? -step : step)
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary || dragging.current) return
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        dragging.current = { pointer: event.pointerId, element: event.currentTarget, y: event.clientY }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const drag = dragging.current
        const height = container.current?.getBoundingClientRect().height ?? 0
        if (!drag || drag.pointer !== event.pointerId || height <= 0) return
        onResize((event.clientY - drag.y) / height)
        drag.y = event.clientY
      }}
      onPointerUp={stopResize}
      onPointerCancel={stopResize}
      onLostPointerCapture={stopResize} />
  )
}
