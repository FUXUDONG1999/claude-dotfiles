// 每会话严格串行 + 跨会话全局并发上限的任务队列。
// 实例只持有调度结构；任务执行状态全部在任务函数自身的作用域内。
export class ChatTaskQueue {
  constructor(maxConcurrentTasks) {
    this.maxConcurrentTasks = maxConcurrentTasks;
    this.chatChains = new Map();
    this.chatPendingCounts = new Map();
    this.runningCount = 0;
    this.waitingCallers = [];
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

  async runWithSlot(taskFunction, chatIdentifier) {
    await this.acquireSlot();
    this.decreasePendingCount(chatIdentifier);

    try {
      return await taskFunction();
    } finally {
      this.releaseSlot();
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

  decreasePendingCount(chatIdentifier) {
    const nextCount = (this.chatPendingCounts.get(chatIdentifier) ?? 1) - 1;

    if (nextCount <= 0) {
      this.chatPendingCounts.delete(chatIdentifier);

      return;
    }

    this.chatPendingCounts.set(chatIdentifier, nextCount);
  }
}
