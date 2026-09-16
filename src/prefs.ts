import { aria2 } from "./api";

export interface DownloadPrefs {
  dir: string;
  maxConcurrent: string;
  maxConnection: string;
  speedLimitKb: string;
  split: string;
  minSplitMb: string;
  skipCertCheck: boolean;
}

const KEY = "aria2-app:download-prefs";

export function loadDownloadPrefs(): DownloadPrefs | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return {
      dir: typeof p.dir === "string" ? p.dir : "",
      maxConcurrent: String(p.maxConcurrent ?? "5"),
      maxConnection: String(p.maxConnection ?? "16"),
      speedLimitKb: String(p.speedLimitKb ?? "0"),
      split: String(p.split ?? "5"),
      minSplitMb: String(p.minSplitMb ?? "20"),
      skipCertCheck: p.skipCertCheck === true,
    };
  } catch {
    return null;
  }
}

export function saveDownloadPrefs(p: DownloadPrefs) {
  localStorage.setItem(KEY, JSON.stringify(p));
}

export function prefsToOptions(p: DownloadPrefs): Record<string, string> {
  const o: Record<string, string> = {
    "max-concurrent-downloads": p.maxConcurrent || "5",
    "max-connection-per-server": p.maxConnection || "16",
    "max-overall-download-limit": Number(p.speedLimitKb) > 0 ? `${p.speedLimitKb}K` : "0",
    split: p.split || "5",
    "min-split-size": `${Number(p.minSplitMb) > 0 ? p.minSplitMb : "20"}M`,
  };
  if (p.dir) o.dir = p.dir;
  return o;
}

/** 把本地保存的下载设置应用到 aria2 引擎（启动时 / 引擎重启后调用） */
export async function applyDownloadPrefs() {
  const p = loadDownloadPrefs();
  if (p) await aria2.changeGlobalOption(prefsToOptions(p));
}
