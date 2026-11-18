import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"

interface PickerOpenOptions {
  query?: string
  returnFocus?: HTMLElement | null
}

interface PickerSession {
  initialQuery: string
  returnFocus: HTMLElement | null
}

export interface PickerBodyProps {
  initialQuery: string
  dialog: RefObject<HTMLDialogElement | null>
  input: RefObject<HTMLInputElement | null>
  close(restoreFocus: boolean): HTMLElement | null
}

export function useNativePicker(beforeShow?: () => void) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [session, setSession] = useState<PickerSession | null>(null)

  const show = useCallback((options?: PickerOpenOptions) => {
    if (!dialog.current || dialog.current.open) return
    const returnFocus = options?.returnFocus !== undefined
      ? options.returnFocus
      : document.activeElement instanceof HTMLElement ? document.activeElement : null
    beforeShow?.()
    setSession((current) => current ?? { initialQuery: options?.query ?? "", returnFocus })
  }, [beforeShow])

  useLayoutEffect(() => {
    if (!session) return
    // The input must be mounted before the native dialog takes focus.
    dialog.current?.showModal()
    input.current?.focus()
  }, [session])

  const close = useCallback((restoreFocus: boolean) => {
    const returnFocus = session?.returnFocus ?? null
    // Other pickers can open immediately after this call.
    if (dialog.current?.open) dialog.current.close()
    setSession(null)
    if (restoreFocus) returnFocus?.focus({ preventScroll: true })
    return returnFocus
  }, [session])

  const body: PickerBodyProps | null = session && { initialQuery: session.initialQuery, dialog, input, close }
  return { dialog, body, show, close }
}

export function usePickerScroll(dialog: PickerBodyProps["dialog"], attribute: string, activeKey: string | undefined, query: string) {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (activeKey === undefined || !dialog.current?.open) return
    list.current?.querySelector(`[${attribute}="${CSS.escape(activeKey)}"]`)?.scrollIntoView({ block: "nearest" })
    // A filter can move the active row without changing its key.
  }, [activeKey, attribute, dialog, query])
  return list
}
