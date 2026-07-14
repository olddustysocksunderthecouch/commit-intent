# commit-intent

Every commit gets a provenance doc — the *why* behind the change, distilled from the AI chats that produced it.

When you commit, a pre-commit hook finds the Claude Code sessions and Cursor composers that plausibly produced your staged files, extracts the **user's intent** (what was asked, how it evolved, corrections, constraints), the **key decisions** and who made them, and a skim of what was built — then writes `docs/intents/<timestamp>_<feature>.md` and stages it into the same commit.

Months later, `git log` tells you *what* changed. `docs/intents/` tells you *why*.

## Install

Run inside the target repository:

```sh
npx github:olddustysocksunderthecouch/commit-intent
```

That's the whole thing. It copies the engine into `.claude/skills/commit-intent/`, wires your pre-commit hook (husky, custom `core.hooksPath`, bare `.git/hooks`, or bootstraps a versioned `.githooks/` if you have none), runs a self-test, and prints the suggested commit. Everything it installs is committed to the repo, so teammates get it via `git pull` — installation is per-repo, once.

## Requirements

- **git**, **node ≥ 20** on each committer's machine
- **[Claude Code](https://claude.com/claude-code) CLI** (`claude`), installed and authenticated — used for the extraction call at commit time. Without it, commits still work: generation fail-open skips.
- macOS or Linux (Windows is best-effort via Git Bash)
- Cursor is optional — its chats are read from its local database when present

## What a commit costs

One headless `claude -p` summarization call (~15–45 s, model configurable via `INTENT_MODEL`, default `sonnet`) — and only when chats actually match the staged files. No matches, merge/rebase commits, amend re-runs (deduped by a staged-diff hash), and `CI` environments all skip instantly. **Nothing ever blocks a commit**: every failure path is a warning.

## Day-to-day

```sh
INTENT_SKIP=1 git commit …    # skip one commit (or --no-verify)
sh .claude/skills/commit-intent/scripts/generate.sh --dry-run    # preview matched chats
sh .claude/skills/commit-intent/scripts/generate.sh --self-test  # source health check
```

Knobs: `INTENT_MODEL`, `INTENT_TIMEOUT_MS`, `INTENT_CLAUDE_BIN`, `INTENT_DEBUG=1`. In Claude Code, the repo gains a `/commit-intent` skill wrapping the same engine.

## Installer flags

| Flag | Effect |
|---|---|
| `--update` | overwrite locally modified payload files (how you take new versions) |
| `--check` | drift report vs this version; exit 1 on drift (CI-friendly) |
| `--uninstall` | remove payload + managed hook block; keeps generated docs |
| `--e2e` | attempt one real generation after install |
| `--agent` | let Claude wire the hook interactively when auto-wiring can't (lefthook, pre-commit framework, global hooksPath) |
| `--agent-verify` | let Claude verify the finished install and report |
| `--yes` | non-interactive |

No Claude Code on the machine but want an agent-led install? See [INSTALL-AGENT.md](INSTALL-AGENT.md) for a paste-into-any-agent flow.

## How matching works

- **Claude Code**: session transcripts under `~/.claude/projects/` for the repo. Strong signal: the session's Edit/Write tool calls touched a staged file. Weak signal: staged filenames mentioned in conversation. 14-day window, recency-boosted.
- **Cursor**: composers in Cursor's global SQLite store, matched by filename mentions in message text (read-only, lock-tolerant).
- Evidence is size-capped, secret-redacted (key/token/JWT patterns), and user messages are prioritised over assistant output. The generator's own headless sessions are marker-excluded so it never matches itself.

## Privacy note

Intent docs quote and paraphrase your AI chats and are **committed to the repo**. The collector redacts common secret patterns and the prompt forbids reproducing credentials, but treat the feature as "chat excerpts become repo content" and make sure your team is comfortable with that. Skip any sensitive commit with `INTENT_SKIP=1`.

## Updating

Re-run the installer: `npx github:olddustysocksunderthecouch/commit-intent --update`. Pin a version with `npx github:olddustysocksunderthecouch/commit-intent#v0.1.0`.

## License

MIT
