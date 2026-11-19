import assert from "node:assert/strict"
import test from "node:test"

import { isSelectAllKey } from "./select-all.ts"

function key(key: string, modifiers: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean; composing?: boolean } = {}) {
  return {
    key,
    metaKey: modifiers.meta ?? false,
    ctrlKey: modifiers.ctrl ?? false,
    altKey: modifiers.alt ?? false,
    shiftKey: modifiers.shift ?? false,
    isComposing: modifiers.composing ?? false,
  }
}

test("Select All is Cmd+A on macOS", () => {
  assert.equal(isSelectAllKey(key("a", { meta: true }), true), true)
  assert.equal(isSelectAllKey(key("A", { meta: true }), true), true)
  assert.equal(isSelectAllKey(key("a", { ctrl: true }), true), false)
  assert.equal(isSelectAllKey(key("a", { meta: true, ctrl: true }), true), false)
})

test("Select All is Ctrl+A elsewhere", () => {
  assert.equal(isSelectAllKey(key("a", { ctrl: true }), false), true)
  assert.equal(isSelectAllKey(key("A", { ctrl: true }), false), true)
  assert.equal(isSelectAllKey(key("a", { meta: true }), false), false)
  assert.equal(isSelectAllKey(key("a", { ctrl: true, meta: true }), false), false)
})

test("other keys and modifiers are not Select All", () => {
  for (const onMac of [true, false]) {
    const modifier = onMac ? { meta: true } : { ctrl: true }
    assert.equal(isSelectAllKey(key("a"), onMac), false)
    assert.equal(isSelectAllKey(key("b", modifier), onMac), false)
    assert.equal(isSelectAllKey(key("a", { ...modifier, shift: true }), onMac), false)
    assert.equal(isSelectAllKey(key("a", { ...modifier, alt: true }), onMac), false)
    assert.equal(isSelectAllKey(key("a", { ...modifier, composing: true }), onMac), false)
  }
})
