import u from "@/utils";
import type { FlowData } from "@/agents/productionAgent/tools";

type FlowDataKey = keyof FlowData;

async function getWorkData(projectId: number, episodesId: number): Promise<Record<string, any> | null> {
  const row = await u
    .db("o_agentWorkData")
    .where("projectId", String(projectId))
    .andWhere("episodesId", String(episodesId))
    .select("data")
    .first();
  if (!row?.data) return null;
  return JSON.parse(row.data);
}

/**
 * 从 DB 读取 FlowData 的单个字段（仅 JSON 存储部分，不含 assets/storyboard 的 OSS 拼装）
 */
export async function readFlowDataField<K extends FlowDataKey>(
  projectId: number,
  episodesId: number,
  field: K,
): Promise<FlowData[K] | null> {
  if (field === "script") {
    const row = await u.db("o_script").where("projectId", projectId).where("id", episodesId).select("content").first();
    return (row?.content ?? null) as FlowData[K] | null;
  }
  const data = await getWorkData(projectId, episodesId);
  if (!data) return null;
  return (data[field] ?? null) as FlowData[K] | null;
}

/**
 * 读取 agent 快照：script + scriptPlan + assets（精简，不含图片 URL）+ storyboardTable
 */
export async function readAgentSnapshot(projectId: number, episodesId: number) {
  const data = await getWorkData(projectId, episodesId);
  const scriptRow = await u.db("o_script").where("projectId", projectId).where("id", episodesId).select("content").first();
  const script = scriptRow?.content ?? "";

  // assets: 从 DB 直接读，只保留结构信息，不拼 OSS URL
  const scriptAssets = await u.db("o_scriptAssets").where("scriptId", episodesId);
  const assetIds = scriptAssets.map((i) => i.assetId);
  const assetsData = assetIds.length
    ? await u
        .db("o_assets")
        .select("id", "name", "type", "prompt", "describe", "assetsId")
        .whereIn("id", assetIds)
        .where("assetsId", null)
        .where("projectId", projectId)
    : [];
  const childAssets = assetIds.length
    ? await u
        .db("o_assets")
        .select("id", "name", "type", "prompt", "describe", "assetsId")
        .where("projectId", projectId)
        .whereIn("assetsId", assetIds)
        .whereNotNull("assetsId")
    : [];

  const assets = assetsData.map((item) => ({
    id: item.id,
    name: item.name ?? "",
    type: item.type ?? "",
    prompt: item.prompt ?? "",
    desc: item.describe ?? "",
    derive: childAssets
      .filter((c) => c.assetsId === item.id)
      .map((c) => ({ id: c.id, assetsId: item.id, name: c.name ?? "", type: c.type, prompt: c.prompt, desc: c.describe ?? "" })),
  }));

  return {
    script,
    scriptPlan: data?.scriptPlan ?? "",
    assets,
    storyboardTable: data?.storyboardTable ?? "",
  };
}

/**
 * 将 storyboardTable 字段写回 o_agentWorkData JSON，带 read-back 验证
 */
export async function writeStoryboardTable(projectId: number, episodesId: number, value: string): Promise<void> {
  const row = await u
    .db("o_agentWorkData")
    .where("projectId", String(projectId))
    .andWhere("episodesId", String(episodesId))
    .first();

  if (!row) {
    await u.db("o_agentWorkData").insert({
      projectId,
      episodesId,
      key: "productionAgent",
      data: JSON.stringify({ script: "", scriptPlan: "", assets: [], storyboardTable: value, storyboard: [] }),
    });
  } else {
    const data = JSON.parse(row.data ?? "{}");
    data.storyboardTable = value;
    await u
      .db("o_agentWorkData")
      .where("projectId", String(projectId))
      .where("key", "productionAgent")
      .andWhere("episodesId", String(episodesId))
      .update({ data: JSON.stringify(data) });
  }

  // read-back 验证
  const check = await readFlowDataField(projectId, episodesId, "storyboardTable");
  if (!check || !check.trim()) {
    throw new Error("分镜表写入验证失败：read-back 为空");
  }
}
