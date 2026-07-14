#!/usr/bin/env node
// commit-intent installer.
// Copies the payload verbatim into the target repo, wires the pre-commit hook
// for the detected hook manager, and verifies. Deterministic by design — the
// optional --agent flags hand only the judgment-heavy edges to Claude.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAYLOAD_DIR = path.join(PKG_ROOT, 'payload');
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
const REPO_SLUG = (pkg.repository?.url || '').match(/github\.com[/:]([^/]+\/[^/.]+)/)?.[1] || 'olddustysocksunderthecouch/commit-intent';
const NPX_SPEC = `npx github:${REPO_SLUG}`;

const SKILL_TARGET = '.claude/skills/commit-intent';
const MAPPING = [
  { from: 'skill/SKILL.md', to: `${SKILL_TARGET}/SKILL.md` },
  { from: 'skill/prompt.md', to: `${SKILL_TARGET}/prompt.md` },
  { from: 'skill/scripts/collect.mjs', to: `${SKILL_TARGET}/scripts/collect.mjs` },
  { from: 'skill/scripts/generate.mjs', to: `${SKILL_TARGET}/scripts/generate.mjs` },
  { from: 'skill/scripts/generate.sh', to: `${SKILL_TARGET}/scripts/generate.sh`, executable: true },
  { from: 'docs-intents-README.md', to: 'docs/intents/README.md' },
];
const VERSION_FILE = `${SKILL_TARGET}/VERSION`;

const WIRE_LINE = 'sh .claude/skills/commit-intent/scripts/generate.sh || true';
const WIRE_SIGNATURE = 'commit-intent/scripts/generate.sh';
const MARKER_START = '# >>> commit-intent >>>';
const MARKER_END = '# <<< commit-intent <<<';
const HOOK_BLOCK = `${MARKER_START} managed block — \`${NPX_SPEC} --uninstall\` removes it\n${WIRE_LINE}\n${MARKER_END}\n`;

const log = (m) => console.log(m);
const warn = (m) => console.error(`! ${m}`);
const die = (m) => {
  console.error(`commit-intent: ${m}`);
  process.exit(1);
};
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const USAGE = `commit-intent installer v${pkg.version}

Installs AI-chat commit provenance into the current git repo: every commit gets
a docs/intents/ doc distilled from the Claude Code / Cursor chats behind it.

Usage: ${NPX_SPEC} [flags]     (run inside the target repository)

Flags:
  --update        overwrite locally modified payload files without prompting
  --yes           assume yes for all prompts (non-interactive install)
  --check         report drift between installed files and this version; exit 1 on drift
  --uninstall     remove payload + managed hook block (keeps generated intent docs)
  --e2e           after install, run one end-to-end generation attempt
  --agent         have Claude (interactive) wire the hook when auto-wiring can't
  --agent-verify  have Claude (interactive) verify the finished installation
  --help          this text
`;

function git(repoRoot, args, opts = {}) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', ...opts }).replace(/\n$/, '');
}

function readIf(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function resolveClaude() {
  if (process.env.INTENT_CLAUDE_BIN) return process.env.INTENT_CLAUDE_BIN;
  const local = path.join(os.homedir(), '.local', 'bin', 'claude');
  if (fs.existsSync(local)) return local;
  const found = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
  const p = (found.stdout || '').trim();
  return found.status === 0 && p ? p : null;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve(a.trim()))));
}

function fileStatuses(repoRoot) {
  return MAPPING.map((m) => {
    const src = fs.readFileSync(path.join(PAYLOAD_DIR, m.from));
    const destPath = path.join(repoRoot, m.to);
    let status = 'new';
    if (fs.existsSync(destPath)) {
      status = src.equals(fs.readFileSync(destPath)) ? 'unchanged' : 'changed';
    }
    return { ...m, status };
  });
}

// ---------- wiring ----------

function hookCandidates(repoRoot, hooksPath) {
  const rels = ['.husky/pre-commit', '.githooks/pre-commit', '.git/hooks/pre-commit', 'lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.pre-commit-config.yaml'];
  if (hooksPath) rels.push(path.join(hooksPath, 'pre-commit'));
  return [...new Set(rels)];
}

