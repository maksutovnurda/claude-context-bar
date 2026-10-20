import type { On } from 'claude-code'
import { test, expect, mock } from 'claude-code/testing'

const props = (hasSurvey: boolean) => ({
  hasSurvey, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {},
})

type Remote = { via: 'app' | 'command' | 'none'; on: boolean; calls: number; lag?: number; allowed?: boolean; reads?: number }

type Drawing = { findAll: (q: { type?: string }) => Promise<readonly { props: Record<string, unknown> }[]> }

async function dot(ui: Drawing) {
  const svg = (await ui.findAll({ type: 'Svg' })).find(el => String(el.props.alt).startsWith('Remote'))
  return /fill="(#[0-9A-F]+)"/i.exec(String(svg?.props.source))?.[1]
}

function world(on: On, remote: Remote) {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 16, 12, 0) })
  on('session.usage', ($, _e, _next) => ({ value: {
    startedAt: 0,
    context: { tokens: 84_000, window: 200_000, percent: 42 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 23.4, resetsAt: new Date(Date.UTC(2026, 9, 16, 14, 14)).toISOString() }],
    cost: { usd: 1.237 },
  } }))
  on('tool.list', ($, _e, _next) => ({ value: remote.via === 'app'
    ? [{ name: 'mcp__ccd_session_mgmt__get_session', description: '', mcp: true }, { name: 'mcp__ccd_session_mgmt__set_remote_control', description: '', mcp: true }]
    : [] }))
  on('tool.check', ($, e, _next) => ({ decision: e.tool === 'mcp__ccd_session_mgmt__get_session' && remote.allowed === false ? 'ask' : 'allow' }))
  on('tool.call', ($, e, _next) => {
    if (remote.via !== 'app') return { deny: 'No such tool available' }
    if (e.tool === 'mcp__ccd_session_mgmt__get_session') {
      remote.reads = (remote.reads ?? 0) + 1
      const shown = remote.lag ? (remote.lag--, !remote.on) : remote.on
      return { result: {}, text: JSON.stringify({ sessionId: 'x', remoteControlState: shown ? 'on' : 'off' }) }
    }
    if (e.tool === 'mcp__ccd_session_mgmt__set_remote_control') {
      remote.on = Boolean(e.enabled)
      remote.calls += 1
      return { result: {}, text: 'ok' }
    }
    return { deny: 'unexpected' }
  })
  on('command.list', ($, _e, _next) => ({ value: remote.via === 'command'
    ? [{ name: 'remote-control', description: remote.on ? 'Disconnect Remote Control' : 'Control this session from your phone or claude.ai/code', source: 'builtin' as const }]
    : [] }))
  on('command.run', ($, e, _next) => {
    if (remote.via === 'command' && e.command === 'remote-control') { remote.on = !remote.on; remote.calls += 1 }
    return {}
  })
  on('session.measure', ($, e, _next) => ({ changed: e.changed }))
  on('session.start', ($, e, _next) => ({ cwd: e.cwd }))
  on('ui.render', ($, e, _next) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return clock
}

test('band shows context fill and time to the limit reset, no model or cost', async ($, on) => {
  world(on, { via: 'app', on: false, calls: 0 })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-bar', surface, component: 'AbovePrompt', props: props(false) })
    expect(await ui.find({ type: 'Text', text: '42%  84k / 200k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'лимит 23%, сброс через 2ч 14м' })).toBeDefined()
    expect(await ui.find({ text: 'Opus' })).toBeUndefined()
    expect(await ui.find({ text: '$' })).toBeUndefined()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()
    await ui.unmount()
  }
})

test('a blue bar under the context bar shows the 5-hour limit, without text', async ($, on) => {
  world(on, { via: 'none', on: false, calls: 0 })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  const desktop = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: props(false) })
  const svg = String((await desktop.find({ type: 'Svg' }))?.props.source)
  // 23% of 140px, drawn under the 42% context bar
  expect(svg).toContain('<rect y="7" width="32" height="4" rx="2" fill="#4A8FE8"/>')
  expect(svg).toContain('<rect y="0" width="59" height="4" rx="2" fill="#D97757"/>')
  await desktop.unmount()

  const terminal = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'AbovePrompt', props: props(false) })
  const blue = (await terminal.findAll({ type: 'Text' })).find(el => el.props.color === '#4A8FE8')
  expect(blue).toBeDefined()
  await terminal.unmount()
})

for (const via of ['app', 'command'] as const) {
  test(`the Remote toggle switches Remote Control (${via})`, async ($, on) => {
    const remote: Remote = { via, on: false, calls: 0 }
    world(on, remote)
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

    const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: props(false) })
    expect(await ui.find({ key: 'remote', text: 'Remote' })).toBeDefined()
    expect(await dot(ui)).toBe('#A3A3A3')
    await ui.press({ key: 'remote' })
    expect(remote.calls).toBe(1)
    expect(remote.on).toBe(true)
    expect(await dot(ui)).toBe('#3FA266')
    await ui.unmount()
  })
}

