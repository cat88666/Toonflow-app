const vendor = {
  id: "elysium",
  version: "2.0",
  author: "Elysium",
  name: "Elysium ComfyUI",
  description: "直连 Elysium ComfyUI 的 RealVisXL 图片与 MiniMax H3 视频服务。",
  inputs: [{ key: "baseUrl", label: "请求地址", type: "url", required: true }],
  inputValues: { baseUrl: "http://43.154.247.11/comfy" },
  models: [
    { name: "RealVisXL V5", modelName: "realvisxl-v5", type: "image", mode: ["text"] },
    {
      name: "MiniMax H3",
      modelName: "minimax-h3",
      type: "video",
      mode: ["text", "singleImage"],
      audio: true,
      durationResolutionMap: [{ duration: [5], resolution: ["768P"] }],
    },
  ],
};

const dimensions = {
  "1:1": [1024, 1024],
  "16:9": [1344, 768],
  "9:16": [768, 1344],
  "4:3": [1152, 896],
  "3:4": [896, 1152],
};

const textRequest = () => null;

const imageRequest = async (config, model) => {
  const baseUrl = vendor.inputValues.baseUrl.replace(/\/+$/, "");
  const [width, height] = dimensions[config.aspectRatio] || dimensions["1:1"];
  const workflow = {
    "3": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "RealVisXL_V5.0_fp16.safetensors" },
    },
    "4": {
      class_type: "KSampler",
      inputs: {
        seed: Date.now() % 2147483647,
        steps: 25,
        cfg: 7,
        sampler_name: "dpmpp_2m",
        scheduler: "karras",
        denoise: 1,
        model: ["3", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width, height, batch_size: 1 },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: config.prompt, clip: ["3", 1] },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: "low quality, blurry, distorted, deformed, watermark, text, logo",
        clip: ["3", 1],
      },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: { samples: ["4", 0], vae: ["3", 2] },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "toonflow", images: ["8", 0] },
    },
  };

  const submitResponse = await fetch(`${baseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow }),
  });
  if (!submitResponse.ok) {
    throw new Error(`ComfyUI 提交失败: ${submitResponse.status} ${await submitResponse.text()}`);
  }
  const submitted = await submitResponse.json();
  if (!submitted.prompt_id) throw new Error("ComfyUI 未返回 prompt_id");

  const result = await pollTask(async () => {
    const historyResponse = await fetch(`${baseUrl}/history/${submitted.prompt_id}`);
    if (!historyResponse.ok) {
      throw new Error(`ComfyUI 查询失败: ${historyResponse.status} ${await historyResponse.text()}`);
    }
    const history = await historyResponse.json();
    const record = history[submitted.prompt_id];
    const image = record && record.outputs && record.outputs["9"] && record.outputs["9"].images && record.outputs["9"].images[0];
    if (!image) return { completed: false };
    const url = `${baseUrl}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder || "")}&type=${encodeURIComponent(image.type || "output")}`;
    return { completed: true, data: url };
  }, 2000, 300000);

  if (result.error) throw new Error(result.error);
  if (!result.data) throw new Error("ComfyUI 图片生成超时");
  return result.data;
};

const h3Graph = {
  n105_15: { class_type: "RandomNoise", inputs: { noise_seed: 833238321491842 } },
  n105_6: {
    class_type: "UNETLoader",
    inputs: { unet_name: "DasiwaMinimaxH3_dasiwaHybrid4turboV1.safetensors", weight_dtype: "default" },
  },
  n105_206: { class_type: "MiniMaxH3SigmaShift", inputs: { shift_video: 6, shift_audio: 3, model: ["n105_6", 0] } },
  n105_13: {
    class_type: "CLIPLoader",
    inputs: { clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", type: "minimax", device: "default" },
  },
  n105_11: { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" } },
  n105_104: {
    class_type: "MiniMaxH3ImageToVideo",
    inputs: { prompt: "", width: 576, height: 768, length: 124, clip: ["n105_13", 0], vae: ["n105_11", 0] },
  },
  n105_16: { class_type: "BasicGuider", inputs: { model: ["n105_206", 0], conditioning: ["n105_104", 0] } },
  n105_155: { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
  n105_9: { class_type: "BasicScheduler", inputs: { scheduler: "simple", steps: 8, denoise: 1, model: ["n105_206", 0] } },
  n105_14: {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      noise: ["n105_15", 0],
      guider: ["n105_16", 0],
      sampler: ["n105_155", 0],
      sigmas: ["n105_9", 0],
      latent_image: ["n105_104", 1],
    },
  },
  n105_10: { class_type: "VAEDecode", inputs: { samples: ["n105_14", 0], vae: ["n105_11", 0] } },
  n105_24: { class_type: "VAELoader", inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" } },
  n105_23: { class_type: "VAEDecodeAudio", inputs: { samples: ["n105_14", 0], vae: ["n105_24", 0] } },
  n126: {
    class_type: "DaSiWa_EnhancedVideoCombine",
    inputs: {
      images: ["n105_10", 0],
      frame_rate: 24,
      codec: "H.264",
      container: "MP4",
      bit_depth: "8-bit",
      quality: 20,
      log_level: "Standard",
      pingpong: false,
      save_metadata: true,
      filename_prefix: "toonflow/minimax-h3",
      save_output: true,
      pass_frames: false,
      crop_to_audio: false,
      audio_codec: "AAC",
      audio_bitrate: "192k",
      save_first_frame: false,
      save_last_frame: false,
      audio: ["n105_23", 0],
    },
  },
};

const uploadComfyImage = async (baseUrl, reference) => {
  const match = reference.base64.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("首帧不是有效的 Base64 图片");
  const extension = match[1] === "image/png" ? "png" : "jpg";
  const form = new FormData();
  form.append("image", Buffer.from(match[2], "base64"), {
    filename: `toonflow-first-frame.${extension}`,
    contentType: match[1],
  });
  form.append("overwrite", "true");
  const response = await axios.post(`${baseUrl}/upload/image`, form, { headers: form.getHeaders() });
  return [response.data.subfolder, response.data.name].filter(Boolean).join("/");
};

const videoRequest = async (config, model) => {
  const baseUrl = vendor.inputValues.baseUrl.replace(/\/+$/, "");
  const graph = JSON.parse(JSON.stringify(h3Graph));
  graph.n105_104.inputs.prompt = config.prompt;
  graph.n105_15.inputs.noise_seed = Date.now() % 1125899906842624;
  graph.n126.inputs.filename_prefix = `toonflow/minimax-h3-${Date.now()}`;

  const singleImage = config.mode === "singleImage" || (Array.isArray(config.mode) && config.mode.includes("singleImage"));
  if (singleImage) {
    const reference = (config.referenceList || []).find((item) => item.type === "image");
    if (!reference) throw new Error("图生视频需要一张首帧图片");
    const image = await uploadComfyImage(baseUrl, reference);
    graph.elysium_first_frame = { class_type: "LoadImage", inputs: { image } };
    graph.n105_104.inputs.first_frame = ["elysium_first_frame", 0];
  }

  const submitResponse = await fetch(`${baseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph }),
  });
  if (!submitResponse.ok) {
    throw new Error(`ComfyUI 视频提交失败: ${submitResponse.status} ${await submitResponse.text()}`);
  }
  const submitted = await submitResponse.json();
  if (!submitted.prompt_id) throw new Error("ComfyUI 未返回视频 prompt_id");

  const result = await pollTask(async () => {
    const historyResponse = await fetch(`${baseUrl}/history/${submitted.prompt_id}`);
    if (!historyResponse.ok) {
      throw new Error(`ComfyUI 视频查询失败: ${historyResponse.status} ${await historyResponse.text()}`);
    }
    const history = await historyResponse.json();
    const record = history[submitted.prompt_id];
    if (!record) return { completed: false };
    if (record.status && record.status.status_str === "error") {
      throw new Error(`ComfyUI 视频生成失败: ${JSON.stringify(record.status.messages || [])}`);
    }
    const output = record.outputs && record.outputs.n126;
    const media = output && [output.gifs, output.videos, output.files, output.images].filter(Boolean).flat()[0];
    if (media && media.filename) {
      const url = `${baseUrl}/view?filename=${encodeURIComponent(media.filename)}&subfolder=${encodeURIComponent(media.subfolder || "")}&type=${encodeURIComponent(media.type || "output")}`;
      return { completed: true, data: url };
    }
    const serialized = JSON.stringify(output || {});
    const match = serialized.match(/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:mp4|webm|mkv)/i);
    if (!match) return { completed: false };
    const parts = match[0].split("/");
    const filename = parts.pop();
    const url = `${baseUrl}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(parts.join("/"))}&type=output`;
    return { completed: true, data: url };
  }, 5000, 900000);

  if (result.error) throw new Error(result.error);
  if (!result.data) throw new Error("ComfyUI 视频生成超时");
  return result.data;
};
const ttsRequest = async () => "";

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
