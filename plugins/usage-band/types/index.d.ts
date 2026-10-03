export type Gauge = { percent: number; resetsAt?: string }
export type Snapshot = { fiveHour?: Gauge; sevenDay?: Gauge; fable?: Gauge }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { usage: Snapshot | null; now: number }
  }
}
