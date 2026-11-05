import { atom, read, update } from 'claude-code'
import type { ProcessRunInit, Register, RenderChildren } from 'claude-code'

import type { PrKind, PrView, SpotlightView } from '../types'

const CREATE_PR_COMMAND = 'compound-engineering:ce-commit-push-pr'
const TICK_MS = 5_000
const WATCHER_DEADLINE_MS = 45_000
const WATCHER_POLL_MS = 400
const CREATE_SETTLE_MS = 5_000
const PR_POLL_MS: Record<PrKind | 'none', number> = {
  pending: 20_000,
  conflicts: 60_000,
  failed: 60_000,
  draft: 60_000,
  open: 60_000,
  merged: 300_000,
  closed: 300_000,
  none: 120_000,
}

const spotlightAtom = atom({ plugin: 'spotlight-pr-band', key: 'spotlight' } as const, {
  phase: 'hidden',
})
const prAtom = atom({ plugin: 'spotlight-pr-band', key: 'pr' } as const, { phase: 'hidden' })

type Repo = {
  top: string
  main: string
  name: string
  isWorktree: boolean
  branch: string
  defaultBranch: string
}

type Status = {
  active?: boolean
  stale?: boolean
  mode?: string
  worktree?: string
}

type Check = { status?: string; conclusion?: string; state?: string }

type RawPr = {
  number: number
  url: string
  state: string
  isDraft: boolean
  mergeable: string
  mergeStateStatus: string
  statusCheckRollup: Check[] | null
}

type Actions = {
  tick: (isForced?: boolean) => Promise<void>
  toggleSpotlight: () => Promise<void>
  createPr: () => Promise<void>
}

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '')

const firstLine = (text: string) =>
  stripAnsi(text)
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length > 0) ?? ''

const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const FAILED_STATES = new Set(['FAILURE', 'ERROR'])
const PENDING_STATES = new Set(['PENDING', 'EXPECTED'])

const isFailed = (check: Check) =>
  FAILED_CONCLUSIONS.has(check.conclusion ?? '') || FAILED_STATES.has(check.state ?? '')

const isPending = (check: Check) =>
  check.status ? check.status !== 'COMPLETED' : PENDING_STATES.has(check.state ?? '')

const toPrView = (raw: RawPr): PrView => {
  const checks = raw.statusCheckRollup ?? []
  const failing = checks.filter(isFailed).length
  const found = { phase: 'found', number: raw.number, url: raw.url, failing } as const

  if (raw.state === 'MERGED') return { ...found, kind: 'merged' }
  if (raw.state === 'CLOSED') return { ...found, kind: 'closed' }
  if (raw.mergeable === 'CONFLICTING' || raw.mergeStateStatus === 'DIRTY') {
    return { ...found, kind: 'conflicts' }
  }
  if (failing > 0) return { ...found, kind: 'failed' }
  if (raw.isDraft) return { ...found, kind: 'draft' }
  if (checks.some(isPending)) return { ...found, kind: 'pending' }

  return { ...found, kind: 'open' }
}

const toSpotlightView = (
  repo: Repo,
  status: Status,
  isMainOnBranch: boolean,
): SpotlightView => {
  if (!status.active && !status.stale) {
    return repo.isWorktree ? { phase: 'off' } : { phase: 'hidden' }
  }

  const worktree = status.worktree ?? 'unknown'
  // A real sync holds the main checkout on a detached checkpoint, so a lock with
  // no live watcher over a checkout on a branch outlived its sync.
  if (isMainOnBranch && (status.stale || status.mode === 'once')) {
    return { phase: 'orphaned', worktree }
  }
  if (status.stale) return { phase: 'crashed', worktree }
  if (repo.isWorktree && worktree === repo.name) {
    return { phase: status.mode === 'once' ? 'once' : 'watching', branch: repo.branch }
  }

  return { phase: 'other', worktree, canSwitch: repo.isWorktree }
}

