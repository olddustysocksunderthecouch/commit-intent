// Deterministic evidence collector for commit-intent docs.
// Managed by the commit-intent installer — edit in the commit-intent repo.
// Finds the Claude Code and Cursor chats that plausibly produced the staged
// files and distills them into a bounded JSON bundle. No LLM calls here.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const WINDOW_DAYS = 14;
const RECENCY_BOOST = 2;
const MAX_CHATS = 6;
const MAX_MESSAGES_PER_CHAT = 40;
const MAX_USER_TEXT = 4000;
const MAX_ASSISTANT_TEXT = 400;
const MAX_BUNDLE_BYTES = 200_000;
const MAX_CURSOR_COMPOSERS_SCANNED = 800;
const MAX_CURSOR_CANDIDATES = 60;

function resolveSqlite() {
  for (const cand of ['/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3', '/usr/local/bin/sqlite3']) {
    if (fs.existsSync(cand)) return cand;
  }
  return 'sqlite3';
}
const SQLITE_BIN = resolveSqlite();

// Present in every prompt our own headless generator sends; sessions containing
// it are generation runs, not real work chats, and must never match themselves.
export const GENERATOR_MARKER = '=== EVIDENCE (JSON) ===';

// Basenames too common (Next.js conventions etc.) to be a meaningful text match
// on their own; these fall back to a parentDir/basename token.
const GENERIC_BASENAMES = new Set([
  'page.tsx', 'page.ts', 'layout.tsx', 'layout.ts', 'route.ts', 'route.tsx',
  'loading.tsx', 'error.tsx', 'not-found.tsx', 'template.tsx', 'default.tsx',
  'index.ts', 'index.tsx', 'index.js', 'index.mjs', 'types.ts', 'utils.ts',
  'constants.ts', 'config.ts', 'actions.ts', 'middleware.ts', 'globals.css',
  'README.md', 'SKILL.md', 'package.json', 'tsconfig.json',
]);

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN[A-Z ]{0,30}PRIVATE KEY-----[\s\S]*?-----END[A-Z ]{0,30}PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{15,}/g,
];
const SECRET_KV =
  /\b(password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|service[_-]?role[_-]?key|authorization)\b(\s*[:=]\s*)(["']?)[^\s"'<>]{6,}/gi;

export function redact(text) {
  let s = text;
  for (const re of SECRET_PATTERNS) s = s.replace(re, '[REDACTED]');
  s = s.replace(SECRET_KV, (_m, key, sep, quote) => `${key}${sep}${quote}[REDACTED]`);
  return s;
}

function buildTokens(stagedFiles) {
  const map = new Map();
  for (const f of stagedFiles) {
    const tokens = new Set([f.toLowerCase()]);
    const base = path.basename(f);
    if (!GENERIC_BASENAMES.has(base)) {
      tokens.add(base.toLowerCase());
      const stem = base.replace(/\.[^.]+$/, '');
      if (stem.length >= 6) tokens.add(stem.toLowerCase());
    } else {
      const parent = path.basename(path.dirname(f));
      if (parent && parent !== '.') tokens.add(`${parent}/${base}`.toLowerCase());
    }
    map.set(f, [...tokens]);
  }
  return map;
}

function scoreChat(chat, tokensByFile, repoRoot) {
  let strong = 0;
  const stagedSet = new Set(tokensByFile.keys());
  for (const abs of chat.filesTouched) {
    if (typeof abs !== 'string' || !abs.startsWith(repoRoot + path.sep)) continue;
    if (stagedSet.has(path.relative(repoRoot, abs))) strong++;
  }
  let hay = chat.title ? chat.title + '\n' : '';
  for (const m of chat.messages) {
    if (hay.length > 4_000_000) break;
    hay += m.text + '\n';
  }
  const hayLower = hay.toLowerCase();
  let weak = 0;
  for (const tokens of tokensByFile.values()) {
    if (tokens.some((t) => hayLower.includes(t))) weak++;
  }
  return { strong, weak, score: strong * 3 + weak };
}

function clip(text, max) {
  if (text.length <= max) return text;
  if (max >= 1500) return text.slice(0, max - 520) + '\n…[trimmed]…\n' + text.slice(-500);
  return text.slice(0, max) + '…';
}

function trimMessages(messages, windowStartMs) {
  const firstUser = messages.find((m) => m.role === 'user');
  let msgs = messages.filter((m) => {
    const t = m.ts ? Date.parse(m.ts) : NaN;
    return Number.isNaN(t) || t >= windowStartMs;
  });
  // The opening message usually states the goal — keep it even if pre-window.
  if (firstUser && !msgs.includes(firstUser)) msgs = [firstUser, ...msgs];

  const merged = [];
  for (const m of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === 'assistant' && m.role === 'assistant') last.text += '\n' + m.text;
    else merged.push({ ...m });
  }

  let out = merged.map((m) => ({
    ts: m.ts || null,
    role: m.role,
    text: clip(redact(m.text.slice(0, 1_000_000)), m.role === 'user' ? MAX_USER_TEXT : MAX_ASSISTANT_TEXT),
  }));

  while (out.length > MAX_MESSAGES_PER_CHAT) {
    const idx = out.findIndex((m) => m.role === 'assistant');
    if (idx === -1) break;
    out.splice(idx, 1);
  }
  if (out.length > MAX_MESSAGES_PER_CHAT) out = [out[0], ...out.slice(-(MAX_MESSAGES_PER_CHAT - 1))];
  return out;
}

function shrinkToBudget(chats) {
  const over = () => Buffer.byteLength(JSON.stringify(chats)) > MAX_BUNDLE_BYTES;
  for (let i = chats.length - 1; i >= 0 && over(); i--) {
    chats[i].messages = chats[i].messages.filter((m) => m.role === 'user');
  }
  while (chats.length > 1 && over()) chats.pop();
  const last = chats[0];
  while (last && last.messages.length > 5 && over()) last.messages.splice(1, 1);
}

// ---------- Claude Code ----------

function encodeProjectDir(p) {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

function extractUserText(content) {
  let t = '';
  if (typeof content === 'string') t = content;
  else if (Array.isArray(content)) {
    t = content.filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('\n');
  }
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!t) return null;
  if (/^<(command-message|command-name|local-command-stdout)/.test(t)) return null;
  if (t.startsWith('[Request interrupted')) return null;
  if (t.startsWith('This session is being continued from a previous')) return null;
  return t;
}

async function parseClaudeSession(file, sessionId) {
  const chat = {
    source: 'claude-code',
    id: sessionId,
    title: null,
    messages: [],
    filesTouched: new Set(),
    isGenerator: false,
  };
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type === 'ai-title') {
      if (j.aiTitle) chat.title = j.aiTitle;
      continue;
    }
    if (j.type === 'summary') {
      if (!chat.title && j.summary) chat.title = j.summary;
      continue;
    }
    if (j.type === 'user') {
      // Sidechain (subagent) prompts are agent-authored, not the human's words.
      if (j.isSidechain || j.isMeta) continue;
      const text = extractUserText(j.message?.content);
      if (!text) continue;
      if (text.includes(GENERATOR_MARKER)) {
        chat.isGenerator = true;
        rl.close();
        break;
      }
      chat.messages.push({ ts: j.timestamp || null, role: 'user', text });
    } else if (j.type === 'assistant') {
      const content = j.message?.content;
      if (!Array.isArray(content)) continue;
      const texts = [];
      for (const b of content) {
        if (b?.type === 'text' && b.text) texts.push(b.text);
        else if (b?.type === 'tool_use' && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(b.name)) {
          // Files edited by subagents still belong to this session, so harvest
          // file paths from sidechain lines too — only their text is excluded.
          const fp = b.input?.file_path || b.input?.notebook_path;
          if (typeof fp === 'string') chat.filesTouched.add(fp);
        }
      }
      if (texts.length && !j.isSidechain) {
        chat.messages.push({ ts: j.timestamp || null, role: 'assistant', text: texts.join('\n') });
      }
    }
  }
  return chat;
}

