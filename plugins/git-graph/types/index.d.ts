export type Commit = {
  sha: string
  parents: string[]
  refs: string[]
  subject: string
  author: string
  when: string
}

export type Changes = { staged: number; unstaged: number; untracked: number }

export type Graph = {
  root: string
  branch: string
  /** Newest first; led by a `WORKTREE` row while there are uncommitted changes. */
  commits: Commit[]
  ascii: string[]
  changes: Changes | null
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
