# Intent docs

Commit provenance, generated automatically. Each doc captures the *why* behind one commit, extracted from the AI chats (Claude Code and Cursor) that produced the staged changes: the user's intent as it evolved (primary), key decisions and who made them, a skim of what was built, and follow-ups.

## How they're made

The repo's pre-commit hook runs `.claude/skills/commit-intent/scripts/generate.sh`, which matches staged files against recent chat transcripts, distills them with one headless `claude -p` call, writes `docs/intents/<local-time>_<feature-slug>.md`, and stages it into the same commit. Fail-open: any problem (no chats matched, model timeout, missing binary) is a warning, never a blocked commit.

Frontmatter on each doc lists the source sessions, the files staged at generation time, and a `staged_diff_sha` used to avoid regenerating for the same staged tree (e.g. on `--amend`).

## Day-to-day

- Skip one commit: `INTENT_SKIP=1 git commit …` (or `--no-verify`, which skips all hooks).
- Preview matches: `sh .claude/skills/commit-intent/scripts/generate.sh --dry-run`
- Health check: `sh .claude/skills/commit-intent/scripts/generate.sh --self-test`
- Knobs: `INTENT_MODEL` (default `sonnet`), `INTENT_TIMEOUT_MS`, `INTENT_CLAUDE_BIN`, `INTENT_DEBUG=1`.
- In Claude Code, `/commit-intent` invokes the same engine interactively.

Known edge case: `git commit <paths>` (partial pathspec commit) uses a temporary index, so a freshly generated doc rides along with the *next* commit instead.

Installed and updated via the commit-intent installer (`npx github:olddustysocksunderthecouch/commit-intent`).
