import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { normalizeStoryboardPrompt, requireStoryboardPrompt } from "@/lib/storyboardPrompt";
const router = express.Router();
interface Storyboard {
  id: number;
  track: string;
  src: string | null;
  associateAssetsIds: number[];
  duration: number;
  state: string;
}
export default router.post(
  "/",
  validateFields({
    prompt: z.string().nullable(),
    duration: z.number(),
    state: z.string(),
    videoDesc: z.string(),
    shouldGenerateImage: z.union([z.literal(0), z.literal(1)]),
    src: z.string().nullable(),
    scriptId: z.number(),
    projectId: z.number(),
  }),
  async (req, res) => {
    const { prompt, duration, state, src, scriptId, projectId, videoDesc, shouldGenerateImage } = req.body;
    const normalizedPrompt = shouldGenerateImage === 1 ? requireStoryboardPrompt(prompt) : normalizeStoryboardPrompt(prompt);
    const trackId = Date.now()
    await u.db("o_videoTrack").insert({
      id: trackId,
      scriptId: scriptId,
      projectId,
    });
    const [id] = await u.db("o_storyboard").insert({
      prompt: normalizedPrompt,
      duration,
      state,
      filePath: u.replaceUrl(src),
      trackId,
      videoDesc,
      shouldGenerateImage,
      scriptId: scriptId,
      projectId: projectId,
    });
    return res.status(200).send(success({ id }));
  },
);
