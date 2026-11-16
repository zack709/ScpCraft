import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type TransferDirection = 'upload' | 'download' | 'local_copy';
export type TransferMode = 'binary' | 'text' | 'automatic';
export type TransferTaskStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'conflict'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export type OverwritePolicy =
  | 'ask'
  | 'overwrite'
  | 'resume'
  | 'rename'
  | 'newer_only'
  | 'skip';

export type ConflictResolution =
  | 'overwrite'
  | 'overwrite_all'
  | 'resume'
  | 'resume_all'
  | 'rename'
  | 'rename_all'
  | 'newer_only'
  | 'skip'
  | 'skip_all'
  | 'cancel';

export const DEFAULT_ASCII_MASK =
  '*.txt;*.html;*.htm;*.cgi;*.pl;*.php;*.py;*.sh;*.xml;*.css;*.js;*.ts;*.tsx;*.json;*.md;*.ini;*.conf;*.yml;*.yaml;*.rs;*.c;*.cpp;*.h;*.sql;*.csv';

export interface TransferOptions {
  direction: TransferDirection;
  sessionId: string | null;
  isMove: boolean;
  preserveTimestamp: boolean;
  preserveRights: boolean;
  octalRights: string | null;
  transferMode: TransferMode;
  asciiFileMask: string;
  fileMask: string;
  newerOnly: boolean;
  excludeHidden: boolean;
  excludeEmptyDirs: boolean;
  useFilepart: boolean;
  removeBomEof: boolean;
  speedLimitKbps: number;
  backgroundQueue: boolean;
  overwritePolicy: OverwritePolicy;
}

export interface TransferItem {
  id: string;
  batchId: string;
  sessionId: string | null;
  direction: TransferDirection;
  isMove: boolean;
  sourcePath: string;
  targetPath: string;
  fileName: string;
  isDir: boolean;
  totalBytes: number;
  transferredBytes: number;
  resumedFromBytes: number;
  speedBps: number;
  etaSeconds: number | null;
  status: TransferTaskStatus;
  error: string | null;
  sourceMtimeMs: number | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  options: TransferOptions;
}

export interface ConflictPrompt {
  itemId: string;
  batchId: string;
  direction: TransferDirection;
  fileName: string;
  sourcePath: string;
  targetPath: string;
  sourceSize: number;
  targetSize: number;
  sourceMtimeMs: number | null;
  targetMtimeMs: number | null;
  hasFilepart: boolean;
  filepartSize: number;
}

export interface TransferQueueSnapshot {
  items: TransferItem[];
  activeConflict: ConflictPrompt | null;
  maxConcurrent: number;
  globalSpeedLimitKbps: number;
  totalSpeedBps: number;
  activeCount: number;
  queuedCount: number;
  completedCount: number;
  failedCount: number;
}

export interface EnqueueTransferRequest {
  sources: string[];
  targetDir: string;
  options: TransferOptions;
}

export type TransferPresetName = 'Default' | 'Binary' | 'Text';

export function buildDefaultTransferOptions(
  direction: TransferDirection,
  sessionId: string | null,
  isMove = false,
  preset: TransferPresetName = 'Default',
): TransferOptions {
  return {
    direction,
    sessionId,
    isMove,
    preserveTimestamp: true,
    preserveRights: false,
    octalRights: '0644',
    transferMode:
      preset === 'Text'
        ? 'text'
        : preset === 'Binary'
        ? 'binary'
        : 'binary',
    asciiFileMask: DEFAULT_ASCII_MASK,
    fileMask: '*',
    newerOnly: false,
    excludeHidden: false,
    excludeEmptyDirs: false,
    useFilepart: true,
    removeBomEof: false,
    speedLimitKbps: 0,
    backgroundQueue: false,
    overwritePolicy: 'ask',
  };
}

export const transferApi = {
  enqueue: (request: EnqueueTransferRequest) =>
    invoke<string>('transfer_enqueue', { request }),

  getSnapshot: () => invoke<TransferQueueSnapshot>('transfer_get_snapshot'),

  controlItem: (
    itemId: string,
    action: 'pause' | 'resume' | 'skip' | 'cancel' | 'retry' | 'remove',
  ) => invoke<void>('transfer_control_item', { itemId, action }),

  controlAll: (
    action: 'pause_all' | 'resume_all' | 'cancel_all' | 'clear_finished',
    batchId?: string | null,
  ) =>
    invoke<void>('transfer_control_all', {
      action,
      batchId: batchId ?? null,
    }),

  resolveConflict: (itemId: string, resolution: ConflictResolution) =>
    invoke<void>('transfer_resolve_conflict', { itemId, resolution }),

  updateSettings: (
    maxConcurrent?: number | null,
    globalSpeedLimitKbps?: number | null,
  ) =>
    invoke<TransferQueueSnapshot>('transfer_update_settings', {
      maxConcurrent: maxConcurrent ?? null,
      globalSpeedLimitKbps: globalSpeedLimitKbps ?? null,
    }),

  onQueueUpdated: (handler: (snapshot: TransferQueueSnapshot) => void): Promise<UnlistenFn> =>
    listen<TransferQueueSnapshot>('transfer://queue-updated', (event) => {
      handler(event.payload);
    }),
};
