import type { WalkthroughSummary } from "@zero/contracts"

export interface WalkthroughsState {
  result: WalkthroughSummary[] | null
  error: string
  loading: boolean
}

type WalkthroughsUpdate =
  | { kind: "start" }
  | { kind: "success"; result: WalkthroughSummary[] }
  | { kind: "error"; error: string }

function sameWalkthroughs(left: WalkthroughSummary[], right: WalkthroughSummary[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index]
    return other !== undefined && entry.id === other.id && entry.title === other.title
      && entry.stepCount === other.stepCount && entry.updatedAt === other.updatedAt
  })
}

// Keep cached summaries and state identity when a background read changes
// nothing. Only an initial or manual read starts visible loading.
export function updateWalkthroughs(state: WalkthroughsState, update: WalkthroughsUpdate): WalkthroughsState {
  switch (update.kind) {
    case "start":
      return state.loading ? state : { ...state, loading: true }
    case "success": {
      const result = state.result !== null && sameWalkthroughs(state.result, update.result) ? state.result : update.result
      return result === state.result && state.error === "" && !state.loading ? state : { result, error: "", loading: false }
    }
    case "error":
      return state.error === update.error && !state.loading ? state : { ...state, error: update.error, loading: false }
  }
}
