import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface EditorOpenRequest {
  pane: string;
  sessionId: string | null;
  path: string;
  isRemote: boolean;
}

export interface EditorDocument {
  docId: string;
  pane: string;
  sessionId: string | null;
  path: string;
  fileName: string;
  isRemote: boolean;
  localTempPath: string;
  content: string;
  encoding: 'UTF-8' | 'UTF-8-BOM' | 'Latin-1' | string;
  lineEnding: 'LF' | 'CRLF' | string;
  size: number;
  modifiedMs: number | null;
  watchingExternal: boolean;
}

export interface EditorSaveRequest {
  docId: string;
  content: string;
  encoding: string;
  lineEnding: string;
}

export interface EditorSaveResult {
  docId: string;
  path: string;
  isRemote: boolean;
  bytesWritten: number;
  savedAtMs: number;
}

export interface EditorExternalSyncEvent {
  docId: string;
  path: string;
  isRemote: boolean;
  bytesWritten: number;
  savedAtMs: number;
  content: string;
  status: 'done' | 'error' | string;
  detail: string;
}

export interface PtyOpenRequest {
  sessionId: string;
  cwd: string | null;
  cols: number;
  rows: number;
}

export interface PtyOutputEvent {
  sessionId: string;
  data: string;
}

export interface PtyClosedEvent {
  sessionId: string;
  exitCode: number | null;
}

export interface RemoteExecRequest {
  sessionId: string;
  command: string;
  cwd: string | null;
}

export interface RemoteExecResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface CustomCommandPreset {
  id: string;
  description: string;
  command: string;
  isLocal: boolean;
  applyToDirectories: boolean;
  executeRecursively: boolean;
  showResultsInTerminal: boolean;
  copyResultsToClipboard: boolean;
  useRemoteFiles: boolean;
  shortcut: string;
}

export type SyncDirection = 'both' | 'remote' | 'local';
export type SyncMode = 'synchronize_files' | 'mirror_files' | 'synchronize_timestamps';
export type SyncActionKind =
  | 'upload_new'
  | 'upload_update'
  | 'download_new'
  | 'download_update'
  | 'update_remote_timestamp'
  | 'update_local_timestamp'
  | 'delete_remote'
  | 'delete_local';

export interface SyncChecklistItem {
  id: string;
  checked: boolean;
  relativePath: string;
  name: string;
  localPath: string;
  remotePath: string;
  localSize: number | null;
  remoteSize: number | null;
  localMtimeMs: number | null;
  remoteMtimeMs: number | null;
  action: SyncActionKind;
  isDir: boolean;
}

export interface SyncCompareRequest {
  sessionId: string | null;
  localDir: string;
  remoteDir: string;
  targetIsRemote: boolean;
  direction: SyncDirection;
  mode: SyncMode;
  deleteFiles: boolean;
  existingFilesOnly: boolean;
  selectedFilesOnly: boolean;
  selectedRelPaths: string[];
  byTime: boolean;
  bySize: boolean;
  byChecksum: boolean;
  caseSensitive: boolean;
  fileMask: string;
}

export interface SyncCompareSummary {
  localDir: string;
  remoteDir: string;
  targetIsRemote: boolean;
  items: SyncChecklistItem[];
  newLocalCount: number;
  newRemoteCount: number;
  updatedLocalCount: number;
  updatedRemoteCount: number;
  obsoleteLocalCount: number;
  obsoleteRemoteCount: number;
}

export interface SyncExecuteRequest {
  sessionId: string | null;
  localDir: string;
  remoteDir: string;
  targetIsRemote: boolean;
  items: SyncChecklistItem[];
}

export interface SyncProgressEvent {
  completed: number;
  total: number;
  currentPath: string;
}

export interface FileFindRequest {
  pane: string;
  sessionId: string | null;
  isRemote: boolean;
  baseDir: string;
  fileMask: string;
  contentKeyword: string;
  caseSensitive: boolean;
  recursive: boolean;
  maxResults: number | null;
}

export interface FileFindMatch {
  name: string;
  directory: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  modifiedMs: number | null;
  matchedLine: number | null;
  matchedPreview: string | null;
}

export interface KeepUpToDateRequest {
  sessionId: string | null;
  localDir: string;
  remoteDir: string;
  targetIsRemote: boolean;
  deleteFiles: boolean;
  existingFilesOnly: boolean;
  recursive: boolean;
  selectedOnly: boolean;
  selectedPaths: string[];
  fileMask: string;
  synchronizeOnStart: boolean;
}

