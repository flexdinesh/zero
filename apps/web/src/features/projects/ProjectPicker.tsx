import { deferImport } from "../../lib/deferred-import.ts"
import { useDeferredDialog, type RegisterDialogOpen } from "../../workspace/use-deferred-dialog.tsx"
import type { PickerOpenOptions } from "./project-picker.ts"

const entry = deferImport(() => import("./ProjectPickerBody.tsx").then(({ ProjectPickerBody }) => ProjectPickerBody))

export function ProjectPicker({ project, registerOpen, onOpen }: {
  project: string
  registerOpen: RegisterDialogOpen<PickerOpenOptions>
  onOpen(project: string): void
}) {
  const { Body, registerBody, fallback } = useDeferredDialog(entry, registerOpen, {
    title: "Switch project", feature: "the project picker", variant: "palette", backdrop: "transparent", shortcut: "o",
  })
  return <>
    {fallback}
    {Body && <Body project={project} registerOpen={registerBody} onOpen={onOpen} />}
  </>
}
