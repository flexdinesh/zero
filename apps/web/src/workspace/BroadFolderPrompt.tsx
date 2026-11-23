import { cn } from "cn"

import { Button } from "../components/ui/button.tsx"

// UnscannedFolder is a broad folder whose files wait to be asked for
// (decision 0194): views that need its files offer to scan it instead.
export interface UnscannedFolder {
  rootName: string
  scan(): void
  openProjects(): void
}

interface BroadFolderPromptProps {
  // rootName names the project's folder.
  rootName: string
  // onScan confirms scanning the folder and reads its files.
  onScan(): void
  // onOpenProjects opens the project picker instead.
  onOpenProjects(): void
  className?: string
}

// BroadFolderPrompt stands in for files a broad folder (home, the
// filesystem root) has not scanned: zero scans it only when asked
// (decision 0194). The Explorer, Search, and Quick Open show it.
export function BroadFolderPrompt({ rootName, onScan, onOpenProjects, className }: BroadFolderPromptProps) {
  return (
    <div className={cn("broad-folder", className)}>
      <p className="broad-folder-text" role="status">{`${rootName || "This folder"} holds too many files to scan by default.`}</p>
      <div className="broad-folder-actions">
        <Button onClick={onScan}>Scan files</Button>
        <Button variant="outline" aria-haspopup="dialog" onClick={onOpenProjects}>Open Project…</Button>
      </div>
    </div>
  )
}
