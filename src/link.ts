export interface PreprocessResult {
  uri: string;
  note?: string;
}

/**
 * 对用户输入的下载链接做站点特化处理。
 * 目前支持 HuggingFace：
 *  - /blob/<rev>/<file>（网页预览地址）→ /resolve/<rev>/<file>（真实下载地址）
 *  - 去掉 ?download=true 等多余参数（resolve 本身就会以下载形式响应）
 */
export function preprocessUri(input: string): PreprocessResult {
  const uri = input.trim();

  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    // magnet 等非常规 URL 原样放行
    return { uri };
  }

  const host = u.hostname.toLowerCase();
  if (host === "huggingface.co" || host === "www.huggingface.co" || host === "hf.co") {
    if (!u.pathname.includes("/resolve/") && u.pathname.includes("/blob/")) {
      u.pathname = u.pathname.replace("/blob/", "/resolve/");
    }
    if (u.search) u.search = "";
    const out = u.toString();
    return out === uri
      ? { uri }
      : { uri: out, note: "已转换为 HuggingFace 直链" };
  }

  return { uri };
}
