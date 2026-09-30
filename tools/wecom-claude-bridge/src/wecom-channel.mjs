export const WECOM_STREAM_CONTENT_BYTE_LIMIT = 20480;

export const TRUNCATION_MARKER_TEXT = '\n\n…（内容超过企微单条上限已截断，全文见服务器日志目录）';

// 按字节上限截断文本，超限时保留头部并追加截断标记。
export function truncateTextToByteLimit(text, byteLimit = WECOM_STREAM_CONTENT_BYTE_LIMIT) {
  if (Buffer.byteLength(text, 'utf8') <= byteLimit) {
    return text;
  }

  const budgetBytes = byteLimit - Buffer.byteLength(TRUNCATION_MARKER_TEXT, 'utf8');
  const keptCharacters = [];
  let usedBytes = 0;

  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');

    if (usedBytes + characterBytes > budgetBytes) {
      break;
    }

    keptCharacters.push(character);
    usedBytes += characterBytes;
  }

  return keptCharacters.join('') + TRUNCATION_MARKER_TEXT;
}

// 企微流式回复封装：节流推送（30 条/分钟限频）+ 6 分钟硬截止兜底 + 超限截断。
// 前置：sendFunction(content, finish) 与 activeChatPushFunction(chatIdentifier, content) 已就绪。
// 后置：finish() 后不再发送流式帧；若曾触发硬截止，最终结果改经 activeChatPushFunction 送达。
export class ThrottledStreamReply {
  constructor(constructionOptions) {
    this.sendFunction = constructionOptions.sendFunction;
    this.intervalMilliseconds = constructionOptions.intervalMilliseconds;
    this.hardDeadlineNoticeText = constructionOptions.hardDeadlineNoticeText;
    this.activeChatIdentifier = constructionOptions.activeChatIdentifier;
    this.activeChatPushFunction = constructionOptions.activeChatPushFunction;

    this.pendingText = '';
    this.lastSendAt = 0;
    this.sendChain = Promise.resolve();
    this.streamClosed = false;
    this.finalResultDelivered = false;
    this.earlyFinalized = false;
    this.flushTimer = null;

    this.hardDeadlineTimer = setTimeout(() => this.finalizeEarly(), constructionOptions.hardDeadlineMilliseconds);
    this.hardDeadlineTimer.unref?.();
  }

  push(progressText) {
    if (this.streamClosed) {
      return;
    }

    this.pendingText = progressText;

    const remainingWaitMilliseconds = this.intervalMilliseconds - (Date.now() - this.lastSendAt);

    if (remainingWaitMilliseconds <= 0) {
      this.dispatchSend(this.pendingText, false);

      return;
    }

    this.scheduleFlush(remainingWaitMilliseconds);
  }

  async finish(finalText) {
    clearTimeout(this.hardDeadlineTimer);

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.finalResultDelivered) {
      return;
    }

    this.finalResultDelivered = true;

    if (this.earlyFinalized) {
      await this.activeChatPushFunction(this.activeChatIdentifier, finalText);

      return;
    }

    this.streamClosed = true;
    this.dispatchSend(finalText, true);
    await this.sendChain;
  }

  finalizeEarly() {
    if (this.streamClosed) {
      return;
    }

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const noticeText = this.pendingText
      ? `${this.pendingText}\n\n---\n⏳ ${this.hardDeadlineNoticeText}，完成后将另行推送。`
      : `⏳ ${this.hardDeadlineNoticeText}，完成后将另行推送。`;

    this.earlyFinalized = true;
    this.streamClosed = true;
    this.dispatchSend(noticeText, true);
  }

  scheduleFlush(delayMilliseconds) {
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;

      if (this.streamClosed) {
        return;
      }

      this.dispatchSend(this.pendingText, false);
    }, delayMilliseconds);
    this.flushTimer.unref?.();
  }

  dispatchSend(content, finish) {
    this.lastSendAt = Date.now();
    this.sendChain = this.sendChain.then(() => this.sendFunction(truncateTextToByteLimit(content), finish));
  }
}
