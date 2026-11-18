import { deferImport } from "../../lib/deferred-import.ts"
import { useDeferredDialog, type RegisterDialogOpen } from "../../workspace/use-deferred-dialog.tsx"

const entry = deferImport(() => import("./ReportProblemDialogBody.tsx").then(({ ReportProblemDialogBody }) => ReportProblemDialogBody))

export function ReportProblemDialog({ registerOpen }: { registerOpen: RegisterDialogOpen<undefined> }) {
  const { Body, registerBody, fallback } = useDeferredDialog(entry, registerOpen, {
    title: "Report a Problem", feature: "the problem report",
  })
  return <>
    {fallback}
    {Body && <Body registerOpen={registerBody} />}
  </>
}
