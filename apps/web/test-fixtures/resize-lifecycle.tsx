import { Fragment, StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"

import { Button } from "../src/components/ui/button.tsx"
import { Pane, PaneSash } from "../src/features/source-control/Pane.tsx"
import { SourceControlProvider, useSourceControlPanes } from "../src/features/source-control/SourceControlProvider.tsx"
import { paneIds } from "../src/features/source-control/source-control-layout.ts"
import { usePaneResize } from "../src/features/source-control/use-pane-resize.ts"
import "../src/style.css"

function CommittedLayout() {
  const layout = useSourceControlPanes()
  return <output aria-label="Committed working weight">{layout.weights.working}</output>
}

function Panes() {
  const layout = useSourceControlPanes()
  const panes = usePaneResize({ active: true, mobile: false, open: paneIds, weights: layout.weights,
    onCommit: layout.setPaneWeights, onReset: layout.resetPanes })
  return <div ref={panes.container} className="scm-panes" style={{ height: 500, width: 400, flex: "none" }}>
    {paneIds.map((id, index) => {
      const above = paneIds[index - 1]
      return <Fragment key={id}>
        {above && <PaneSash elementRef={(element) => panes.setSashElement(id, element)} label={`Resize ${above} and ${id}`}
          isResizing={panes.isResizing} onStart={(event) => panes.start(above, id, event)} onMove={panes.move} onStop={panes.stop}
          onResize={(delta) => layout.resizePanes(paneIds, above, id, delta)} onReset={panes.reset} />}
        <Pane title={id} open elementRef={(element) => panes.setPaneElement(id, element)} onOpenChange={() => {}}>
          <span>{id} content</span>
        </Pane>
      </Fragment>
    })}
  </div>
}

function Fixture() {
  const [project, setProject] = useState("first")
  const [mounted, setMounted] = useState(true)
  return <>
    <Button onClick={() => setProject((current) => current === "first" ? "second" : "first")}>Switch project</Button>
    <Button onClick={() => setMounted((current) => !current)}>Toggle panes</Button>
    <output aria-label="Current project">{project}</output>
    <SourceControlProvider key={project} project={project}>
      <CommittedLayout />
      {mounted && <Panes />}
    </SourceControlProvider>
  </>
}

const root = document.getElementById("root")
if (!root) throw new Error("Missing fixture root")
createRoot(root).render(<StrictMode><Fixture /></StrictMode>)
