import { useEffect } from "react"

// The desktop app's Help › Report a Problem… asks the page to open its
// problem report (decision 0151); the page gathers it, for local and remote
// windows alike.
export function useDesktopReportProblem(open: () => void) {
  useEffect(() => {
    function onMenu(event: Event) {
      event.preventDefault()
      open()
    }
    window.addEventListener("zero:report-problem", onMenu)
    return () => window.removeEventListener("zero:report-problem", onMenu)
  }, [open])
}
