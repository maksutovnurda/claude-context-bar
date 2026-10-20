import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Limit, Snapshot } from '../types'

const snap = { plugin: 'context-bar', key: 'snap' } as const
// The 5-hour window belongs to the account, not to one session: the last reading any
// session saw lets a session that has made no request of its own still show it.
const KEPT = 'five-hour'

const ACCENT = '#D97757'
const LIMIT = '#4A8FE8'
const WARN = '#C2413A'
const ON = '#3FA266'
const CONNECTING = '#D9A441'
const OFF = '#A3A3A3'

// How often the band catches the clock and the Remote switch up; the figures themselves
// are pushed by session.measure, so this tick is only for what nothing announces.
const TICK = 5000
// The Remote switch is read every third tick; right after a press, every second.
const REMOTE_EVERY = 3
const CHASE = 1000

// The desktop draws a Button's children in its own colour, so the dot is a drawing beside it.
const dot = (color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="${color}"/></svg>`
const BAR = 140

const short = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace('.0', '')}M`
    : n >= 1000 ? `${Math.round(n / 1000)}k`
    : `${n}`

const pad = (n: number) => String(n).padStart(2, '0')

// Time to the reset as a clock reads it: 02:14, the words left off.
const hhmm = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`

const minutesTo = (resetsAt: number | null, now: number) =>
  resetsAt === null || resetsAt <= now ? null : Math.ceil((resetsAt - now) / 60_000)

const GAP = 3

const track = (percent: number, color: string, y: number) => {
  const fill = Math.max(0, Math.min(BAR, Math.round((BAR * percent) / 100)))
  return `<rect y="${y}" width="${BAR}" height="4" rx="2" fill="#888" fill-opacity="0.18"/>`
    + `<rect y="${y}" width="${fill}" height="4" rx="2" fill="${color}"/>`
}

// Context on top; under it, without text, the 5-hour limit.
const barsHeight = (limit: number | null) => (limit === null ? 4 : 8 + GAP)

const bars = (percent: number, limit: number | null) => {
  const height = barsHeight(limit)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR}" height="${height}" viewBox="0 0 ${BAR} ${height}">`
    + track(percent, percent >= 80 ? WARN : ACCENT, 0)
    + (limit === null ? '' : track(limit, LIMIT, 4 + GAP))
    + '</svg>'
}

type Figures = Pick<Snapshot, 'percent' | 'tokens' | 'estimated'>

// `context` is the last response's own input count, and the engine has none at all until
// a session has had a response: one just opened, resumed or compacted. /context's local
// estimate stands in meanwhile — it sends no request — so a resumed session is not a
// blank bar until the person writes something.
async function figures($: EngineInterface, context: SessionContextUsage): Promise<Figures> {
  if (context.percent !== undefined && context.tokens !== undefined)
    return { percent: context.percent, tokens: context.tokens, estimated: false }
  const guess = await $.session.usage({ breakdown: 'summary' })
    .then(u => u.context.breakdown?.totalTokens)
    .catch(() => undefined)
  return guess === undefined
    ? { percent: null, tokens: null, estimated: false }
    : {
      percent: Math.min(100, Math.round((guess * 100) / context.window)),
      tokens: guess,
      estimated: true,
    }
}

type Limits = Pick<Snapshot, 'fiveHour' | 'resetsAt' | 'minutes' | 'limitKept'>

const NO_LIMIT: Limits = { fiveHour: null, resetsAt: null, minutes: null, limitKept: false }

async function limits($: EngineInterface, rateLimits: readonly SessionRateLimit[], now: number): Promise<Limits> {
  const five = rateLimits.find(r => r.kind === 'five_hour')
  if (five !== undefined) {
    const seen: Limit = {
      percent: Math.round(five.percentUsed),
      resetsAt: five.resetsAt !== undefined ? Date.parse(five.resetsAt) : null,
    }
    await $.store.set(KEPT, seen).catch(() => {})
    return { fiveHour: seen.percent, resetsAt: seen.resetsAt, minutes: minutesTo(seen.resetsAt, now), limitKept: false }
  }
  const kept = await $.store.get(KEPT).catch(() => undefined) as Limit | undefined
  // A reading of a window that has since reset says nothing about the one running now.
  return kept !== undefined && kept.resetsAt !== null && kept.resetsAt > now
    ? { fiveHour: kept.percent, resetsAt: kept.resetsAt, minutes: minutesTo(kept.resetsAt, now), limitKept: true }
    : NO_LIMIT
}

