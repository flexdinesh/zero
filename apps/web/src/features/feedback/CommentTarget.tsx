import { FolderIcon, GitBranchIcon } from "lucide-react"

import { branchLabel } from "./feedback-model.ts"

// CommentTarget is the project a screen comment joins: the folder's name and
// its branch ("detached HEAD" without one; a folder shows no branch). The
// Browser's comments show it (decision 0184).
export interface CommentTargetProps {
  name: string
  branch: string
  // folder says the project is no repository.
  folder: boolean
}

export function CommentTarget({ name, branch, folder }: CommentTargetProps) {
  return (
    <p className="comment-target">
      <span className="comment-target-label">Comments go to</span>
      <span className="comment-target-part"><FolderIcon aria-hidden="true" />{name}</span>
      {!folder && (
        <span className="comment-target-part" data-detached={branch ? undefined : true}>
          <GitBranchIcon aria-hidden="true" />{branchLabel(branch)}
        </span>
      )}
    </p>
  )
}
