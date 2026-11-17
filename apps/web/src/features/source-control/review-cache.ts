// One review owns its visited data until it unmounts. Pierre owns the
// offscreen row virtualization and keeps the renderer's measured layout.
export function reviewCache<T>() {
  const entries = new Map<string, T>()
  const listeners = new Map<string, Set<() => void>>()
  return {
    get: (key: string): T | null => entries.get(key) ?? null,
    set(key: string, entry: T) {
      entries.set(key, entry)
      for (const listener of listeners.get(key) ?? []) listener()
    },
    subscribe(key: string, listener: () => void) {
      const group = listeners.get(key) ?? new Set()
      group.add(listener)
      listeners.set(key, group)
      return () => {
        group.delete(listener)
        if (group.size === 0) listeners.delete(key)
      }
    },
  }
}
