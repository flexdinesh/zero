import { useEffect } from "react"

import { isSelectAll, isTextField } from "../lib/select-all.ts"

// useSelectAllGuard keeps Select All from selecting the whole app (decision
// 0174). The document pane selects its own text first; any Select All left
// over, outside text fields and dialogs, selects nothing.
export function useSelectAllGuard() {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || !isSelectAll(event) || isTextField(event.target)) return
      if (document.querySelector("dialog[open]")) return
      event.preventDefault()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])
}
