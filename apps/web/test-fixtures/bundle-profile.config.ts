import { fileURLToPath } from "node:url"

import { defineConfig, mergeConfig, type Plugin } from "vite"

import appConfig from "../vite.config.ts"

const profile: Plugin = {
  name: "zero-bundle-react-profile",
  enforce: "pre",
  transform(code, id) {
    if (!id.endsWith("/apps/web/src/main.tsx")) return
    const render = /createRoot\(root\)\.render\(\n(    <ThemeProvider[\s\S]+?^    <\/ThemeProvider>),/mu
    if (!render.test(code)) throw new Error("Missing production React root for profiling")
    return `import { Profiler as BundleProfiler, type ProfilerOnRenderCallback } from "react"
const recordBundleProfile: ProfilerOnRenderCallback = (id, phase, actualDuration, baseDuration, startTime, commitTime) => {
  document.dispatchEvent(new CustomEvent("zero-profile", { detail: { id, phase, actualDuration, baseDuration, startTime, commitTime } }))
}
${code.replace(render, 'createRoot(root).render(\n    <BundleProfiler id="workspace" onRender={recordBundleProfile}>\n$1\n    </BundleProfiler>,')}`
  },
}

export default defineConfig(async (environment) => mergeConfig(await appConfig(environment), {
  plugins: [profile],
  resolve: {
    alias: [{ find: "react-dom/client", replacement: fileURLToPath(new URL("../node_modules/react-dom/profiling.js", import.meta.url)) }],
  },
}))
