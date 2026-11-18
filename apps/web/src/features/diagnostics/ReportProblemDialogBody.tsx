import { isDiagnostics } from "@zero/contracts"
import { ArrowUpRightIcon, XIcon } from "lucide-react"
import { useCallback, useLayoutEffect, useRef, useState } from "react"

import { Button } from "../../components/ui/button.tsx"
import { CopyButton } from "../../components/ui/copy-button.tsx"
import { DialogShell } from "../../components/ui/dialog-shell.tsx"
import { IconButton } from "../../components/ui/icon-button.tsx"
import { Notice, StatusMessage } from "../../components/ui/notice.tsx"
import { ViewHeader } from "../../components/ui/view-header.tsx"

import { failureReason, fetchJSON, isAbort, RequestError } from "../../api/http.ts"
import { desktopBridge } from "../../lib/desktop-bridge.ts"
import { uiErrors } from "../../lib/ui-errors.ts"
import type { RegisterDialogOpen } from "../../workspace/use-deferred-dialog.tsx"
import { issueUrl } from "./issue-url.ts"
import { buildReport, clientFacts, systemInfo, type ReportInput } from "./report.ts"

type ReportState =
  | { status: "loading" }
  | { status: "ready"; input: ReportInput; report: string }

// gatherReport reads the server's and the desktop app's parts of a report;
// a server that cannot answer still leaves a report saying why.
async function gatherReport(signal: AbortSignal): Promise<ReportInput> {
  const bridge = desktopBridge()
  const desktop = bridge?.diagnostics ? bridge.diagnostics() : Promise.resolve(null)
  let server: ReportInput["server"] = null
  let serverError = ""
  try {
    server = await fetchJSON("/api/diagnostics", { signal }, isDiagnostics, (failure) => `Couldn't read the server's diagnostics: ${failureReason(failure)}.`)
  } catch (error: unknown) {
    if (isAbort(error)) throw error
    serverError = error instanceof RequestError ? failureReason(error.failure) : "the request failed"
  }
  return {
    server,
    serverError,
    desktop: await desktop,
    client: clientFacts(window.location.host, window.location.hostname, Boolean(bridge), navigator.userAgent),
    uiErrors: uiErrors.entries(),
  }
}

// ReportProblemDialogBody shows the redacted problem report (decision 0152) for
// the user to read, copy, and paste into a new GitHub issue. Nothing is sent
// anywhere until they do.
export function ReportProblemDialogBody({ registerOpen }: { registerOpen: RegisterDialogOpen<undefined> }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const pending = useRef<AbortController | null>(null)
  const [state, setState] = useState<ReportState>({ status: "loading" })

  const show = useCallback(() => {
    const element = dialog.current
    if (!element) return
    if (!element.open) element.showModal()
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setState({ status: "loading" })
    gatherReport(controller.signal).then((input) => {
      if (!controller.signal.aborted) setState({ status: "ready", input, report: buildReport(input) })
    }, () => undefined)
  }, [])

  useLayoutEffect(() => {
    registerOpen(show)
    return () => {
      registerOpen(null)
      pending.current?.abort()
    }
  }, [registerOpen, show])

  return (
    <DialogShell
      ref={dialog}
      variant="panel"
      className="report-dialog"
      aria-labelledby="report-title"
      onClick={(event) => { if (event.target === dialog.current) dialog.current.close() }}
      onClose={() => pending.current?.abort()}
    >
      <div className="report-shell">
        <ViewHeader
          variant="dialog"
          className="report-header"
          title="Report a Problem"
          titleId="report-title"
          actions={<IconButton label="Close problem report" icon={<XIcon aria-hidden="true" />} onClick={() => dialog.current?.close()} />}
        />
        <Notice className="report-notice">
          Read the report before you share it. Home directories and tokens are hidden, but file names and errors stay. Nothing is
          sent until you paste it.
        </Notice>
        {state.status === "loading"
          ? <StatusMessage className="report-status">Gathering the report…</StatusMessage>
          : <pre className="report-preview" tabIndex={0} aria-label="Problem report">{state.report}</pre>}
        <footer className="report-footer">
          <CopyButton variant="chip" className="report-copy" label="Copy report" text={state.status === "ready" ? state.report : ""}
            disabled={state.status !== "ready"}>Copy report</CopyButton>
          <Button variant="outline" disabled={state.status !== "ready"} onClick={() => {
            if (state.status !== "ready") return
            window.open(issueUrl(systemInfo(state.input)), "_blank", "noopener,noreferrer")
          }}>
            Open GitHub issue<ArrowUpRightIcon aria-hidden="true" />
          </Button>
        </footer>
      </div>
    </DialogShell>
  )
}
