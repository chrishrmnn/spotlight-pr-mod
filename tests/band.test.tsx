import { expect, mock, test } from 'claude-code/testing'

const MAIN = '/repo'
const WORKTREE = '/repo/.claude/worktrees/feat'
const BAND = {
  plugin: 'spotlight-pr-band',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

type World = {
  cwd?: string
  status?: object | null
  mainOnBranch?: boolean
  pr?: object | null
  prError?: string
  broken?: string
  log?: string
  subject?: string
  ran?: string
}

const ok = (stdout = '') => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})
const fail = (stderr = '') => ({
  value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

const wire = (on: any, world: World) => {
  const calls: { argv: readonly string[]; env?: Record<string, string> }[] = []
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: world.cwd ?? WORKTREE }))
  on('command.run', (_: unknown, e: { command: string }) => {
    world.ran = e.command

    return { text: '' }
  })
  on('process.run', (_: unknown, e: { argv: readonly string[]; init?: { env?: Record<string, string> } }) => {
    calls.push({ argv: e.argv, env: e.init?.env })
    const line = e.argv.join(' ')
    if (line.includes('rev-parse --show-toplevel')) return ok(world.cwd ?? WORKTREE)
    if (line.includes('worktree list')) return ok(`worktree ${MAIN}\nHEAD abc\n`)
    if (line.includes('refs/remotes/origin/HEAD')) return ok('origin/master')
    if (line.includes('branch --show-current')) return ok('feat')
    if (line.includes('symbolic-ref -q')) return world.mainOnBranch ? ok('refs/heads/master') : fail()
    if (line === 'spotlight status --json') {
      return world.status === null ? fail() : ok(JSON.stringify(world.status ?? { active: false }))
    }
    if (e.argv[0] === 'gh') {
      if (world.prError) return fail(world.prError)
      return world.pr ? ok(JSON.stringify(world.pr)) : fail('no pull requests found for branch "feat"')
    }
    if (e.argv[0] === 'find') return ok(world.broken ?? '')
    if (e.argv[0] === 'tail') return ok(world.log ?? 'Watching for changes...')
    if (e.argv[0] === 'wc') return fail()
    if (line.startsWith('git log')) return ok(world.subject ?? 'real commit')
    return ok()
  })

  return calls
}

const boot = async ($: any, on: any, world: World, surface: 'desktop' | 'terminal' = 'desktop') => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/me', PATH: '/usr/bin' })
  const calls = wire(on, world)
  on('ui.render', ($$: any, e: any) => {
    const { Text } = $$.ui.resolve(e)

    return <Text>engine</Text>
  })
  await $.session.start({ cwd: world.cwd ?? WORKTREE, surface, isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface })

  return { ui, calls, clock }
}

const pr = (over: object = {}) => ({
  number: 42,
  url: 'https://github.com/o/r/pull/42',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
  ...over,
})

const PR_CASES: [string, object, RegExp][] = [
  ['open', {}, /#42 · Open/],
  ['checks running', { statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: '' }] }, /Checks running/],
  ['draft', { isDraft: true }, /Draft/],
  ['merge conflicts', { mergeable: 'CONFLICTING' }, /Merge conflicts/],
  ['failed check run', { statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }, /CI failed \(1\)/],
  ['failed status', { statusCheckRollup: [{ state: 'ERROR' }, { state: 'FAILURE' }] }, /CI failed \(2\)/],
  ['a cancelled run is no failure', { statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'CANCELLED' }] }, /#42 · Open/],
  ['conflicts win over CI', { mergeable: 'CONFLICTING', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }, /Merge conflicts/],
  ['merged', { state: 'MERGED' }, /Merged/],
  ['closed', { state: 'CLOSED' }, /Closed/],
]

for (const surface of ['desktop', 'terminal'] as const) {
  for (const [name, over, expected] of PR_CASES) {
    test(`PR state on ${surface}: ${name}`, async ($, on) => {
      const { ui } = await boot($, on, { pr: pr(over) }, surface)
      expect(await ui.find({ type: 'Text', text: expected })).toBeDefined()
      await ui.unmount()
    })
  }
}

test('no PR offers Create a PR, which runs the skill', async ($, on) => {
  const world: World = {}
  const { ui } = await boot($, on, world)
  await ui.press({ key: 'pr-create' })
  expect(world.ran).toBe('compound-engineering:ce-commit-push-pr')
  expect(await ui.find({ type: 'Text', text: /Creating PR/ })).toBeDefined()
  await ui.unmount()
})

test('Create a PR drops a running spotlight first', async ($, on) => {
  const world: World = { status: { active: true, mode: 'watch', worktree: 'feat' } }
  const { ui, calls } = await boot($, on, world)
  await ui.press({ key: 'pr-create' })
  expect(calls.some(c => c.argv.join(' ') === 'spotlight stop')).toBe(true)
  expect(world.ran).toBe('compound-engineering:ce-commit-push-pr')
  await ui.unmount()
})

test('a network failure keeps the band from offering Create a PR', async ($, on) => {
  const { ui } = await boot($, on, { prError: 'error connecting to api.github.com' })
  expect(await ui.find({ key: 'pr-create' })).toBeUndefined()
  await ui.unmount()
})

test('off offers Start, which watches with git in English', async ($, on) => {
  const world: World = {}
  const { ui, calls } = await boot($, on, world)
  await ui.press({ key: 'spotlight' })
  const sync = calls.find(c => c.argv.join(' ') === 'spotlight sync feat --detach')
  expect(sync?.env?.LC_ALL).toBe('C')
  await ui.unmount()
})

