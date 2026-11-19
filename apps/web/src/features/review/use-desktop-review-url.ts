import { useEffect } from "react"

// The desktop app's Review › Review URL… asks the local window's page which
// page to review (decision 0177).
export function useDesktopReviewURL(open: () => void) {
  useEffect(() => {
    function onMenu(event: Event) {
      event.preventDefault()
      open()
    }
    window.addEventListener("zero:review-url", onMenu)
    return () => window.removeEventListener("zero:review-url", onMenu)
  }, [open])
}
