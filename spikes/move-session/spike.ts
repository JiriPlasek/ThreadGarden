/**
 * Throwaway spike for moving a chat between machines (spec
 * docs/superpowers/specs/2026-11-02-move-chat-design.md §5). Uses only the
 * Agent SDK's official session API; never reads or writes under ~/.claude.
 *
 *   seed   --cwd <dir> --claude <path>
 *   export <sessionId> --dir <cwd> --out <file>
 *   resume <file> --cwd <dir> --claude <path>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { parseArgs } from 'node:util';
import {
  getSessionMessages,
  importSessionToStore,
  listSessions,
  query,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
} from '@anthropic-ai/claude-agent-sdk';

const SEED_PROMPT =
  'Spike seed. 1) Read README.md and tell me its first line. 2) Use a subagent (Task tool) to list the files in this folder. 3) Remember this word for later: ORNN-FORGE. Reply briefly.';
const RESUME_PROMPT =
  'Spike check, no tools: in one line, what word did I ask you to remember, and what did the subagent find?';

type Exported = {
  sessionId: string;
  sourceDir: string;
  keys: Array<{ key: SessionKey; entries: SessionStoreEntry[] }>;
};

const keyText = (k: SessionKey): string => JSON.stringify(k);

async function runTurn(
  prompt: string,
  options: Parameters<typeof query>[0]['options'],
): Promise<string | undefined> {
  let sessionId: string | undefined;
  for await (const m of query({ prompt, options })) {
    if (m.type === 'system' && m.subtype === 'init') {
      sessionId = m.session_id;
      console.log(`init session_id ${m.session_id}`);
    } else if (m.type === 'assistant') {
      for (const b of m.message.content) {
        if (b.type === 'text') console.log(`assistant: ${b.text}`);
        else if (b.type === 'tool_use') console.log(`tool_use: ${b.name}`);
      }
    } else if (m.type === 'result') {
      console.log(`result ${m.subtype} session_id ${m.session_id}`);
      if (m.subtype === 'success') console.log(`reply: ${m.result}`);
    } else if (m.type === 'system') {
      console.log(`system ${m.subtype}`);
    }
  }
  return sessionId;
}

async function report(dir: string, id: string | undefined, sessionStore?: SessionStore): Promise<void> {
  const sessions = await listSessions({ dir, sessionStore });
  console.log(`listSessions(${dir}): ${sessions.length}`);
  for (const s of sessions) console.log(`  ${s.sessionId}  ${s.summary.slice(0, 60)}`);
  if (id) {
    const msgs = await getSessionMessages(id, { dir, sessionStore });
    console.log(`getSessionMessages(${id}): ${msgs.length}`);
    for (const m of msgs.slice(-2)) console.log(`  last ${m.type}: ${JSON.stringify(m.message).slice(0, 120)}`);
  }
}

async function seed(cwd: string, claude: string): Promise<void> {
  const id = await runTurn(SEED_PROMPT, {
    cwd,
    pathToClaudeCodeExecutable: claude,
    allowedTools: ['Read', 'Glob', 'LS', 'Task'],
  });
  console.log(`session ${id}`);
  await report(cwd, id);
}

async function exportSession(sessionId: string, dir: string, out: string): Promise<void> {
  const keys = new Map<string, { key: SessionKey; entries: SessionStoreEntry[] }>();
  const store: SessionStore = {
    async append(key, entries) {
      const k = keyText(key);
      const slot = keys.get(k) ?? { key, entries: [] };
      slot.entries.push(...entries);
      keys.set(k, slot);
    },
    async load() {
      return null;
    },
  };
  await importSessionToStore(sessionId, store, { dir, includeSubagents: true });
  const data: Exported = { sessionId, sourceDir: dir, keys: [...keys.values()] };
  writeFileSync(out, JSON.stringify(data));
  for (const { key, entries } of data.keys) console.log(`key ${keyText(key)}: ${entries.length} entries`);
  console.log(`wrote ${out}`);
}

/**
 * The export file as a persistent store, the way Threadgarden would keep a
 * moved chat: a resume from a store runs in a temporary Claude config dir, so
 * the store is the chat's only home on the target. Keyed by session id and
 * subpath; any projectKey is answered.
 */
function fileStore(file: string, data: Exported): SessionStore {
  const find = (sessionId: string, subpath?: string) =>
    data.keys.find((k) => k.key.sessionId === sessionId && k.key.subpath === subpath);
  const save = () => writeFileSync(file, JSON.stringify(data));
  return {
    async append(key, entries) {
      let slot = find(key.sessionId, key.subpath);
      if (!slot) {
        slot = { key, entries: [] };
        data.keys.push(slot);
      }
      const seen = new Set(slot.entries.map((e) => e.uuid).filter(Boolean));
      const fresh = entries.filter((e) => !e.uuid || !seen.has(e.uuid));
      slot.entries.push(...fresh);
      save();
      console.log(`append ${keyText(key)}: ${entries.length} (${fresh.length} new)`);
    },
    async listSessions(projectKey) {
      const ids = [...new Set(data.keys.map((k) => k.key.sessionId))];
      console.log(`listSessions ${projectKey} -> ${ids.length}`);
      return ids.map((sessionId) => ({ sessionId, mtime: Date.now() }));
    },
    async load(key) {
      const hit = find(key.sessionId, key.subpath);
      console.log(`load ${keyText(key)} -> ${hit ? `${hit.entries.length} entries` : 'null'}`);
      return hit ? hit.entries : null;
    },
    async listSubkeys(key) {
      const subs = data.keys
        .filter((k) => k.key.sessionId === key.sessionId && k.key.subpath !== undefined)
        .map((k) => k.key.subpath!);
      console.log(`listSubkeys ${JSON.stringify(key)} -> ${JSON.stringify(subs)}`);
      return subs;
    },
  };
}

async function resume(file: string, cwd: string, claude: string, prompt = RESUME_PROMPT): Promise<void> {
  const data = JSON.parse(readFileSync(file, 'utf8')) as Exported;
  const store = fileStore(file, data);
  console.log(`source session ${data.sessionId} from ${data.sourceDir}`);
  const id = await runTurn(prompt, {
    resume: data.sessionId,
    sessionStore: store,
    cwd,
    pathToClaudeCodeExecutable: claude,
    maxTurns: 1,
    allowedTools: [],
  });
  console.log(`resumed session ${id} (source ${data.sessionId}, ${id === data.sessionId ? 'same id' : 'NEW id'})`);
  console.log('-- local Claude history:');
  await report(cwd, id);
  console.log('-- through the store:');
  await report(cwd, id, store);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cwd: { type: 'string' },
    dir: { type: 'string' },
    out: { type: 'string' },
    claude: { type: 'string' },
    prompt: { type: 'string' },
  },
});
const need = (v: string | undefined, name: string): string => {
  if (!v) throw new Error(`missing ${name}`);
  return v;
};

try {
  const [cmd, arg] = positionals;
  if (cmd === 'seed') await seed(need(values.cwd, '--cwd'), need(values.claude, '--claude'));
  else if (cmd === 'export')
    await exportSession(need(arg, 'sessionId'), need(values.dir, '--dir'), need(values.out, '--out'));
  else if (cmd === 'resume')
    await resume(need(arg, 'file'), need(values.cwd, '--cwd'), need(values.claude, '--claude'), values.prompt);
  else throw new Error('usage: seed | export <id> | resume <file>');
} catch (e) {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
}
