import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { validateImageResult } from "./ai";

async function pngDataUrl(buffer: Buffer) {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

test("rejects a near-black image", async () => {
  const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
  await assert.rejects(validateImageResult(await pngDataUrl(image), "a valid image prompt"), /近乎纯黑/);
});

test("accepts a dark image with visible detail", async () => {
  const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 2, g: 2, b: 2 } } })
    .composite([{ input: await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: 80, g: 30, b: 20 } } }).png().toBuffer(), left: 20, top: 20 }])
    .png()
    .toBuffer();
  await assert.doesNotReject(validateImageResult(await pngDataUrl(image), "a detailed dark cinematic scene"));
});

test("rejects identical output returned for different prompts", async () => {
  const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 60, g: 80, b: 100 } } }).png().toBuffer();
  const result = await pngDataUrl(image);
  await validateImageResult(result, "first unique prompt");
  await assert.rejects(validateImageResult(result, "second unique prompt"), /完全相同/);
});
