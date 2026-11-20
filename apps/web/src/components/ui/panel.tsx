import { cn } from "cn"
import { useEffect, useLayoutEffect, useState, type HTMLAttributes } from "react"

interface PanelProps extends HTMLAttributes<HTMLElement> {
  // onHeight hears the content's height in CSS pixels, rounded up, on mount
  // and whenever it changes, so the native view can fit it.
  onHeight?(height: number): void
}

// Panel is a whole page the desktop app shows in its own small web view,
// such as the Browser's composer (decision 0186): the raised surface over
// the viewport, scrolling past its content's bound. Panels are used with a
// mouse at any width, so the page declares pointer density and the
// primitives keep their desktop sizes under the narrow-screen breakpoint.
// Bands (PanelHeader, PanelBody, PanelFooter) meet on hairlines.
export function Panel({ onHeight, className, ...props }: PanelProps) {
  const [section, setSection] = useState<HTMLElement | null>(null)

  // Before the first paint, so touch sizes never show.
  useLayoutEffect(() => {
    const root = document.documentElement
    const previous = root.getAttribute("data-density")
    root.setAttribute("data-density", "pointer")
    return () => {
      if (previous === null) root.removeAttribute("data-density")
      else root.setAttribute("data-density", previous)
    }
  }, [])

  useEffect(() => {
    if (!section || !onHeight) return
    const report = () => onHeight(Math.ceil(section.getBoundingClientRect().height))
    report()
    const observer = new ResizeObserver(report)
    observer.observe(section)
    return () => observer.disconnect()
  }, [onHeight, section])

  return (
    <div className="ui-panel-page">
      <section ref={setSection} className={cn("ui-panel", className)} {...props} />
    </div>
  )
}

export function PanelHeader({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <header className={cn("ui-panel-band ui-panel-header", className)} {...props} />
}

export function PanelBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ui-panel-band ui-panel-body", className)} {...props} />
}

export function PanelFooter({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <footer className={cn("ui-panel-band ui-panel-footer", className)} {...props} />
}
