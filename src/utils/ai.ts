import { generateText, streamText, wrapLanguageModel, stepCountIs, extractReasoningMiddleware } from "ai";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import axios from "axios";
import crypto from "node:crypto";
import sharp from "sharp";
import u from "@/utils";
import { normalizeStoryboardPrompt } from "@/lib/storyboardPrompt";

type AiType =
  | "scriptAgent"
  | "productionAgent"
  | "universalAi"
  | "scriptAgent:decisionAgent"
  | "scriptAgent:supervisionAgent"
  | "scriptAgent:storySkeletonAgent"
  | "scriptAgent:adaptationStrategyAgent"
  | "scriptAgent:scriptAgent"
  | "productionAgent:decisionAgent"
  | "productionAgent:supervisionAgent"
  | "productionAgent:deriveAssetsAgent"
  | "productionAgent:generateAssetsAgent"
  | "productionAgent:directorPlanAgent"
  | "productionAgent:storyboardGenAgent"
  | "productionAgent:storyboardPanelAgent"
  | "productionAgent:storyboardTableAgent";

type FnName = "textRequest" | "imageRequest" | "videoRequest" | "ttsRequest";

const AiTypeValues: AiType[] = [
  "scriptAgent",
  "productionAgent",
  "universalAi",
  "scriptAgent:decisionAgent",
  "scriptAgent:supervisionAgent",
  "scriptAgent:storySkeletonAgent",
  "scriptAgent:adaptationStrategyAgent",
  "scriptAgent:scriptAgent",
  "productionAgent:decisionAgent",
  "productionAgent:supervisionAgent",
  "productionAgent:deriveAssetsAgent",
  "productionAgent:generateAssetsAgent",
  "productionAgent:directorPlanAgent",
  "productionAgent:storyboardGenAgent",
  "productionAgent:storyboardPanelAgent",
  "productionAgent:storyboardTableAgent",
];

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const CONTROL_AGENT_MAX_OUTPUT_TOKENS = 1024;

export function resolveMaxOutputTokens(aiType: AiType | `${string}:${string}`, configured?: number | null) {
  if (configured && configured > 0) return configured;
  if (aiType.endsWith(":decisionAgent") || aiType.endsWith(":supervisionAgent")) return CONTROL_AGENT_MAX_OUTPUT_TOKENS;
  return DEFAULT_MAX_OUTPUT_TOKENS;
}

async function getUsableTextModel(modelName?: string | null) {
  if (!modelName) return null;
  const [vendorId, name] = modelName.split(/:(.+)/);
  if (!vendorId || !name) return null;
  const vendor = await u.db("o_vendorConfig").where({ id: vendorId, enable: 1 }).first();
  if (!vendor) return null;
  const model = (await u.vendor.getModelList(vendorId)).find((item: any) => item.modelName === name && item.type === "text");
  return model ? { vendorId, model } : null;
}

async function findFallbackTextModel() {
  const configured = await u.db("o_agentDeploy").whereNotNull("modelName").whereNot("modelName", "").orderBy("id");
  for (const item of configured) {
    const usable = await getUsableTextModel(item.modelName);
    if (usable) return usable;
  }

  const vendors = await u.db("o_vendorConfig").where("enable", 1).orderBy("id");
  for (const vendor of vendors) {
    const model = (await u.vendor.getModelList(vendor.id!)).find((item: any) => item.type === "text");
    if (model) return { vendorId: vendor.id!, model };
  }
  return null;
}

async function resolveAgentModelConfig(value: AiType) {
  const agentUseMode = await u.db("o_setting").where("key", "agentUseMode").first();
  const key = agentUseMode?.value === "1" ? value : value.split(/:(.+)/)[0];
  const config = await u.db("o_agentDeploy").where("key", key).first();
  if (!config) throw new Error(`未找到 AI 配置项：${key}`);
  if (await getUsableTextModel(config.modelName)) return config;

  const fallback = await findFallbackTextModel();
  if (!fallback) throw new Error("没有可用的文本模型，请先在供应商配置中启用并配置一个文本模型");

  const repaired = {
    model: fallback.model.modelName,
    modelName: `${fallback.vendorId}:${fallback.model.modelName}`,
    vendorId: fallback.vendorId,
  };
  await u.db("o_agentDeploy").where("id", config.id).update(repaired);
  return { ...config, ...repaired };
}

