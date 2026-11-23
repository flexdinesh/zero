import { useLayoutEffect, useRef } from "react"

import { SkeletonRows } from "../components/ui/skeleton-rows.tsx"
import { TitleBar } from "./TitleBar.tsx"
import { savedSidebarWidth } from "./use-sidebar-resize.ts"

// WorkspaceSkeleton is the workspace's frame while the first route loads: a
// deep link's document can wait on a large folder's scan, and the window
// shows where things go meanwhile (decision 0192). It draws no controls, so
// nothing can be pressed before it works.
export function WorkspaceSkeleton() {
  const layout = useRef<HTMLDivElement>(null)
  const status = useRef<HTMLDivElement>(null)
  // The sidebar opens at its saved width, as the workspace will.
  useLayoutEffect(() => {
    const width = `${savedSidebarWidth()}px`
    for (const grid of [layout.current, status.current]) grid?.style.setProperty("--sidebar-width", width)
  }, [])
  return (
    <>
      <TitleBar title="Zero" />
      <div ref={layout} className="layout workspace-skeleton">
        <div className="workspace-skeleton-pane">
          <div className="activity-bar" />
          <aside className="sidebar" aria-label="Files">
            <div className="workspace-skeleton-header" />
            {/* The frame fades in as a whole. */}
            <SkeletonRows label="Loading files" delayed={false} />
          </aside>
        </div>
        <div className="sidebar-resizer" aria-hidden="true" />
        <div className="workspace">
          <div className="workspace-toolbar" />
          <main aria-busy="true" aria-label="Document" />
        </div>
      </div>
      <div ref={status} className="status-bar workspace-skeleton-status" />
    </>
  )
}
