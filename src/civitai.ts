import { invoke } from "@tauri-apps/api/core";
import { aria2 } from "./api";
import { applySiteAuth, loadCivitaiKey } from "./sitekeys";
import { controlBaseUrl } from "./control";

/**
 * Civitai 模型页支持：输入网页链接（civitai.com/models/...）时，
 * 通过官方 API 拉取模型信息（版本 / 文件 / 预览图），供新建任务弹窗展示。
 * API 请求经 Rust http_get 走引擎同款本地代理，鉴权用已保存的 API Key。
 */

export interface CivitaiFile {
  id: number;
  name: string;
  sizeKB: number;
  type: string;
  primary: boolean;
  downloadUrl: string;
}

export interface CivitaiVersion {
  id: number;
  name: string;
  baseModel?: string;
  files: CivitaiFile[];
  images: { url: string; nsfwLevel?: number }[];
}

export interface CivitaiModel {
  id: number;
  name: string;
  type?: string;
  creator?: string;
  versions: CivitaiVersion[];
}

/** 识别 Civitai 模型页链接（网页地址；api/download 直链返回 null，走普通流程） */
export function parseCivitaiPageUrl(input: string): { modelId: number; versionId?: number } | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host !== "civitai.com" && host !== "www.civitai.com") return null;
  const m = u.pathname.match(/^\/models\/(\d+)(?:[/?#]|$)/);
  if (!m) return null;
  const v = Number(u.searchParams.get("modelVersionId"));
  return { modelId: Number(m[1]), versionId: v > 0 ? v : undefined };
}

interface RawFile {
  id?: number;
  name?: string;
  sizeKB?: number;
  type?: string;
  primary?: boolean;
  downloadUrl?: string;
}

interface RawVersion {
  id: number;
  name?: string;
  baseModel?: string;
  status?: string;
  files?: RawFile[];
  images?: { url?: string; nsfwLevel?: number; type?: string }[];
}

interface RawModel {
  id?: number;
  name?: string;
  type?: string;
  creator?: { username?: string };
  modelVersions?: RawVersion[];
}

/**
 * 预览图经 APP 的 /img 本地代理加载：<img> 直连走 WebView 系统代理，
 * 未开系统代理时 image.civitai.com 不可达；本地代理与下载引擎同一条通道。
 */
function proxiedImage(url: string): string {
  return `${controlBaseUrl()}/img?u=${encodeURIComponent(url)}`;
}

/** 任务 ↔ 封面图 映射的本地存储（下载卡片封面用） */
const TASK_IMAGE_KEY = "aria2-app:task-image";
const PROXY_MARK = "/img?u=";

/** 剥掉本地图片代理前缀，还原 civitai 原始图片地址（已是原始地址则原样返回） */
function unproxied(url: string): string {
  const i = url.indexOf(PROXY_MARK);
  if (i < 0) return url;
  try {
    return decodeURIComponent(url.slice(i + PROXY_MARK.length));
  } catch {
    return url;
  }
}

/** 记住某个下载链接对应的预览图（键 = 鉴权归一化后的主链接，与任务列表一致）。
 *  存原始地址而非代理地址：控制端口可能变化，展示时再按当前端口包代理。 */
export function rememberTaskImage(downloadUrl: string, imageUrl?: string) {
  if (!imageUrl) return;
  try {
    const map = JSON.parse(localStorage.getItem(TASK_IMAGE_KEY) ?? "{}") as Record<string, string>;
    map[applySiteAuth(downloadUrl).uri] = unproxied(imageUrl);
    // 只保留最近 60 条，防止无限增长
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete map[k];
    localStorage.setItem(TASK_IMAGE_KEY, JSON.stringify(map));
  } catch {
    // 忽略存储失败
  }
}

/** 取任务主链接对应的封面图（无则 null）。data: 内联图直通（占位封面用），其余按当前控制端口包本地代理 */
export function taskImageFor(uri: string): string | null {
  if (!uri) return null;
  try {
    const map = JSON.parse(localStorage.getItem(TASK_IMAGE_KEY) ?? "{}") as Record<string, string>;
    const u = map[applySiteAuth(uri).uri];
    if (!u) return null;
    const raw = unproxied(u);
    return raw.startsWith("data:") ? raw : proxiedImage(raw);
  } catch {
    return null;
  }
}

/** 拉取并归一化模型信息（versions 保持 API 顺序：最新在前） */
export async function fetchCivitaiModel(modelId: number): Promise<CivitaiModel> {
  const headers: string[] = [];
  const key = loadCivitaiKey();
  if (key) headers.push(`Authorization: Bearer ${key}`);
  const raw = await invoke<string>("http_get", {
    url: `https://civitai.com/api/v1/models/${modelId}`,
    headers,
    proxy: aria2.proxy,
  });
  let data: RawModel;
  try {
    data = JSON.parse(raw) as RawModel;
  } catch {
    throw new Error("Civitai 返回了无法解析的内容");
  }
  const versions = (data.modelVersions ?? [])
    .map((v) => ({
      id: v.id,
      name: v.name ?? `#${v.id}`,
      baseModel: v.baseModel,
      files: (v.files ?? []).filter((f) => f.downloadUrl).map((f) => ({
        id: f.id ?? 0,
        name: f.name ?? "未命名文件",
        sizeKB: f.sizeKB ?? 0,
        type: f.type ?? "Model",
        primary: f.primary ?? false,
        downloadUrl: f.downloadUrl!,
      })),
      images: (v.images ?? [])
        .filter((im) => im.url && im.type !== "video")
        .map((im) => ({ url: proxiedImage(im.url!), nsfwLevel: im.nsfwLevel })),
    }))
    .filter((v) => v.files.length > 0);
  if (versions.length === 0) throw new Error("该模型没有可下载的文件");
  return {
    id: data.id ?? modelId,
    name: data.name ?? `模型 #${modelId}`,
    type: data.type,
    creator: data.creator?.username,
    versions,
  };
}