const lockPathFor = async (home: string, main: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(main))
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')

  return `${home}/.spotlight/locks/${basename(main)}-${hash.slice(0, 8)}.lock`
}

const BROKEN_SYMLINKS_FIND = [
  'find',
  '.',
  '(',
  '-name',
  '.git',
  '-o',
  '-name',
  'node_modules',
  ')',
  '-prune',
  '-o',
  '-type',
  'l',
  '!',
  '-exec',
  'test',
  '-e',
  '{}',
  ';',
  '-print',
]

export const register: Register = on => {
  let actions: Actions | null = null
  let isTurnRunning = false
  let isCreating = false

  on('session.start', async ($, e, next) => {
    let env: Record<string, string> | null = null
    let isTicking = false
    let isActing = false
    let isForceQueued = false
    let lastBranch = ''
    let roots: { top: string; main: string; defaultBranch: string } | null = null
    let prFetchedAt = 0
    let prFetchedFor = ''

    const putSpotlight = async (value: SpotlightView) => {
      if (JSON.stringify(await read($, spotlightAtom)) === JSON.stringify(value)) return
      await update($, spotlightAtom, () => value)
      $.ui.invalidate('ui.render')
    }

    const putPr = async (value: PrView) => {
      if (JSON.stringify(await read($, prAtom)) === JSON.stringify(value)) return
      await update($, prAtom, () => value)
      $.ui.invalidate('ui.render')
    }

    const envOf = async () => {
      if (env) return env
      const path = await $.env.get('PATH')
      const home = await $.env.get('HOME')
      env = {
        PATH: `${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${path ?? '/usr/bin:/bin'}`,
        // spotlight tells "nothing to stash" by git's English wording. Translated,
        // it records a stash it never made and `stop` pops someone else's entry.
        LC_ALL: 'C',
      }

      return env
    }

    const run = async (argv: readonly string[], init: ProcessRunInit = {}) => {
      try {
        return await $.process.run(argv, { ...init, env: await envOf() })
      } catch {
        return null
      }
    }

    const output = async (argv: readonly string[], init: ProcessRunInit = {}) => {
      const result = await run(argv, init)

      return result?.exitCode === 0 ? result.stdout.trim() : null
    }

    const resolveRepo = async (): Promise<Repo | null> => {
      const cwd = await $.session.cwd()
      const top = await output(['git', 'rev-parse', '--show-toplevel'], { cwd })
      if (top === null) return null

      if (roots?.top !== top) {
        const list = await output(['git', 'worktree', 'list', '--porcelain'], { cwd: top })
        const originHead = await output(
          ['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
          { cwd: top },
        )
        roots = {
          top,
          main: list?.match(/^worktree (.+)$/m)?.[1] ?? top,
          defaultBranch: originHead?.replace(/^origin\//, '') ?? '',
        }
      }

      const branch = await output(['git', 'branch', '--show-current'], { cwd: top })
      if (branch) lastBranch = branch

      return {
        top,
        main: roots.main,
        name: basename(top),
        isWorktree: top !== roots.main,
        branch: lastBranch,
        defaultBranch: roots.defaultBranch,
      }
    }

    const readStatus = async (repo: Repo): Promise<Status | null> => {
      const text = await output(['spotlight', 'status', '--json'], { cwd: repo.main })
      if (text === null) return null
      try {
        return JSON.parse(text) as Status
      } catch {
        return null
      }
    }

    const refreshSpotlight = async (repo: Repo) => {
      const status = await readStatus(repo)
      // Where the CLI is not installed there is nothing to press.
      if (status === null) return putSpotlight({ phase: 'hidden' })

      const head = await output(['git', 'symbolic-ref', '-q', 'HEAD'], { cwd: repo.main })
      await putSpotlight(toSpotlightView(repo, status, head !== null))
    }

    const refreshPr = async (repo: Repo, isForced: boolean) => {
      const isOnDefault =
        repo.branch === '' ||
        repo.branch === repo.defaultBranch ||
        (repo.defaultBranch === '' && /^(main|master)$/.test(repo.branch))
      if (isOnDefault) return putPr({ phase: 'hidden' })

      const current = await read($, prAtom)
      const now = await $.clock.now()
      const pollMs = PR_POLL_MS[current.phase === 'found' ? current.kind : 'none']
      const isDue = isForced || prFetchedFor !== repo.branch || now - prFetchedAt >= pollMs
      if (!isDue) return
      prFetchedAt = now
      prFetchedFor = repo.branch

      const result = await run(
        [
          'gh',
          'pr',
          'view',
          repo.branch,
          '--json',
          'number,url,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup',
        ],
        { cwd: repo.top, timeoutMs: 20_000 },
      )
      if (result === null) return

      if (result.exitCode === 0) {
        isCreating = false
        return putPr(toPrView(JSON.parse(result.stdout) as RawPr))
      }
      if (/no pull requests? found/i.test(result.stderr)) {
        return putPr(isCreating ? { phase: 'creating' } : { phase: 'none' })
      }
      if (/none of the git remotes|no git remotes|not a git repository/i.test(result.stderr)) {
        return putPr({ phase: 'hidden' })
      }
      // Anything else is the network or auth: keep what is drawn, so a blip never
      // turns an open PR into a "Create a PR" button.
    }

    const tick = async (isForced = false) => {
      if (isTicking) {
        isForceQueued = isForceQueued || isForced
        return
      }
      isTicking = true
      try {
        const repo = await resolveRepo()
        if (!repo) {
          await putSpotlight({ phase: 'hidden' })
          await putPr({ phase: 'hidden' })
          return
        }
        if (!isActing) await refreshSpotlight(repo)
        await refreshPr(repo, isForced)
      } finally {
        isTicking = false
        if (isForceQueued) {
          isForceQueued = false
          void tick(true)
        }
      }
    }

    const act = async (label: string, work: (repo: Repo) => Promise<void>) => {
      if (isActing) return
      const repo = await resolveRepo()
      if (!repo) return
      isActing = true
      await putSpotlight({ phase: 'busy', label })
      try {
        await work(repo)
      } finally {
        isActing = false
        await tick()
      }
    }

    const stopSync = async (repo: Repo) => {
      const result = await run(['spotlight', 'stop'], { cwd: repo.main, timeoutMs: 30_000 })
      if (result?.exitCode === 0) return true
      $.ui.toast(`Spotlight could not stop: ${firstLine(result?.stderr ?? 'it did not run')}`)

      return false
    }

    const waitForWatcher = async (logPath: string, offset: number) => {
      const deadline = (await $.clock.now()) + WATCHER_DEADLINE_MS

      return new Promise<string | null>(resolve => {
        const poll = async () => {
          const log = stripAnsi((await output(['tail', '-c', `+${offset + 1}`, logPath])) ?? '')
          const error = log.match(/^Error: (.+)$/m)?.[1]
          if (error) return resolve(error)
          if (log.includes('Watching for changes')) return resolve(null)
          // A very large worktree may still be walking; the ticks read the lock.
          if ((await $.clock.now()) > deadline) return resolve(null)
          $.clock.after(WATCHER_POLL_MS, () => void poll())
        }
        void poll()
      })
    }

    const startWatcher = async (repo: Repo) => {
      const home = (await $.env.get('HOME')) ?? ''
      const logPath = `${home}/.spotlight/${basename(repo.main)}-${repo.name}.log`
      const offset = Number.parseInt((await output(['wc', '-c', logPath])) ?? '0', 10) || 0
      const inMain = { cwd: repo.main }
      const mainRef =
        (await output(['git', 'symbolic-ref', '-q', '--short', 'HEAD'], inMain)) ??
        (await output(['git', 'rev-parse', 'HEAD'], inMain)) ??
        ''
      const worktreeHead = (await output(['git', 'rev-parse', 'HEAD'], { cwd: repo.top })) ?? ''
      const stashList = ['git', 'stash', 'list', '-1', '--format=%H']
      const stashTop = await output(stashList, inMain)

      const started = await run(['spotlight', 'sync', repo.name, '--detach'], inMain)
      if (started?.exitCode !== 0) {
        $.ui.toast(`Spotlight failed: ${firstLine(started?.stderr ?? 'it did not run')}`)
        return
      }

      const error = await waitForWatcher(logPath, offset)
      if (error === null) return

      // A watcher that fails after its first sync releases the lock but restores
      // nothing, so `spotlight stop` can no longer help: undo its steps here.
      await run(['git', 'checkout', mainRef], inMain)
      const subject = await output(['git', 'log', '-1', '--format=%s'], { cwd: repo.top })
      if (subject === 'spotlight checkpoint') {
        await run(['git', 'reset', '--soft', worktreeHead], { cwd: repo.top })
      }
      const stashAfter = await output(stashList, inMain)
      const stashNote =
        stashAfter && stashAfter !== stashTop
          ? ` Main's uncommitted changes are in stash ${stashAfter.slice(0, 10)}.`
          : ''
      $.ui.toast(`Spotlight failed and was undone: ${error}.${stashNote}`, { timeoutMs: 15_000 })
    }

    const startSync = async (repo: Repo) => {
      const found = await output(BROKEN_SYMLINKS_FIND, { cwd: repo.top, timeoutMs: 60_000 })
      const broken = (found ?? '').split('\n').filter(Boolean)
      if (broken.length === 0) return startWatcher(repo)

      // The watcher dies on a broken symlink and strands the main checkout, so
      // this worktree can only be synced by hand until the links are repaired.
      const result = await run(['spotlight', 'sync', repo.name, '--once'], {
        cwd: repo.main,
        timeoutMs: 120_000,
      })
      if (result?.exitCode !== 0) {
        $.ui.toast(`Spotlight failed: ${firstLine(result?.stderr ?? 'it did not run')}`)
        return
      }
      $.ui.toast(
        `Synced once: ${broken.length} broken symlink(s) stop the watcher (${broken[0]}). Stop and start it again to update.`,
        { timeoutMs: 10_000 },
      )
    }

    const restart = async (repo: Repo) => {
      if (await stopSync(repo)) await startSync(repo)
    }

    const createPr = async () => {
      isCreating = true
      await putPr({ phase: 'creating' })

      // The watcher amends HEAD and the next stop unwinds to the old head, so a
      // commit made over a checkpoint would be rewritten: drop the checkpoint first.
      const spotlight = await read($, spotlightAtom)
      if (spotlight.phase === 'watching' || spotlight.phase === 'once') {
        await act('Stopping…', async repo => {
          if (await stopSync(repo)) $.ui.toast('Spotlight stopped before committing.')
        })
      }

      try {
        await $.command.run({ command: CREATE_PR_COMMAND })
      } catch {
        try {
          await $.prompt.submit({ text: `/${CREATE_PR_COMMAND}`, asUser: true })
        } catch {
          isCreating = false
          await putPr({ phase: 'none' })
          $.ui.toast(`Could not run /${CREATE_PR_COMMAND}.`)
        }
      }
    }

    const clearOrphanedLock = async (repo: Repo) => {
      // Only the file goes: `spotlight stop` would force a checkout over main.
      const home = (await $.env.get('HOME')) ?? ''
      const path = await lockPathFor(home, repo.main)
      const result = await run(['rm', path])
      if (result?.exitCode === 0) return true
      $.ui.toast(`Could not clear the stale lock: ${firstLine(result?.stderr ?? path)}`)

      return false
    }

    const toggleSpotlight = async () => {
      const spotlight = await read($, spotlightAtom)
      switch (spotlight.phase) {
        case 'off':
          return act('Starting…', startSync)
        case 'orphaned':
          return act('Starting…', async repo => {
            if ((await clearOrphanedLock(repo)) && repo.isWorktree) await startSync(repo)
          })
        case 'other':
          return spotlight.canSwitch
            ? act('Switching…', restart)
            : act('Stopping…', async repo => {
                await stopSync(repo)
              })
        case 'watching':
        case 'once':
        case 'crashed':
          return act('Stopping…', async repo => {
            await stopSync(repo)
          })
      }
    }

    actions = {
      tick,
      createPr,
      toggleSpotlight,
    }

    const result = await next(e)
    void tick(true)
    $.clock.every(TICK_MS, () => void tick())

    return result
  })

  on('turn.start', ($, e, next) => {
    isTurnRunning = true

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    isTurnRunning = false
    const result = await next(e)
    void actions?.tick(true)
    if (isCreating) {
      // This turn may be the one the skill was queued behind: give it time to start.
      $.clock.after(CREATE_SETTLE_MS, () => {
        if (isTurnRunning) return
        isCreating = false
        void actions?.tick(true)
      })
    }

    return result
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    if (/\bgit\s+push\b|\bgh\s+pr\b/.test(e.command)) void actions?.tick(true)

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const spotlight = await read($, spotlightAtom)
    const pr = await read($, prAtom)
    if (e.props.hasSurvey || (spotlight.phase === 'hidden' && pr.phase === 'hidden')) {
      return next(e)
    }

    const table = $.ui.resolve(e)
    const { Box, Button, Link, Text } = table
    const Svg = 'Svg' in table ? table.Svg : null

    const icon = (name: IconName, tone: Tone) =>
      Svg ? (
        <Svg source={svgSource(name, tone)} alt={name} width={13} height={13} />
      ) : (
        <Text color={TONE_TEXT[tone]}>{GLYPHS[name]} </Text>
      )

    const label = (text: string, tone?: Tone) =>
      tone ? (
        <Text size="footnote" color={TONE_TEXT[tone]}>
          {text}
        </Text>
      ) : (
        <Text size="footnote" dimColor>
          {text}
        </Text>
      )

    const button = (key: string, text: string, onPress: () => void) => (
      <Button key={key} label={text} onPress={onPress}>
        <Text size="footnote">{text}</Text>
      </Button>
    )

    const spotlightPart = () => {
      switch (spotlight.phase) {
        case 'hidden':
          return null
        case 'busy':
          // Buttons have no disabled state; `act` already ignores a press while busy.
          return <Button key="spotlight" label={spotlight.label} dimColor onPress={() => {}} />
        case 'watching':
          return [
            Svg ? (
              <Svg source={RIPPLE_SVG} alt="Spotlight running" width={14} height={14} />
            ) : (
              <Text color={TONE_TEXT.success}>◉ </Text>
            ),
            <Text size="footnote" wrap="truncate-middle">
              Spotlight {spotlight.branch}
            </Text>,
            button('spotlight-stop', 'Stop', () => void actions?.toggleSpotlight()),
          ]
        case 'once':
          return [
            <Text size="footnote" wrap="truncate-middle">
              Spotlight {spotlight.branch} (synced once)
            </Text>,
            button('spotlight-stop', 'Stop', () => void actions?.toggleSpotlight()),
          ]
        case 'off':
        case 'orphaned':
        case 'other':
        case 'crashed': {
          const hover =
            spotlight.phase === 'other'
              ? `on ${spotlight.worktree}`
              : spotlight.phase === 'crashed'
                ? `crashed on ${spotlight.worktree}: press to restore`
                : null

          return (
            <Box key="spotlight-row" flexDirection="row" alignItems="center" gap="xs" minWidth={0}>
              {spotlight.phase === 'crashed' ? icon('alert', 'failed') : null}
              <Button
                key="spotlight"
                label="Spotlight"
                onPress={() => void actions?.toggleSpotlight()}
              />
              {hover ? (
                <Box display="none" hover={{ display: 'flex' }} flexShrink={1} minWidth={0}>
                  <Text size="footnote" dimColor wrap="truncate-middle">
                    {hover}
                  </Text>
                </Box>
              ) : null}
            </Box>
          )
        }
      }
    }

    const prPart = () => {
      switch (pr.phase) {
        case 'hidden':
          return null
        case 'none':
          return button('pr-create', 'Create a PR', () => void actions?.createPr())
        case 'creating':
          return label('Creating PR…')
        case 'found': {
          const style = PR_STYLES[pr.kind]
          const state = pr.kind === 'failed' ? `CI failed (${pr.failing})` : style.label

          return [
            icon(style.icon, style.tone),
            <Link href={pr.url}>{label(`#${pr.number} · ${state} ↗`, style.tone)}</Link>,
          ]
        }
      }
    }

    const part = (children: RenderChildren | undefined, shrink: number) =>
      children == null ? null : (
        <Box flexDirection="row" alignItems="center" gap="xs" flexShrink={shrink} minWidth={0}>
          {children}
        </Box>
      )

    return (
      <Box
        flexDirection="row"
        alignItems="center"
        justifyContent="space-between"
        gap="sm"
        width="100%"
      >
        {part(spotlightPart(), 1)}
        {part(prPart(), 0)}
      </Box>
    )
  })
}

type Tone = 'success' | 'failed' | 'conflicts' | 'pending' | 'merged' | 'neutral'

const TONE_TEXT: Record<Tone, string> = {
  success: 'success',
  failed: 'error',
  conflicts: '#db6d28',
  pending: 'warning',
  merged: 'merged',
  neutral: 'inactive',
}

const TONE_ICON: Record<Tone, string> = {
  success: '#3fb950',
  failed: '#f85149',
  conflicts: '#db6d28',
  pending: '#d29922',
  merged: '#a371f7',
  neutral: '#8b949e',
}

type IconName = 'alert' | 'pr' | 'draft' | 'closed' | 'merge' | 'cross' | 'clock'

const ICONS: Record<IconName, string> = {
  alert:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  pr: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/>',
  draft:
    '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M18 6V5"/><path d="M18 11v-1"/><path d="M6 9v12"/>',
  closed:
    '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M18 11.5V15"/><path d="m21 3-6 6"/><path d="m21 9-6-6"/><path d="M6 9v12"/>',
  merge:
    '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  cross: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
}

const GLYPHS: Record<IconName, string> = {
  alert: '⚠',
  pr: '●',
  draft: '○',
  closed: '⊘',
  merge: '✓',
  cross: '✗',
  clock: '◷',
}

const PR_STYLES: Record<PrKind, { label: string; tone: Tone; icon: IconName }> = {
  open: { label: 'Open', tone: 'success', icon: 'pr' },
  pending: { label: 'Checks running', tone: 'pending', icon: 'clock' },
  draft: { label: 'Draft', tone: 'neutral', icon: 'draft' },
  conflicts: { label: 'Merge conflicts', tone: 'conflicts', icon: 'alert' },
  failed: { label: 'CI failed', tone: 'failed', icon: 'cross' },
  merged: { label: 'Merged', tone: 'merged', icon: 'merge' },
  closed: { label: 'Closed', tone: 'neutral', icon: 'closed' },
}

// The ripple loader as SVG, since the band draws no CSS of its own: same 1 s
// curve, same half-second offset, 16/80 of the size with a heavier stroke.
const rippleRing = (begin: string) =>
  `<circle cx="8" cy="8" r="1" fill="none" stroke="${TONE_ICON.success}" stroke-width="1.2" opacity="0"><animate attributeName="r" dur="1s" begin="${begin}" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.05;1" values="1;1;7.4" keySplines="0 0 1 1;0 0.2 0.8 1"/><animate attributeName="opacity" dur="1s" begin="${begin}" repeatCount="indefinite" keyTimes="0;0.049;0.05;1" values="0;0;1;0"/></circle>`

const RIPPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${rippleRing('0s')}${rippleRing('-0.5s')}</svg>`

const svgSource = (name: IconName, tone: Tone) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${TONE_ICON[tone]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`
