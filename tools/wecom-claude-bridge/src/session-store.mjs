import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// chatid → { sessionId, workingDirectory } 的持久化映射，原子写入。
export class SessionStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.sessions = this.loadSessions();
  }

  getSession(chatIdentifier) {
    return this.sessions.get(chatIdentifier) ?? null;
  }

  saveSession(chatIdentifier, session) {
    this.sessions.set(chatIdentifier, session);
    this.persist();
  }

  removeSession(chatIdentifier) {
    this.sessions.delete(chatIdentifier);
    this.persist();
  }

  loadSessions() {
    if (!existsSync(this.filePath)) {
      return new Map();
    }

    const parsedContent = JSON.parse(readFileSync(this.filePath, 'utf8'));

    return new Map(Object.entries(parsedContent));
  }

  persist() {
    mkdirSync(dirname(this.filePath), { recursive: true });

    const temporaryFilePath = `${this.filePath}.tmp`;

    writeFileSync(temporaryFilePath, JSON.stringify(Object.fromEntries(this.sessions), null, 2));
    renameSync(temporaryFilePath, this.filePath);
  }
}
