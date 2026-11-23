// abortError is what a caller whose own signal aborted receives.
function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError")
}

interface InFlight<T> {
  promise: Promise<T>
  controller: AbortController
  // waiting counts the callers still waiting on promise.
  waiting: number
}

// sharedRequest shares one in-flight run among concurrent callers; a call
// after it settles runs again (no cache beyond in flight). A caller's own
// signal rejects only that caller with an AbortError; the run aborts only
// once every caller waiting on it has aborted (decision 0193).
export function sharedRequest<T>(run: (signal: AbortSignal) => Promise<T>): (signal?: AbortSignal) => Promise<T> {
  let current: InFlight<T> | null = null
  return (signal) => {
    if (signal?.aborted) return Promise.reject(abortError())
    let flight = current
    if (!flight) {
      const controller = new AbortController()
      const started: InFlight<T> = { promise: run(controller.signal), controller, waiting: 0 }
      const settle = () => {
        if (current === started) current = null
      }
      started.promise.then(settle, settle)
      current = started
      flight = started
    }
    const shared = flight
    shared.waiting++
    return new Promise<T>((resolve, reject) => {
      let done = false
      const finish = () => {
        done = true
        shared.waiting--
        signal?.removeEventListener("abort", abort)
      }
      const abort = () => {
        if (done) return
        finish()
        reject(abortError())
        if (shared.waiting > 0) return
        shared.controller.abort()
        if (current === shared) current = null
      }
      signal?.addEventListener("abort", abort, { once: true })
      shared.promise.then((value) => {
        if (done) return
        finish()
        resolve(value)
      }, (error: unknown) => {
        if (done) return
        finish()
        reject(error)
      })
    })
  }
}
