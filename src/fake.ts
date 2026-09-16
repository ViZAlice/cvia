import type { Aria2Task } from "./types";
import { rememberTaskImage } from "./civitai";

/**
 * 假下载（仅调试用）：不经过引擎、不碰网络下载，在前端注入合成任务组，
 * 用于离线调校「下载中」的全部视觉（拉幕/光斑/卡片/玻璃浮层/进度动画）
 * 以及演示截图。封面用 Civitai 真实预览图（经本地 /img 代理加载）。
 * 由控制通道 {"type":"fake","payload":{"on":true,"count":3}} 开关。
 */

interface FakeSpec {
  uri: string;
  name: string;
  totalGB: number;
  startPct: number;
  speedMB: number;
  /** 真实预览图地址（Civitai），运行时经本地图片代理加载 */
  cover: string;
}

const SPECS: FakeSpec[] = [
  {
    uri: "https://civitai.com/api/download/models/900001?fileId=880001",
    name: "fakeDreamXL_v3.safetensors",
    totalGB: 6.6,
    startPct: 0.18,
    speedMB: 4.6,
    cover:
      "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/b85e0746-43e4-42f6-a663-43c49c597048/original=true/139400223.jpeg",
  },
  {
    uri: "https://civitai.com/api/download/models/900002?fileId=880002",
    name: "animeBoosterPony_v12.safetensors",
    totalGB: 2.4,
    startPct: 0.62,
    speedMB: 8.2,
    cover:
      "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/75cfd705-6941-4d59-ae42-8bfac3e7f8c7/original=true/139475088.jpeg",
  },
  {
    uri: "https://civitai.com/api/download/models/900003?fileId=880003",
    name: "styleMixtape_v7.safetensors",
    totalGB: 4.1,
    startPct: 0.43,
    speedMB: 6.5,
    cover:
      "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/05e1ce00-8f0d-4708-8530-634d53a49999/original=true/140263154.jpeg",
  },
  {
    uri: "https://civitai.com/api/download/models/900004?fileId=880004",
    name: "detailTweaker_v2.safetensors",
    totalGB: 1.2,
    startPct: 0.77,
    speedMB: 3.1,
    cover:
      "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/bbb9922c-546b-42d8-ae55-0e97d0d0b823/original=true/140263273.jpeg",
  },
];

export function makeFakeTasks(count: number): Aria2Task[] {
  return SPECS.slice(0, Math.max(1, Math.min(count, SPECS.length))).map((s, i) => {
    // 顺带登记封面映射，让假任务走「图片铺底 + 玻璃浮层」的完整卡片形态
    rememberTaskImage(s.uri, s.cover);
    const total = Math.round(s.totalGB * 1024 * 1024 * 1024);
    const done = Math.round(total * s.startPct);
    return {
      gid: `f4ke${String(1000 + i)}test${String(i)}`,
      status: "active",
      totalLength: String(total),
      completedLength: String(done),
      uploadLength: "0",
      downloadSpeed: String(Math.round(s.speedMB * 1024 * 1024)),
      uploadSpeed: "0",
      connections: "16",
      dir: "C:/Models/image-generation",
      files: [
        {
          index: "1",
          path: `C:/Models/image-generation/${s.name}`,
          length: String(total),
          completedLength: String(done),
          selected: "true",
          uris: [{ uri: s.uri, status: "used" }],
        },
      ],
    };
  });
}

/** 每秒推进一点进度（各自速度不同，封顶 97% 不完成，便于长时间观察） */
export function tickFake(tasks: Aria2Task[]): Aria2Task[] {
  return tasks.map((t) => {
    const jitter = 0.85 + Math.random() * 0.3;
    const base = Number(t.downloadSpeed) || 4 * 1024 * 1024;
    const next = Math.round(
      Math.min(Number(t.totalLength) * 0.97, Number(t.completedLength) + Math.round(base * jitter)),
    );
    const files = t.files?.map((f) => ({ ...f, completedLength: String(next) }));
    return {
      ...t,
      completedLength: String(next),
      downloadSpeed: String(Math.round(base * jitter)),
      files,
    };
  });
}
