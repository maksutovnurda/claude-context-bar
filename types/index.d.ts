export type Snapshot = {
  percent: number | null
  tokens: number | null
  /** True while the fill is the local estimate rather than a response's own count. */
  estimated: boolean
  fiveHour: number | null
  /** When the 5-hour window resets, ms since the epoch. */
  resetsAt: number | null
  /** Minutes to that reset, recomputed on the tick so the countdown moves on its own. */
  minutes: number | null
  /** True while the 5-hour figures are the last reading kept, not this session's own. */
  limitKept: boolean
  /** Remote Control: its state, or null where this session cannot have it. */
  remote: 'on' | 'off' | 'connecting' | null
  /** How it is switched: the desktop app's own switch, or /remote-control in a terminal. */
  remoteVia: 'app' | 'command' | null
}

/** The last 5-hour reading, kept across sessions: the window is the account's. */
export type Limit = { percent: number; resetsAt: number | null }

declare module 'claude-code' {
  interface PluginState {
    'context-bar': { snap: Snapshot | null }
  }
}
