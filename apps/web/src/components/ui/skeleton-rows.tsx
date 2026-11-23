import { cn } from "cn"

// rowShapes is the outline the rows draw: a few folders, some nested files.
// Fixed, so every load draws the same quiet shape (decision 0192).
const rowShapes: readonly { depth: 0 | 1 | 2; width: "short" | "medium" | "long" }[] = [
  { depth: 0, width: "medium" },
  { depth: 0, width: "short" },
  { depth: 1, width: "long" },
  { depth: 1, width: "medium" },
  { depth: 2, width: "short" },
  { depth: 1, width: "long" },
  { depth: 0, width: "medium" },
  { depth: 0, width: "long" },
  { depth: 1, width: "short" },
  { depth: 0, width: "medium" },
]

interface SkeletonRowsProps {
  // label names what is loading, for assistive technology.
  label: string
  className?: string
}

// SkeletonRows stands in for list rows still loading: static bars with no
// shimmer. It appears only after --delay-progress, so a quick load never
// flashes it.
export function SkeletonRows({ label, className }: SkeletonRowsProps) {
  return (
    <div className={cn("ui-skeleton-rows", className)} role="status" aria-busy="true">
      <span className="visually-hidden">{`${label}…`}</span>
      {rowShapes.map((row, index) => (
        <div key={index} className="ui-skeleton-row" data-depth={row.depth} data-width={row.width} aria-hidden="true">
          <span className="ui-skeleton-icon" />
          <span className="ui-skeleton-bar" />
        </div>
      ))}
    </div>
  )
}