export interface KeepUpToDateLogEntry {
  timestampMs: number;
  action: string;
  relativePath: string;
  detail: string;
  status: string;
}

export interface KeepUpToDateStatus {
  running: boolean;
  startedAtMs: number | null;
  localDir: string;
  remoteDir: string;
  syncedCount: number;
  errorCount: number;
  logs: KeepUpToDateLogEntry[];
}

export const editorApi = {
  openFile: (request: EditorOpenRequest) =>
    invoke<EditorDocument>('editor_open_file', { request }),
  saveFile: (request: EditorSaveRequest) =>
    invoke<EditorSaveResult>('editor_save_file', { request }),
  reloadFile: (docId: string) =>
    invoke<EditorDocument>('editor_reload_file', { docId }),
  openExternal: (docId: string, editorCommand: string | null) =>
    invoke<string>('editor_open_external', { docId, editorCommand }),
  closeFile: (docId: string) =>
    invoke<void>('editor_close_file', { docId }),
  onExternalSynced: (cb: (event: EditorExternalSyncEvent) => void): Promise<UnlistenFn> =>
    listen<EditorExternalSyncEvent>('editor://external-synced', (ev) => cb(ev.payload)),
};

export const shellApi = {
  ptyOpen: (request: PtyOpenRequest) =>
    invoke<void>('sftp_pty_open', { request }),
  ptyWrite: (sessionId: string, data: string) =>
    invoke<void>('sftp_pty_write', { sessionId, data }),
  ptyResize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>('sftp_pty_resize', { sessionId, cols, rows }),
  ptyClose: (sessionId: string) =>
    invoke<void>('sftp_pty_close', { sessionId }),
  execRemote: (request: RemoteExecRequest) =>
    invoke<RemoteExecResult>('sftp_exec_command', { request }),
  execLocal: (command: string, cwd: string | null) =>
    invoke<RemoteExecResult>('local_exec_command', { command, cwd }),
  listCustomCommands: () =>
    invoke<CustomCommandPreset[]>('custom_commands_list'),
  saveCustomCommands: (commands: CustomCommandPreset[]) =>
    invoke<CustomCommandPreset[]>('custom_commands_save', { commands }),
  expandCustomCommand: (
    pattern: string,
    currentPath: string,
    selectedFiles: string[],
    promptValues: Record<string, string>,
  ) =>
    invoke<string>('custom_command_expand', {
      pattern,
      currentPath,
      selectedFiles,
      promptValues,
    }),
  onPtyOutput: (cb: (event: PtyOutputEvent) => void): Promise<UnlistenFn> =>
    listen<PtyOutputEvent>('terminal://output', (ev) => cb(ev.payload)),
  onPtyClosed: (cb: (event: PtyClosedEvent) => void): Promise<UnlistenFn> =>
    listen<PtyClosedEvent>('terminal://closed', (ev) => cb(ev.payload)),
};

export const syncApi = {
  compareDirectories: (request: SyncCompareRequest) =>
    invoke<SyncCompareSummary>('sync_compare_directories', { request }),
  executeChecklist: (request: SyncExecuteRequest) =>
    invoke<number>('sync_execute_checklist', { request }),
  findFiles: (request: FileFindRequest) =>
    invoke<FileFindMatch[]>('find_files_search', { request }),
  startKeepUpToDate: (request: KeepUpToDateRequest) =>
    invoke<KeepUpToDateStatus>('sync_keep_up_to_date_start', { request }),
  stopKeepUpToDate: () =>
    invoke<KeepUpToDateStatus>('sync_keep_up_to_date_stop'),
  getKeepUpToDateStatus: () =>
    invoke<KeepUpToDateStatus>('sync_keep_up_to_date_status'),
  onSyncProgress: (cb: (event: SyncProgressEvent) => void): Promise<UnlistenFn> =>
    listen<SyncProgressEvent>('sync://progress', (ev) => cb(ev.payload)),
  onKeepUpToDate: (cb: (status: KeepUpToDateStatus) => void): Promise<UnlistenFn> =>
    listen<KeepUpToDateStatus>('sync://keep-up-to-date', (ev) => cb(ev.payload)),
};
