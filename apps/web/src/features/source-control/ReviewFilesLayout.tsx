import { PanelRightIcon } from "lucide-react"
import { Activity, type ComponentProps } from "react"

import { IconButton } from "../../components/ui/icon-button.tsx"
import { ReviewFilesRail, ReviewFilesSheet } from "./ReviewFilesRail.tsx"
import { defaultRailWidth } from "./source-control-layout.ts"
import { useReviewRailLayout } from "./SourceControlProvider.tsx"

export function ReviewFilesButton({ mobile }: { mobile: boolean }) {
  const layout = useReviewRailLayout()
  const shown = !mobile && !layout.railHidden
  return <IconButton label="Files" title={shown ? "Hide Files" : "Show Files"} aria-pressed={shown}
    icon={<PanelRightIcon aria-hidden="true" />} onClick={() => {
      if (mobile) layout.setSheetOpen(true)
      else layout.setRailHidden(!layout.railHidden)
    }} />
}

type RailProps = Omit<ComponentProps<typeof ReviewFilesRail>, "hideViewed" | "onHideViewedChange" | "width" | "onResize" | "onResetWidth" | "onHide"> & {
  visible: boolean
}

// Visibility/lifetime follows the kept review. Layout subscriptions stop at
// these leaves instead of updating the workspace or its document subtree.
export function ReviewRail({ visible, ...props }: RailProps) {
  const layout = useReviewRailLayout()
  if (layout.railHidden) return null
  return <Activity mode={visible ? "visible" : "hidden"}>
    <ReviewFilesRail {...props} hideViewed={layout.railHideViewed} onHideViewedChange={layout.setRailHideViewed}
      width={layout.railWidth} onResize={layout.setRailWidth}
      onResetWidth={() => layout.setRailWidth(defaultRailWidth)} onHide={() => layout.setRailHidden(true)} />
  </Activity>
}

export function ReviewSheet(props: Omit<ComponentProps<typeof ReviewFilesSheet>, "open" | "hideViewed" | "onHideViewedChange" | "onClose">) {
  const layout = useReviewRailLayout()
  return <ReviewFilesSheet {...props} open={layout.sheetOpen} hideViewed={layout.railHideViewed}
    onHideViewedChange={layout.setRailHideViewed} onClose={() => layout.setSheetOpen(false)} />
}
