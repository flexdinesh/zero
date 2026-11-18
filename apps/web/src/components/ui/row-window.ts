export function rowOffsets(count: number, size: (index: number) => number): number[] {
  const offsets = [0]
  let height = 0
  for (let index = 0; index < count; index++) {
    height += size(index)
    offsets.push(height)
  }
  return offsets
}

// The row containing offset, clamped to the first or last row.
export function rowAt(offsets: readonly number[], offset: number): number {
  if (offsets.length < 2) return -1
  let low = 0
  let high = offsets.length - 1
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if ((offsets[middle] ?? Infinity) <= offset) low = middle
    else high = middle
  }
  return low
}

export function windowedIndexes(offsets: readonly number[], top: number, height: number,
  retained: readonly (number | undefined)[]): number[] {
  const count = offsets.length - 1
  const indexes = new Set<number>()
  for (const index of retained) if (index !== undefined && index >= 0 && index < count) indexes.add(index)
  const start = Math.max(0, top - height)
  const end = Math.min(offsets.at(-1) ?? 0, top + 2 * height)
  if (height > 0 && start < end) {
    for (let index = rowAt(offsets, start); (offsets[index] ?? Infinity) < end; index++) indexes.add(index)
  }
  return [...indexes].sort((a, b) => a - b)
}