function claudeSessionFiles(repoRoot) {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsRoot)) return [];
  const encoded = encodeProjectDir(repoRoot);
  const files = [];
  for (const dir of fs.readdirSync(projectsRoot)) {
    if (dir !== encoded && !dir.startsWith(encoded + '-')) continue;
    const abs = path.join(projectsRoot, dir);
    let entries;
    try {
      entries = fs.readdirSync(abs);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(abs, name);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.isFile()) files.push({ file, mtimeMs: st.mtimeMs });
    }
  }
  return files;
}

async function scanClaudeCode({ repoRoot, windowStartMs, debug }) {
  const chats = [];
  const candidates = claudeSessionFiles(repoRoot).filter((f) => f.mtimeMs >= windowStartMs);
  debug(`claude-code: ${candidates.length} session(s) in window`);
  for (const { file } of candidates) {
    try {
      const chat = await parseClaudeSession(file, path.basename(file, '.jsonl'));
      if (!chat.isGenerator && chat.messages.some((m) => m.role === 'user')) chats.push(chat);
    } catch (e) {
      debug(`claude-code: failed to parse ${path.basename(file)}: ${e.message}`);
    }
  }
  return chats;
}

// ---------- Cursor ----------

function cursorDbPath() {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
}

function sqliteJson(db, sql) {
  const out = execFileSync(SQLITE_BIN, ['-readonly', '-json', '-cmd', '.timeout 3000', db, sql], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const trimmed = out.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

function cursorTs(v) {
  if (typeof v === 'number') return new Date(v).toISOString();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return null;
}

function scanCursor({ windowStartMs, debug }) {
  const db = cursorDbPath();
  if (!fs.existsSync(db)) {
    debug('cursor: db not found; skipping');
    return [];
  }
  // Key-range predicates (not LIKE) so the primary-key index is used; the DB is
  // multi-GB and shared with a possibly-running Cursor, so reads stay read-only.
  const composers = sqliteJson(
    db,
    `SELECT key,
            json_extract(value,'$.name') AS name,
            json_extract(value,'$.createdAt') AS createdAt,
            json_extract(value,'$.lastUpdatedAt') AS lastUpdatedAt
     FROM cursorDiskKV
     WHERE key >= 'composerData:' AND key < 'composerData;'
     ORDER BY rowid DESC LIMIT ${MAX_CURSOR_COMPOSERS_SCANNED}`,
  );
  const candidates = composers
    .filter((c) => {
      const ts = c.lastUpdatedAt ?? c.createdAt;
      return typeof ts === 'number' && ts >= windowStartMs;
    })
    .slice(0, MAX_CURSOR_CANDIDATES);
  debug(`cursor: ${candidates.length} composer(s) in window`);

  const chats = [];
  for (const c of candidates) {
    const cid = c.key.slice('composerData:'.length);
    if (!/^[A-Za-z0-9-]+$/.test(cid)) continue;
    let bubbles;
    try {
      bubbles = sqliteJson(
        db,
        `SELECT json_extract(value,'$.type') AS type,
                json_extract(value,'$.text') AS text,
                json_extract(value,'$.createdAt') AS createdAt
         FROM cursorDiskKV
         WHERE key >= 'bubbleId:${cid}:' AND key < 'bubbleId:${cid};'
         ORDER BY rowid`,
      );
    } catch (e) {
      debug(`cursor: bubble fetch failed for ${cid}: ${e.message}`);
      continue;
    }
    const messages = [];
    for (const b of bubbles) {
      if (typeof b.text !== 'string' || !b.text.trim()) continue;
      messages.push({ ts: cursorTs(b.createdAt), role: b.type === 1 ? 'user' : 'assistant', text: b.text });
    }
    if (!messages.some((m) => m.role === 'user')) continue;
    chats.push({
      source: 'cursor',
      id: cid,
      title: typeof c.name === 'string' ? c.name : null,
      messages,
      filesTouched: new Set(),
    });
  }
  return chats;
}

// ---------- entry points ----------

export async function collectEvidence({ repoRoot, stagedFiles, debug = () => {} }) {
  const nowMs = Date.now();
  // Full 14-day scan window: uncommitted work often predates the last commit
  // (other commits land while a change sits in the working tree), so the last
  // commit time is only a recency boost, never a cutoff.
  const windowStartMs = nowMs - WINDOW_DAYS * 86400e3;
  let lastCommitMs = windowStartMs;
  try {
    lastCommitMs =
      parseInt(execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: repoRoot, encoding: 'utf8' }).trim(), 10) * 1000;
  } catch {
    // fresh repo: no boost reference
  }
  const tokensByFile = buildTokens(stagedFiles);

  const all = [];
  try {
    all.push(...(await scanClaudeCode({ repoRoot, windowStartMs, debug })));
  } catch (e) {
    debug(`claude-code scan failed: ${e.message}`);
  }
  try {
    all.push(...scanCursor({ windowStartMs, debug }));
  } catch (e) {
    debug(`cursor scan failed: ${e.message}`);
  }

  const needWeak = Math.min(2, stagedFiles.length);
  const scored = [];
  for (const chat of all) {
    const { strong, weak, score } = scoreChat(chat, tokensByFile, repoRoot);
    if (strong < 1 && weak < needWeak) continue;
    const latestTs = chat.messages.reduce((acc, m) => {
      const t = m.ts ? Date.parse(m.ts) : NaN;
      return Number.isNaN(t) ? acc : Math.max(acc, t);
    }, 0);
    scored.push({ chat, score: score + (latestTs >= lastCommitMs ? RECENCY_BOOST : 0) });
  }
  scored.sort((a, b) => b.score - a.score);

  const chats = scored.slice(0, MAX_CHATS).map(({ chat, score }) => ({
    source: chat.source,
    id: chat.id,
    title: chat.title || null,
    score,
    filesEdited: [...chat.filesTouched]
      .filter((f) => typeof f === 'string' && f.startsWith(repoRoot + path.sep))
      .map((f) => path.relative(repoRoot, f))
      .slice(0, 30),
    messages: trimMessages(chat.messages, windowStartMs),
  }));

  shrinkToBudget(chats);
  return {
    window: { from: new Date(windowStartMs).toISOString(), to: new Date(nowMs).toISOString() },
    chats,
  };
}

