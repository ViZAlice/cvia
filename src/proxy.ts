import { invoke } from "@tauri-apps/api/core";

export type ProxyMode = "auto" | "manual" | "off";

export interface ProxyPref {
  mode: ProxyMode;
  /** manual 模式下使用的端口 */
  port: number;
  /** auto 模式下依次探测的端口列表 */
  ports: number[];
}

const KEY = "aria2-app:proxy-pref";
const DEFAULT_PREF: ProxyPref = { mode: "auto", port: 7890, ports: [10808, 7890] };

export function loadProxyPref(): ProxyPref {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        mode: p.mode === "manual" || p.mode === "off" ? p.mode : "auto",
        port: Number(p.port) > 0 ? Number(p.port) : DEFAULT_PREF.port,
        ports:
          Array.isArray(p.ports) && p.ports.length > 0
            ? p.ports.map(Number).filter((n: number) => n > 0 && n < 65536)
            : [...DEFAULT_PREF.ports],
      };
    }
  } catch {
    // 忽略损坏的本地配置
  }
  return { ...DEFAULT_PREF, ports: [...DEFAULT_PREF.ports] };
}

export function saveProxyPref(pref: ProxyPref) {
  localStorage.setItem(KEY, JSON.stringify(pref));
}

/** 探测端口列表，返回第一个可连接的端口 */
export async function scanProxy(ports: number[]): Promise<number | null> {
  return await invoke<number | null>("scan_proxy", { ports });
}

/** 按偏好解析出最终应使用的代理端口（null = 不使用代理） */
export async function resolveProxy(pref: ProxyPref): Promise<number | null> {
  if (pref.mode === "off") return null;
  if (pref.mode === "manual") return pref.port;
  return await scanProxy(pref.ports);
}

/** 切换 aria2 引擎代理（会重启引擎，任务自动恢复） */
export async function setProxy(proxy: number | null): Promise<void> {
  await invoke("set_proxy", { proxy });
}

/** 切换证书校验（会重启引擎在启动参数中生效），返回是否发生了重启 */
export async function setCertCheck(skip: boolean): Promise<boolean> {
  return await invoke<boolean>("set_cert_check", { skip });
}

export function parsePortList(text: string): number[] {
  return text
    .split(/[，,\s;；]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
}
