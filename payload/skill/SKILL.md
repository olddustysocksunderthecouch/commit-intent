---
name: commit-intent
description: Capture the intent behind staged changes as a provenance doc in docs/intents/, extracted from the Claude Code and Cursor chats that produced the code. Use when the user asks to generate or preview an intent doc, capture commit intent, check why the pre-commit intent hook skipped or failed, or run its self-test.
---

# Commit intent docs

Every commit in this repo should carry a doc in `docs/intents/` recording *why* the change exists: the user's intent distilled from the AI chats that produced the staged code (primary), key decisions, and a skim of what was built. Generation runs automatically from the repo's pre-commit hook (wired by the commit-intent installer, fail-open) and the doc is staged into the same commit. This skill is the manual entry point to the same engine.

This directory is managed by the commit-intent installer — improvements belong in the commit-intent repo, not here.

## Commands

All via Bash, from the repo root:

```sh
# Preview: which chats match the currently staged files (no LLM call, no writes)
sh .claude/skills/commit-intent/scripts/generate.sh --dry-run

# Generate for real: writes docs/intents/<local-time>_<slug>.md and stages it
sh .claude/skills/commit-intent/scripts/generate.sh

# Source health check: are Claude Code transcripts and the Cursor DB readable?
sh .claude/skills/commit-intent/scripts/generate.sh --self-test

# Test with simulated staged files (bypasses the index; doc written but NOT staged)
sh .claude/skills/commit-intent/scripts/generate.sh --files=src/foo.ts,src/bar.ts
```

## Environment knobs

- `INTENT_MODEL` — model for the extraction call (default `sonnet`)
- `INTENT_SKIP=1` — skip generation for one commit (or use `git commit --no-verify`)
- `INTENT_TIMEOUT_MS` — LLM call timeout (default `90000`)
- `INTENT_CLAUDE_BIN` — path to the claude binary (default `~/.local/bin/claude`, then PATH)
- `INTENT_DEBUG=1` — verbose matching/scan diagnostics on stderr

## How it works

`scripts/collect.mjs` deterministically finds candidate chats — Claude Code session transcripts under `~/.claude/projects/` (matched by Edit/Write tool calls touching staged files, plus filename mentions) and Cursor composers in its global SQLite store (matched by filename mentions) — within a 14-day window. It builds a redacted, size-capped evidence bundle. `scripts/generate.mjs` then makes one headless `claude -p` call (no tools) to distill the doc, writes it with script-owned frontmatter (including `staged_diff_sha`, the dedupe key), and stages it.

## Behaviour notes for Claude

- When invoked as a skill, run `--dry-run` first and show the user the matched chats, then generate unless they object. After generating, offer to read the doc back and refine wording — edits are safe because `docs/intents/` is excluded from `staged_diff_sha`; re-stage the doc after editing.
- Skips are normal, not failures: nothing staged, no matching chats, the model judging every matched chat irrelevant (`SOURCES: none`), merge/rebase in progress, or an up-to-date doc already staged.
- If generation reports a failure, the commit still proceeds by design. Diagnose with `--self-test` and `INTENT_DEBUG=1`.
- Never run `generate.sh` in a loop or on unstaged work; it reads the index.
