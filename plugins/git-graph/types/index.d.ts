export type Commit = {
  sha: string
  parents: string[]
  refs: string[]
  subject: string
  author: string
  when: string
}

export type Graph = {
  root: string
  branch: string
  commits: Commit[]
  ascii: string[]
}

export type GraphError = { error: string }

declare module 'claude-code' {
  interface PluginState {
    'git-graph': {
      repo: string | null
      isCollapsed: boolean
      limit: number
      graph: Graph | GraphError | null
    }
  }
}
