import { lazy, Suspense, type ReactElement, type ReactNode } from "react"
import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useRouterState,
  useSearch,
} from "@tanstack/react-router"

import { App } from "./App.tsx"
import { SourceControlProvider } from "./features/source-control/SourceControlProvider.tsx"
import { isAbort } from "./api/http.ts"
import { loadPage } from "./api/page-data.ts"
import { parseDiffLineAnchor } from "./features/source-control/diff-line-selection.ts"
import { ChooseProject } from "./features/projects/ChooseProject.tsx"
import { defaultProject, fetchProjects, repoKey, repoLanding, type RepoLanding } from "./api/projects-data.ts"
import { compareSearch, legacyCompare, reviewFragment, routeCompare } from "./features/source-control/compare.ts"
import { isCommitHash } from "./lib/commit-hash.ts"
import { browserTabID, routeAt } from "./workspace/workspace-tabs.ts"
import { routeStep, routeWalkthrough } from "./features/walkthrough/walkthrough-steps.ts"
import { routeFeedback, routeThread } from "./features/feedback/feedback-model.ts"
import { navigationHistoryFor } from "./workspace/navigation-history-store.ts"
import { WorkspaceSkeleton } from "./workspace/WorkspaceSkeleton.tsx"
import { loadsWorkspace } from "./workspace/first-load.ts"
import { treeStore, withRouteTree } from "./workspace/tree-store.ts"

interface PageSearch {
  [key: string]: unknown
  path?: string
  project?: string
  // repo=<identity> finds the project by its repository's identity
  // ("github.com/owner/repo", decision 0188) where project= does not open;
  // it is dropped once a project is found.
  repo?: string
  // Without a path, review=working, review=branch (with base, and head for a
  // stack layer), commit=<hash>, or from=<hash>&to=<hash> open a review tab
  // (decisions 0035, 0040). review=branch&uncommitted=1 adds the working
  // tree to HEAD's branch (decision 0051).
  review?: "working" | "branch"
  base?: string
  head?: string
  uncommitted?: 1
  commit?: string
  from?: string
  to?: string
  // With a path, at=<hash> opens that commit's version of the file.
  at?: string
  // wt=<id> follows a walkthrough (decision 0047); step=<n> (1-based) names
  // the step whose target the route opens. Without a path or review, the
  // route opens the walkthrough's own tab.
  wt?: string
  step?: number
  // welcome=1, without a path, review, or walkthrough, opens the Welcome tab
  // (decision 0052).
  welcome?: 1
  // browser=<n>, without a path, review, walkthrough, or Welcome, opens the
  // project's Browser tab n, from 1 (decisions 0181, 0195).
  browser?: number
  // fb=<id> reveals the Feedback view at that feedback (decision 0120);
  // alone it opens no tab. With thread=<n>, and without a path, review, or
  // walkthrough, it opens that visual thread's screen tab (decision 0182).
  fb?: string
  thread?: number
  // With a path, diff=1, commit=, branch=1, and from=&to= are per-file diff
  // routes from before review tabs; they redirect to the review.
  diff?: 1
  branch?: 1
}

function validateSearch(search: Record<string, unknown>): PageSearch {
  return {
    ...search,
    path: typeof search.path === "string" ? search.path : undefined,
    at: routeAt(search.path, search.at),
    project: typeof search.project === "string" && search.project !== "" ? search.project : undefined,
    repo: typeof search.repo === "string" && repoKey(search.repo) !== "" ? repoKey(search.repo) : undefined,
    review: search.review === "working" || search.review === "branch" ? search.review : undefined,
    base: typeof search.base === "string" && search.base !== "" ? search.base : undefined,
    head: typeof search.head === "string" && search.head !== "" ? search.head : undefined,
    uncommitted: search.uncommitted === 1 || search.uncommitted === "1" ? 1 : undefined,
    diff: search.diff === 1 || search.diff === "1" ? 1 : undefined,
    commit: isCommitHash(search.commit) ? search.commit : undefined,
    branch: search.branch === 1 || search.branch === "1" ? 1 : undefined,
    from: isCommitHash(search.from) ? search.from : undefined,
    to: isCommitHash(search.to) ? search.to : undefined,
    wt: routeWalkthrough(search.wt),
    step: routeStep(search.step),
    welcome: search.welcome === 1 || search.welcome === "1" ? 1 : undefined,
    browser: browserTabID(search.browser),
    fb: routeFeedback(search.fb),
    thread: routeFeedback(search.fb) ? routeThread(search.thread) : undefined,
  }
}

// withProject puts project first so URLs read /view?project=…&path=….
function withProject(search: PageSearch, project: string): PageSearch {
  const { project: _previous, ...rest } = search
  return { project, ...rest }
}

// withoutRepo drops repo= once it has found its project: URLs within the
// app name projects by path (decision 0188).
function withoutRepo(search: PageSearch): PageSearch {
  const { repo: _repo, ...rest } = search
  return rest
}

// findRepo resolves a link's repo= (decision 0188); when projects cannot be
// listed, the page asks and reports why.
async function findRepo(search: PageSearch, signal: AbortSignal): Promise<RepoLanding> {
  try {
    return repoLanding(await fetchProjects(signal), search.project ?? "", search.repo ?? "")
  } catch (error: unknown) {
    if (isAbort(error)) throw error
    return { kind: "choose" }
  }
}

// choosing is the index route's loader data while it asks for a project.
const choosing = { choosing: true }

function isChoosing(value: unknown): boolean {
  return typeof value === "object" && value !== null && "choosing" in value && value.choosing === true
}

