import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

import { defineConfig, mergeConfig, type Plugin } from "vite"

import appConfig from "../vite.config.ts"

const root = fileURLToPath(new URL("../../../", import.meta.url)).replaceAll("\\", "/")

function moduleName(id: string) {
  return id.replaceAll("\\", "/").replaceAll(root, "")
}

const graph: Plugin = {
  name: "zero-diagnostic-bundle-graph",
  writeBundle({ dir }, bundle) {
    if (dir === undefined) throw new Error("Bundle graph requires a Vite output directory")
    const files = Object.values(bundle).sort((a, b) => a.fileName.localeCompare(b.fileName)).map((file) => {
      const content = readFileSync(path.join(dir, file.fileName))
      const sizes = { bytes: content.byteLength, gzipBytes: gzipSync(content).byteLength }
      if (file.type === "asset") return { file: file.fileName, ...sizes, type: file.type, sources: file.originalFileNames.map(moduleName) }
      return {
        file: file.fileName, ...sizes, type: file.type, entry: file.isEntry, dynamicEntry: file.isDynamicEntry,
        facade: file.facadeModuleId && moduleName(file.facadeModuleId),
        imports: file.imports, dynamicImports: file.dynamicImports,
        css: [...(file.viteMetadata?.importedCss ?? [])], assets: [...(file.viteMetadata?.importedAssets ?? [])],
        modules: Object.entries(file.modules).map(([id, module]) => ({ id: moduleName(id), renderedBytes: module.renderedLength })),
      }
    })
    const reachable = new Set<string>()
    function visit(name: string) {
      if (reachable.has(name)) return
      reachable.add(name)
      const file = bundle[name]
      if (file?.type === "chunk") for (const imported of file.imports) visit(imported)
    }
    for (const file of Object.values(bundle)) if (file.type === "chunk" && file.isEntry) visit(file.fileName)
    writeFileSync(path.join(dir, "bundle-graph.json"), JSON.stringify({
      staticEntryClosure: [...reachable].sort(), files,
    }, null, 2))
  },
}

export default defineConfig(async (environment) => mergeConfig(await appConfig(environment), {
  build: { manifest: true },
  plugins: [graph],
}))
