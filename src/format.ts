import type { Aria2Task } from "./types";

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
}

export function fmtSpeed(n: number): string {
  return `${fmtBytes(n)}/s`;
}

export function fmtEta(remaining: number, speed: number): string {
  if (speed <= 0 || remaining <= 0) return "--";
  const s = Math.ceil(remaining / speed);
  if (s >= 86400) return ">1 天";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} 时 ${m} 分`;
  if (m > 0) return `${m} 分 ${sec} 秒`;
  return `${sec} 秒`;
}

export function taskName(t: Aria2Task): string {
  const bt = t.bittorrent?.info?.name;
  if (bt) return bt;
  const p = t.files?.[0]?.path;
  // 磁力任务拿到元数据前 path 只有目录，basename 会得到目录名，需排除
  if (p && p !== t.dir) {
    const base = p.split(/[\\/]/).pop();
    if (base) return base;
  }
  const uri = t.files?.[0]?.uris?.[0]?.uri;
  if (uri) {
    if (/^magnet:/i.test(uri)) {
      // 优先显示 dn= 里的名称，否则用 info hash 前缀
      try {
        const u = new URL(uri);
        const dn = u.searchParams.get("dn");
        if (dn) return dn;
        const xt = u.searchParams.get("xt") ?? "";
        const hash = xt.split(":").pop() ?? "";
        if (hash) return `磁力 ${hash.slice(0, 12)}…`;
      } catch {
        // 解析失败原样显示
      }
      return uri;
    }
    try {
      return decodeURIComponent(uri.split("/").pop() || uri);
    } catch {
      return uri;
    }
  }
  return t.gid;
}

export const STATUS_LABEL: Record<string, string> = {
  active: "下载中",
  waiting: "等待中",
  paused: "已暂停",
  complete: "已完成",
  error: "出错",
  removed: "已删除",
};