async function resolveModelName(value: AiType | `${string}:${string}`): Promise<`${string}:${string}`> {
  if (AiTypeValues.includes(value as AiType)) {
    const config = await resolveAgentModelConfig(value as AiType);
    return config.modelName as `${string}:${string}`;
  }
  return value as `${string}:${string}`;
}

async function getModelConfig(value: AiType | `${string}:${string}`) {
  if (AiTypeValues.includes(value as AiType)) {
    return resolveAgentModelConfig(value as AiType);
  }
  return null;
}

async function getVendorTemplateFn(
  fnName: "textRequest",
  modelName: `${string}:${string}`,
): Promise<(think?: boolean, thinkLevel?: 0 | 1 | 2 | 3) => any>;
async function getVendorTemplateFn(fnName: Exclude<FnName, "textRequest">, modelName: `${string}:${string}`): Promise<(input: any) => any>;
async function getVendorTemplateFn(fnName: FnName, modelName: `${string}:${string}`): Promise<any> {
  const [id, name] = modelName.split(/:(.+)/);
  const vendorConfigData = await u.db("o_vendorConfig").where("id", id).first();
  if (!vendorConfigData) throw new Error(`未找到供应商配置 id=${id}`);
  const modelList = await u.vendor.getModelList(id);
  const selectedModel = modelList.find((i: any) => i.modelName == name);
  if (!selectedModel) throw new Error(`未找到模型 ${name} id=${id}`);
  const running = u.vm(u.vendor.getJsCode(id));
  if (running.vendor) {
    Object.assign(running.vendor.inputValues, JSON.parse(vendorConfigData.inputValues ?? "{}"));
    running.vendor.models = modelList;
  }
  const fn = running[fnName];
  if (!fn) throw new Error(`未找到供应商配置中的函数 ${fnName} id=${id}`);
  if (fnName == "textRequest")
    return (think?: boolean, thinkLevel: 0 | 1 | 2 | 3 = 0) => {
      const effectiveThink = think ?? !!selectedModel.think;
      return fn(selectedModel, effectiveThink, thinkLevel);
    };
  else return <T>(input: T) => fn(input, selectedModel);
}

async function withTaskRecord<T>(
  modelKey: AiType | `${string}:${string}`,
  taskClass: string,
  describe: string,
  relatedObjects: string,
  projectId: number,
  fn: (modelName: `${string}:${string}`, think: Boolean, thinkLevel: 0 | 1 | 2 | 3) => Promise<T>,
): Promise<T> {
  const modelName = await resolveModelName(modelKey);
  const [_, model] = modelName.split(/:(.+)/);
  const taskRecord = await u.task(projectId, taskClass, model, { describe: describe, content: relatedObjects });
  try {
    const result = await fn(modelName, false, 0);

    taskRecord(1);
    return result;
  } catch (e) {
    taskRecord(-1, u.error(e).message);
    throw new Error(u.error(e).message);
  }
}