type Remote = Pick<Snapshot, 'remote' | 'remoteVia'>

const GET_SESSION = 'mcp__ccd_session_mgmt__get_session'
const NO_REMOTE: Remote = { remote: null, remoteVia: null }

// The desktop app owns Remote Control: get_session("self") reports remoteControlState.
// Nothing announces a change, so the band reads it on the tick, and only where a rule
// already allows the call: a poll must never put a permission dialog in front of the
// person. In a terminal, /remote-control is the toggle; its description reads
// "Disconnect Remote Control" while connected.
async function remoteState($: EngineInterface): Promise<Remote> {
  try {
    const isApp = (await $.tool.list()).some(t => t.name === GET_SESSION)
    if (isApp) {
      const { decision } = await $.tool.check({ tool: GET_SESSION, input: { session_id: 'self' } })
      if (decision !== 'allow') return NO_REMOTE
      const r = await $.tool.call({ tool: GET_SESSION, session_id: 'self' })
      const state = r.text ? /"remoteControlState"\s*:\s*"(\w+)"/.exec(r.text)?.[1] : undefined
      if (!r.isError && !r.deny && state) {
        return state === 'on' || state === 'off' || state === 'connecting'
          ? { remote: state, remoteVia: 'app' }
          : NO_REMOTE
      }
    }
  } catch {
    // not in the desktop app: no such tool
  }
  const rc = (await $.command.list()).find(c => c.name === 'remote-control')
  return rc
    ? { remote: /disconnect/i.test(rc.description) ? 'on' : 'off', remoteVia: 'command' }
    : NO_REMOTE
}

// The press the switch is waiting out, the tick's count and the two timers: module state,
// so the helpers below are top-level functions and a hot reload starts them over.
let pending: { target: 'on' | 'off'; until: number } | null = null
let ticks = 0
let tick: { cancel: () => void } | undefined
let chase: { cancel: () => void } | undefined

// After a press the app still reports the old state for a few seconds:
// hold the switch where the press put it until the app catches up.
function held(s: Snapshot, now: number): Snapshot {
  if (pending === null || s.remote === null) return s
  if (s.remote === pending.target || now > pending.until) {
    pending = null
    return s
  }
  return { ...s, remote: pending.target === 'on' ? 'connecting' : 'off' }
}

// One write per change and none otherwise, so an idle session costs nothing. The engine
// caches what a render hook drew, so a write is followed by the ask that draws the band
// again: without it the line keeps the figures it was first drawn with.
async function write($: EngineInterface, next: Snapshot) {
  const now = await $.clock.now()
  const value = held(next, now)
  const { value: before = null } = await $.state.get(snap)
  if (before !== null && JSON.stringify(before) === JSON.stringify(value)) return
  await $.state.set(snap, value)
  $.ui.invalidate('ui.render')
}

async function measured(
  $: EngineInterface,
  from?: { context: SessionContextUsage; rateLimits: readonly SessionRateLimit[] },
): Promise<Snapshot> {
  const now = await $.clock.now()
  const usage = from ?? await $.session.usage()
  const [fill, limit, remote] = await Promise.all([
    figures($, usage.context),
    limits($, usage.rateLimits, now),
    remoteState($),
  ])
  return { ...fill, ...limit, ...remote }
}

// The countdown and the Remote switch are the two things nothing pushes.
async function onTick($: EngineInterface) {
  ticks += 1
  const { value: s = null } = await $.state.get(snap)
  if (s === null) return write($, await measured($))
  const remote = pending !== null || ticks % REMOTE_EVERY === 0
    ? await remoteState($)
    : { remote: s.remote, remoteVia: s.remoteVia }
  return write($, { ...s, ...remote, minutes: minutesTo(s.resetsAt, await $.clock.now()) })
}

function arm($: EngineInterface) {
  tick?.cancel()
  tick = $.clock.every(TICK, () => { void onTick($).catch(() => {}) })
}

async function chased($: EngineInterface) {
  const { value: s = null } = await $.state.get(snap)
  if (s === null || pending === null) {
    chase?.cancel()
    chase = undefined
    return
  }
  await write($, { ...s, ...await remoteState($) })
}

