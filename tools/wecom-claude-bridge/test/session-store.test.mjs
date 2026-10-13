import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SessionStore } from '../src/session-store.mjs';

const SIX_HOURS = 6 * 3600_000;

function createTemporaryStore({ nowProvider } = {}) {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'wecom-claude-bridge-test-'));
  const stateFilePath = join(stateDirectory, 'state.json');

  return {
    stateDirectory,
    stateFilePath,
    store: new SessionStore(stateFilePath, nowProvider),
    cleanup: () => rmSync(stateDirectory, { recursive: true, force: true }),
  };
}

test('SessionStore activateSession 建立当前会话并截断首问摘要，重启后仍在', () => {
  const fixture = createTemporaryStore();

  try {
    fixture.store.activateSession('chat-1', {
      sessionId: 'session-abc',
      firstPrompt: `${'很'.repeat(80)}长的第一个问题`,
    });

    const record = fixture.store.getRecord('chat-1');
    assert.equal(record.active.sessionId, 'session-abc');
    assert.equal(record.active.firstPrompt.length, 60);
    assert.equal(record.active.lastActiveAt > 0, true);
    assert.deepEqual(record.history, []);

    const reloadedStore = new SessionStore(fixture.stateFilePath);
    assert.equal(reloadedStore.getRecord('chat-1').active.sessionId, 'session-abc');
  } finally {
    fixture.cleanup();
  }
});

test('SessionStore 重复 activateSession 将旧当前会话降级进历史（新的在前）', () => {
  const fixture = createTemporaryStore();

  try {
    fixture.store.activateSession('chat-1', { sessionId: 'session-a', firstPrompt: '问题 A' });
    fixture.store.activateSession('chat-1', { sessionId: 'session-b', firstPrompt: '问题 B' });

    const record = fixture.store.getRecord('chat-1');
    assert.equal(record.active.sessionId, 'session-b');
    assert.deepEqual(
      record.history.map((entry) => entry.sessionId),
      ['session-a'],
    );
  } finally {
    fixture.cleanup();
  }
});

test('SessionStore 历史最多保留 5 条，最旧的被挤掉', () => {
  const fixture = createTemporaryStore();

  try {
    for (let index = 0; index < 7; index += 1) {
      fixture.store.activateSession('chat-1', { sessionId: `session-${index}`, firstPrompt: `问题 ${index}` });
    }

    const record = fixture.store.getRecord('chat-1');
    assert.deepEqual(
      record.history.map((entry) => entry.sessionId),
      ['session-5', 'session-4', 'session-3', 'session-2', 'session-1'],
    );
  } finally {
    fixture.cleanup();
  }
});

test('SessionStore activateSession 恢复历史中的会话时，把它从历史里移除', () => {
  const fixture = createTemporaryStore();

  try {
    fixture.store.activateSession('chat-1', { sessionId: 'session-a', firstPrompt: '问题 A' });
    fixture.store.activateSession('chat-1', { sessionId: 'session-b', firstPrompt: '问题 B' });
    fixture.store.activateSession('chat-1', { sessionId: 'session-a', firstPrompt: '问题 A' });

    const record = fixture.store.getRecord('chat-1');
    assert.equal(record.active.sessionId, 'session-a');
    assert.deepEqual(record.history.map((entry) => entry.sessionId), ['session-b']);
  } finally {
    fixture.cleanup();
  }
});

test('SessionStore touchActiveSession 刷新闲置计时', () => {
  let currentTime = 1_000;
  const fixture = createTemporaryStore({ nowProvider: () => currentTime });

  try {
    fixture.store.activateSession('chat-1', { sessionId: 'session-a', firstPrompt: '问题 A' });
    assert.equal(fixture.store.getRecord('chat-1').active.lastActiveAt, 1_000);

    currentTime = 9_999;
    fixture.store.touchActiveSession('chat-1');
    assert.equal(fixture.store.getRecord('chat-1').active.lastActiveAt, 9_999);
  } finally {
    fixture.cleanup();
  }
});