// The composer's page (decision 0184) loads on its own route only.
const ComposerPage = lazy(() => import("./features/review/ComposerPage.tsx").then((module) => ({ default: module.ComposerPage })))

function RoutedApp() {
  // Committed (not pending) search: the workspace switches once the new
  // project's page has loaded, then remounts without the old project's state.
  const project = useSearch({ strict: false, select: (search) => typeof search.project === "string" ? search.project : "" })
  // The index route without a project asks which to open (decision 0153).
  const asking = useRouterState({ select: (state) => state.matches.some((match) => match.routeId === indexRoute.id && isChoosing(match.loaderData)) })
  // /composer is the composer alone: no workspace, no project to load.
  const composing = useRouterState({ select: (state) => state.matches.some((match) => match.routeId === composerRoute.id) })
  if (composing) return <Suspense fallback={null}><ComposerPage /></Suspense>
  if (asking) return <ChooseProject />
  return <SourceControlProvider key={project} project={project}><App project={project} /></SourceControlProvider>
}

const rootRoute = createRootRoute({
  component: RoutedApp,
})

// FirstLoad draws the workspace's frame until the first route has loaded:
// the router publishes no match before its loaders finish, and a deep link's
// document can wait on a large folder's scan (decision 0192). Later
// navigations keep the workspace, which shows its own progress. A route
// that shows no workspace (asking for a project) draws no frame
// (decision 0193).
function FirstLoad({ children }: { children: ReactNode }): ReactElement {
  const loading: boolean = useRouterState({
    select: (state) => state.matches.length === 0 && loadsWorkspace(state.location.pathname, state.location.search),
  })
  return <>{loading && <WorkspaceSkeleton />}{children}</>
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch,
  // Without a project the page asks which, even when there is only one
  // (decisions 0153, 0191), and paints before projects are listed: serving
  // no folder, it says so itself (decision 0193).
  beforeLoad: async ({ search, abortController }) => {
    // A repo= link opens its checkout, else asks among its checkouts, or
    // among every project when this server has none.
    if (search.repo) {
      const found = await findRepo(search, abortController.signal)
      if (found.kind === "open") throw redirect({ to: "/", search: withProject(withoutRepo(search), found.project), replace: true })
      return { choose: true }
    }
    return { choose: !search.project }
  },
  loaderDeps: ({ search }) => ({ project: search.project ?? "" }),
  // Choosing a project loads no page. A project's tree loads beside its
  // page (decision 0193).
  loader: ({ abortController, context, deps, preload }) => context.choose ? choosing
    : withRouteTree(treeStore, { project: deps.project, preload, signal: abortController.signal }, () => loadPage({
      pathname: "/",
      project: deps.project,
      selected: "",
      signal: abortController.signal,
    })),
})

const viewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "view",
  validateSearch,
  // A path without a project is relative to the first served root.
  beforeLoad: async ({ search, location, abortController }) => {
    // A per-file diff route opens its review at that file, keeping its lines.
    const legacy = legacyCompare(search)
    if (legacy) {
      const lines = parseDiffLineAnchor(location.hash)
      throw redirect({
        to: "/view",
        search: { ...(search.project ? { project: search.project } : {}), ...compareSearch(legacy.compare) },
        hash: reviewFragment(legacy.path, lines),
        replace: true,
      })
    }
    // A repo= link opens its checkout, keeping its target; a choice goes
    // through the index route's page, which keeps them too.
    if (search.repo) {
      const found = await findRepo(search, abortController.signal)
      if (found.kind === "open") throw redirect({ to: "/view", search: withProject(withoutRepo(search), found.project), hash: location.hash, replace: true })
      throw redirect({ to: "/", search, hash: location.hash, replace: true })
    }
    if (search.project) return
    let project = ""
    try {
      project = defaultProject(await fetchProjects(abortController.signal))
    } catch (error: unknown) {
      if (isAbort(error)) throw error
    }
    // Keep line anchors (#L12) across the default-project redirect.
    if (project) throw redirect({ to: "/view", search: withProject(search, project), hash: location.hash, replace: true })
  },
  // A review, walkthrough, Welcome, or Browser tab loads only the tree; a review's
  // pane reads /api/diff per file.
  loaderDeps: ({ search }) => {
    const diff = routeCompare(search) !== null || (!search.path && (search.wt !== undefined || search.welcome !== undefined || search.browser !== undefined || search.fb !== undefined))
    return { project: search.project ?? "", selected: diff ? "" : search.path ?? "", at: diff ? "" : search.at ?? "", diff }
  },
  loader: ({ abortController, deps, preload }) => withRouteTree(treeStore, { project: deps.project, preload, signal: abortController.signal }, () => loadPage({
    pathname: deps.diff ? "/" : "/view",
    project: deps.project,
    selected: deps.selected,
    at: deps.at,
    signal: abortController.signal,
  })),
})

// composerRoute is the page the desktop app shows beside a pick on the
// Browser's page (decision 0184). It loads nothing: the pick names its
// project.
const composerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "composer",
})

const routeTree = rootRoute.addChildren([indexRoute, viewRoute, composerRoute])

export const router = createRouter({
  InnerWrap: FirstLoad,
  defaultPreload: "intent",
  defaultPreloadStaleTime: 2_000,
  routeTree,
  // The persistent workspace owns document scroll; the tree retains its DOM scroll.
  scrollRestoration: false,
  defaultHashScrollIntoView: false,
})

// Follow history from the first route on, before the workspace mounts.
navigationHistoryFor(router.history)

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
