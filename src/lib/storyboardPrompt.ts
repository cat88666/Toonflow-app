const invalidPromptValues = new Set(["null", "undefined"]);

export function normalizeStoryboardPrompt(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const prompt = value.trim();
  if (!prompt || invalidPromptValues.has(prompt.toLowerCase())) return null;
  return prompt;
}

export function requireStoryboardPrompt(value: unknown): string {
  const prompt = normalizeStoryboardPrompt(value);
  if (!prompt || prompt.length < 20) throw new Error("分镜图提示词无效或过短，已拒绝生成");
  if (/<\/?parameter(?:=|\b)/i.test(prompt)) throw new Error("分镜图提示词包含异常 XML 参数，已拒绝生成");
  return prompt;
}
