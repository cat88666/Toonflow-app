import assert from "node:assert/strict";
import test from "node:test";
import { normalizeStoryboardPrompt, requireStoryboardPrompt, storyboardPromptForClient } from "./storyboardPrompt";

test("normalizes missing prompt sentinels", () => {
  for (const value of [null, undefined, "", "   ", "null", " NULL ", "undefined"]) {
    assert.equal(normalizeStoryboardPrompt(value), null);
  }
});

test("keeps and trims a valid prompt", () => {
  assert.equal(normalizeStoryboardPrompt("  a valid storyboard image prompt  "), "a valid storyboard image prompt");
});

test("serializes a missing prompt as an empty string for client-side ID matching", () => {
  assert.equal(storyboardPromptForClient(null), "");
  assert.equal(storyboardPromptForClient("  valid prompt  "), "valid prompt");
});

test("rejects prompts that must not reach image generation", () => {
  for (const value of [null, "null", "short", "<parameter=prompt>broken</parameter>"]) {
    assert.throws(() => requireStoryboardPrompt(value));
  }
});

test("accepts a complete storyboard prompt", () => {
  assert.equal(requireStoryboardPrompt("A complete cinematic storyboard prompt for generation"), "A complete cinematic storyboard prompt for generation");
});
