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

  const terminal = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'AbovePrompt', props: props(false) })
  expect(await terminal.find({ type: 'Text', text: '42%' })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: '84k  ·  02:14' })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: '23%' })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: '02:14' })).toBeDefined()
  expect(await terminal.find({ text: 'Opus' })).toBeUndefined()
  expect(await terminal.find({ text: '$' })).toBeUndefined()
  await terminal.unmount()

  const desktop = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: props(false) })
  const drawn = (await desktop.findAll({ type: 'Svg' })).map(el => String(el.props.source)).join('')
  // 9px, under the surface's smallest text step, so the figures sit inside the drawing
  expect(drawn).toContain('font-size="9"')
  expect(drawn).toContain('>42%<')
  expect(drawn).toContain('>23%<')
  expect(await desktop.find({ type: 'Text', text: '84k  ·  02:14' })).toBeDefined()
  expect(await desktop.find({ text: 'Opus' })).toBeUndefined()
  await desktop.unmount()
})

test('each bar has its own percent: the context fill over the 5-hour limit', async ($, on) => {
  world(on, { via: 'none', on: false, calls: 0 })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  const desktop = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: props(false) })
  const svgs = await desktop.findAll({ type: 'Svg' })
  const source = (what: string) =>
    String(svgs.find(el => String(el.props.alt).startsWith(what))?.props.source)
  // each bar is its own drawing beside its own percent: 42% of 140px over 23% of it
  expect(source('контекст')).toContain('<rect y="4" width="59" height="4" rx="2" fill="#D97757"/>')
  expect(source('лимит')).toContain('<rect y="4" width="32" height="4" rx="2" fill="#4A8FE8"/>')
  expect(source('лимит')).toContain('>23%<')
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
  expect(String((await ui.find({ type: 'Svg' }))?.props.source)).toContain('>42%<')
  expect(await ui.find({ type: 'Text', text: '84k' })).toBeDefined()
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

  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'AbovePrompt', props: props(false) })
  expect(await ui.find({ type: 'Text', text: '02:14' })).toBeDefined()
  await clock.advance(5 * 60_000)
  expect(await ui.find({ type: 'Text', text: '02:09' })).toBeDefined()
  await ui.unmount()
})

test('before its first response a session shows the local estimate, not a blank bar', async ($, on) => {
  quiet(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'AbovePrompt', props: props(false) })
  expect(await ui.find({ type: 'Text', text: '\u224838%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '76k' })).toBeDefined()
  await ui.unmount()
})

test('a session of its own makes no reading: the 5-hour window is the last one kept', async ($, on) => {
  const resetsAt = Date.UTC(2026, 9, 16, 14, 14)
  quiet(on, { 'five-hour': { percent: 23, resetsAt } })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', component: 'AbovePrompt', props: props(false) })
  expect(await ui.find({ type: 'Text', text: '\u224823%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '02:14' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '\u224823%  02:14' })).toBeUndefined()
  await ui.unmount()
})

test('a reading past its reset is dropped, not shown as a running window', async ($, on) => {
  quiet(on, { 'five-hour': { percent: 23, resetsAt: Date.UTC(2026, 9, 16, 11, 0) } })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: props(false) })
  expect((await ui.findAll({ type: 'Svg' })).some(el => String(el.props.alt).startsWith('лимит'))).toBe(false)
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
  const drawn = (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.source)).join('')
  expect(drawn).toContain('>46%<')
  expect(drawn).toContain('>31%<')
  expect(await ui.find({ type: 'Text', text: '91k  ·  02:14' })).toBeDefined()
  await ui.unmount()
})
