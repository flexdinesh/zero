import { fileURLToPath } from "node:url"

import { defineConfig, mergeConfig, type Plugin } from "vite"

import appConfig from "../vite.config.ts"

// Diagnostic build only. The shipped config neither aliases React nor
// instruments components. Use the same boundaries on both sides of a change.
const boundaries = new Map([
  ["/src/App.tsx", "App"],
  ["/src/features/search/SearchView.tsx", "SearchView"],
  ["/src/features/explorer/FileTree.tsx", "FileTree"],
  ["/src/features/documents/SourceDocument.tsx", "SourceDocument"],
  ["/src/features/source-control/SourceControlView.tsx", "SourceControlView"],
  ["/src/features/source-control/ReviewFilesRail.tsx", "ReviewFilesRail"],
  ["/src/features/source-control/ReviewDocument.tsx", "ReviewDocument"],
])

const profile: Plugin = {
  name: "zero-diagnostic-react-profile",
  enforce: "pre",
  transform(code, id) {
    const name = [...boundaries].find(([suffix]) => id.endsWith(suffix))?.[1]
    if (!name) return
    const declaration = `export function ${name}(`
    if (!code.includes(declaration)) throw new Error(`Missing profile boundary: ${name}`)
    return `import { Profiler, type ComponentProps, type ProfilerOnRenderCallback } from "react"
const recordProfile: ProfilerOnRenderCallback = (id, phase, actualDuration, baseDuration, startTime, commitTime) => {
  document.dispatchEvent(new CustomEvent("zero-profile", { detail: { id, phase, actualDuration, baseDuration, startTime, commitTime } }))
}
${code.replace(declaration, `function Profiled${name}(`)}
export function ${name}(props: ComponentProps<typeof Profiled${name}>) {
  return <Profiler id="${name}" onRender={recordProfile}><Profiled${name} {...props} /></Profiler>
}`
  },
}

export default defineConfig(async (environment) => mergeConfig(await appConfig(environment), {
  plugins: [profile],
  resolve: {
    alias: [{ find: "react-dom/client", replacement: fileURLToPath(new URL("../node_modules/react-dom/profiling.js", import.meta.url)) }],
  },
}))
