export type SpotlightView =
  | { phase: 'hidden' }
  | { phase: 'off' }
  | { phase: 'busy'; label: string }
  | { phase: 'watching'; branch: string }
  | { phase: 'once'; branch: string }
  | { phase: 'other'; worktree: string; canSwitch: boolean }
  | { phase: 'crashed'; worktree: string }
  | { phase: 'orphaned'; worktree: string }

export type PrKind =
  | 'open'
  | 'pending'
  | 'draft'
  | 'conflicts'
  | 'failed'
  | 'merged'
  | 'closed'

export type PrView =
  | { phase: 'hidden' }
  | { phase: 'none' }
  | { phase: 'creating' }
  | { phase: 'found'; kind: PrKind; number: number; url: string; failing: number }

declare module 'claude-code' {
  interface PluginState {
    'spotlight-pr-band': { spotlight: SpotlightView; pr: PrView }
  }
}
