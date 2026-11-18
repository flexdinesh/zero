import { useEffect, useState, type ComponentProps } from "react"

import { FeatureLoadFailure } from "../../components/ui/feature-load-failure.tsx"
import { StatusMessage } from "../../components/ui/notice.tsx"
import { deferImport } from "../../lib/deferred-import.ts"
import type { ReviewDocument } from "./ReviewDocument.tsx"

const reviewModule = deferImport(() => import("./ReviewDocument.tsx"))

type ReviewLoad =
  | { kind: "loading" | "error"; retrying: boolean }
  | { kind: "ready"; Document: typeof ReviewDocument }

function initialLoad(): ReviewLoad {
  const loaded = reviewModule.peek()
  return loaded ? { kind: "ready", Document: loaded.ReviewDocument } : { kind: "loading", retrying: false }
}

export function releaseLoadedDiffResources() {
  reviewModule.peek()?.releaseDiffResources()
}

export function DeferredReview(props: ComponentProps<typeof ReviewDocument>) {
  const [load, setLoad] = useState(initialLoad)

  useEffect(() => {
    if (load.kind !== "loading") return
    let active = true
    void reviewModule.load().then(
      ({ ReviewDocument }) => {
        if (active) setLoad({ kind: "ready", Document: ReviewDocument })
      },
      () => {
        if (active) setLoad({ kind: "error", retrying: load.retrying })
      },
    )
    return () => { active = false }
  }, [load])

  if (load.kind === "ready") return <load.Document {...props} />
  if (load.kind === "loading") return <StatusMessage className="document-loading" role="status">Loading review…</StatusMessage>
  return (
    <div className="error">
      <FeatureLoadFailure feature="the review" retry={load.retrying ? undefined : () => {
        props.scrollRoot.current?.focus({ preventScroll: true })
        setLoad({ kind: "loading", retrying: true })
      }} />
    </div>
  )
}
