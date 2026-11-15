import { cn } from "cn"
import type { ButtonHTMLAttributes, HTMLAttributes, Ref } from "react"

export type RowDensity = "list" | "pick" | "menu" | "drawer"

// RowIndent is why a row's content starts where it does (decision 0149):
// - flush: a top-level row.
// - toggle: the row leads with its own disclosure chevron.
// - nested: under a pane or file header, past that header's chevron.
// - match: a search match under its file.
// The end inset is fixed: trailing content clears the overlay scrollbar lane.
export type RowIndent = "flush" | "toggle" | "nested" | "match"

interface ListRowProps extends HTMLAttributes<HTMLDivElement> {
  density?: RowDensity
  indent?: RowIndent
  // active marks the keyboard or pointer cursor in a listbox.
  active?: boolean
  selected?: boolean
  ref?: Ref<HTMLDivElement>
}

// ListRow is one row of a tree, listbox, or result list. Hover adds a state
// layer; active and selected rows take the selection fill and ink.
export function ListRow({ density = "list", indent = "flush", active, selected, className, ref, ...props }: ListRowProps) {
  return (
    <div
      ref={ref}
      className={cn("ui-row", className)}
      data-density={density}
      data-indent={indent}
      data-active={active || undefined}
      data-selected={selected || undefined}
      {...props}
    />
  )
}

interface ListButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  density?: RowDensity
  indent?: RowIndent
  selected?: boolean
  ref?: Ref<HTMLButtonElement>
}

// ListButton is a row that performs one action, e.g. a settings category.
export function ListButton({ density = "pick", indent = "flush", selected, className, type = "button", ref, ...props }: ListButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn("ui-row", className)}
      data-density={density}
      data-indent={indent}
      data-selected={selected || undefined}
      {...props}
    />
  )
}
