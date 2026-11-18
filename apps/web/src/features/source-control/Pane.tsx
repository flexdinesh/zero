import { useLayoutEffect, useRef, type PointerEvent, type ReactNode, type Ref } from "react"

import { SectionToggle } from "../../components/ui/section-toggle.tsx"

interface PaneProps {
  title: string
  open: boolean
  elementRef: Ref<HTMLElement>
  onOpenChange(open: boolean): void
  note?: ReactNode
  actions?: ReactNode
  children: ReactNode
}

// Pane content retains its React lifetime while the layout owner previews
// the flex shares through elementRef (decisions 0040, 0123, 0130, 0161).
export function Pane({ actions, children, elementRef, note, open, title, onOpenChange }: PaneProps) {
  const header = useRef<HTMLHeadingElement>(null)
  const bodyFocused = useRef(false)
  useLayoutEffect(() => {
    if (open || !bodyFocused.current) return
    bodyFocused.current = false
    if (document.activeElement === document.body) header.current?.querySelector("button")?.focus()
  }, [open])
  return (
    <section ref={elementRef} className="scm-pane" aria-label={title} data-open={open || undefined}>
      <div className="scm-pane-header">
        <h3 ref={header} className="scm-pane-heading">
          <SectionToggle className="scm-pane-toggle" expanded={open} onExpandedChange={onOpenChange}>
            <span className="scm-pane-title">{title}</span>
            {note}
          </SectionToggle>
        </h3>
        {open && actions && <div className="scm-pane-header-actions">{actions}</div>}
      </div>
      {open && <div className="scm-pane-body" onFocusCapture={() => { bodyFocused.current = true }} onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) bodyFocused.current = false
      }}>{children}</div>}
    </section>
  )
}

const step = 0.05

interface PaneSashProps {
  elementRef: Ref<HTMLDivElement>
  label: string
  isResizing(): boolean
  onStart(event: PointerEvent<HTMLDivElement>): void
  onMove(event: PointerEvent<HTMLDivElement>): void
  onStop(event: PointerEvent<HTMLDivElement>): void
  onResize(delta: number): void
  onReset(): void
}

// The coordinated layout owns both sashes, their accessible values, and the
// active pointer. Keyboard resizing commits immediately while pointer-idle.
export function PaneSash({ elementRef, isResizing, label, onMove, onReset, onResize, onStart, onStop }: PaneSashProps) {
  return (
    <div ref={elementRef} className="scm-sash" role="separator" aria-orientation="horizontal" aria-label={label}
      aria-valuemin={0} aria-valuemax={100} tabIndex={0}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
        event.preventDefault()
        if (!isResizing()) onResize(event.key === "ArrowUp" ? -step : step)
      }}
      onPointerDown={onStart}
      onPointerMove={onMove}
      onPointerUp={onStop}
      onPointerCancel={onStop}
      onLostPointerCapture={onStop} />
  )
}