function appendHookBlock(repoRoot, relFile, { shebang }) {
  const abs = path.join(repoRoot, relFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const existing = readIf(abs);
  if (existing === null) {
    fs.writeFileSync(abs, (shebang ? '#!/bin/sh\n\n' : '') + HOOK_BLOCK);
  } else {
    const sep = existing.endsWith('\n') ? '\n' : '\n\n';
    fs.writeFileSync(abs, existing + sep + HOOK_BLOCK);
  }
  if (shebang) fs.chmodSync(abs, 0o755);
}

function wireHook(repoRoot, repoSlugForMsgs) {
  let hooksPath = '';
  try {
    hooksPath = git(repoRoot, ['config', 'core.hooksPath']);
  } catch {
    // not set
  }

  for (const rel of hookCandidates(repoRoot, hooksPath)) {
    const content = readIf(path.resolve(repoRoot, rel));
    if (content !== null && content.includes(WIRE_SIGNATURE)) {
      return { mode: 'already-wired', file: rel };
    }
  }

  if (fs.existsSync(path.join(repoRoot, '.husky')) && fs.statSync(path.join(repoRoot, '.husky')).isDirectory()) {
    appendHookBlock(repoRoot, '.husky/pre-commit', { shebang: false });
    return { mode: 'husky', file: '.husky/pre-commit' };
  }

  if (hooksPath && !hooksPath.includes('.husky')) {
    const abs = path.resolve(repoRoot, hooksPath);
    if (!abs.startsWith(repoRoot + path.sep) && abs !== repoRoot) {
      return {
        mode: 'manual',
        reason: `core.hooksPath points outside the repo (${hooksPath}) — wiring a shared hooks dir would affect other repos`,
        instructions: `Add this line to ${hooksPath}/pre-commit yourself:\n    ${WIRE_LINE}`,
      };
    }
    const rel = path.join(hooksPath, 'pre-commit');
    const shebang = readIf(path.join(repoRoot, rel)) === null;
    appendHookBlock(repoRoot, rel, { shebang });
    return { mode: 'hooksPath', file: rel };
  }

  for (const lf of ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml']) {
    if (fs.existsSync(path.join(repoRoot, lf))) {
      return {
        mode: 'manual',
        reason: `lefthook config detected (${lf}) — YAML is not edited automatically`,
        instructions: `Add to ${lf}:\n    pre-commit:\n      commands:\n        commit-intent:\n          run: ${WIRE_LINE}\nThen run: lefthook install`,
      };
    }
  }

  if (fs.existsSync(path.join(repoRoot, '.pre-commit-config.yaml'))) {
    return {
      mode: 'manual',
      reason: 'pre-commit framework detected — YAML is not edited automatically',
      instructions: `Add to .pre-commit-config.yaml:\n    - repo: local\n      hooks:\n        - id: commit-intent\n          name: commit-intent\n          entry: sh .claude/skills/commit-intent/scripts/generate.sh\n          language: system\n          always_run: true\n          pass_filenames: false`,
    };
  }

  if (fs.existsSync(path.join(repoRoot, '.git/hooks/pre-commit'))) {
    appendHookBlock(repoRoot, '.git/hooks/pre-commit', { shebang: false });
    fs.chmodSync(path.join(repoRoot, '.git/hooks/pre-commit'), 0o755);
    return {
      mode: 'git-hooks',
      file: '.git/hooks/pre-commit',
      note: '.git/hooks is not versioned — other clones must re-run the installer',
    };
  }

  appendHookBlock(repoRoot, '.githooks/pre-commit', { shebang: true });
  git(repoRoot, ['config', 'core.hooksPath', '.githooks']);
  const hasPackageJson = fs.existsSync(path.join(repoRoot, 'package.json'));
  return {
    mode: 'githooks-bootstrap',
    file: '.githooks/pre-commit',
    note:
      'created versioned .githooks/ and set core.hooksPath for this clone.\n' +
      (hasPackageJson
        ? `  Other clones arm it automatically if you add to package.json scripts:\n    "prepare": "git config core.hooksPath .githooks"`
        : '  Other clones must run once: git config core.hooksPath .githooks'),
  };
}

// ---------- commands ----------

function doCheck(repoRoot) {
  const st = fileStatuses(repoRoot);
  const version = readIf(path.join(repoRoot, VERSION_FILE));
  log(`installed version info: ${version ? version.split('\n')[0] : '(no VERSION file)'} — this installer: v${pkg.version}`);
  let drift = false;
  for (const f of st) {
    const mark = f.status === 'unchanged' ? '=' : f.status === 'new' ? 'MISSING' : 'DRIFT';
    if (f.status !== 'unchanged') drift = true;
    log(`  [${mark}] ${f.to}`);
  }
  log(drift ? 'drift detected — run with --update to sync' : 'installed files match this version');
  process.exit(drift ? 1 : 0);
}

function doUninstall(repoRoot) {
  const blockRe = new RegExp(`\\n?${rx(MARKER_START)}[^\\n]*\\n[\\s\\S]*?${rx(MARKER_END)}\\n?`, 'g');
  let hooksPath = '';
  try {
    hooksPath = git(repoRoot, ['config', 'core.hooksPath']);
  } catch {}
  for (const rel of hookCandidates(repoRoot, hooksPath)) {
    const abs = path.resolve(repoRoot, rel);
    const content = readIf(abs);
    if (content === null) continue;
    if (blockRe.test(content)) {
      const cleaned = content.replace(blockRe, '\n');
      if (rel === '.githooks/pre-commit' && cleaned.replace(/#!\/bin\/sh/, '').trim() === '') {
        fs.rmSync(abs);
        if (hooksPath === '.githooks') {
          try {
            git(repoRoot, ['config', '--unset', 'core.hooksPath']);
          } catch {}
        }
        try {
          fs.rmdirSync(path.dirname(abs));
        } catch {}
        log(`removed ${rel} (was created by the installer)`);
      } else {
        fs.writeFileSync(abs, cleaned);
        log(`removed managed block from ${rel}`);
      }
    } else if (content.includes(WIRE_SIGNATURE)) {
      warn(`${rel} references commit-intent outside a managed block — remove that line manually`);
    }
    blockRe.lastIndex = 0;
  }

  const skillAbs = path.join(repoRoot, SKILL_TARGET);
  if (fs.existsSync(skillAbs)) {
    fs.rmSync(skillAbs, { recursive: true, force: true });
    log(`removed ${SKILL_TARGET}/`);
  }
  const readmeAbs = path.join(repoRoot, 'docs/intents/README.md');
  const payloadReadme = fs.readFileSync(path.join(PAYLOAD_DIR, 'docs-intents-README.md'));
  if (fs.existsSync(readmeAbs) && payloadReadme.equals(fs.readFileSync(readmeAbs))) {
    fs.rmSync(readmeAbs);
    log('removed docs/intents/README.md');
  }
  log('done. Generated intent docs in docs/intents/ were kept.');
}

async function doInstall(repoRoot, flags) {
  log(`commit-intent installer v${pkg.version} → ${repoRoot}`);
  if (process.platform === 'win32') warn('Windows is best-effort: hooks need Git Bash; paths are untested');

  const claudeBin = resolveClaude();
  if (!claudeBin) {
    warn('claude CLI not found — install & authenticate Claude Code, or generation will fail-open skip on every commit');
  }

  const st = fileStatuses(repoRoot);
  const changed = st.filter((f) => f.status === 'changed');
  if (changed.length && !flags.update && !flags.yes) {
    for (const f of changed) log(`  locally modified: ${f.to}`);
    if (process.stdin.isTTY) {
      const a = await ask(`overwrite ${changed.length} locally modified file(s)? [y/N] `);
      if (!/^y(es)?$/i.test(a)) die('aborted — re-run with --update to overwrite, or --check to inspect drift');
    } else {
      die('locally modified files present — re-run with --update to overwrite (or --check to inspect)');
    }
  }

  for (const f of st) {
    const dest = path.join(repoRoot, f.to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(PAYLOAD_DIR, f.from), dest);
    if (f.executable) fs.chmodSync(dest, 0o755);
    log(`  [${f.status === 'unchanged' ? '=' : f.status === 'new' ? '+' : '~'}] ${f.to}`);
  }
  fs.writeFileSync(
    path.join(repoRoot, VERSION_FILE),
    `${pkg.version}\ninstalled: ${new Date().toISOString()}\nsource: ${NPX_SPEC}\n`,
  );

  const wiring = wireHook(repoRoot, REPO_SLUG);
  if (wiring.mode === 'already-wired') {
    log(`hook: already wired via ${wiring.file} — left untouched`);
  } else if (wiring.mode === 'manual') {
    warn(`hook NOT wired automatically: ${wiring.reason}`);
    log(wiring.instructions);
    if (flags.agent) {
      runAgent(repoRoot, claudeBin, wiringPrompt(wiring));
    } else {
      log(`(or re-run with --agent to let Claude wire it interactively)`);
    }
  } else {
    log(`hook: wired via ${wiring.file} (${wiring.mode})`);
    if (wiring.note) log(`  note: ${wiring.note}`);
  }

  log('\nverify — running self-test:');
  const selfTest = spawnSync('sh', [path.join(repoRoot, SKILL_TARGET, 'scripts/generate.sh'), '--self-test'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  process.stdout.write((selfTest.stdout || '').replace(/^/gm, '  '));
  process.stderr.write((selfTest.stderr || '').replace(/^/gm, '  '));
  if (selfTest.status !== 0) warn('self-test exited non-zero — generation may skip until resolved (commits are never blocked)');

  if (flags.e2e) {
    let sample = 'package.json';
    try {
      sample = git(repoRoot, ['ls-files']).split('\n')[0] || sample;
    } catch {}
    log(`\ne2e — attempting one real generation (match target: ${sample}):`);
    const e2e = spawnSync('sh', [path.join(repoRoot, SKILL_TARGET, 'scripts/generate.sh'), `--files=${sample}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    process.stdout.write((e2e.stdout || '').replace(/^/gm, '  '));
    process.stderr.write((e2e.stderr || '').replace(/^/gm, '  '));
    log('  (a "no matching AI chats" result still proves the pipeline runs end to end)');
  }

  if (flags.agentVerify) runAgent(repoRoot, claudeBin, verifyPrompt());

  log('\nnext steps:');
  const toCommit = ['.claude/skills/commit-intent', 'docs/intents/README.md'];
  if (wiring.file && !wiring.file.startsWith('.git/')) toCommit.push(wiring.file);
  log(`  git add ${toCommit.join(' ')}`);
  log(`  git commit -m "chore: add commit-intent provenance docs"`);
  log(`  (that first commit will generate its own intent doc — skip any commit with INTENT_SKIP=1)`);
}

function wiringPrompt(wiring) {
  return (
    `The commit-intent payload is installed at .claude/skills/commit-intent (read its SKILL.md for context). ` +
    `Automatic hook wiring was skipped: ${wiring.reason}. ` +
    `Wire this command into the repo's pre-commit flow so it runs on every commit, fail-open (it must never block a commit): ${WIRE_LINE} ` +
    `Then run "sh .claude/skills/commit-intent/scripts/generate.sh --self-test" and summarize what you changed.`
  );
}

function verifyPrompt() {
  return (
    `Verify the commit-intent installation in this repo without making changes unless something is clearly broken: ` +
    `1) payload files present under .claude/skills/commit-intent, 2) the repo's pre-commit flow reaches scripts/generate.sh and is fail-open, ` +
    `3) run "sh .claude/skills/commit-intent/scripts/generate.sh --self-test" and interpret the output, ` +
    `4) report a short verdict with any issues and exact fixes.`
  );
}

function runAgent(repoRoot, claudeBin, prompt) {
  if (!claudeBin) {
    warn('--agent requested but no claude CLI found');
    return;
  }
  log('\nlaunching Claude interactively — approve or reject its changes as it works:');
  const res = spawnSync(claudeBin, [prompt], { cwd: repoRoot, stdio: 'inherit' });
  if (res.error) warn(`could not launch claude: ${res.error.message}`);
}

// ---------- entry ----------

async function main() {
  const argv = new Set(process.argv.slice(2));
  if (argv.has('--help') || argv.has('-h')) {
    log(USAGE);
    return;
  }
  const major = parseInt(process.versions.node, 10);
  if (major < 20) die(`node >= 20 required (running ${process.versions.node})`);

  let repoRoot;
  try {
    repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    die('not inside a git repository — cd into the target repo first');
  }

  if (argv.has('--check')) return doCheck(repoRoot);
  if (argv.has('--uninstall')) return doUninstall(repoRoot);
  await doInstall(repoRoot, {
    yes: argv.has('--yes'),
    update: argv.has('--update'),
    e2e: argv.has('--e2e'),
    agent: argv.has('--agent'),
    agentVerify: argv.has('--agent-verify'),
  });
}

main().catch((e) => die(e.message));
