import type { EngineInterface, Register } from 'claude-code'

import type { Snapshot } from '../types'

const snap = { plugin: 'context-bar', key: 'snap' } as const

const ACCENT = '#D97757'
const LIMIT = '#4A8FE8'
const WARN = '#C2413A'
const ON = '#3FA266'
const CONNECTING = '#D9A441'
const OFF = '#A3A3A3'

// The desktop draws a Button's children in its own colour, so the dot is a drawing beside it.
const dot = (color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="${color}"/></svg>`
const BAR = 140

const short = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace('.0', '')}M`
    : n >= 1000 ? `${Math.round(n / 1000)}k`
    : `${n}`

const left = (ms: number) => {
  const m = Math.max(0, Math.ceil(ms / 60_000))
  const h = Math.floor(m / 60)
  return h > 0 ? `${h}ч ${m % 60}м` : `${m}м`
}

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

type Remote = Pick<Snapshot, 'remote' | 'remoteVia'>

const GET_SESSION = 'mcp__ccd_session_mgmt__get_session'

// The desktop app owns Remote Control: get_session("self") reports remoteControlState.
// The bar polls it, so it reads it only where a rule already allows the call: a poll
// must never put a permission dialog in front of the person.
// In a terminal, /remote-control is the toggle; its description reads "Disconnect Remote Control" while connected.
async function remoteState($: EngineInterface): Promise<Remote> {
  try {
    const isApp = (await $.tool.list()).some(t => t.name === GET_SESSION)
    if (isApp) {
      const { decision } = await $.tool.check({ tool: GET_SESSION, input: { session_id: 'self' } })
      if (decision !== 'allow') return { remote: null, remoteVia: null }
      const r = await $.tool.call({ tool: GET_SESSION, session_id: 'self' })
      const state = r.text ? /"remoteControlState"\s*:\s*"(\w+)"/.exec(r.text)?.[1] : undefined
      if (!r.isError && !r.deny && state) {
        return state === 'on' || state === 'off' || state === 'connecting'
          ? { remote: state, remoteVia: 'app' }
          : { remote: null, remoteVia: null }
      }
    }
  } catch {
    // not in the desktop app: no such tool
  }
  const rc = (await $.command.list()).find(c => c.name === 'remote-control')
  return rc
    ? { remote: /disconnect/i.test(rc.description) ? 'on' : 'off', remoteVia: 'command' }
    : { remote: null, remoteVia: null }
}

async function snapshot($: EngineInterface): Promise<Snapshot> {
  const [usage, remote] = await Promise.all([$.session.usage(), remoteState($)])
  const five = usage.rateLimits.find(r => r.kind === 'five_hour')
  return {
    percent: usage.context.percent ?? null,
    tokens: usage.context.tokens ?? null,
    window: usage.context.window,
    fiveHour: five ? Math.round(five.percentUsed) : null,
    resetsAt: five?.resetsAt ? Date.parse(five.resetsAt) : null,
    ...remote,
  }
}

export const register: Register = on => {
  let timer: { cancel: () => void } | undefined
  // After a press the app still reports the old state for a few seconds:
  // hold the switch where the press put it until the app catches up.
  let pending: { target: 'on' | 'off'; until: number } | null = null

  const held = (s: Snapshot, now: number): Snapshot => {
    if (pending === null || s.remote === null) return s
    if (s.remote === pending.target || now > pending.until) {
      pending = null
      return s
    }
    return { ...s, remote: pending.target === 'on' ? 'connecting' : 'off' }
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const first = await snapshot($)
    await $.state.set(snap, held(first, await $.clock.now()))
    timer?.cancel()
    timer = $.clock.every(2000, async () => {
      const s = await snapshot($)
      await $.state.set(snap, held(s, await $.clock.now()))
    })
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const s = await snapshot($)
    await $.state.set(snap, held(s, await $.clock.now()))
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
    const now = await $.clock.now()
    const limit = s.fiveHour === null ? null
      : s.resetsAt !== null && s.resetsAt > now
        ? `·  лимит ${s.fiveHour}%, сброс через ${left(s.resetsAt - now)}`
        : `·  лимит ${s.fiveHour}%`

    const isOn = s.remote === 'on' || s.remote === 'connecting'
    const dotColor = s.remote === 'on' ? ON : s.remote === 'connecting' ? CONNECTING : OFF
    const toggle = async () => {
      pending = { target: isOn ? 'off' : 'on', until: (await $.clock.now()) + 20_000 }
      await $.state.set(snap, { ...s, remote: isOn ? 'off' : 'connecting' })
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
      const fresh = await snapshot($)
      await $.state.set(snap, held(fresh, await $.clock.now()))
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
            {`${pct}%`}
            <Text dimColor>{s.tokens !== null ? `  ${short(s.tokens)} / ${short(s.window)}` : ''}</Text>
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
