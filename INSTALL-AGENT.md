# Agent-led installation

Instructions for an AI coding agent (Claude Code or similar) installing commit-intent into the current repository. A human can trigger this by pasting into their agent:

> Install commit-intent into this repo following https://github.com/olddustysocksunderthecouch/commit-intent/blob/main/INSTALL-AGENT.md

## Preferred path

If node ≥ 20 and network access are available, just run the deterministic installer and interpret its output:

```sh
npx github:olddustysocksunderthecouch/commit-intent --yes
```

Only fall back to the manual steps below if npx is unavailable or the installer reports it could not wire the hook.

## Manual steps

1. **Fetch the payload**: clone `https://github.com/olddustysocksunderthecouch/commit-intent` to a temp dir. Copy `payload/skill/` to `.claude/skills/commit-intent/` and `payload/docs-intents-README.md` to `docs/intents/README.md` in the target repo, byte-for-byte — do not adapt or rewrite payload files. Make `scripts/generate.sh` executable.
2. **Wire the hook**: arrange for the repo's pre-commit flow to run, on every commit and fail-open (it must never block a commit):
   ```sh
   sh .claude/skills/commit-intent/scripts/generate.sh || true
   ```
   Respect whatever hook manager the repo already uses (husky, lefthook, pre-commit framework, `core.hooksPath`, bare `.git/hooks`). If there is none, create a versioned `.githooks/pre-commit` and set `git config core.hooksPath .githooks`, noting that each clone needs that config once (a `"prepare"` script can automate it in JS repos).
3. **Verify**: run `sh .claude/skills/commit-intent/scripts/generate.sh --self-test` and confirm at least one chat source is readable. Confirm the hook file is reached on commit (e.g. inspect the hook chain — do not make a throwaway commit without asking).
4. **Report**: list the files you added, the hook file you modified, and the self-test result. Suggest the commit command; do not commit without being asked.

## Constraints

- Never edit files under `.claude/skills/commit-intent/` — they are managed by the installer; local edits are overwritten on update.
- The hook line must be fail-open (`|| true` or equivalent) in every hook manager.
- Do not run the generator against unstaged work; `--dry-run` and `--self-test` are the safe diagnostics.