// A press is worth following closely: the app reports the old state for a few seconds.
function chaseRemote($: EngineInterface) {
  chase?.cancel()
  chase = $.clock.every(CHASE, () => { void chased($).catch(() => {}) })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await write($, await measured($))
    arm($)
    return result
  })

  // The figures are pushed, not polled: this fires after every turn and whenever a
  // rate-limit window moves a whole point. Arming the tick here again also outlives a
  // refused period, which would otherwise end the interval for the rest of the session.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await write($, await measured($, e))
    arm($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { value: s = null } = await $.state.get(snap)
    if (e.props.hasSurvey || s === null) return next(e)

    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    const pct = s.percent ?? 0
    const cells = Math.min(20, Math.round(pct / 5))
    const limitCells = s.fiveHour === null ? null : Math.max(0, Math.min(20, Math.round(s.fiveHour / 5)))
    const hot = pct >= 80
    // `≈` marks what is not a response's own figure: the local estimate of the fill, and
    // a 5-hour reading this session did not make itself. `·` separates every group: the
    // alt text keeps its comma, being a phrase a screen reader reads out.
    const fill = s.percent === null ? '—' : `${s.estimated ? '≈' : ''}${s.percent}%`
    const limit = s.fiveHour === null ? null
      : s.minutes !== null
        ? `·  ${s.limitKept ? '≈' : ''}лимит ${s.fiveHour}%  ·  ${hhmm(s.minutes)}`
        : `·  ${s.limitKept ? '≈' : ''}лимит ${s.fiveHour}%`

    const isOn = s.remote === 'on' || s.remote === 'connecting'
    const dotColor = s.remote === 'on' ? ON : s.remote === 'connecting' ? CONNECTING : OFF
    const toggle = async () => {
      pending = { target: isOn ? 'off' : 'on', until: (await $.clock.now()) + 20_000 }
      await $.state.set(snap, { ...s, remote: isOn ? 'off' : 'connecting' })
      $.ui.invalidate('ui.render')
      try {
        if (s.remoteVia === 'app') {
          const r = await $.tool.call({ tool: 'mcp__ccd_session_mgmt__set_remote_control', session_id: 'self', enabled: !isOn })
          const problem = r.deny ?? (r.isError ? r.text : undefined)
          if (problem) {
            pending = null
            $.ui.toast('Remote Control не переключился: нет разрешения или ошибка приложения')
          }
        } else {
          await $.command.run({ command: 'remote-control', args: '' })
        }
      } catch {
        pending = null
        $.ui.toast('Remote Control не переключился')
      }
      await write($, { ...s, ...await remoteState($) })
      if (pending !== null) chaseRemote($)
    }

    return (
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" paddingX={1}>
        <Box flexDirection="row" alignItems="center" gap={1}>
          {Svg
            ? (
              <Svg
                source={bars(pct, s.fiveHour)}
                alt={s.fiveHour === null ? `контекст ${pct}%` : `контекст ${pct}%, лимит ${s.fiveHour}%`}
                width={BAR}
                height={barsHeight(s.fiveHour)}
              />
            )
            : (
              <Box flexDirection="column">
                <Text color={hot ? 'error' : 'claude'}>{'━'.repeat(cells)}<Text dimColor>{'━'.repeat(20 - cells)}</Text></Text>
                {limitCells !== null
                  ? <Text color={LIMIT}>{'━'.repeat(limitCells)}<Text dimColor>{'━'.repeat(20 - limitCells)}</Text></Text>
                  : null}
              </Box>
            )}
          <Text size="caption" tabular color={hot ? 'error' : undefined} dimColor={!hot}>
            {fill}
            <Text dimColor>{s.tokens !== null ? `  ${short(s.tokens)}` : ''}</Text>
          </Text>
          {limit !== null ? <Text size="caption" tabular dimColor>{limit}</Text> : null}
        </Box>
        {s.remote !== null
          ? (
            <Box key="remote-row" flexDirection="row" alignItems="center" gap={1}>
              {Svg
                ? <Svg source={dot(dotColor)} alt={`Remote Control: ${s.remote}`} width={8} height={8} />
                : <Text color={s.remote === 'off' ? undefined : dotColor} dimColor={!isOn}>●</Text>}
              <Button key="remote" plain dimColor={!isOn} onPress={toggle} label="Remote" />
            </Box>
          )
          : null}
      </Box>
    )
  })
}
