export type Snapshot = {
  percent: number | null
  tokens: number | null
  window: number
  fiveHour: number | null
  /** When the 5-hour window resets, ms since the epoch. */
  resetsAt: number | null
  /** Remote Control: its state, or null where this session cannot have it. */
  remote: 'on' | 'off' | 'connecting' | null
  /** How it is switched: the desktop app's own switch, or /remote-control in a terminal. */
  remoteVia: 'app' | 'command' | null
}

declare module 'claude-code' {
  interface PluginState {
    'context-bar': { snap: Snapshot | null }
  }
}
