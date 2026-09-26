import assert from "node:assert/strict";
import test from "node:test";
import { compactStepMessages, estimateTokens } from "./aiContext";

const call = (id: string, payload: string) => ({ role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "write", input: payload }] });
const result = (id: string, payload: string) => ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "write", output: payload }] });

test("uses a conservative estimate for Chinese text", () => {
  const chinese = "中".repeat(10000);
  assert.ok(estimateTokens(chinese) >= 10000);
});

test("drops the oldest completed tool round as an indivisible pair", () => {
  const messages = [
    { role: "system", content: "系统指令" },
    { role: "user", content: "原始用户目标" },
    call("old", "旧".repeat(3000)),
    result("old", "旧结果".repeat(3000)),
    call("recent", "最近调用"),
    result("recent", "最近结果"),
  ];
  const compacted = compactStepMessages(messages, 500);
  assert.deepEqual(compacted.slice(0, 2), messages.slice(0, 2));
  assert.equal(compacted.some((message) => JSON.stringify(message).includes('"old"')), false);
  assert.equal(compacted.some((message) => JSON.stringify(message).includes('"recent"')), true);
  const resultIds = compacted.filter((message) => message.role === "tool").flatMap((message) => message.content.map((part: any) => part.toolCallId));
  const callIds = compacted.filter((message) => message.role === "assistant").flatMap((message) => message.content.map((part: any) => part.toolCallId));
  assert.deepEqual(resultIds, callIds);
});

test("fails instead of orphaning the most recent tool result", () => {
  const messages = [
    { role: "system", content: "系统指令" },
    { role: "user", content: "原始目标" },
    call("recent", "调用".repeat(3000)),
    result("recent", "结果".repeat(3000)),
  ];
  assert.throws(() => compactStepMessages(messages, 100), /无法在保留/);
});

test("rejects an orphaned tool result even when the context is small", () => {
  assert.throws(() => compactStepMessages([result("missing", "结果")], 1000), /孤立 tool result/);
});
