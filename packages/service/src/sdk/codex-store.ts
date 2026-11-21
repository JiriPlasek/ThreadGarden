/** Threadgarden owns the display journal; Codex owns the resumable model context. */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { SDKMessage, SDKSessionInfo, SessionMessage } from './adapter.js';
import { isCodexSession } from './providers.js';

export type CodexRecord = {
  id: string;
  cwd: string;
  threadId?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  firstPrompt?: string;
  title?: string;
  native?: boolean;
  createdHere?: boolean;
  nativePath?: string;
  historyMode?: string;
  modelProvider?: string;
  home?: string;
  preservePermissions?: boolean;
  runtimeVersion?: string;
  contextUsage?: { used: number; max: number };
  createdAt: number;
  updatedAt: number;
};

export class CodexStore {
  private byThread?: Map<string, CodexRecord>;
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(id: string, ext: string): string {
    if (!isCodexSession(id)) throw new Error('Invalid Codex session id');
    return path.join(this.dir, `${id}.${ext}`);
  }

  read(id: string): CodexRecord | undefined {
    try {
      return JSON.parse(readFileSync(this.file(id, 'json'), 'utf8')) as CodexRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  save(record: CodexRecord): void {
    const target = this.file(record.id, 'json');
    writeFileSync(`${target}.tmp`, JSON.stringify(record));
    renameSync(`${target}.tmp`, target);
    if (record.threadId) this.byThread?.set(record.threadId, record);
  }

  records(): CodexRecord[] {
    return readdirSync(this.dir)
      .filter((name) => /^codex-[0-9a-f-]{36}\.json$/.test(name))
      .map((name) => this.read(name.slice(0, -5)))
      .filter((record): record is CodexRecord => !!record);
  }

  recordForThread(threadId: string): CodexRecord | undefined {
    this.byThread ??= new Map(
      this.records()
        .filter((record) => record.threadId)
        .map((record) => [record.threadId!, record]),
    );
    return this.byThread.get(threadId);
  }

  append(record: CodexRecord, message: SDKMessage): void {
    appendFileSync(this.file(record.id, 'jsonl'), `${JSON.stringify(message)}\n`);
    record.updatedAt = Date.now();
    this.save(record);
  }

  messages(id: string): SessionMessage[] {
    let text: string;
    try {
      text = readFileSync(this.file(id, 'jsonl'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    // A process killed during append can leave a partial last line.
    return text
      .split('\n')
      .slice(0, -1)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SessionMessage);
  }

  info(id: string): SDKSessionInfo | undefined {
    const record = this.read(id);
    if (!record) return undefined;
    let fileSize = 0;
    try {
      fileSize = statSync(this.file(id, 'jsonl')).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let lastModified = record.updatedAt;
    if (record.nativePath) {
      try {
        const native = statSync(record.nativePath);
        fileSize += native.size;
        lastModified = Math.max(lastModified, native.mtimeMs);
      } catch {
        // Paginated history can exist only in Codex's database; the native listing is authoritative.
      }
    }
    return {
      sessionId: id,
      cwd: record.cwd,
      summary: record.firstPrompt?.slice(0, 120) ?? 'Codex chat',
      ...(record.title ? { customTitle: record.title } : {}),
      firstPrompt: record.firstPrompt,
      createdAt: record.createdAt,
      lastModified,
      fileSize,
    };
  }

  list(): SDKSessionInfo[] {
    return this.records()
      .map((record) => this.info(record.id))
      .filter((info): info is SDKSessionInfo => !!info);
  }
}
