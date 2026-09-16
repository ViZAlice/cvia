import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { aria2 } from "../api";
import { preprocessUri } from "../link";
import { applySiteAuth } from "../sitekeys";
import { fmtBytes } from "../format";
import {
  fetchCivitaiModel,
  parseCivitaiPageUrl,
  rememberTaskImage,
  type CivitaiModel,
} from "../civitai";
import FadeImg from "./FadeImg";

interface Props {
  onClose: () => void;
  onDone: () => void;
  onError: (e: unknown) => void;
  /** 独立 Civitai 入口打开时：提示语聚焦模型页链接（行为不变，任何链接都能贴） */
  preset?: "civitai";
}

/** 记住上次使用的保存目录，下次新建任务时预填 */
const LAST_DIR_KEY = "aria2-app:last-dir";

/** 预览图最多展示的张数（骨架占位不铺满屏幕），其余计数提示 */
const MAX_PREVIEW_IMAGES = 6;

export default function AddTask({ onClose, onDone, onError, preset }: Props) {
  const [uris, setUris] = useState("");
  const [dir, setDir] = useState(() => localStorage.getItem(LAST_DIR_KEY) ?? "");
  const [customName, setCustomName] = useState("");
  const [checksumAlgo, setChecksumAlgo] = useState("sha-256");
  const [checksumHex, setChecksumHex] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Civitai 模型页面板状态
  const [civModel, setCivModel] = useState<CivitaiModel | null>(null);
  const [civLoading, setCivLoading] = useState(false);
  const [civError, setCivError] = useState("");
  const [civVersionId, setCivVersionId] = useState<number | null>(null);
  const [civReload, setCivReload] = useState(0);
  const [lightbox, setLightbox] = useState<string | null>(null);

  // 打开对话框时若剪贴板正好是一行链接，自动预填（最常见的操作流：复制→新建）
  useEffect(() => {
    invoke<string>("read_clipboard")
      .then((text) => {
        const s = (text ?? "").trim();
        if (!s || s.includes("\n") || s.length > 2048) return;
        if (/^(https?|ftp):\/\//i.test(s) || /^magnet:/i.test(s)) setUris(s);
      })
      .catch(() => {});
  }, []);

  const pickDir = async () => {
    const selected = await open({ directory: true, title: "选择保存目录" });
    if (typeof selected === "string") setDir(selected);
  };

  const lines = uris
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  // 仅单个 http(s) 链接时支持自定义文件名 / 校验和
  const singleHttp = lines.length === 1 && /^https?:\/\//i.test(lines[0]);

  // 输入为 Civitai 模型页链接时自动拉取模型信息（300ms 去抖，输入变化即作废旧请求）
  const urisKey = lines.join("\n");
  useEffect(() => {
    const target = lines.length === 1 ? parseCivitaiPageUrl(lines[0]) : null;
    if (!target) {
      setCivModel(null);
      setCivError("");
      setCivLoading(false);
      return;
    }
    let stale = false;
    setCivModel(null);
    setCivError("");
    setCivLoading(true);
    const timer = setTimeout(() => {
      fetchCivitaiModel(target.modelId)
        .then((m) => {
          if (stale) return;
          setCivModel(m);
          // URL 带 modelVersionId 则选中它，否则默认最新（API 顺序第一个）
          const wanted = m.versions.find((v) => v.id === target.versionId);
          setCivVersionId(wanted ? wanted.id : (m.versions[0]?.id ?? null));
        })
        .catch((e) => {
          if (stale) return;
          setCivError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!stale) setCivLoading(false);
        });
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urisKey, civReload]);

  const conversions = lines
    .map((s) => {
      const pre = preprocessUri(s);
      const auth = applySiteAuth(pre.uri);
      return { uri: auth.uri, note: [pre.note, auth.note].filter(Boolean).join("；") };
    })
    .filter((r) => r.note);

  /**
   * 提交下载。override 用于 Civitai 面板直接指定链接（绕过输入框），
   * 此时 noExtras=true：自定义文件名/校验和等附加项属于输入框链接的上下文，不套用。
   * 面板已解析且输入框是模型页链接时，「开始下载」= 下载当前选中版本的主文件
   * （直接把网页链接交给 aria2 只会去下 HTML 页面，是错误路径）。
   */
  const submit = async (override?: string[], noExtras = false) => {
    let src = override ?? lines;
    if (!override && civModel && src.length === 1 && parseCivitaiPageUrl(src[0])) {
      const ver = civModel.versions.find((v) => v.id === civVersionId) ?? civModel.versions[0];
      const primary = ver?.files.find((f) => f.primary) ?? ver?.files[0];
      if (!primary) {
        onError(new Error("当前版本没有可下载的文件"));
        return;
      }
      rememberTaskImage(primary.downloadUrl, ver?.images[0]?.url);
      src = [primary.downloadUrl];
      noExtras = true;
    }
    if (src.length === 0) return;
    const single = !noExtras && src.length === 1 && /^https?:\/\//i.test(src[0]);
    const finalUris = src.map((s) => applySiteAuth(preprocessUri(s).uri).uri);
    setSubmitting(true);
    try {
      const options: Record<string, string | string[]> = {};
      if (dir) {
        options.dir = dir;
        localStorage.setItem(LAST_DIR_KEY, dir);
      }
      if (single) {
        const name = customName.trim();
        if (name) options.out = name;
        const hex = checksumHex.trim().toLowerCase();
        if (hex) options.checksum = `${checksumAlgo}=${hex}`;
        const headers = headersText
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.includes(":"));
        if (headers.length > 0) options.header = headers;
      }
      for (const uri of finalUris) {
        await aria2.addUri([uri], options);
      }
      onDone();
    } catch (e) {
      onError(e);
      setSubmitting(false);
    }
  };

  const civVersion =
    civModel?.versions.find((v) => v.id === civVersionId) ?? civModel?.versions[0];
  const civImages = civVersion?.images.slice(0, MAX_PREVIEW_IMAGES) ?? [];
  const civMoreImages = (civVersion?.images.length ?? 0) - civImages.length;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{preset === "civitai" ? "Civitai 模型下载" : "新建下载"}</h2>
        <label className="field">
          <span>
            {preset === "civitai"
              ? "粘贴 Civitai 模型页链接（自动列出版本 / 文件 / 预览图）"
              : "下载链接（每行一个，支持 http(s) / ftp / magnet / 磁力链接）"}
          </span>
          <textarea
            autoFocus
            rows={preset === "civitai" ? 2 : 4}
            data-testid="input-uris"
            placeholder={
              preset === "civitai"
                ? "https://civitai.com/models/…?modelVersionId=…"
                : "https://example.com/file.zip\nmagnet:?xt=urn:btih:...\n或粘贴 civitai.com/models/... 模型页链接"
            }
            value={uris}
            onChange={(e) => setUris(e.target.value)}
          />
        </label>

        {/* Civitai 模型信息面板：输入模型页链接时出现 */}
        {(civLoading || civError || civModel) && (
          <div className="civ-panel" data-testid="civitai-panel">
            {civLoading && (
              <div className="civ-status" data-testid="civitai-status-loading">
                正在获取模型信息…
              </div>
            )}
            {!civLoading && civError && (
              <div className="civ-status error" data-testid="civitai-status-error">
                获取模型信息失败：{civError}
                <button
                  className="btn small"
                  data-testid="civitai-retry"
                  onClick={() => setCivReload((n) => n + 1)}
                >
                  重试
                </button>
              </div>
            )}
            {!civLoading && civModel && civVersion && (
              <>
                <div className="civ-head">
                  <span className="civ-name" title={civModel.name}>
                    {civModel.name}
                  </span>
                  <span className="civ-meta">
                    {[
                      civModel.type,
                      civModel.creator ? `by ${civModel.creator}` : null,
                      civModel.versions.length > 1 ? `${civModel.versions.length} 个版本` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                {civModel.versions.length > 1 && (
                  <label className="field civ-version-row">
                    <span>选择版本</span>
                    <select
                      className="algo-select"
                      data-testid="civitai-version-select"
                      value={civVersion.id}
                      onChange={(e) => setCivVersionId(Number(e.target.value))}
                    >
                      {civModel.versions.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                          {v.baseModel ? ` · ${v.baseModel}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="civ-files">
                  {civVersion.files.map((f) => (
                    <div
                      className="civ-file"
                      key={f.id}
                      data-testid={`civitai-file-${f.id}`}
                      data-primary={f.primary ? "true" : undefined}
                    >
                      <span className="civ-file-type">{f.type === "Model" ? "模型" : f.type}</span>
                      <span className="civ-file-name" title={f.name}>
                        {f.name}
                      </span>
                      <span className="civ-file-size">{fmtBytes(f.sizeKB * 1024)}</span>
                      <button
                        className="btn small primary"
                        data-testid={`civitai-dl-${f.id}`}
                        disabled={submitting}
                        onClick={() => {
                          // 记住「这个下载 → 用哪张预览图当卡片封面」
                          rememberTaskImage(f.downloadUrl, civVersion?.images[0]?.url);
                          submit([f.downloadUrl], true);
                        }}
                      >
                        下载
                      </button>
                    </div>
                  ))}
                </div>
                {civImages.length > 0 && (
                  <div className="civ-imgs">
                    {civImages.map((im, i) => (
                      <FadeImg
                        key={i}
                        src={im.url}
                        className="civ-img"
                        onClick={() => setLightbox(im.url)}
                      />
                    ))}
                    {civMoreImages > 0 && (
                      <span className="civ-imgs-more">+{civMoreImages} 张</span>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {conversions.length > 0 && (
          <div className="convert-notes">
            {conversions.map((c, i) => (
              <div key={i} className="convert-note">
                ↳ {c.note}：{c.uri.replace(/token=[^&]+/g, "token=***")}
              </div>
            ))}
          </div>
        )}
        <label className="field">
          <span>保存到（留空使用默认目录）</span>
          <div className="dir-row">
            <input
              type="text"
              data-testid="input-dir"
              value={dir}
              placeholder="默认下载目录"
              onChange={(e) => setDir(e.target.value)}
            />
            <button className="btn" data-testid="btn-browse-dir" onClick={pickDir}>
              浏览…
            </button>
          </div>
        </label>
        {singleHttp && !civModel && (
          <>
            <label className="field">
              <span>自定义文件名（可选，留空则依次取：服务端文件名 → 链接中的文件名）</span>
              <input
                type="text"
                data-testid="input-name"
                value={customName}
                placeholder="例如 model.safetensors"
                onChange={(e) => setCustomName(e.target.value)}
              />
            </label>
            <label className="field">
              <span>完整性校验（可选，填来源网站给出的哈希值，下载完成后自动校验）</span>
              <div className="dir-row">
                <select
                  className="algo-select"
                  data-testid="select-algo"
                  value={checksumAlgo}
                  onChange={(e) => setChecksumAlgo(e.target.value)}
                >
                  <option value="sha-256">SHA-256</option>
                  <option value="sha-1">SHA-1</option>
                  <option value="md5">MD5</option>
                </select>
                <input
                  type="text"
                  data-testid="input-checksum"
                  value={checksumHex}
                  placeholder="哈希值（十六进制）"
                  onChange={(e) => setChecksumHex(e.target.value)}
                />
              </div>
            </label>
            <label className="field">
              <span>自定义请求头（可选，每行一个，用于需要 API key / Cookie 的站点）</span>
              <textarea
                rows={2}
                data-testid="input-headers"
                placeholder={"Authorization: Bearer 你的API_KEY"}
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
              />
            </label>
          </>
        )}
        <div className="modal-actions">
          <button className="btn" data-testid="btn-cancel-add" onClick={onClose}>
            取消
          </button>
          {/* Civitai 模型页输入：下载只走面板里每个文件的按钮，不出现第二个下载入口 */}
          {!(civModel || civLoading || civError) && (
            <button
              className="btn primary"
              data-testid="btn-submit-add"
              disabled={submitting || uris.trim() === ""}
              onClick={() => submit()}
            >
              {submitting ? "添加中…" : "开始下载"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
