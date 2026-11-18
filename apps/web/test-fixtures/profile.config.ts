import { fileURLToPath } from "node:url"

import { defineConfig, mergeConfig, type Plugin } from "vite"

import appConfig from "../vite.config.ts"

// Diagnostic build only. The shipped config neither aliases React nor
// instruments components. Use the same boundaries on both sides of a change.
const boundaries: ReadonlyMap<string, readonly string[]> = new Map([
  ["/src/App.tsx", ["App"]],
  ["/src/features/navigation/NavigationProvider.tsx", ["NavigationProvider"]],
  ["/src/features/navigation/NavigationStatusPanel.tsx", ["NavigationStatusPanel"]],
  ["/src/workspace/StatusBar.tsx", ["StatusBar"]],
  ["/src/workspace/Sidebar.tsx", ["Sidebar"]],
  ["/src/features/search/SearchView.tsx", ["SearchView"]],
  ["/src/features/explorer/FileTree.tsx", ["FileTree"]],
  ["/src/features/documents/SourceDocument.tsx", ["SourceDocument"]],
  ["/src/features/documents/DocumentPreview.tsx", ["DocumentPreview"]],
  ["/src/features/documents/MermaidBlock.tsx", ["MermaidBlock"]],
  ["/src/features/documents/OndineMermaidDiagram.tsx", ["OndineMermaidDiagram"]],
  ["/src/features/source-control/SourceControlProvider.tsx", ["SourceControlProvider"]],
  ["/src/features/source-control/SourceControlView.tsx", ["SourceControlView"]],
  ["/src/features/source-control/Pane.tsx", ["Pane", "PaneSash"]],
  ["/src/features/source-control/UncommittedPane.tsx", ["UncommittedPane"]],
  ["/src/features/source-control/CommitsPane.tsx", ["CommitsPane"]],
  ["/src/features/source-control/BranchesPane.tsx", ["BranchesPane"]],
  ["/src/features/source-control/FilesTree.tsx", ["FilesTree"]],
  ["/src/features/source-control/ReviewFilesLayout.tsx", ["ReviewRail"]],
  ["/src/features/source-control/ReviewFilesRail.tsx", ["ReviewFilesRail"]],
  ["/src/features/source-control/ReviewDocument.tsx", ["ReviewDocument"]],
])

const profile: Plugin = {
  name: "zero-diagnostic-react-profile",
  enforce: "pre",
  transform(code, id) {
    const names = [...boundaries].find(([suffix]) => id.endsWith(suffix))?.[1]
    if (!names) return
    if (process.env.ZERO_PROFILE_SOURCE === "1" && !names.includes("SourceDocument")) return
    let instrumented = code
    if (process.env.ZERO_PROFILE_FEEDBACK === "1") {
      if (!names.includes("ReviewDocument")) return
      // Keep the keyed boundary outside ReviewFile so its normal memo
      // comparison and descendant-only updates run on either revision.
      const file = /<ReviewFile key=\{file\.path\}([\s\S]*?) \/>/gu
      if ([...code.matchAll(file)].length !== 1) throw new Error("Expected one keyed ReviewFile")
      instrumented = code.replace(file,
        '<ZeroDiagnosticProfiler key={file.path} id={`ReviewFile:${file.path}`} onRender={recordProfile}><ReviewFile$1 /></ZeroDiagnosticProfiler>')
    }
    for (const name of names) {
      const defaultExport = code.includes(`export default function ${name}(`)
      const declaration = `export ${defaultExport ? "default " : ""}function ${name}(`
      if (!instrumented.includes(declaration)) throw new Error(`Missing profile boundary: ${name}`)
      instrumented = `${instrumented.replace(declaration, `function Profiled${name}(`)}
export ${defaultExport ? "default " : ""}function ${name}(props: ZeroDiagnosticComponentProps<typeof Profiled${name}>) {
  return <ZeroDiagnosticProfiler id="${name}" onRender={recordProfile}><Profiled${name} {...props} /></ZeroDiagnosticProfiler>
}`
    }
    return `import { Profiler as ZeroDiagnosticProfiler, type ComponentProps as ZeroDiagnosticComponentProps, type ProfilerOnRenderCallback as ZeroDiagnosticOnRender } from "react"
const recordProfile: ZeroDiagnosticOnRender = (id, phase, actualDuration, baseDuration, startTime, commitTime) => {
  document.dispatchEvent(new CustomEvent("zero-profile", { detail: { id, phase, actualDuration, baseDuration, startTime, commitTime } }))
}
${instrumented}`
  },
}

export default defineConfig(async (environment) => mergeConfig(await appConfig(environment), {
  plugins: [profile],
  resolve: {
    alias: [{ find: "react-dom/client", replacement: fileURLToPath(new URL("../node_modules/react-dom/profiling.js", import.meta.url)) }],
  },
}))
