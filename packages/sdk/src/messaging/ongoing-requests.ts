/**
 * 全局正在进行的请求管理器
 * 用于跟踪每个对话的 AI 请求状态，支持 /stop 命令实时打断
 */

type OngoingRequest = {
  abortController: AbortController;
  startedAt: number;
  /** Marked as stopped by /stop command */
  stopped: boolean;
};

const ongoingRequests = new Map<string, OngoingRequest>();

/**
 * 注册一个正在进行的请求
 */
export function registerOngoingRequest(
  conversationId: string,
  abortController: AbortController,
): void {
  ongoingRequests.set(conversationId, {
    abortController,
    startedAt: Date.now(),
    stopped: false,
  });
}

/**
 * 移除一个已完成的请求
 */
export function unregisterOngoingRequest(conversationId: string): void {
  ongoingRequests.delete(conversationId);
}

/**
 * 停止指定对话的正在进行的请求
 * @returns 是否成功停止
 */
export function stopOngoingRequest(conversationId: string): boolean {
  const request = ongoingRequests.get(conversationId);
  if (!request) {
    return false;
  }
  
  request.stopped = true;
  request.abortController.abort();
  // Don't delete the entry - keep it so isConversationStopped can check it
  // It will be cleaned up by unregisterOngoingRequest when processOneMessage completes
  return true;
}

/**
 * 检查对话是否被停止
 */
export function isConversationStopped(conversationId: string): boolean {
  const request = ongoingRequests.get(conversationId);
  return request?.stopped ?? false;
}

/**
 * 检查是否有正在进行的请求
 */
export function hasOngoingRequest(conversationId: string): boolean {
  return ongoingRequests.has(conversationId);
}

/**
 * 获取所有正在进行的请求的对话 ID
 */
export function getOngoingRequestConversationIds(): string[] {
  return Array.from(ongoingRequests.keys());
}