test('SessionStore demoteActiveSession 把当前会话移入历史，无当前会话时是空操作', () => {
  const fixture = createTemporaryStore();

  try {
    fixture.store.demoteActiveSession('chat-1');
    assert.equal(fixture.store.getRecord('chat-1'), null);

    fixture.store.activateSession('chat-1', { sessionId: 'session-a', firstPrompt: '问题 A' });
    fixture.store.demoteActiveSession('chat-1');

    const record = fixture.store.getRecord('chat-1');
    assert.equal(record.active, null);
    assert.deepEqual(record.history.map((entry) => entry.sessionId), ['session-a']);
  } finally {
    fixture.cleanup();
  }
});

test('SessionStore setWorkingDirectory 记录目录并把当前会话降级进历史', () => {
  const fixture = createTemporaryStore();

  try {
    fixture.store.activateSession('chat-1', { sessionId: 'session-a', firstPrompt: '问题 A' });
    fixture.store.setWorkingDirectory('chat-1', '/data/project');

    const record = fixture.store.getRecord('chat-1');
    assert.equal(record.workingDirectory, '/data/project');
    assert.equal(record.active, null);
    assert.deepEqual(record.history.map((entry) => entry.sessionId), ['session-a']);
  } finally {
    fixture.cleanup();
  }
});

test('SessionStore resolveActiveSession 在 TTL 内返回当前会话且不动历史', () => {
  let currentTime = 1_000;
  const fixture = createTemporaryStore({ nowProvider: () => currentTime });

  try {
    fixture.store.activateSession('chat-1', { sessionId: 'session-a', firstPrompt: '问题 A' });

    currentTime += SIX_HOURS;
    const resolved = fixture.store.resolveActiveSession('chat-1', SIX_HOURS);

    assert.deepEqual(resolved, { sessionId: 'session-a', expiredJustNow: false });
    assert.equal(fixture.store.getRecord('chat-1').active.sessionId, 'session-a');
  } finally {
    fixture.cleanup();
  }
});

test('SessionStore resolveActiveSession 超过 TTL 时降级当前会话并报告刚过期', () => {
  let currentTime = 1_000;
  const fixture = createTemporaryStore({ nowProvider: () => currentTime });

  try {
    fixture.store.activateSession('chat-1', { sessionId: 'session-a', firstPrompt: '问题 A' });

    currentTime += SIX_HOURS + 1;
    const resolved = fixture.store.resolveActiveSession('chat-1', SIX_HOURS);

    assert.deepEqual(resolved, { sessionId: null, expiredJustNow: true });
    const record = fixture.store.getRecord('chat-1');
    assert.equal(record.active, null);
    assert.deepEqual(record.history.map((entry) => entry.sessionId), ['session-a']);
  } finally {
    fixture.cleanup();
  }
});

test('SessionStore resolveActiveSession 对无记录的 chat 返回未过期空结果', () => {
  const fixture = createTemporaryStore();

  try {
    assert.deepEqual(fixture.store.resolveActiveSession('chat-missing', SIX_HOURS), {
      sessionId: null,
      expiredJustNow: false,
    });
  } finally {
    fixture.cleanup();
  }
});

test('SessionStore 加载旧格式状态：有 sessionId 的进历史，无 sessionId 的只留目录', () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'wecom-claude-bridge-test-'));
  const stateFilePath = join(stateDirectory, 'state.json');

  writeFileSync(
    stateFilePath,
    JSON.stringify({
      'chat-old-with-session': { sessionId: 'legacy-session', workingDirectory: '/data/legacy' },
      'chat-old-empty': { sessionId: null, workingDirectory: '/data/other' },
    }),
  );

  try {
    const store = new SessionStore(stateFilePath);

    const withSession = store.getRecord('chat-old-with-session');
    assert.equal(withSession.workingDirectory, '/data/legacy');
    assert.equal(withSession.active, null);
    assert.deepEqual(
      withSession.history.map((entry) => entry.sessionId),
      ['legacy-session'],
    );

    const empty = store.getRecord('chat-old-empty');
    assert.equal(empty.workingDirectory, '/data/other');
    assert.deepEqual(empty.history, []);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('SessionStore 对不存在与已清空的 chat 返回 null 记录', () => {
  const fixture = createTemporaryStore();

  try {
    assert.equal(fixture.store.getRecord('chat-missing'), null);

    fixture.store.activateSession('chat-1', { sessionId: 'session-a', firstPrompt: '问题 A' });
    fixture.store.removeRecord('chat-1');
    assert.equal(fixture.store.getRecord('chat-1'), null);
  } finally {
    fixture.cleanup();
  }
});
