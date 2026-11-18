import { deferImport } from "../lib/deferred-import.ts"
import type { NotificationStatus } from "../lib/desktop-bridge.ts"
import { useDeferredDialog, type RegisterDialogOpen } from "../workspace/use-deferred-dialog.tsx"
import type { SettingId } from "./settings.ts"

const entry = deferImport(() => import("./SettingsDialogBody.tsx").then(({ SettingsDialogBody }) => SettingsDialogBody))

// With a setting, reveal and focus its control.
export type OpenSettings = (setting?: SettingId) => void

export function SettingsDialog({ registerOpen, notificationStatus }: {
  registerOpen: RegisterDialogOpen<SettingId>
  notificationStatus: NotificationStatus | null
}) {
  const { Body, registerBody, fallback } = useDeferredDialog(entry, registerOpen, {
    title: "Settings", feature: "settings", backdrop: "transparent", shortcut: ",",
  })
  return <>
    {fallback}
    {Body && <Body registerOpen={registerBody} notificationStatus={notificationStatus} />}
  </>
}
