# Spotlight + PR band

A Claude Code mod that adds a small band above the prompt, for sessions working in a git worktree:

- **Spotlight** syncs the worktree into your main checkout with [spotlight](https://github.com/azranel/homebrew-spotlight), so you can run the app from there. While it runs, the band shows a loader, `Spotlight {branch}` and **Stop**.
- **The branch's PR**, with its state: open, checks running, draft, merge conflicts, CI failed, merged or closed. With no PR, it offers **Create a PR**, which runs `/compound-engineering:ce-commit-push-pr`.

## Install

At the prompt of a terminal session:

```
/plugin install spotlight-pr-band --marketplace chrishrmnn/spotlight-pr-mod
```

From a shell:

```bash
claude plugin install spotlight-pr-band --marketplace chrishrmnn/spotlight-pr-mod
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `chrishrmnn/spotlight-pr-mod`, then **Add plugin**.

## What it needs

| Tool | Without it |
|---|---|
| [`spotlight`](https://github.com/azranel/homebrew-spotlight) | The Spotlight button does not appear |
| [`gh`](https://cli.github.com/), signed in | The PR part stays hidden or out of date |
| The `compound-engineering` plugin | **Create a PR** sends the command as a plain prompt, which may not work |

## How Spotlight behaves here

- **Your main checkout changes.** Spotlight stashes its uncommitted changes and puts it on a detached checkpoint of the worktree until you stop.
- **Commit after stopping.** The watcher amends HEAD and stopping resets the branch to where it started, so a commit made during a spotlight gets rewritten. **Create a PR** stops the spotlight first; a commit you ask for in chat does not.
- **Broken symlinks stop the watcher.** spotlight's watcher dies on one and leaves the main checkout detached, so the mod syncs once instead and tells you which link is at fault. To pick up later changes, stop and start again.
- **Non-English git.** spotlight 0.3.0 reads git's English wording to tell whether it stashed anything. In another locale, `spotlight stop` can pop someone else's stash entry. The mod runs spotlight with `LC_ALL=C`, but running it by hand does not.
- **Leftover locks.** If spotlight left a lock behind and the main checkout is back on a branch, pressing **Spotlight** deletes the lock file and starts. It does not run `spotlight stop`, which would force a checkout over the main checkout.

## Limits

- The desktop app can hide the band at times, apparently while it shows its next-step box.
- On desktop, a press on a busy button does nothing, but buttons have no real disabled state.

## Tests

```bash
claude plugin test .
```
