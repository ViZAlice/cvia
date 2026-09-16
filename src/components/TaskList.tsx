import { useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { aria2 } from "../api";
import type { Aria2Task } from "../types";
import { taskImageFor } from "../civitai";
import { copyText } from "../clipboard";
import { fmtBytes, fmtEta, fmtSpeed, STATUS_LABEL, taskName } from "../format";
import FadeImg from "./FadeImg";

interface Props {
  tasks: Aria2Task[];
  onAction: (fn: () => Promise<unknown>) => Promise<void>;
  onRestart: (t: Aria2Task) => Promise<void>;
  onRetry: (t: Aria2Task) => Promise<void>;
  isRetryExhausted: (t: Aria2Task) => boolean;
  onError: (e: unknown) => void;
}

export default function TaskList({ tasks, onAction, onRestart, onRetry, isRetryExhausted, onError }: Props) {
  return (
    <div className="task-list">
      {tasks.map((t, i) => (
        <TaskRow
          key={t.gid}
          index={i}
          task={t}
          onAction={onAction}
          onRestart={onRestart}
          onRetry={onRetry}
          isRetryExhausted={isRetryExhausted}
          onError={onError}
        />
      ))}
    </div>
  );
}

/** 文件扩展名徽标（卡片左上的彩色块） */
function extBadge(t: Aria2Task): string {
  const name = taskName(t);
  const last = name.split(".").pop() ?? "";
  if (!last || last === name || last.length > 5) return "DL";
  return last.slice(0, 4).toUpperCase();
}

function TaskRow({
  task: t,
  index,
  onAction,
  onRestart,
  onRetry,
  isRetryExhausted,
  onError,
}: {
  task: Aria2Task;
  index: number;
  onAction: Props["onAction"];
  onRestart: Props["onRestart"];
  onRetry: Props["onRetry"];
  isRetryExhausted: Props["isRetryExhausted"];
  onError: Props["onError"];
}) {
  const total = Number(t.totalLength);
  const done = Number(t.completedLength);
  const speed = Number(t.downloadSpeed);
  const pct = total > 0 ? (done / total) * 100 : t.status === "complete" ? 100 : 0;
  const running = t.status === "active" || t.status === "waiting" || t.status === "paused";
  const isBt = Boolean(t.infoHash || t.bittorrent);
  const retriable =
    t.status === "error" && !isBt && t.files?.some((f) => f.uris?.length > 0);
  const restartable = running && !isBt && t.files?.some((f) => f.uris?.length > 0);
  const firstPath = t.files?.find((f) => f.path)?.path ?? "";
  const mainUri = t.files?.[0]?.uris?.[0]?.uri ?? "";
  const dirName = t.dir?.split(/[\\/]/).filter(Boolean).pop() ?? "";
  /** Civitai 任务下载时记下的预览图 → 卡片封面 */
  const cover = taskImageFor(mainUri);

  /** 操作进行中：禁用按钮，避免重复点击和无反馈感 */
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const act = (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    fn().finally(() => setBusy(false));
  };

  const filePaths = () => (t.files ?? []).map((f) => f.path).filter(Boolean);

  const handleDeleteRunning = () => {
    if (!window.confirm(`确定删除任务「${taskName(t)}」吗？任务未完成，已下载的部分文件将一并删除。`))
      return;
    act(() =>
      onAction(async () => {
        // 删除 = 不要了：删任务、清掉下载记录，连带删掉未下载完成的分片和控制文件
        const paths = filePaths();
        await aria2.remove(t.gid);
        await aria2.removeDownloadResult(t.gid).catch(() => {});
        if (paths.length > 0) await invoke("delete_files", { paths });
      }),
    );
  };

  const handleClearRecord = () => {
    if (!window.confirm(`确定清除「${taskName(t)}」的下载记录吗？（磁盘上的文件会保留）`))
      return;
    act(() => onAction(() => aria2.removeDownloadResult(t.gid)));
  };

  const handleDeleteComplete = () => {
    if (!window.confirm(`同时清理「${taskName(t)}」的下载记录和已下载的文件？`)) return;
    act(() =>
      onAction(async () => {
        const paths = filePaths();
        await aria2.removeDownloadResult(t.gid);
        if (paths.length > 0) await invoke("delete_files", { paths });
      }),
    );
  };

  const handleRestart = () => {
    if (
      !window.confirm(
        `用最新设置重新开始「${taskName(t)}」吗？\n当前进度会保留（断点续传），新设置（分片数等）立即生效。`,
      )
    )
      return;
    act(() => onRestart(t));
  };

  const handleCopyLink = () => {
    copyText(mainUri).then((ok) => {
      if (ok) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }
    });
  };

  const openInExplorer = (fn: "reveal_path" | "open_path") => {
    invoke(fn, { path: firstPath }).catch(onError);
  };

  return (
    <div
      className={`task-card ${cover ? "has-cover" : ""} status-${t.status}`}
      data-gid={t.gid}
      style={{ "--i": index } as CSSProperties}
    >
      {/* Civitai 任务：预览图整卡铺底，信息以玻璃浮层叠加、不参与布局 */}
      {cover && <FadeImg src={cover} className="tc-bg" alt="" />}
      <div className={cover ? "tc-overlay" : "tc-body"}>
        <div className="tc-head">
          {!cover && (
            <div className="tc-icon" aria-hidden>
              {extBadge(t)}
            </div>
          )}
          <div className="tc-title">
            <span className="tc-name" title={`${taskName(t)}${firstPath ? `\n${firstPath}` : ""}`}>
              {isBt && <span className="tag">BT</span>}
              {taskName(t)}
            </span>
            <span className="tc-sub" title={t.dir}>
              {dirName}
            </span>
          </div>
          <span className={`badge badge-${t.status}`}>
            {t.status === "active" && <span className="badge-dot" />}
            {STATUS_LABEL[t.status] ?? t.status}
          </span>
        </div>

        {(running || t.status === "complete") && (
        <div className="progress">
          <div
            className={`progress-bar ${t.status === "complete" ? "done" : ""}`}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
      )}

      <div className="tc-meta">
        {t.status !== "complete" && <span className="tc-pct">{pct.toFixed(1)}%</span>}
        <span>
          {fmtBytes(done)} / {total > 0 ? fmtBytes(total) : "未知"}
        </span>
        {t.status === "active" && (
          <>
            <span className="speed">↓ {fmtSpeed(speed)}</span>
            {Number(t.uploadSpeed) > 0 && <span>↑ {fmtSpeed(Number(t.uploadSpeed))}</span>}
            <span>剩余 {fmtEta(total - done, speed)}</span>
            {Number(t.connections) > 0 && <span>{t.connections} 连接</span>}
          </>
        )}
        {t.status === "error" && (
          <span className="error-text">
            {t.errorMessage || `错误码 ${t.errorCode ?? "?"}`}
            {isRetryExhausted(t) && "（已自动重试 3 次失败，请手动重试）"}
          </span>
        )}
      </div>

      <div className="tc-actions">
        {busy && <span className="busy-hint">处理中…</span>}
        {t.status === "complete" && firstPath && (
          <button
            className="btn small"
            data-testid="btn-open"
            disabled={busy}
            title="用默认程序打开"
            onClick={() => openInExplorer("open_path")}
          >
            打开
          </button>
        )}
        {firstPath && (
          <button
            className="btn small"
            data-testid="btn-reveal"
            disabled={busy}
            title="在资源管理器中显示"
            onClick={() => openInExplorer("reveal_path")}
          >
            目录
          </button>
        )}
        {mainUri && (
          <button
            className="btn small"
            data-testid="btn-copy-link"
            disabled={busy}
            title={copied ? "已复制" : "复制下载链接"}
            onClick={handleCopyLink}
          >
            {copied ? "已复制" : "链接"}
          </button>
        )}
        {t.status === "active" && (
          <button
            className="btn small"
            data-testid="btn-pause"
            disabled={busy}
            onClick={() => act(() => onAction(() => aria2.pause(t.gid)))}
          >
            暂停
          </button>
        )}
        {t.status === "paused" && (
          <button
            className="btn small"
            data-testid="btn-resume"
            disabled={busy}
            onClick={() => act(() => onAction(() => aria2.unpause(t.gid)))}
          >
            继续
          </button>
        )}
        {restartable && (
          <button
            className="btn small"
            data-testid="btn-restart"
            disabled={busy}
            title="停止并用最新设置重新开始，进度保留"
            onClick={handleRestart}
          >
            重开
          </button>
        )}
        {retriable && (
          <button
            className="btn small"
            data-testid="btn-retry"
            disabled={busy}
            onClick={() => act(() => onRetry(t))}
          >
            重试
          </button>
        )}
        {running && (
          <button
            className="btn small danger"
            data-testid="btn-delete"
            disabled={busy}
            onClick={handleDeleteRunning}
          >
            删除
          </button>
        )}
        {!running && (
          <button
            className="btn small"
            data-testid="btn-clear-record"
            disabled={busy}
            onClick={handleClearRecord}
          >
            清除记录
          </button>
        )}
        {t.status === "complete" && (
          <button
            className="btn small danger"
            data-testid="btn-delete-complete"
            disabled={busy}
            onClick={handleDeleteComplete}
          >
            删除
          </button>
        )}
      </div>
      </div>
    </div>
  );
}
