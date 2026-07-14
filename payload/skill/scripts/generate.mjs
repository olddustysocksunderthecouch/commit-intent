// commit-intent orchestrator: guards → collect evidence → one headless claude
// call (text in, text out, no tools) → write doc → git add. Fail-open: every
// error path warns and exits 0 so a commit is never blocked.
// Managed by the commit-intent installer — edit in the commit-intent repo.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectEvidence, selfTest, GENERATOR_MARKER } from './collect.mjs';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEBUG = process.env.INTENT_DEBUG === '1';
const LOCKFILE_BASENAMES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'deno.lock', 'bun.lockb']);

const log = (m) => process.stderr.write(`commit-intent: ${m}\n`);
const debug = (m) => {
  if (DEBUG) log(m);
};

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts }).replace(/\n$/, '');
}

const p2 = (n) => String(n).padStart(2, '0');
// Colon-free local time: sortable, readable, safe on Windows checkouts.
function fileStamp(d) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
}
function isoWithOffset(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
    `T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}${sign}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`
  );
}
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
function yamlStr(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function runClaude(prompt) {
  const defaultBin = path.join(os.homedir(), '.local', 'bin', 'claude');
  const bin = process.env.INTENT_CLAUDE_BIN || (fs.existsSync(defaultBin) ? defaultBin : 'claude');
  const model = process.env.INTENT_MODEL || 'sonnet';
  const timeoutMs = parseInt(process.env.INTENT_TIMEOUT_MS || '90000', 10);
  // No tools needed, and --setting-sources ''/--strict-mcp-config keep the run
  // free of project MCP servers and plugins for a fast, side-effect-free start.
  const args = ['-p', '--model', model, '--output-format', 'text', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
  debug(`invoking ${bin} --model ${model} (timeout ${timeoutMs}ms, prompt ${(Buffer.byteLength(prompt) / 1024).toFixed(0)} KB)`);
  return new Promise((resolve, reject) => {
    // cwd = tmpdir so the generation run's own transcript is not saved under
    // this repo's project dir, where future collector runs would scan it.
    const child = spawn(bin, args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (fn, v) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(v);
      }
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`claude timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) =>
      code === 0 ? finish(resolve, out) : finish(reject, new Error(`claude exited ${code}: ${err.trim().slice(0, 300)}`)),
    );
    child.stdin.on('error', () => {});
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function parseOutput(raw, fallbackSlugSource) {
  let text = raw.trim();
  text = text.replace(/^```[a-z]*\s*\n/, '').replace(/\n```\s*$/, '');
  let slug = null;
  const m = text.match(/^\s*SLUG:\s*([A-Za-z0-9][A-Za-z0-9-]{0,60})\s*$/m);
  if (m) {
    slug = m[1].toLowerCase();
    text = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  }
  if (!slug) slug = slugify(fallbackSlugSource) || 'staged-changes';
  // The model may decline outright: `SOURCES: none` means it judged every
  // matched chat irrelevant to the staged changes, and no doc should exist.
  if (/^\s*SOURCES:\s*none\b/im.test(text)) {
    return { noMatch: true, slug, usedIndexes: null, body: '' };
  }
  let usedIndexes = null;
  const s = text.match(/^\s*SOURCES:\s*([0-9][0-9,\s]*)$/m);
  if (s) {
    usedIndexes = s[1].split(',').map((n) => parseInt(n.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
    text = (text.slice(0, s.index) + text.slice(s.index + s[0].length)).trim();
  }
  if (text.length < 200 || !/^##\s+Intent/m.test(text)) {
    if (DEBUG) {
      const dump = path.join(os.tmpdir(), `commit-intent-raw-${Date.now()}.txt`);
      fs.writeFileSync(dump, raw);
      log(`raw model output saved to ${dump}`);
    }
    throw new Error('model output failed validation (missing "## Intent" section or too short)');
  }
  return { slug, usedIndexes, body: text };
}

function frontmatter({ date, branch, head, stagedDiffSha, chats, files }) {
  const lines = [
    '---',
    `date: ${date}`,
    `branch: ${yamlStr(branch)}`,
    `head: ${head}`,
    `staged_diff_sha: ${stagedDiffSha}`,
    'sources:',
  ];
  for (const c of chats) {
    lines.push(`  - source: ${c.source}`, `    id: ${c.id}`, `    title: ${yamlStr(c.title || '')}`);
  }
  lines.push('files:');
  for (const f of files) lines.push(`  - ${yamlStr(f)}`);
  lines.push('---');
  return lines.join('\n') + '\n';
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const selfTestMode = argv.includes('--self-test');
  const filesArg = argv.find((a) => a.startsWith('--files='));

  const repoRoot = git(['rev-parse', '--show-toplevel']);
  process.chdir(repoRoot);

  if (selfTestMode) {
    await selfTest(repoRoot);
    return;
  }

  const gitDirRaw = git(['rev-parse', '--git-dir']);
  const gitDir = path.isAbsolute(gitDirRaw) ? gitDirRaw : path.join(repoRoot, gitDirRaw);
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply']) {
    if (fs.existsSync(path.join(gitDir, marker))) {
      log(`${marker} present; skipping intent doc`);
      return;
    }
  }

  const testMode = Boolean(filesArg);
  let stagedAll;
  let matchable;
  if (testMode) {
    matchable = filesArg.slice('--files='.length).split(',').map((s) => s.trim()).filter(Boolean);
    stagedAll = matchable;
    log(`test mode: simulating ${matchable.length} staged file(s); doc will not be git-added`);
  } else {
    stagedAll = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
    matchable = stagedAll.filter((f) => !f.startsWith('docs/intents/') && !LOCKFILE_BASENAMES.has(path.basename(f)));
  }
  if (!matchable.length) {
    log('nothing substantive staged; skipping intent doc');
    return;
  }

  let stagedDiffSha = 'test-mode';
  if (!testMode) {
    const diff = git(['diff', '--cached', '--', ':(exclude)docs/intents']);
    stagedDiffSha = createHash('sha256').update(diff).digest('hex').slice(0, 16);
    for (const f of stagedAll.filter((f) => f.startsWith('docs/intents/') && f.endsWith('.md'))) {
      let content = '';
      try {
        content = git(['show', `:${f}`]);
      } catch {
        continue;
      }
      if (content.includes(`staged_diff_sha: ${stagedDiffSha}`)) {
        log(`matching intent doc already staged (${f}); skipping`);
        return;
      }
    }
  }

  const evidence = await collectEvidence({ repoRoot, stagedFiles: matchable, debug });
  if (!evidence.chats.length) {
    log('no matching AI chats found for the staged changes; skipping intent doc');
    return;
  }

  let diffstat = matchable.join('\n');
  if (!testMode) {
    try {
      diffstat = git(['diff', '--cached', '--stat', '--', ':(exclude)docs/intents']);
    } catch {
      // fall back to the file list
    }
  }
  if (diffstat.length > 4000) diffstat = diffstat.slice(0, 4000) + '\n…[truncated]';

  let branch = 'unknown';
  try {
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {}
  let head = 'none';
  try {
    head = git(['rev-parse', '--short', 'HEAD']);
  } catch {}

  const now = new Date();
  const bundle = {
    repo: path.basename(repoRoot),
    branch,
    generatedAt: isoWithOffset(now),
    stagedFiles: matchable,
    diffstat,
    window: evidence.window,
    chats: evidence.chats.map((c, i) => ({ index: i + 1, ...c })),
  };

  const summary = evidence.chats
    .map((c) => {
      const users = c.messages.filter((m) => m.role === 'user').length;
      const edited = c.filesEdited.length ? `, edited ${c.filesEdited.length} repo file(s)` : '';
      return `  [${c.source}] ${c.title || '(untitled)'} — score ${c.score}, ${users} user / ${c.messages.length - users} assistant msgs${edited}`;
    })
    .join('\n');
  log(`matched ${evidence.chats.length} chat(s), evidence ${(Buffer.byteLength(JSON.stringify(bundle)) / 1024).toFixed(0)} KB:\n${summary}`);

  if (dryRun) {
    log(`dry run: would write docs/intents/${fileStamp(now)}_<slug>.md`);
    return;
  }

  const promptTemplate = fs.readFileSync(path.join(SKILL_DIR, 'prompt.md'), 'utf8');
  const prompt = `${promptTemplate}\n\n${GENERATOR_MARKER}\n${JSON.stringify(bundle, null, 1)}\n`;
  const raw = await runClaude(prompt);
  const { slug, usedIndexes, noMatch, body } = parseOutput(raw, branch);

  if (noMatch) {
    log(`model reviewed ${evidence.chats.length} matched chat(s) and judged none applicable to the staged changes; skipping intent doc`);
    return;
  }

  // The frontmatter lists only the chats the doc actually drew on; matched-but
  // -irrelevant chats stay out. If the SOURCES line is missing or garbled, keep
  // the full matched list — provenance must never be silently lost.
  let sourceChats = evidence.chats;
  if (usedIndexes) {
    const used = evidence.chats.filter((_, i) => usedIndexes.includes(i + 1));
    if (used.length) {
      sourceChats = used;
      if (used.length < evidence.chats.length) {
        log(`sources: doc cites ${used.length} of ${evidence.chats.length} matched chat(s); dropping the rest from frontmatter`);
      }
    } else {
      log('sources: SOURCES line matched no chats; keeping all matched chats in frontmatter');
    }
  }

  const doc =
    frontmatter({ date: isoWithOffset(now), branch, head, stagedDiffSha, chats: sourceChats, files: matchable }) + '\n' + body + '\n';

  fs.mkdirSync(path.join(repoRoot, 'docs', 'intents'), { recursive: true });
  let rel = `docs/intents/${fileStamp(now)}_${slug}.md`;
  if (fs.existsSync(path.join(repoRoot, rel))) rel = `docs/intents/${fileStamp(now)}_${slug}-2.md`;
  fs.writeFileSync(path.join(repoRoot, rel), doc);

  if (testMode) {
    console.log(`commit-intent: wrote ${rel} (test mode: not staged)`);
  } else {
    git(['add', '--', rel]);
    console.log(`commit-intent: wrote and staged ${rel}`);
  }
}

main().catch((e) => {
  log(`failed — commit proceeds without intent doc (${e.message})`);
  if (DEBUG && e.stack) process.stderr.write(e.stack + '\n');
  process.exitCode = 0;
});
