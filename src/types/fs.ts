import type { SiteConfig } from './site';

export type SortField = 'name' | 'size' | 'type' | 'modified' | 'ext' | 'attr';
export type SortDirection = 'asc' | 'desc';
export type InterfaceMode = 'commander' | 'explorer';
export type PaneId = 'left' | 'right';
export type RightPaneMode = 'remote_placeholder' | 'local_secondary' | 'remote_sftp';
export type ThemeMode = 'dark' | 'light';

export interface DriveInfo {
  name: string;
  path: string;
  kind: string;
  totalBytes: number | null;
  availableBytes: number | null;
}

export interface FileEntry {
  name: string;
  path: string;
  extension: string;
  fileType: 'dir' | 'file' | 'symlink' | 'symlink_dir' | string;
  size: number;
  modifiedMs: number | null;
  createdMs: number | null;
  readonly: boolean;
  hidden: boolean;
  system: boolean;
  permissionsText: string;
  octalMode: string;
  symlinkTarget: string | null;
}

export interface BreadcrumbSegment {
  label: string;
  path: string;
}

export interface DirectoryListing {
  path: string;
  parentPath: string | null;
  breadcrumbs: BreadcrumbSegment[];
  entries: FileEntry[];
  totalFiles: number;
  totalDirs: number;
  hiddenCount: number;
  totalBytes: number;
}

export interface FileProperties {
  entry: FileEntry;
  itemCount: number;
  calculatedSize: number;
  sha256: string | null;
}

export interface PaneState {
  currentPath: string;
  parentPath: string | null;
  breadcrumbs: BreadcrumbSegment[];
  entries: FileEntry[];
  totalFiles: number;
  totalDirs: number;
  hiddenCount: number;
  totalBytes: number;
  loading: boolean;
  error: string | null;
  showHidden: boolean;
  showTree: boolean;
  filterMask: string;
  sortField: SortField;
  sortDir: SortDirection;
  selectedPaths: string[];
  focusedPath: string | null;
  lastAnchorPath: string | null;
  history: string[];
  historyIndex: number;
}

export interface QueueItem {
  id: string;
  operation: 'copy' | 'move' | 'delete' | 'mkdir' | 'newfile' | 'rename';
  source: string;
  target: string;
  status: 'done' | 'running' | 'error';
  detail: string;
  timestamp: number;
}

export interface SessionTab {
  id: string;
  title: string;
  protocol: string;
  connected: boolean;
  color: string;
  site?: SiteConfig;
}

export type ActiveModalType =
  | 'none'
  | 'mkdir'
  | 'newfile'
  | 'symlink'
  | 'bookmarks'
  | 'rename'
  | 'delete'
  | 'properties'
  | 'opendir'
  | 'filter'
  | 'copy'
  | 'move'
  | 'synchronize'
  | 'keep_up_to_date'
  | 'find_files'
  | 'custom_commands'
  | 'preferences'
  | 'cleanup'
  | 'generate_url';
