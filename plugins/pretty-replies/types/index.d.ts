export type PrettyRepliesState = { enabled: boolean }

declare module 'claude-code' {
  interface PluginState {
    'pretty-replies': { enabled: boolean }
  }
}