test('the dot stays yellow while the app is still connecting', async ($, on) => {
  const remote: Remote = { via: 'app', on: false, calls: 0 }
  const clock = world(on, remote)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: props(false) })
  remote.lag = 3
  await ui.press({ key: 'remote' })
  expect(await dot(ui)).toBe('#D9A441')
  await clock.advance(2000)
  expect(await dot(ui)).toBe('#D9A441')
  await clock.advance(4000)
  expect(await dot(ui)).toBe('#3FA266')
  await ui.unmount()
})

test('without an allow rule the bar never asks the app, so no permission dialogs', async ($, on) => {
  const remote: Remote = { via: 'app', on: false, calls: 0, allowed: false }
  const clock = world(on, remote)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await clock.advance(10_000)

  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: props(false) })
  expect(remote.reads ?? 0).toBe(0)
  expect(await ui.find({ key: 'remote' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '42%  84k / 200k' })).toBeDefined()
  await ui.unmount()
})

test('no toggle where Remote Control is unavailable; band yields to a survey', async ($, on) => {
  world(on, { via: 'none', on: false, calls: 0 })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: props(false) })
  expect(await ui.find({ key: 'remote' })).toBeUndefined()
  await ui.unmount()
  const survey = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: props(true) })
  expect(await survey.find({ type: 'Text', text: '%' })).toBeUndefined()
  await survey.unmount()
})

// A session the engine has no figures for: just opened, resumed or compacted, before its
// first response. /context's local estimate is all there is, and the 5-hour window only
// what an earlier session wrote.
function quiet(on: On, kept?: Record<string, unknown>) {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 16, 12, 0) })
  mock.store(on, kept)
  on('session.usage', ($, e, _next) => ({ value: {
    startedAt: 0,
    context: e.breakdown === undefined ? { window: 200_000 } : {
      window: 200_000,
      breakdown: {
        categories: [], totalTokens: 76_000, maxTokens: 200_000, rawMaxTokens: 200_000,
        autocompactSource: 'model-default' as const, percentage: 38, gridRows: [],
        model: 'Opus', memoryFiles: [], mcpTools: [], agents: [],
        isAutoCompactEnabled: false, apiUsage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
    rateLimits: [],
  } }))
  on('tool.list', ($, _e, _next) => ({ value: [] }))
  on('command.list', ($, _e, _next) => ({ value: [] }))
  on('session.measure', ($, e, _next) => ({ changed: e.changed }))
  on('session.start', ($, e, _next) => ({ cwd: e.cwd }))
  on('ui.render', ($, e, _next) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return clock
}

test('the countdown to the reset moves while the session sits idle', async ($, on) => {
  const clock = world(on, { via: 'none', on: false, calls: 0 })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: props(false) })
  expect(await ui.find({ type: 'Text', text: 'сброс через 2ч 14м' })).toBeDefined()
  await clock.advance(5 * 60_000)
  expect(await ui.find({ type: 'Text', text: 'сброс через 2ч 9м' })).toBeDefined()
  await ui.unmount()
})

test('before its first response a session shows the local estimate, not a blank bar', async ($, on) => {
  quiet(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: props(false) })
  expect(await ui.find({ type: 'Text', text: '\u224838%  76k / 200k' })).toBeDefined()
  await ui.unmount()
})

test('a session of its own makes no reading: the 5-hour window is the last one kept', async ($, on) => {
  const resetsAt = Date.UTC(2026, 9, 16, 14, 14)
  quiet(on, { 'five-hour': { percent: 23, resetsAt } })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: props(false) })
  expect(await ui.find({ type: 'Text', text: '\u2248лимит 23%, сброс через 2ч 14м' })).toBeDefined()
  await ui.unmount()
})

test('a reading past its reset is dropped, not shown as a running window', async ($, on) => {
  quiet(on, { 'five-hour': { percent: 23, resetsAt: Date.UTC(2026, 9, 16, 11, 0) } })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: props(false) })
  expect(await ui.find({ type: 'Text', text: 'лимит' })).toBeUndefined()
  await ui.unmount()
})

test('a turn pushes the figures: the band has them without waiting for a tick', async ($, on) => {
  quiet(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: props(false) })
  await $.session.measure({
    context: { tokens: 91_000, window: 200_000, percent: 46 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 31, resetsAt: new Date(Date.UTC(2026, 9, 16, 14, 14)).toISOString() }],
    changed: ['context', 'rateLimits'],
  })
  expect(await ui.find({ type: 'Text', text: '46%  91k / 200k' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'лимит 31%, сброс через 2ч 14м' })).toBeDefined()
  await ui.unmount()
})
