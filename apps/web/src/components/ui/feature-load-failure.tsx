import { Button } from "./button.tsx"

export function FeatureLoadFailure({ feature, retry }: { feature: string; retry?: () => void }) {
  return (
    <>
      <p role="alert">Couldn't load {feature}.{retry ? "" : " Reload the page to try again."}</p>
      {retry
        ? <Button type="button" variant="outline" onClick={retry}>Retry</Button>
        : <Button type="button" variant="outline" onClick={() => window.location.reload()}>Reload page</Button>}
    </>
  )
}
