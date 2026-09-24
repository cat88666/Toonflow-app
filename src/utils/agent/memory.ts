import u from "@/utils";
import { v4 as uuidv4 } from "uuid";
import type { memories as MemoryRow } from "@/types/database";
import { tool, jsonSchema } from "ai";
import { z } from "zod";

// ── 可调配置默认值 ──
const DEFAULTS: {
  messagesPerSummary: number;
  summaryMaxLength: number;
  shortTermLimit: number;
  summaryLimit: number;
  ragLimit: number;
  deepRetrieveSummaryLimit: number;
  embeddingEnabled: number;
} = {
  messagesPerSummary: 3, // 每累积多少条message触发一次summary生成
  summaryMaxLength: 500, // summary最大字符长度
  shortTermLimit: 5, // get()返回的近期未总结message条数
  summaryLimit: 10, // get()返回的summary条数
  ragLimit: 3, // get()向量相似搜索返回的message条数
  deepRetrieveSummaryLimit: 5, // deepRetrieve()向量召回summary的条数
  embeddingEnabled: 0, // 是否启用本地 ONNX 向量检索
};

// ── 向量搜索辅助 ──
function vectorSearch(rows: MemoryRow[], queryEmbedding: number[], limit: number) {
  return rows
    .map((row) => {
      try {
        const embedding: number[] = JSON.parse(row.embedding ?? "[]");
        if (embedding.length !== queryEmbedding.length) return null;
        const similarity = queryEmbedding.reduce((dot, value, index) => dot + value * embedding[index], 0);
        return { ...row, similarity };
      } catch {
        return null;
      }
    })
    .filter((row): row is MemoryRow & { similarity: number } => row !== null)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

async function getEmbedding(text: string): Promise<number[]> {
  const embedding = await import("./embedding");
  return embedding.getEmbedding(text);
}

class Memory {
  private agentType: string;
  private isolationKey: string;

  constructor(agentType: string, isolationKey: string) {
    this.agentType = agentType;
    this.isolationKey = isolationKey;
  }

  private async generateSummary(contents: string[]): Promise<string> {
    const { summaryMaxLength } = await this.getConfigData({ summaryMaxLength: DEFAULTS.summaryMaxLength });
    const { text } = await u.Ai.Text(this.agentType as any).invoke({
      system: `你是一个记忆压缩助手。请将以下多条记忆内容压缩为一段简洁的摘要，不超过${summaryMaxLength}个字符。只输出摘要内容，不要加任何前缀或解释。`,
      messages: [{ role: "user", content: contents.map((c, i) => `${i + 1}. ${c}`).join("\n") }],
    });
    return text.slice(0, Number(summaryMaxLength));
  }

  private async judgeSummaryRelevance(keyword: string, summaries: { id: string; content: string }[]): Promise<string[]> {
    const list = summaries.map((s) => `[${s.id}] ${s.content}`).join("\n");
    const { text } = await u.Ai.Text(this.agentType as any).invoke({
      system:
        '你是一个信息检索助手。用户会给你一个关键词和一组摘要，请判断哪些摘要可能包含与关键词相关的详细信息。只返回相关摘要的id列表，用JSON数组格式，例如 ["id1","id2"]。不要解释。',
      messages: [{ role: "user", content: `关键词: ${keyword}\n\n摘要列表:\n${list}` }],
    });
    try {
      const ids = JSON.parse(text);
      if (Array.isArray(ids)) return ids.map(String);
    } catch {}
    return [];
  }
  private async getConfigData<T extends Record<string, string | number>>(defaults: T): Promise<T> {
    const keys = Object.keys(defaults) as (keyof T & string)[];
    const rows = await u.db("o_setting").whereIn("key", keys);

    const dbMap: Record<string, string | null> = {};
    for (const row of rows) {
      if (row.key != null) dbMap[row.key] = row.value ?? null;
    }

    const result = { ...defaults };
    for (const key of keys) {
      const raw = dbMap[key];
      if (raw == null) continue; // null / undefined 使用默认值
      const num = Number(raw);
      (result as Record<string, string | number>)[key] = Number.isNaN(num) ? raw : num;
    }
    return result;
  }

  async add(role: string = "user", content: string, options?: { name?: string; createTime?: number }) {
    const { messagesPerSummary, embeddingEnabled } = await this.getConfigData({
      messagesPerSummary: DEFAULTS.messagesPerSummary,
      embeddingEnabled: DEFAULTS.embeddingEnabled,
    });
    const id = uuidv4();
    const embedding = Number(embeddingEnabled) === 1 ? await getEmbedding(content) : null;
    const isolationKey = this.isolationKey;

    await u.db("memories").insert({
      id,
      isolationKey,
      type: "message",
      role,
      name: options?.name,
      content,
      embedding: embedding ? JSON.stringify(embedding) : null,
      relatedMessageIds: null,
      summarized: 0,
      createTime: options?.createTime ?? Date.now(),
    } as any);

    // 检查未总结消息数量
    const unsummarized = await u.db("memories").where({ isolationKey, type: "message", summarized: 0 }).orderBy("createTime", "asc");

    if (unsummarized.length >= Number(messagesPerSummary)) {
      const batch = unsummarized.slice(0, Number(messagesPerSummary));
      const batchIds = batch.map((m) => m.id);
      const batchContents = batch.map((m) => m.content);

      const summaryContent = await this.generateSummary(batchContents);
      const summaryEmbedding = Number(embeddingEnabled) === 1 ? await getEmbedding(summaryContent) : null;
      const summaryId = uuidv4();

      await u.db("memories").insert({
        id: summaryId,
        isolationKey,
        type: "summary",
        content: summaryContent,
        embedding: summaryEmbedding ? JSON.stringify(summaryEmbedding) : null,
        relatedMessageIds: JSON.stringify(batchIds),
        summarized: 0,
        createTime: Date.now(),
      } as any);

      // 标记已总结
      await u.db("memories").whereIn("id", batchIds).update({ summarized: 1 });
    }
  }

  async get(text: string) {
    const { shortTermLimit, summaryLimit, ragLimit, embeddingEnabled } = await this.getConfigData({
      shortTermLimit: DEFAULTS.shortTermLimit,
      summaryLimit: DEFAULTS.summaryLimit,
      ragLimit: DEFAULTS.ragLimit,
      embeddingEnabled: DEFAULTS.embeddingEnabled,
    });

    const isolationKey = this.isolationKey;
    // shortTerm: 最近未被总结的 messages
    const shortTerm = await u
      .db("memories")
      .where({ isolationKey, type: "message", summarized: 0 })
      .orderBy("createTime", "desc")
      .limit(Number(shortTermLimit));
    shortTerm.reverse(); // 最旧在前

    // summaries: 最近的 summary
    const summaries = await u.db("memories").where({ isolationKey, type: "summary" }).orderBy("createTime", "desc").limit(Number(summaryLimit));
    summaries.reverse();

    let ragResults: ReturnType<typeof vectorSearch> = [];
    if (Number(embeddingEnabled) === 1) {
      const queryEmbedding = await getEmbedding(text);
      const allMessages = await u.db("memories").where({ isolationKey, type: "message" }).whereNotNull("embedding");
      ragResults = vectorSearch(allMessages, queryEmbedding, Number(ragLimit));
    }

    return {
      shortTerm: shortTerm.map((m: any) => ({ id: m.id, role: m.role, name: m.name, content: m.content, createTime: m.createTime })),
      summaries: summaries.map((s) => ({
        id: s.id,
        content: s.content,
        relatedMessageIds: JSON.parse(s.relatedMessageIds || "[]"),
        createTime: (s as any).createTime,
      })),
      rag: ragResults.map((r) => ({ id: r.id, content: r.content, similarity: r.similarity })),
    };
  }

  async deepRetrieve(keyword: string) {
    const { deepRetrieveSummaryLimit, embeddingEnabled } = await this.getConfigData({
      deepRetrieveSummaryLimit: DEFAULTS.deepRetrieveSummaryLimit,
      embeddingEnabled: DEFAULTS.embeddingEnabled,
    });

    const isolationKey = this.isolationKey;
    const allSummaries = await u.db("memories").where({ isolationKey, type: "summary" }).orderBy("createTime", "desc");
    const topSummaries =
      Number(embeddingEnabled) === 1
        ? vectorSearch(allSummaries, await getEmbedding(keyword), Number(deepRetrieveSummaryLimit))
        : allSummaries.slice(0, Number(deepRetrieveSummaryLimit));

    if (topSummaries.length === 0) return [];

    // 步骤2: AI 判断相关性
    const relevantIds = await this.judgeSummaryRelevance(
      keyword,
      topSummaries.map((s) => ({ id: s.id!, content: s.content })),
    );

    if (relevantIds.length === 0) return [];

    // 步骤3: 展开查询原始 messages
    const relevantSummaries = topSummaries.filter((s) => relevantIds.includes(s.id!));
    const messageIds = relevantSummaries.flatMap((s) => JSON.parse(s.relatedMessageIds || "[]") as string[]);

    if (messageIds.length === 0) return [];

    const messages = await u.db("memories").whereIn("id", messageIds).orderBy("createTime", "asc");

    return messages.map((m) => ({ id: m.id, content: m.content, createTime: m.createTime }));
  }

  getTools() {
    return {
      deepRetrieve: tool({
        description: "深度检索记忆：当你需要回忆与某个关键词相关的详细历史信息时使用此工具",
        inputSchema: jsonSchema<{ keyword: string }>(
          z
            .object({
              keyword: z.string().describe("要检索的关键词"),
            })
            .toJSONSchema(),
        ),
        execute: async ({ keyword }) => {
          const results = await this.deepRetrieve(keyword);
          if (results.length === 0) return { found: false, message: "未找到相关记忆" };
          return { found: true, memories: results.map((r) => r.content) };
        },
      }),
    };
  }
}

export default Memory;
