const vendor = {
  id: "elysium",
  version: "3.1",
  author: "Elysium",
  name: "Elysium",
  description: "Elysium 模型网关（OpenAI 风格接口）：文本、图片、视频。",
  inputs: [
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "http://127.00.0.1/v1" },
    { key: "apiKey", label: "API 密钥", type: "password", required: true, placeholder: "sk-..." },
  ],
  inputValues: { baseUrl: "http://127.00.0.1/v1", apiKey: "" },
  models: [
    { name: "Elysium Chat", modelName: "elysium-chat", type: "text", think: false },
    { name: "Elysium Image", modelName: "elysium-image", type: "image", mode: ["text"] },
    {
      name: "Elysium Video",
      modelName: "elysium-video",
      type: "video",
      mode: ["text", "singleImage"],
      audio: true,
      durationResolutionMap: [{ duration: [5, 10], resolution: ["512P", "768P", "1184P"] }],
    },
  ],
};

// 图片尺寸：网关要求宽高为 8 的倍数且不超过 2048
const dimensions = {
  "1:1": "1024x1024",
  "16:9": "1344x768",
  "9:16": "768x1344",
  "4:3": "1152x896",
  "3:4": "896x1152",
};

// 视频分辨率 → 网关 quality（low 384x512、medium 576x768、high 864x1184）
const videoQualities = { "512P": "low", "768P": "medium", "1184P": "high" };

const settings = () => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少 API 密钥");
  return {
    baseUrl: vendor.inputValues.baseUrl.replace(/\/+$/, ""),
    headers: { Authorization: `Bearer ${vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "")}` },
  };
};

// 网关错误为 OpenAI 格式：{ error: { message } }
const failure = (prefix, error) => {
  const message = error.response?.data?.error?.message || error.message;
  return new Error(`${prefix}: ${message}`);
};

const textRequest = (model, think, thinkLevel = 0, workload = "interactive") => {
  const { baseUrl, headers } = settings();
  const effortMap = { 0: "low", 1: "low", 2: "medium", 3: "xhigh" };
  const sampling = think
    ? { temperature: 1, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0 }
    : thinkLevel === 3
      ? { temperature: 0.8, top_p: 0.9, top_k: 20, min_p: 0, presence_penalty: 0.8 }
      : { temperature: 0.2, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 0 };

  return createOpenAICompatible({
    name: "elysium",
    baseURL: baseUrl,
    apiKey: headers.Authorization.slice(7),
    fetch: async (url, options) => {
      const rawBody = JSON.parse(options?.body || "{}");
      const chatTemplateKwargs = {
        ...(rawBody.chat_template_kwargs || {}),
        enable_thinking: !!think,
        ...(think ? { reasoning_effort: effortMap[thinkLevel] } : {}),
      };
      return fetch(url, {
        ...options,
        headers: { ...(options?.headers || {}), "X-Elysium-Workload": workload },
        body: JSON.stringify({ ...rawBody, ...sampling, chat_template_kwargs: chatTemplateKwargs }),
      });
    },
  }).chatModel(model.modelName);
};

const imageRequest = async (config, model) => {
  const { baseUrl, headers } = settings();
  const response = await axios
    .post(
      `${baseUrl}/images/generations`,
      { model: model.modelName, prompt: config.prompt, size: dimensions[config.aspectRatio] || dimensions["1:1"] },
      { headers, timeout: 600000 },
    )
    .catch((error) => {
      throw failure("图片生成失败", error);
    });
  const image = response.data?.data?.[0]?.b64_json;
  if (!image) throw new Error("网关未返回图片");
  return `data:image/png;base64,${image}`;
};

const videoRequest = async (config, model) => {
  const { baseUrl, headers } = settings();
  const body = {
    model: model.modelName,
    prompt: config.prompt,
    seconds: String(config.duration || 5),
    quality: videoQualities[config.resolution] || "medium",
  };
  const singleImage = config.mode === "singleImage" || (Array.isArray(config.mode) && config.mode.includes("singleImage"));
  if (singleImage) {
    const reference = (config.referenceList || []).find((item) => item.type === "image");
    if (!reference) throw new Error("图生视频需要一张首帧图片");
    body.input_reference = reference.base64;
  }

  const submitted = await axios.post(`${baseUrl}/videos`, body, { headers, timeout: 180000 }).catch((error) => {
    throw failure("视频提交失败", error);
  });
  const id = submitted.data?.id;
  if (!id) throw new Error("网关未返回视频任务 ID");

  const result = await pollTask(async () => {
    const { data } = await axios.get(`${baseUrl}/videos/${id}`, { headers, timeout: 30000 }).catch((error) => {
      throw failure("视频查询失败", error);
    });
    if (data.status === "failed") return { completed: false, error: `视频生成失败: ${data.error?.message || "未知错误"}` };
    return { completed: data.status === "completed" };
  }, 5000, 1800000);
  if (result.error) throw new Error(result.error);

  // 下载需要网关密钥，因此在这里取回并转为 Data URL
  const content = await axios
    .get(`${baseUrl}/videos/${id}/content`, { headers, responseType: "arraybuffer", timeout: 600000 })
    .catch((error) => {
      throw failure("视频下载失败", error);
    });
  return `data:video/mp4;base64,${Buffer.from(content.data).toString("base64")}`;
};

const ttsRequest = async () => "";

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