async function urlToBase64(url: string, retries = 3, delay = 1000): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, { responseType: "arraybuffer" });
      const base64 = Buffer.from(res.data).toString("base64");
      return `${base64}`;
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise((resolve) => setTimeout(resolve, delay * attempt));
    }
  }
  throw new Error("urlToBase64 failed");
}
class AiText {
  private AiType: AiType | `${string}:${string}`;
  private think?: boolean;
  private thinkLevel: 0 | 1 | 2 | 3;
  constructor(AiType: AiType | `${string}:${string}`, think?: boolean, thinkLevel: 0 | 1 | 2 | 3 = 0) {
    this.AiType = AiType;
    this.think = think;
    this.thinkLevel = thinkLevel;
  }
  private async resolveModel(middleware?: any | any[]) {
    const switchAiDevTool = await u.db("o_setting").where("key", "switchAiDevTool").first();
    const modelName = await resolveModelName(this.AiType);
    const sdkFn = await getVendorTemplateFn("textRequest", modelName);
    const baseModel = await sdkFn(this.think, this.thinkLevel);
    const mws = [
      ...(switchAiDevTool?.value === "1" ? [devToolsMiddleware()] : []),
      ...(middleware ? (Array.isArray(middleware) ? middleware : [middleware]) : []),
    ];
    return mws.length > 0 ? wrapLanguageModel({ model: baseModel, middleware: mws.length === 1 ? mws[0] : mws }) : baseModel;
  }
  async invoke(input: Omit<Parameters<typeof generateText>[0], "model">) {
    const config = await getModelConfig(this.AiType);
    const maxOutputTokens = resolveMaxOutputTokens(this.AiType, config?.maxOutputTokens);

    return generateText({
      ...(input.tools && { stopWhen: stepCountIs(Object.keys(input.tools).length * 50) }),
      ...input,
      model: await this.resolveModel(),
      ...(config?.temperature && { temperature: config.temperature }),
      maxOutputTokens,
    } as Parameters<typeof generateText>[0]);
  }
  async stream(input: Omit<Parameters<typeof streamText>[0], "model">) {
    const config = await getModelConfig(this.AiType);
    const maxOutputTokens = resolveMaxOutputTokens(this.AiType, config?.maxOutputTokens);

    return streamText({
      ...(input.tools && { stopWhen: stepCountIs(Object.keys(input.tools).length * 50) }),
      ...input,
      model: await this.resolveModel(extractReasoningMiddleware({ tagName: "reasoning_content", separator: "\n" })),
      ...(config?.temperature && { temperature: config.temperature }),
      maxOutputTokens,
    } as Parameters<typeof streamText>[0]);
  }
}

function referenceList2imageBase642(id: string, input: any) {
  const version = u.vendor.getVendor(id).version;
  if (!version || isNaN(parseFloat(version)) || parseFloat(version) < 2.0) {
    input.imageBase64 = input.referenceList.map((item: any) => item.base64);
    return input;
  }
  return input;
}

export type ReferenceList = { type: "image"; base64: string } | { type: "audio"; base64: string } | { type: "video"; base64: string };

