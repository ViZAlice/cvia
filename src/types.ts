export interface Aria2Uri {
  uri: string;
  status: string;
}

export interface Aria2File {
  index: string;
  path: string;
  length: string;
  completedLength: string;
  selected: string;
  uris: Aria2Uri[];
}

export type TaskStatus =
  | "active"
  | "waiting"
  | "paused"
  | "error"
  | "complete"
  | "removed";

export interface Aria2Task {
  gid: string;
  status: TaskStatus;
  totalLength: string;
  completedLength: string;
  uploadLength: string;
  downloadSpeed: string;
  uploadSpeed: string;
  connections: string;
  dir: string;
  files: Aria2File[];
  bittorrent?: { info?: { name?: string } };
  infoHash?: string;
  numSeeders?: string;
  seeder?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface GlobalStat {
  downloadSpeed: string;
  uploadSpeed: string;
  numActive: string;
  numWaiting: string;
  numStopped: string;
  numStoppedTotal: string;
}

export type GlobalOption = Record<string, string>;
