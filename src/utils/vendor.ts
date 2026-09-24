import { transform } from "sucrase";
import fs from "fs";
import path from "path";
import u from "@/utils";

export function writeCode(id: string | number, tsCode: string) {
  const rootDir = u.getPath("vendor")
  fs.mkdirSync(rootDir, { recursive: true })
  if (fs.existsSync(path.join(rootDir,  `${id}.ts`))) {
    fs.writeFileSync(path.join(rootDir,  `${id}.ts`), tsCode);
  }
  fs.writeFileSync(path.join(rootDir,  `${id}.ts`), tsCode);
  cache.delete(String(id));
}

export function getCode(id: string): string {
  const rootDir = u.getPath("vendor");
  const targetFile = path.join(rootDir, `${id}.ts`);
  if (!fs.existsSync(targetFile)) return "";
  return fs.readFileSync(targetFile, "utf-8");
}

// 按文件 mtime 缓存编译结果和只读的 vendor 导出，避免每次调用都重新 transform + 创建 vm2 沙箱
const cache = new Map<string, { mtimeMs: number; jsCode: string; exports: Record<string, any> }>();

function load(id: string) {
  const targetFile = path.join(u.getPath("vendor"), `${id}.ts`);
  const mtimeMs = fs.existsSync(targetFile) ? fs.statSync(targetFile).mtimeMs : -1;
  const hit = cache.get(id);
  if (hit && hit.mtimeMs === mtimeMs) return hit;
  const jsCode = transform(getCode(id), { transforms: ["typescript"] }).code;
  const entry = { mtimeMs, jsCode, exports: u.vm(jsCode) };
  cache.set(id, entry);
  return entry;
}

// 返回编译后的 JS；需要修改 vendor 状态的调用方应自行 u.vm(jsCode) 创建独立沙箱
export function getJsCode(id: string): string {
  return load(id).jsCode;
}

export async function getModelList(id: string): Promise<Array<any>> {
  const models = await u.db("o_vendorConfig").where("id", id).select("models").first();
  if (!models || !models.models) return [];
  const vendorData = load(id).exports;
  if(!vendorData || !vendorData.vendor || !vendorData.vendor.models) return [];
  const combined = [...JSON.parse(JSON.stringify(vendorData.vendor.models)), ...JSON.parse(models?.models ?? "[]")];
  const map = new Map<string, any>();
  for (const m of combined) {
    map.set(m.modelName, m);
  }
  return [...map.values()];
}

export function getVendor(id: string) {
  return load(id).exports.vendor;
}
