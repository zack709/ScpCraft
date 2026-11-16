import type { FileEntry, SortDirection, SortField } from '../types/fs';

export function formatSizeKB(bytes: number): string {
  if (bytes <= 0) return '0 KB';
  const kb = Math.max(1, Math.ceil(bytes / 1024));
  return `${kb.toLocaleString('en-US')} KB`;
}

const FILE_TYPE_LABELS: Record<string, string> = {
  pdf: 'PDF Document',
  jpg: 'JPG 檔案',
  jpeg: 'JPG 檔案',
  png: 'PNG 檔案',
  zip: '壓縮檔',
  '7z': '壓縮檔',
  rar: '壓縮檔',
  exe: '應用程式',
  txt: '文字文件',
  md: 'Markdown 來源檔案',
  json: '組態設定',
  yaml: '組態設定',
  yml: '組態設定',
  ini: '組態設定',
  toml: '組態設定',
  ps1: 'Windows PowerShell 指令碼',
  cmd: 'Windows 命令指令碼',
  bat: 'Windows 命令指令碼',
  mp4: '視訊檔案',
  mkv: '視訊檔案',
  doc: 'Word 文件',
  docx: 'Word 文件',
  xls: 'Excel / CSV 檔案',
  xlsx: 'Excel / CSV 檔案',
  csv: 'Excel / CSV 檔案',
  ppt: 'PowerPoint 簡報',
  pptx: 'PowerPoint 簡報',
  rs: '程式碼來源檔案',
  ts: '程式碼來源檔案',
  tsx: '程式碼來源檔案',
  js: '程式碼來源檔案',
  py: '程式碼來源檔案',
  php: '程式碼來源檔案',
};

export function getFileTypeDescription(entry: FileEntry): string {
  if (isDirEntry(entry)) return '檔案資料夾';
  const ext = entry.extension.toLowerCase();
  if (ext && FILE_TYPE_LABELS[ext]) {
    return FILE_TYPE_LABELS[ext];
  }
  return entry.extension ? `${entry.extension.toUpperCase()} 檔案` : '檔案';
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = bytes / 1024;
  let unitIdx = 0;
  while (val >= 1024 && unitIdx < units.length - 1) {
    val /= 1024;
    unitIdx++;
  }
  return `${val >= 100 ? val.toFixed(0) : val >= 10 ? val.toFixed(1) : val.toFixed(2)} ${units[unitIdx]}`;
}

export function formatDateTime(ms: number | null): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const h24 = d.getHours();
  const period = h24 < 12 ? '上午' : '下午';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${period} ${pad(h12)}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function isDirEntry(entry: FileEntry): boolean {
  return entry.fileType === 'dir' || entry.fileType === 'symlink_dir';
}

export function matchFilterMask(name: string, mask: string): boolean {
  const trimmed = mask.trim();
  if (!trimmed || trimmed === '*' || trimmed === '*.*') return true;
  const patterns = trimmed
    .split(/[;,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (patterns.length === 0) return true;

  return patterns.some((pat) => {
    const escaped = pat
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    const regex = new RegExp(`^${escaped}$`, 'i');
    return regex.test(name);
  });
}

export function getVisibleSortedEntries(
  entries: FileEntry[],
  filterMask: string,
  sortField: SortField,
  sortDir: SortDirection,
  showHidden = true
): FileEntry[] {
  const filtered = entries.filter((entry) => {
    if (!showHidden && entry.hidden) return false;
    if (isDirEntry(entry)) return true; // Keep directories navigable like WinSCP
    return matchFilterMask(entry.name, filterMask);
  });

  const factor = sortDir === 'asc' ? 1 : -1;

  return [...filtered].sort((a, b) => {
    const aDir = isDirEntry(a);
    const bDir = isDirEntry(b);
    if (aDir !== bDir) {
      return aDir ? -1 : 1; // Folders always stay on top
    }

    let cmp = 0;
    switch (sortField) {
      case 'name':
        cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        break;
      case 'ext':
        cmp = a.extension.localeCompare(b.extension, undefined, { sensitivity: 'base' });
        if (cmp === 0) {
          cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        }
        break;
      case 'size':
        cmp = a.size - b.size;
        break;
      case 'type':
        cmp = getFileTypeDescription(a).localeCompare(getFileTypeDescription(b), 'zh-TW');
        break;
      case 'modified':
        cmp = (a.modifiedMs ?? 0) - (b.modifiedMs ?? 0);
        break;
      case 'attr':
        cmp = a.permissionsText.localeCompare(b.permissionsText);
        break;
    }

    if (cmp === 0) {
      cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    }
    return cmp * factor;
  });
}

/** Determine if a file/folder should appear visually dimmed like WinSCP hidden/system items. */
export function isEntryDimmed(entry: FileEntry): boolean {
  const lower = entry.name.toLowerCase();
  return (
    entry.hidden ||
    entry.system ||
    entry.name.startsWith('$') ||
    entry.name.startsWith('.') ||
    lower === 'desktop.ini' ||
    entry.name === 'System Volume Information'
  );
}

/** Extract compact folder label for WinSCP-style `<LeftDir> – <RightDir>` session tab titles. */
export function formatDirTabName(fullPath: string): string {
  const trimmed = fullPath.trim();
  if (!trimmed) return 'Local';
  if (/^[a-zA-Z]:[\\/]?$/.test(trimmed)) {
    return `${trimmed[0].toUpperCase()}:\\`;
  }
  if (trimmed === '/') return '/';
  const cleaned = trimmed.replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || trimmed;
}

/** Compare left and right directory listings and return paths of differing entries in each pane. */
export function findDifferentEntryPaths(
  leftEntries: FileEntry[],
  rightEntries: FileEntry[]
): { leftDiffPaths: string[]; rightDiffPaths: string[] } {
  const rightMap = new Map(rightEntries.map((e) => [e.name.toLowerCase(), e]));
  const leftMap = new Map(leftEntries.map((e) => [e.name.toLowerCase(), e]));

  const isDiff = (a: FileEntry, b: FileEntry | undefined): boolean => {
    if (!b) return true;
    const aDir = isDirEntry(a);
    const bDir = isDirEntry(b);
    if (aDir !== bDir) return true;
    if (aDir && bDir) return false;
    if (a.size !== b.size) return true;
    return Math.abs((a.modifiedMs ?? 0) - (b.modifiedMs ?? 0)) > 2000;
  };

  return {
    leftDiffPaths: leftEntries.filter((e) => isDiff(e, rightMap.get(e.name.toLowerCase()))).map((e) => e.path),
    rightDiffPaths: rightEntries.filter((e) => isDiff(e, leftMap.get(e.name.toLowerCase()))).map((e) => e.path),
  };
}

export function formatSpeedBps(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
  let value = bps;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const decimals = unitIndex === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

export function formatDurationSec(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hrs > 0 ? `${pad(hrs)}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
}