interface ImageConfig {
  prompt: string;
  referenceList?: Extract<ReferenceList, { type: "image" }>[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

interface TaskRecord {
  taskClass: string; // 任务分类
  describe: string; // 任务描述
  relatedObjects: string; // 相关对象信息，便于后续分析和追踪
  projectId: number; // 项目ID
}

const recentImageResults = new Map<string, string>();

export async function validateImageResult(result: string, promptValue: unknown) {
  const prompt = normalizeStoryboardPrompt(promptValue);
  if (!prompt) throw new Error("图片提示词为空或无效，已拒绝调用模型");
  if (!result) throw new Error("图片模型未返回图片数据");

  const buffer = Buffer.from(result.replace(/^data:[^;]+;base64,/, ""), "base64");
  if (!buffer.length) throw new Error("图片模型返回了空图片数据");

  let metadata: sharp.Metadata;
  let stats: sharp.Stats;
  try {
    const image = sharp(buffer, { failOn: "error" });
    [metadata, stats] = await Promise.all([image.metadata(), image.stats()]);
  } catch {
    throw new Error("图片模型返回的数据无法解码");
  }

  if (!metadata.width || !metadata.height || metadata.width < 64 || metadata.height < 64) {
    throw new Error("图片模型返回的图片尺寸异常");
  }
  const colorChannels = stats.channels.slice(0, 3);
  if (colorChannels.length && colorChannels.every((channel) => channel.mean <= 3 && channel.stdev <= 3)) {
    throw new Error("图片模型返回了近乎纯黑的异常图片");
  }
  if (metadata.hasAlpha && stats.channels.at(-1)?.mean === 0) {
    throw new Error("图片模型返回了完全透明的异常图片");
  }

  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  const previousPrompt = recentImageResults.get(hash);
  if (previousPrompt && previousPrompt !== prompt) {
    throw new Error("图片模型对不同提示词返回了完全相同的异常图片");
  }
  recentImageResults.set(hash, prompt);
  if (recentImageResults.size > 100) recentImageResults.delete(recentImageResults.keys().next().value!);

  return buffer;
}

class AiImage {
  private key: `${string}:${string}`;
  private result: string = "";
  constructor(key: `${string}:${string}`) {
    this.key = key;
  }
  async run(input: ImageConfig, taskRecord?: TaskRecord) {
    const modelName = await resolveModelName(this.key);
    const exec = async (mn: `${string}:${string}`) => {
      const prompt = normalizeStoryboardPrompt(input.prompt);
      if (!prompt) throw new Error("图片提示词为空或无效，已拒绝调用模型");
      input.prompt = prompt;
      const fn = await getVendorTemplateFn("imageRequest", mn);
      await referenceList2imageBase642(mn.split(/:(.+)/)[0], input);
      this.result = await fn(input);
      if (this.result.startsWith("http")) this.result = await urlToBase64(this.result);
      await validateImageResult(this.result, input.prompt);
      return this;
    };
    if (taskRecord) {
      await withTaskRecord(this.key, taskRecord.taskClass, taskRecord.describe, taskRecord.relatedObjects, taskRecord.projectId, exec);
      return this;
    }
    await exec(modelName);
    return this;
  }
  async save(path: string) {
    await u.oss.writeFile(path, this.result);
    return this;
  }
}

type VideoMode =
  | "singleImage" //单图参考
  | "startEndRequired" //首尾帧（两张都得有）
  | "endFrameOptional" //首尾帧（尾帧可选）
  | "startFrameOptional" //首尾帧（首帧可选）
  | "text" //文本
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[]; //多参考（数字代表限制数量）

interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  referenceList?: ReferenceList[];
  audio?: boolean;
  mode: VideoMode[];
}

class AiVideo {
  private key: `${string}:${string}`;
  private result: string = "";
  constructor(key: `${string}:${string}`) {
    this.key = key;
  }
  async run(input: VideoConfig, taskRecord?: TaskRecord) {
    const modelName = await resolveModelName(this.key);
    try {
      const exec = async (mn: `${string}:${string}`) => {
        const fn = await getVendorTemplateFn("videoRequest", mn);
        await referenceList2imageBase642(mn.split(/:(.+)/)[0], input);

        this.result = await fn(input);

        if (this.result.startsWith("http")) this.result = await urlToBase64(this.result);
      };
      if (taskRecord) {
        await withTaskRecord(this.key, taskRecord.taskClass, taskRecord.describe, taskRecord.relatedObjects, taskRecord.projectId, exec);
        return this;
      }
      await exec(modelName);
      return this;
    } catch (e) {
      throw e;
    }
  }
  async save(path: string) {
    await u.oss.writeFile(path, this.result);
    return this;
  }
}
class AiAudio {
  private key: `${string}:${string}`;
  private result: string = "";
  constructor(key: `${string}:${string}`) {
    this.key = key;
  }
  async run(input: VideoConfig, taskRecord?: TaskRecord) {
    const modelName = await resolveModelName(this.key);
    const exec = async (mn: `${string}:${string}`) => {
      try {
        const fn = await getVendorTemplateFn("ttsRequest", mn);
        await referenceList2imageBase642(mn.split(/:(.+)/)[0], input);
        this.result = await fn(input);

        if (this.result.startsWith("http")) this.result = await urlToBase64(this.result);
        return this;
      } catch (e) {}
    };
    if (taskRecord) {
      return withTaskRecord(this.key, taskRecord.taskClass, taskRecord.describe, taskRecord.relatedObjects, taskRecord.projectId, exec);
    }
    return await exec(modelName);
  }
  async save(path: string) {
    await u.oss.writeFile(path, this.result);
    return this;
  }
}

export default {
  Text: (AiType: AiType | `${string}:${string}`, think?: boolean, thinkLevel?: 0 | 1 | 2 | 3) => new AiText(AiType, think, thinkLevel),
  Image: (key: `${string}:${string}`) => new AiImage(key),
  Video: (key: `${string}:${string}`) => new AiVideo(key),
  Audio: (key: `${string}:${string}`) => new AiAudio(key),
};
