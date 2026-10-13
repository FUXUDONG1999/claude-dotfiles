import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const HISTORY_LIMIT = 5;
const FIRST_PROMPT_LENGTH_LIMIT = 60;

// chatid → { workingDirectory, active, history } 的持久化映射，原子写入。
// active: { sessionId, firstPrompt, lastActiveAt } | null（当前可续聊会话，TTL 由调用方判定）。
// history: [{ sessionId, firstPrompt, endedAt }]（最近结束的会话，新的在前，上限 HISTORY_LIMIT 条）。
// 时间统一取自 nowProvider（默认 Date.now），测试可注入假时钟。
export class SessionStore {
  constructor(filePath, nowProvider = Date.now) {
    this.filePath = filePath;
    this.nowProvider = nowProvider;
    this.sessions = this.loadSessions();
  }

  getRecord(chatIdentifier) {
    return this.sessions.get(chatIdentifier) ?? null;
  }

  // 让指定会话成为当前会话：旧当前会话降级进历史，同一 sessionId 从历史去重。
  activateSession(chatIdentifier, { sessionId, firstPrompt }) {
    const record = this.ensureRecord(chatIdentifier);

    if (record.active) {
      this.pushHistoryEntry(record, {
        sessionId: record.active.sessionId,
        firstPrompt: record.active.firstPrompt,
        endedAt: this.nowProvider(),
      });
    }

    record.history = record.history.filter((entry) => entry.sessionId !== sessionId);
    record.active = {
      sessionId,
      firstPrompt: (firstPrompt ?? '').slice(0, FIRST_PROMPT_LENGTH_LIMIT),
      lastActiveAt: this.nowProvider(),
    };
    this.persist();
  }

  touchActiveSession(chatIdentifier) {
    const record = this.sessions.get(chatIdentifier);

    if (record?.active) {
      record.active.lastActiveAt = this.nowProvider();
      this.persist();
    }
  }

  demoteActiveSession(chatIdentifier) {
    const record = this.sessions.get(chatIdentifier);

    if (!record?.active) {
      return;
    }

    this.pushHistoryEntry(record, {
      sessionId: record.active.sessionId,
      firstPrompt: record.active.firstPrompt,
      endedAt: this.nowProvider(),
    });
    record.active = null;
    this.persist();
  }

  setWorkingDirectory(chatIdentifier, workingDirectory) {
    const record = this.ensureRecord(chatIdentifier);

    record.workingDirectory = workingDirectory;
    this.demoteActiveSession(chatIdentifier);
  }

  // TTL 判定与降级一体化：仍在 TTL 内返回当前会话；已闲置超时则降级进历史并报告 expiredJustNow。
  resolveActiveSession(chatIdentifier, ttlMilliseconds) {
    const record = this.sessions.get(chatIdentifier);

    if (!record?.active) {
      return { sessionId: null, expiredJustNow: false };
    }

    if (this.nowProvider() - record.active.lastActiveAt <= ttlMilliseconds) {
      return { sessionId: record.active.sessionId, expiredJustNow: false };
    }

    this.demoteActiveSession(chatIdentifier);

    return { sessionId: null, expiredJustNow: true };
  }

  removeRecord(chatIdentifier) {
    this.sessions.delete(chatIdentifier);
    this.persist();
  }

  ensureRecord(chatIdentifier) {
    if (!this.sessions.has(chatIdentifier)) {
      this.sessions.set(chatIdentifier, { workingDirectory: null, active: null, history: [] });
    }

    return this.sessions.get(chatIdentifier);
  }

  pushHistoryEntry(record, entry) {
    record.history = [entry, ...record.history.filter((existing) => existing.sessionId !== entry.sessionId)].slice(
      0,
      HISTORY_LIMIT,
    );
  }

  loadSessions() {
    if (!existsSync(this.filePath)) {
      return new Map();
    }

    const parsedContent = JSON.parse(readFileSync(this.filePath, 'utf8'));

    return new Map(Object.entries(parsedContent).map(([chatIdentifier, entry]) => [chatIdentifier, this.migrateEntry(entry)]));
  }

  // 旧格式 { sessionId, workingDirectory } → 新格式；有 sessionId 的视为已结束会话进历史（无时间戳）。
  migrateEntry(entry) {
    if (entry && typeof entry === 'object' && entry.active === undefined && entry.history === undefined) {
      return {
        workingDirectory: entry.workingDirectory ?? null,
        active: null,
        history: entry.sessionId
          ? [{ sessionId: entry.sessionId, firstPrompt: null, endedAt: null }]
          : [],
      };
    }

    return entry ?? { workingDirectory: null, active: null, history: [] };
  }

  persist() {
    mkdirSync(dirname(this.filePath), { recursive: true });

    const temporaryFilePath = `${this.filePath}.tmp`;

    writeFileSync(temporaryFilePath, JSON.stringify(Object.fromEntries(this.sessions), null, 2));
    renameSync(temporaryFilePath, this.filePath);
  }
}
