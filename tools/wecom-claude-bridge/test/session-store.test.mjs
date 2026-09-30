import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SessionStore } from '../src/session-store.mjs';

function createTemporaryStore() {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'wecom-claude-bridge-test-'));

  return {
    stateDirectory,
    store: new SessionStore(join(stateDirectory, 'state.json')),
    cleanup: () => rmSync(stateDirectory, { recursive: true, force: true }),
  };
}

test('SessionStore 保存后可读取，且重启（新实例）后仍在', async () => {
  const fixture = createTemporaryStore();

  try {
    fixture.store.saveSession('chat-1', { sessionId: 'session-abc', workingDirectory: '/data/project' });

    assert.deepEqual(fixture.store.getSession('chat-1'), {
      sessionId: 'session-abc',
      workingDirectory: '/data/project',
    });

    const reloadedStore = new SessionStore(join(fixture.stateDirectory, 'state.json'));
    assert.deepEqual(reloadedStore.getSession('chat-1'), {
      sessionId: 'session-abc',
      workingDirectory: '/data/project',
    });
  } finally {
    fixture.cleanup();
  }
});

test('SessionStore 对不存在的会话返回 null，removeSession 后亦为 null', () => {
  const fixture = createTemporaryStore();

  try {
    fixture.store.saveSession('chat-1', { sessionId: 'session-abc', workingDirectory: '/data/project' });
    fixture.store.removeSession('chat-1');

    assert.equal(fixture.store.getSession('chat-1'), null);
    assert.equal(fixture.store.getSession('chat-missing'), null);
  } finally {
    fixture.cleanup();
  }
});
