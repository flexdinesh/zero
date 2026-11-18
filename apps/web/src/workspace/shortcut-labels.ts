const mac = typeof navigator !== "undefined" && navigator.platform.includes("Mac")

export const projectShortcutLabel = mac ? "⌘O" : "Ctrl+O"
export const settingsShortcutLabel = mac ? "⌘," : "Ctrl+,"
