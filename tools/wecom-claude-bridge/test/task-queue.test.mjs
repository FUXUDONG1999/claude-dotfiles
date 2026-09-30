import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ChatTaskQueue } from '../src/task-queue.mjs';

function createGate() {
  let openGate;

  const gatePromise = new Promise((resolveOpen) => {
    openGate = resolveOpen;
  });

  return {
    open: openGate,
    waitToOpen: () => gatePromise,
  };
}

async function waitForCondition(conditionFunction, timeoutMilliseconds = 2_000) {
  const startedAtMilliseconds = Date.now();

  while (!conditionFunction()) {
    if (Date.now() - startedAtMilliseconds > timeoutMilliseconds) {
      throw new Error('等待条件超时');
    }

    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5));
  }
}

test('ChatTaskQueue 同一会话的任务严格串行', async () => {
  const queue = new ChatTaskQueue(3);
  const executionOrder = [];
  const firstGate = createGate();
  const secondGate = createGate();
  const startedFlags = { first: false, second: false };

  const firstPromise = queue.enqueue('chat-1', async () => {
    startedFlags.first = true;
    executionOrder.push('first-start');
    await firstGate.waitToOpen();
    executionOrder.push('first-end');
  });
  const secondPromise = queue.enqueue('chat-1', async () => {
    startedFlags.second = true;
    executionOrder.push('second-start');
    await secondGate.waitToOpen();
    executionOrder.push('second-end');
  });

  await waitForCondition(() => startedFlags.first);
  assert.equal(startedFlags.second, false);
  assert.deepEqual(executionOrder, ['first-start']);

  firstGate.open();
  await waitForCondition(() => startedFlags.second);
  assert.deepEqual(executionOrder, ['first-start', 'first-end', 'second-start']);

  secondGate.open();
  await Promise.all([firstPromise, secondPromise]);
  assert.deepEqual(executionOrder, ['first-start', 'first-end', 'second-start', 'second-end']);
});

test('ChatTaskQueue 不同会话可并行但总数不超过上限', async () => {
  const maxConcurrentTasks = 2;
  const queue = new ChatTaskQueue(maxConcurrentTasks);
  const gates = Array.from({ length: 5 }, () => createGate());
  let runningCount = 0;
  let peakRunningCount = 0;

  const promises = gates.map((gate, gateIndex) =>
    queue.enqueue(`chat-${gateIndex}`, async () => {
      runningCount += 1;
      peakRunningCount = Math.max(peakRunningCount, runningCount);
      await gate.waitToOpen();
      runningCount -= 1;
    }),
  );

  await waitForCondition(() => peakRunningCount === maxConcurrentTasks);
  await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 50));

  assert.ok(peakRunningCount <= maxConcurrentTasks);
  assert.equal(peakRunningCount, maxConcurrentTasks);

  gates.forEach((gate) => gate.open());
  await Promise.all(promises);
  assert.equal(queue.getStatus().runningCount, 0);
});

test('ChatTaskQueue getStatus 反映排队与运行状态', async () => {
  const queue = new ChatTaskQueue(1);
  const firstGate = createGate();
  const secondGate = createGate();
  const startedFlags = { first: false, second: false };

  const firstPromise = queue.enqueue('chat-1', async () => {
    startedFlags.first = true;
    await firstGate.waitToOpen();
  });
  const secondPromise = queue.enqueue('chat-1', async () => {
    startedFlags.second = true;
    await secondGate.waitToOpen();
  });

  await waitForCondition(() => startedFlags.first);
  const status = queue.getStatus();

  assert.equal(status.runningCount, 1);
  assert.equal(status.queuedTaskCount, 1);
  assert.equal(status.chatQueueLength('chat-1'), 1);

  firstGate.open();
  await waitForCondition(() => startedFlags.second);
  secondGate.open();
  await Promise.all([firstPromise, secondPromise]);

  assert.equal(queue.getStatus().runningCount, 0);
});
