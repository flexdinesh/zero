import { type MouseEvent, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"

import { CodeBlockControls } from "./CodeBlockControls.tsx"
import { MermaidBlock } from "./MermaidBlock.tsx"
import { createPreviewFence, previewScrollRoot, schedulePreviewFences, type PreviewFence } from "./preview-fences.ts"

interface DiagramPortal {
  host: HTMLDivElement
  key: number
  source: string
}

interface CodeBlockPortal {
  host: HTMLDivElement
  key: number
  fence: PreviewFence
}

interface DocumentPreviewProps {
  html: string
  navigate(href: string): void
}

function internalDocumentHref(event: MouseEvent<HTMLElement>): string | null {
  if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return null
  }
  if (!(event.target instanceof Element)) return null
  const anchor = event.target.closest("a")
  if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) return null
  if (anchor.target && anchor.target !== "_self") return null
  const url = new URL(anchor.href, window.location.href)
  if (url.origin !== window.location.origin || url.pathname !== "/view") return null
  return `${url.pathname}${url.search}${url.hash}`
}

// fenceLanguage is a fence's declared language, from goldmark's class.
function fenceLanguage(code: HTMLElement): string | null {
  const languageClass = [...code.classList].find((className) => className.startsWith("language-"))
  return languageClass?.slice("language-".length) || null
}

function PreviewCodeControls({ fence }: { fence: PreviewFence }) {
  const language = useSyncExternalStore(fence.subscribe, fence.snapshot)
  return <CodeBlockControls language={language} source={fence.source} />
}

export function DocumentPreview({ html, navigate }: DocumentPreviewProps) {
  const article = useRef<HTMLElement>(null)
  const [codeBlocks, setCodeBlocks] = useState<CodeBlockPortal[]>([])
  const [diagrams, setDiagrams] = useState<DiagramPortal[]>([])
  const renderedHTML = useMemo(() => ({ __html: html }), [html])

  useLayoutEffect(() => {
    if (!article.current) return
    const restoreBlocks: Array<() => void> = []
    const nextDiagrams = [...article.current.querySelectorAll("pre > code.language-mermaid")].flatMap((code, index) => {
      const pre = code.parentElement
      if (!pre) return []
      const host = document.createElement("div")
      host.className = "mermaid-portal"
      pre.replaceWith(host)
      restoreBlocks.push(() => host.replaceWith(pre))
      return [{ host, key: index, source: code.textContent ?? "" }]
    })
    const nextCodeBlocks = [...article.current.querySelectorAll<HTMLElement>("pre > code")].flatMap((code, index) => {
      const pre = code.parentElement
      if (!pre) return []
      const wrapper = document.createElement("div")
      wrapper.className = "code-block"
      const host = document.createElement("div")
      host.className = "code-block-controls-portal"
      pre.replaceWith(wrapper)
      wrapper.append(pre, host)
      restoreBlocks.push(() => wrapper.replaceWith(pre))
      const source = code.textContent ?? ""
      // Fences gain a language label once Highlights recognizes it.
      return [{ host, key: index, fence: createPreviewFence(code, fenceLanguage(code), source) }]
    })
    setDiagrams(nextDiagrams)
    setCodeBlocks(nextCodeBlocks)
    const cancelHighlighting = schedulePreviewFences(nextCodeBlocks.map((block) => block.fence), previewScrollRoot(article.current))
    return () => {
      cancelHighlighting()
      for (const restore of restoreBlocks) restore()
    }
  }, [html])

  return (
    <>
      <article
        ref={article}
        dangerouslySetInnerHTML={renderedHTML}
        onClick={(event) => {
          const href = internalDocumentHref(event)
          if (!href) return
          event.preventDefault()
          navigate(href)
        }}
      />
      {diagrams.map(({ host, key, source }) => createPortal(<MermaidBlock source={source} />, host, key))}
      {codeBlocks.map(({ host, key, fence }) => (
        createPortal(<PreviewCodeControls fence={fence} />, host, key)
      ))}
    </>
  )
}
