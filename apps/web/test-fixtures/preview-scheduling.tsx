import { useState } from "react"
import { createRoot } from "react-dom/client"

import { Button } from "../src/components/ui/button.tsx"
import { DocumentPreview } from "../src/features/documents/DocumentPreview.tsx"
import { ThemeProvider } from "../src/settings/ThemeProvider.tsx"
import "../src/style.css"

const mode = new URLSearchParams(window.location.search).get("mode")
const original = '<h1>Original preview</h1><pre><code class="language-javascript">const original = "before";\n</code></pre><p><a href="/view?path=next.md">Next document</a></p>'
const replacement = '<h1>Replacement preview</h1><pre><code class="language-javascript">const replacement = "after";\n</code></pre>'
const next = '<h1>Next preview</h1><pre><code class="language-javascript">const next = "destination";\n</code></pre>'
// Absolute positions keep the queue's visible, near, and far cases independent
// of fonts and of the controls added around a fence.
const queue = '<h1>Queued fences</h1><section aria-label="First fence" style="position:absolute;top:80px"><pre><code class="language-javascript">const first = 1;\n</code></pre></section><section aria-label="Near fence" style="position:absolute;top:800px"><pre><code class="language-javascript">const near = 2;\n</code></pre></section><section aria-label="Visible fence" style="position:absolute;top:240px"><pre><code class="language-javascript">const visible = 3;\n</code></pre></section><section aria-label="Far fence" style="position:absolute;top:1600px"><pre><code class="language-javascript">const far = 4;\n</code></pre></section>'
const plain = '<h1>Plain fences</h1><pre><code>unlabeled &lt;source&gt;\n</code></pre><pre><code class="language-text">text &lt;source&gt;\n</code></pre><pre><code class="language-plain">plain &lt;source&gt;\n</code></pre><pre><code class="language-plaintext">plaintext &lt;source&gt;\n</code></pre><pre><code class="language-txt">txt &lt;source&gt;\n</code></pre>'
// Enough horizontal content to require a different layout at the final width.
const mermaid = '<h1>Responsive diagram</h1><pre><code class="language-mermaid">flowchart LR\nA[Read the original source] --> B[Prepare the preview] --> C[Schedule the compiler] --> D[Render the diagram] --> E[Review the final result]\n</code></pre>'
const params = new URLSearchParams(window.location.search)
const endings = params.get("ending") === "mixed" ? ["\n", "\r\n", "\r"] : [params.get("ending") === "crlf" ? "\r\n" : params.get("ending") === "cr" ? "\r" : "\n"]
const chunkSource = Array.from({ length: 325 }, (_, index) => {
  const row = [99, 100, 199, 200, 323].includes(index) ? "" : index === 175
    ? `const wide = "${"wide ".repeat(300)}";`
    : `const row${index} = "<row & ${index}>"; // café 中文`
  const ending = index === 324 && params.get("final") === "no" ? "" : endings[index % endings.length] ?? "\n"
  return row + ending
}).join("")
// Character references keep CR/CRLF intact through the initial HTML parser.
const chunks = `<h1>Chunked preview</h1><pre><code class="language-javascript">${chunkSource.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\r", "&#13;")}</code></pre><p><a href="/view?path=next.md">Next document</a></p>`

function PreviewSchedulingFixture() {
  const [html, setHTML] = useState(mode === "queue" ? queue : mode === "plain" ? plain : mode === "mermaid" ? mermaid : mode === "chunks" ? chunks : original)
  const [visible, setVisible] = useState(true)
  const [navigation, setNavigation] = useState("")

  return (
    <>
      <nav aria-label="Fixture controls">
        <Button variant="outline" onClick={() => setHTML(replacement)}>Replace content</Button>
        <Button variant="outline" onClick={() => setVisible((current) => !current)}>Toggle preview</Button>
      </nav>
      <output aria-label="Navigation">{navigation}</output>
      <main aria-label="Preview fixture" style={{
        overflow: mode === "queue" ? "auto" : "visible",
        height: mode === "queue" ? 600 : undefined,
        padding: 0,
        position: mode === "queue" ? "relative" : undefined,
        width: mode === "mermaid" ? 700 : undefined,
      }}>
        {visible && <DocumentPreview html={html} navigate={(href) => {
          setNavigation(href)
          setHTML(next)
        }} />}
      </main>
    </>
  )
}

const root = document.getElementById("root")
if (root) {
  createRoot(root).render(
    <ThemeProvider initialTheme={{ theme: "light", resolvedTheme: "light" }}>
      <PreviewSchedulingFixture />
    </ThemeProvider>,
  )
}
