const DEFAULT_CONTEXT_TOKENS = 65536;
const GATEWAY_RESERVE_TOKENS = 2048;

export function estimateTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 3);
}

function toolCallIds(message: any): string[] {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content
    .filter((part: any) => part?.type === "tool-call" || part?.type === "tool_use")
    .map((part: any) => String(part.toolCallId ?? part.tool_use_id ?? part.id ?? ""))
    .filter(Boolean);
}

function toolResultIds(message: any): string[] {
  if (message?.role !== "tool" || !Array.isArray(message.content)) return [];
  return message.content
    .filter((part: any) => part?.type === "tool-result" || part?.type === "tool_result")
    .map((part: any) => String(part.toolCallId ?? part.tool_use_id ?? part.id ?? ""))
    .filter(Boolean);
}

function completedToolRounds(messages: any[]): { start: number; end: number }[] {
  const rounds: { start: number; end: number }[] = [];
  for (let start = 0; start < messages.length; start++) {
    const calls = toolCallIds(messages[start]);
    if (calls.length === 0) continue;
    const found = new Set<string>();
    let end = start;
    while (end + 1 < messages.length && messages[end + 1]?.role === "tool") {
      end++;
      for (const id of toolResultIds(messages[end])) found.add(id);
    }
    if (calls.every((id) => found.has(id))) rounds.push({ start, end });
    start = end;
  }
  return rounds;
}

function assertNoOrphanedToolResults(messages: any[]) {
  const calls = new Set<string>();
  for (const message of messages) {
    for (const id of toolCallIds(message)) calls.add(id);
    for (const id of toolResultIds(message)) {
      if (!calls.has(id)) throw new Error(`Agent 上下文包含孤立 tool result: ${id}`);
    }
  }
}

export function compactStepMessages(messages: any[], maxInputTokens: number): any[] {
  assertNoOrphanedToolResults(messages);
  if (estimateTokens(messages) <= maxInputTokens) return messages;

  const rounds = completedToolRounds(messages);
  const latest = rounds.at(-1);
  const removable = rounds.filter((round) => round !== latest);
  const removed = new Set<number>();
  for (const round of removable) {
    for (let index = round.start; index <= round.end; index++) removed.add(index);
    const compacted = messages.filter((_, index) => !removed.has(index));
    if (estimateTokens(compacted) <= maxInputTokens) {
      assertNoOrphanedToolResults(compacted);
      return compacted;
    }
  }

  throw new Error(`Agent 上下文过长（保守估算 ${estimateTokens(messages)} tokens），无法在保留系统指令、原始目标和最近完整工具轮次的前提下继续`);
}

export function stepInputBudget(maxOutputTokens: number): number {
  return DEFAULT_CONTEXT_TOKENS - GATEWAY_RESERVE_TOKENS - maxOutputTokens;
}
