import { SearchIcon } from "lucide-react"

import { IconButton } from "../../components/ui/icon-button.tsx"
import { useFindAvailable } from "./FindProvider.tsx"

// FindButton opens find from the document toolbar on phones, which have no
// Ctrl/Cmd+F (decision 0172); it shows only while the view has text.
export function FindButton() {
  const open = useFindAvailable()
  if (!open) return null
  return <IconButton className="find-toggle" size="bar" label="Find" icon={<SearchIcon aria-hidden="true" />} onClick={open} />
}