export async function selfTest(repoRoot) {
  const lines = [];
  try {
    const files = claudeSessionFiles(repoRoot).sort((a, b) => b.mtimeMs - a.mtimeMs);
    lines.push(`claude-code: ${files.length} session transcript(s) for this repo`);
    for (const { file, mtimeMs } of files.slice(0, 3)) {
      const chat = await parseClaudeSession(file, path.basename(file, '.jsonl'));
      const users = chat.messages.filter((m) => m.role === 'user').length;
      lines.push(
        `  - ${new Date(mtimeMs).toISOString()}  ${chat.title || '(untitled)'}  [${users} user msgs, ${chat.filesTouched.size} files touched${chat.isGenerator ? ', generator run' : ''}]`,
      );
    }
  } catch (e) {
    lines.push(`claude-code: FAILED — ${e.message}`);
  }
  try {
    const db = cursorDbPath();
    if (!fs.existsSync(db)) lines.push('cursor: db not found (Cursor not installed?)');
    else {
      const rows = sqliteJson(
        db,
        `SELECT key, json_extract(value,'$.name') AS name, json_extract(value,'$.lastUpdatedAt') AS ts
         FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;'
         ORDER BY rowid DESC LIMIT 3`,
      );
      lines.push(`cursor: db reachable, ${rows.length} most recent composer(s):`);
      for (const r of rows) {
        const cid = r.key.slice('composerData:'.length);
        let bubbleCount = '?';
        try {
          bubbleCount =
            sqliteJson(db, `SELECT COUNT(*) AS n FROM cursorDiskKV WHERE key >= 'bubbleId:${cid}:' AND key < 'bubbleId:${cid};'`)[0]?.n ?? '?';
        } catch {
          // count is informational only
        }
        lines.push(`  - ${r.ts ? new Date(r.ts).toISOString() : '(no timestamp)'}  ${r.name || '(unnamed)'}  [${bubbleCount} bubbles]`);
      }
    }
  } catch (e) {
    lines.push(`cursor: FAILED — ${e.message}`);
  }
  console.log(lines.join('\n'));
}