test('a broken symlink falls back to one sync', async ($, on) => {
  const { ui, calls } = await boot($, on, { broken: './docs/README.md\n' })
  await ui.press({ key: 'spotlight' })
  expect(calls.some(c => c.argv.join(' ') === 'spotlight sync feat --once')).toBe(true)
  expect(calls.some(c => c.argv.join(' ').includes('--detach'))).toBe(false)
  await ui.unmount()
})

test('a watcher that dies is undone', async ($, on) => {
  const { ui, calls } = await boot($, on, {
    mainOnBranch: true,
    log: 'Error: failed to watch directory: nope\n',
    subject: 'spotlight checkpoint',
  })
  await ui.press({ key: 'spotlight' })
  const lines = calls.map(c => c.argv.join(' '))
  expect(lines.some(l => l.startsWith('git checkout '))).toBe(true)
  expect(lines.some(l => l.startsWith('git reset --soft'))).toBe(true)
  await ui.unmount()
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`running shows the branch and Stop on ${surface}`, async ($, on) => {
    const { ui, calls } = await boot(
      $,
      on,
      { status: { active: true, mode: 'watch', worktree: 'feat' } },
      surface,
    )
    expect(await ui.find({ type: 'Text', text: /Spotlight feat/ })).toBeDefined()
    expect(await ui.find({ key: 'spotlight' })).toBeUndefined()
    await ui.press({ key: 'spotlight-stop' })
    expect(calls.some(c => c.argv.join(' ') === 'spotlight stop')).toBe(true)
    await ui.unmount()
  })
}

test('a press shows Starting… on the button while it works', async ($, on) => {
  const world: World = { log: 'nothing yet' }
  const { ui, clock } = await boot($, on, world)
  const press = ui.press({ key: 'spotlight' })
  await clock.settle()
  const busy = await ui.find({ key: 'spotlight' })
  expect(JSON.stringify(busy)).toContain('Starting…')
  world.log = 'Watching for changes...'
  await clock.advance(1000)
  await press
  await ui.unmount()
})

test('off names no branch', async ($, on) => {
  const { ui } = await boot($, on, {})
  expect(await ui.find({ key: 'spotlight' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^feat$/ })).toBeUndefined()
  await ui.unmount()
})

test('one sync says so and offers Stop', async ($, on) => {
  const { ui } = await boot($, on, { status: { active: true, mode: 'once', worktree: 'feat' } })
  expect(await ui.find({ type: 'Text', text: /Spotlight feat \(synced once\)/ })).toBeDefined()
  expect(await ui.find({ key: 'spotlight-stop' })).toBeDefined()
  await ui.unmount()
})

test('another worktree: press takes it over', async ($, on) => {
  const { ui, calls } = await boot($, on, {
    status: { active: true, mode: 'watch', worktree: 'other' },
  })
  expect(await ui.find({ type: 'Text', text: /on other/ })).toBeDefined()
  await ui.press({ key: 'spotlight' })
  const lines = calls.map(c => c.argv.join(' '))
  expect(lines).toContain('spotlight stop')
  expect(lines).toContain('spotlight sync feat --detach')
  await ui.unmount()
})

test('a crashed watcher restores on press', async ($, on) => {
  const { ui, calls } = await boot($, on, {
    status: { active: false, stale: true, mode: 'watch', worktree: 'feat' },
  })
  expect(await ui.find({ type: 'Text', text: /crashed/ })).toBeDefined()
  await ui.press({ key: 'spotlight' })
  expect(calls.some(c => c.argv.join(' ') === 'spotlight stop')).toBe(true)
  await ui.unmount()
})

test('an orphaned lock is removed, never stopped, then spotlight starts', async ($, on) => {
  const { ui, calls } = await boot($, on, {
    mainOnBranch: true,
    status: { active: true, mode: 'once', worktree: 'gone' },
  })
  await ui.press({ key: 'spotlight' })
  const lines = calls.map(c => c.argv.join(' '))
  expect(lines.some(l => /^rm \/home\/me\/\.spotlight\/locks\/repo-[0-9a-f]{8}\.lock$/.test(l))).toBe(true)
  expect(lines).not.toContain('spotlight stop')
  expect(lines).toContain('spotlight sync feat --detach')
  await ui.unmount()
})

test('a live watcher over a checkout on a branch is not an orphan', async ($, on) => {
  const { ui, calls } = await boot($, on, {
    mainOnBranch: true,
    status: { active: true, mode: 'watch', worktree: 'feat' },
  })
  await ui.press({ key: 'spotlight-stop' })
  const lines = calls.map(c => c.argv.join(' '))
  expect(lines.some(l => l.startsWith('rm '))).toBe(false)
  expect(lines).toContain('spotlight stop')
  await ui.unmount()
})

test('without the CLI the spotlight control is gone', async ($, on) => {
  const { ui } = await boot($, on, { status: null })
  expect(await ui.find({ key: 'spotlight' })).toBeUndefined()
  expect(await ui.find({ key: 'pr-create' })).toBeDefined()
  await ui.unmount()
})

test('the main checkout hides Start', async ($, on) => {
  const { ui } = await boot($, on, { cwd: MAIN })
  expect(await ui.find({ key: 'spotlight' })).toBeUndefined()
  await ui.unmount()
})
