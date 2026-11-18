import { useRouter } from "@tanstack/react-router"
import { XIcon } from "lucide-react"
import { useCallback, useId, useLayoutEffect, useRef, useState, type RefObject } from "react"

import { DialogShell } from "../components/ui/dialog-shell.tsx"
import { FeatureLoadFailure } from "../components/ui/feature-load-failure.tsx"
import { IconButton } from "../components/ui/icon-button.tsx"
import { StatusMessage } from "../components/ui/notice.tsx"
import { ViewHeader } from "../components/ui/view-header.tsx"
import type { DeferredImport } from "../lib/deferred-import.ts"

type Open<Options> = (options?: Options) => void
export type RegisterDialogOpen<Options> = (open: Open<Options> | null) => void

interface OpenRequest<Options> {
  options: Options | undefined
  returnFocus: HTMLElement | null
}

type LoadPhase = "loading" | "error" | "reload"

interface DialogOptions {
  title: string
  feature: string
  variant?: "palette" | "panel"
  backdrop?: "transparent" | "overlay"
  shortcut?: string
}

// Register the open command eagerly. The real dialog takes over once its
// body mounts, with the options and focus target from the original request.
export function useDeferredDialog<Options, Body>(
  entry: DeferredImport<Body>,
  registerOpen: RegisterDialogOpen<Options>,
  { title, feature, variant, backdrop, shortcut }: DialogOptions,
) {
  const router = useRouter()
  const dialog = useRef<HTMLDialogElement>(null)
  const pending = useRef<OpenRequest<Options> | null>(null)
  const openBody = useRef<Open<Options> | null>(null)
  const [Body, setBody] = useState<Body | null>(null)
  const [phase, setPhase] = useState<LoadPhase | null>(null)

  const dismiss = useCallback(() => {
    const request = pending.current
    pending.current = null
    if (dialog.current?.open) dialog.current.close()
    setPhase(null)
    if (request?.returnFocus?.isConnected) request.returnFocus.focus({ preventScroll: true })
  }, [])

  const load = useCallback((retrying: boolean) => {
    const request = pending.current
    if (!request) return
    setPhase("loading")
    void entry.load().then(
      (loaded) => {
        if (pending.current === request) setBody(() => loaded)
      },
      () => {
        if (pending.current === request) setPhase(retrying ? "reload" : "error")
      },
    )
  }, [entry])

  const open = useCallback((options?: Options) => {
    if (openBody.current) {
      openBody.current(options)
      return
    }
    if (pending.current) {
      pending.current.options = options
      return
    }
    const active = document.activeElement
    pending.current = { options, returnFocus: active instanceof HTMLElement ? active : null }
    const loaded = entry.peek()
    if (loaded !== undefined) setBody(() => loaded)
    else load(false)
  }, [entry, load])

  useLayoutEffect(() => {
    registerOpen(open)
    const unsubscribe = router.subscribe("onBeforeNavigate", ({ hrefChanged }) => {
      if (hrefChanged && pending.current) dismiss()
    })
    const onShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey)) return
      if (event.key.toLowerCase() !== shortcut) return
      event.preventDefault()
      open()
    }
    if (shortcut) document.addEventListener("keydown", onShortcut)
    return () => {
      pending.current = null
      registerOpen(null)
      unsubscribe()
      if (shortcut) document.removeEventListener("keydown", onShortcut)
    }
  }, [dismiss, open, registerOpen, router, shortcut])

  const registerBody = useCallback<RegisterDialogOpen<Options>>((open) => {
    openBody.current = open
  }, [])

  useLayoutEffect(() => {
    const request = pending.current
    const open = openBody.current
    if (Body === null || !request || !open) return
    dismiss()
    open(request.options)
  }, [Body, dismiss])

  const fallback = phase && <DialogLoadStatus dialog={dialog} phase={phase} title={title} feature={feature}
    variant={variant} backdrop={backdrop} onDismiss={dismiss} onRetry={() => load(true)} />
  return { Body, registerBody, fallback }
}

interface DialogLoadStatusProps extends Pick<DialogOptions, "title" | "feature" | "variant" | "backdrop"> {
  dialog: RefObject<HTMLDialogElement | null>
  phase: LoadPhase
  onDismiss(): void
  onRetry(): void
}

function DialogLoadStatus({ dialog, phase, title, feature, variant, backdrop, onDismiss, onRetry }: DialogLoadStatusProps) {
  const titleId = useId()
  const closeButton = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    const element = dialog.current
    if (!element) return
    if (!element.open) element.showModal()
    if (!element.contains(document.activeElement)) closeButton.current?.focus()
  }, [dialog, phase])

  return (
    <DialogShell ref={dialog} variant={variant} backdrop={backdrop} aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onDismiss() }}
      onClick={(event) => { if (event.target === dialog.current) onDismiss() }}>
      <ViewHeader variant="dialog" title={title} titleId={titleId}
        actions={<IconButton ref={closeButton} label="Close" icon={<XIcon aria-hidden="true" />} onClick={onDismiss} />} />
      <div className="ui-dialog-load">
        {phase === "loading" ? <StatusMessage role="status">Loading {feature}…</StatusMessage>
          : <FeatureLoadFailure feature={feature} retry={phase === "error" ? onRetry : undefined} />}
      </div>
    </DialogShell>
  )
}
