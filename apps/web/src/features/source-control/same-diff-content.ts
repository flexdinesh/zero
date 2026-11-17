import type { DiffResponse, DiffSide } from "@zero/contracts"

function sameSide(left: DiffSide | null, right: DiffSide | null): boolean {
  return left === right || (left !== null && right !== null
    && left.content === right.content && left.size === right.size
    && left.binary === right.binary && left.tooLarge === right.tooLarge)
}

// Rendering identity follows content, not a read counter or commit id. Compare
// source strings directly; serialize only the server's small structured layout.
export function sameDiffContent(left: DiffResponse, right: DiffResponse): boolean {
  return left.path === right.path && left.oldPath === right.oldPath && left.status === right.status
    && left.documentType.language === right.documentType.language
    && sameSide(left.original, right.original) && sameSide(left.modified, right.modified)
    && JSON.stringify(left.lineDiff) === JSON.stringify(right.lineDiff)
}
