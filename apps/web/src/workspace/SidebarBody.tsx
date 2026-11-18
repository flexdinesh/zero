import { memo, useState, type ReactNode } from "react"

interface SidebarBodyProps {
  visible: boolean
  children: ReactNode
}

// Keep visited DOM and imperative models alive. Presentation receives the
// latest inputs on reveal. Controllers and context readers sit above this gate.
export const SidebarBody = memo(function SidebarBody({ visible, children }: SidebarBodyProps) {
  const [visited, setVisited] = useState(visible)
  if (visible && !visited) setVisited(true)
  return visible || visited ? children : null
}, (previous, next) => previous.visible === next.visible && (!next.visible || previous.children === next.children))
