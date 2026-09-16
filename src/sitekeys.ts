export interface AuthResult {
  uri: string;
  note?: string;
}

const CIVITAI_KEY = "aria2-app:civitai-key";

export function loadCivitaiKey(): string {
  try {
    return localStorage.getItem(CIVITAI_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveCivitaiKey(key: string) {
  try {
    if (key) localStorage.setItem(CIVITAI_KEY, key);
    else localStorage.removeItem(CIVITAI_KEY);
  } catch {
    // 忽略存储失败
  }
}

/**
 * 为需要鉴权的站点自动附加凭证。
 * 目前支持 Civitai：向 URL 附加 token 参数（幂等，已存在则替换为当前 key）。
 * URL 携带 token 的方式可让重试 / 断点续传自动继承鉴权。
 */
export function applySiteAuth(uri: string): AuthResult {
  const key = loadCivitaiKey();
  if (!key) return { uri };

  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return { uri };
  }

  const host = u.hostname.toLowerCase();
  if (host === "civitai.com" || host === "www.civitai.com") {
    u.searchParams.delete("token");
    u.searchParams.set("token", key);
    return { uri: u.toString(), note: "已附加 Civitai API Key" };
  }
  return { uri };
}
