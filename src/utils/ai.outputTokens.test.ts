import assert from "node:assert/strict";
import test from "node:test";
import { resolveMaxOutputTokens } from "./ai";

test("limits control agents when no output limit is configured", () => {
  assert.equal(resolveMaxOutputTokens("productionAgent:decisionAgent", null), 1024);
  assert.equal(resolveMaxOutputTokens("scriptAgent:supervisionAgent", 0), 1024);
});

test("keeps enough output budget for content agents", () => {
  assert.equal(resolveMaxOutputTokens("productionAgent:storyboardTableAgent", null), 4096);
  assert.equal(resolveMaxOutputTokens("universalAi", 0), 4096);
});

test("preserves an explicit output limit", () => {
  assert.equal(resolveMaxOutputTokens("productionAgent:decisionAgent", 2048), 2048);
});
