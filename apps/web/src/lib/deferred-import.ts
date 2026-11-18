export interface DeferredImport<Module> {
  peek(): Module | undefined
  load(): Promise<Module>
}

// Share one attempt per entry and retain successful modules. A rejected
// import leaves the caller free to start a fresh attempt.
export function deferImport<Module>(importModule: () => Promise<Module>): DeferredImport<Module> {
  let loaded: Module | undefined
  let pending: Promise<Module> | undefined
  return {
    peek: () => loaded,
    load() {
      pending ??= importModule().then(
        (module) => {
          loaded = module
          return module
        },
        (error: unknown) => {
          pending = undefined
          throw error
        },
      )
      return pending
    },
  }
}
