// 每会话严格串行 + 跨会话全局并发上限的任务队列。
// 实例只持有调度结构；任务执行状态全部在任务函数自身的作用域内。
export class ChatTaskQueue {
  constructor(maxConcurrentTasks) {
    this.maxConcurrentTasks = maxConcurrentTasks;
    this.chatChains = new Map();
    this.chatPendingCounts = new Map();
    this.runningChats = new Map();
    this.runningCount = 0;
    this.waitingCallers = [];
    this.idleWaiters = [];
  }

  async enqueue(chatIdentifier, taskFunction) {
    this.increasePendingCount(chatIdentifier);

    const previousChain = this.chatChains.get(chatIdentifier) ?? Promise.resolve();
    const executionPromise = previousChain.then(() => this.runWithSlot(taskFunction, chatIdentifier));

    this.chatChains.set(
      chatIdentifier,
      executionPromise.catch(() => {
        this.decreasePendingCount(chatIdentifier);
      }),
    );

    return executionPromise;
  }

  getStatus() {
    let queuedTaskCount = 0;

    for (const count of this.chatPendingCounts.values()) {
      queuedTaskCount += count;
    }

    return {
      runningCount: this.runningCount,
      queuedTaskCount,
      chatQueueLength: (chatIdentifier) => this.chatPendingCounts.get(chatIdentifier) ?? 0,
    };
  }

  // 等待队列完全排空（无运行中、无排队）；超时则返回非 idle 及仍在运行的会话清单。
  // 供优雅停机使用：调用方据 idle 决定是否发中断通知。
  async waitForIdle(timeoutMilliseconds) {
    if (this.isIdle()) {
      return { idle: true, runningChatIdentifiers: [] };
    }

    return new Promise((resolveWaiter) => {
      const resolveAsIdle = () => {
        clearTimeout(timeoutHandle);
        resolveWaiter({ idle: true, runningChatIdentifiers: [] });
      };
      const timeoutHandle = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((waiter) => waiter !== resolveAsIdle);
        resolveWaiter({ idle: false, runningChatIdentifiers: [...this.runningChats.keys()] });
      }, timeoutMilliseconds);

      this.idleWaiters.push(resolveAsIdle);
    });
  }

  isIdle() {
    return this.runningCount === 0 && this.chatPendingCounts.size === 0;
  }

  notifyIdleWaitersIfReached() {
    if (this.isIdle() && this.idleWaiters.length > 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      waiters.forEach((waiter) => waiter());
    }
  }

  async runWithSlot(taskFunction, chatIdentifier) {
    await this.acquireSlot();
    this.decreasePendingCount(chatIdentifier);
    this.increaseRunningChat(chatIdentifier);

    try {
      return await taskFunction();
    } finally {
      this.releaseSlot();
      this.decreaseRunningChat(chatIdentifier);
      this.notifyIdleWaitersIfReached();
    }
  }

  async acquireSlot() {
    if (this.runningCount < this.maxConcurrentTasks) {
      this.runningCount += 1;

      return;
    }

    await new Promise((resolveAcquire) => this.waitingCallers.push(resolveAcquire));
  }

  releaseSlot() {
    const nextCaller = this.waitingCallers.shift();

    if (nextCaller) {
      nextCaller();

      return;
    }

    this.runningCount -= 1;
  }

  increasePendingCount(chatIdentifier) {
    this.chatPendingCounts.set(chatIdentifier, (this.chatPendingCounts.get(chatIdentifier) ?? 0) + 1);
  }

  increaseRunningChat(chatIdentifier) {
    this.runningChats.set(chatIdentifier, (this.runningChats.get(chatIdentifier) ?? 0) + 1);
  }

  decreaseRunningChat(chatIdentifier) {
    const nextCount = (this.runningChats.get(chatIdentifier) ?? 1) - 1;

    if (nextCount <= 0) {
      this.runningChats.delete(chatIdentifier);

      return;
    }

    this.runningChats.set(chatIdentifier, nextCount);
  }

  decreasePendingCount(chatIdentifier) {
    const nextCount = (this.chatPendingCounts.get(chatIdentifier) ?? 1) - 1;

    if (nextCount <= 0) {
      this.chatPendingCounts.delete(chatIdentifier);

      return;
    }

    this.chatPendingCounts.set(chatIdentifier, nextCount);
  }
}
