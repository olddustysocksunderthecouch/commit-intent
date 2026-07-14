# commit-intent

**A pre-commit hook that auto-writes a `why` doc for each commit by mining the Claude Code / Cursor chats that produced it.**

Git records *what* changed and *who* typed it. But when AI writes a 300-line diff nobody hand-typed, the reasoning — the ask, the edge cases, the corrections — never makes it into the repo. That's the newest kind of technical debt: not messy code, lost context. And the maddening part is the *why* isn't gone. It's sitting in chat logs on your disk right now; nothing just carries it forward.

`commit-intent` is the carrier. At commit time it matches the relevant session transcripts to your staged files and uses the Claude Code CLI you already have to distill the intent — how the ask evolved, the constraints, the key decisions and who made them — into `docs/intents/<timestamp>_<feature>.md`, staged into the same commit as the code it explains.

The *why* now travels with the *what*. Same repo, same commit — for future-you, for a teammate, for the next AI agent that has to work on the code.

No new platform, no new workflow: it runs on the tools and AI already on your machine. Hand-typed hotfixes match no chat and produce no doc, and `INTENT_SKIP=1` waves any commit through untouched.

> Useful? **[A star](https://github.com/olddustysocksunderthecouch/commit-intent/stargazers)** is how I know to keep building — [here's why that matters more than usual](#is-this-worth-expanding).

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

You just commit. It runs. There's nothing to remember from the get-go.

Everything below is optional — overrides and escape hatches worth knowing about, but not needed to use the tool:

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
- **A model-side relevance gate backstops the matcher**: filename matching deliberately over-collects, so the extractor both filters the cited sources and can decline entirely (`SOURCES: none`) — a commit whose matched chats turn out to be noise gets no doc, not a fabricated one.
- Evidence is size-capped, secret-redacted (key/token/JWT patterns), and user messages are prioritised over assistant output. The generator's own headless sessions are marker-excluded so it never matches itself.

## Privacy note

Intent docs quote and paraphrase your AI chats and are **committed to the repo**. The collector redacts common secret patterns and the prompt forbids reproducing credentials, but treat the feature as "chat excerpts become repo content" and make sure your team is comfortable with that. Skip any sensitive commit with `INTENT_SKIP=1`.

## Updating

Re-run the installer: `npx github:olddustysocksunderthecouch/commit-intent --update`. Pin a version with `npx github:olddustysocksunderthecouch/commit-intent#v0.2.0`.

## Is this worth expanding?

There's a small irony in shipping a provenance tool: `npx github:…` leaves me no trace of *your* intent. This repo has exactly the problem it solves — I can't tell the difference between "installed once, shrugged" and "quietly documenting every commit at three companies."

GitHub gives you one signal that costs a single click: **if commit-intent earned a place in your workflow, [star the repo](https://github.com/olddustysocksunderthecouch/commit-intent/stargazers)** ⭐. The star count is, literally, the input that decides how much gets built next.

Want to steer *what* gets built rather than just *whether*? [Open an issue](https://github.com/olddustysocksunderthecouch/commit-intent/issues/new) describing the one thing that would make this indispensable for your team — a real use case outranks any number of upvotes.

## Maintainers wanted

This started as a one-repo itch and works today, but the interesting version is bigger than one maintainer. If you'd like to co-own a piece of it, open an issue introducing yourself — or just arrive with a PR. Directions that need an owner:

- **Jira / Linear MCP integration** — enrich intent docs with the ticket behind the branch: acceptance criteria, discussion, and decision trail alongside the chat evidence.
- **More chat sources** — Windsurf, GitHub Copilot chat, Codex CLI, aider, Gemini CLI. Each is one self-contained collector in `payload/skill/scripts/collect.mjs` (see `scanCursor` for the shape: find candidates, extract user/assistant messages, return chats).
- **Auto-wiring for lefthook and the pre-commit framework** — today the installer prints instructions instead of editing YAML.
- **Windows support** — hook bootstrap and paths under Git Bash are currently best-effort.
- **Backfill** — generate intent docs for historical commits, commit hashes included.
- **npm publish + release automation** — when GitHub-only distribution outgrows itself.

The whole codebase is dependency-free Node — two scripts in `payload/`, one installer in `bin/` — and reads end to end in twenty minutes.

## License

MIT
