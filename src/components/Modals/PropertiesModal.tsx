import { useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, FileText, Hash, Info, X } from 'lucide-react';
import { formatBytes, formatDateTime, isDirEntry } from '../../utils/formatters';
import { localFsApi } from '../../services/localFsApi';
import { sftpApi, type ChecksumEntry, type RemoteFileProperties } from '../../services/sftpApi';
import { getTargetPathsForPane, useWorkspaceStore } from '../../stores/useWorkspaceStore';
import type { FileProperties } from '../../types/fs';
import { PermissionsGrid } from './PermissionsGrid';

export function PropertiesModal() {
  const {
    theme,
    activeModal,
    modalPane,
    rightPaneMode,
    activeTabId,
    leftPane,
    rightPane,
    closeModal,
    refreshPane,
  } = useWorkspaceStore();

  const pane = modalPane === 'left' ? leftPane : rightPane;
  const targets = getTargetPathsForPane(pane);
  const firstEntry = pane.entries.find((e) => e.path === targets[0]) ?? null;
  const isRemoteSftp = modalPane === 'right' && rightPaneMode === 'remote_sftp';

  const [tab, setTab] = useState<'common' | 'checksum'>('common');
  const [localProps, setLocalProps] = useState<FileProperties | null>(null);
  const [remoteProps, setRemoteProps] = useState<RemoteFileProperties | null>(null);
  const [octalMode, setOctalMode] = useState('0644');
  const [ownerUidInput, setOwnerUidInput] = useState('');
  const [groupGidInput, setGroupGidInput] = useState('');
  const [addXToDirs, setAddXToDirs] = useState(false);
  const [recursive, setRecursive] = useState(false);
  const [checksumAlg, setChecksumAlg] = useState<'all' | 'SHA-256' | 'SHA-512' | 'CRC32'>('all');
  const [checksums, setChecksums] = useState<ChecksumEntry[]>([]);
  const [calculatingSize, setCalculatingSize] = useState(false);
  const [calculatingHash, setCalculatingHash] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (activeModal !== 'properties') return;

    setTab('common');
    setError(null);
    setChecksums([]);
    setAddXToDirs(false);
    setRecursive(false);
    setSaving(false);
    setCalculatingSize(false);
    setCalculatingHash(false);

    if (!targets[0]) {
      setLocalProps(null);
      setRemoteProps(null);
      return;
    }

    if (isRemoteSftp) {
      setLocalProps(null);
      setOctalMode(firstEntry?.octalMode || '0644');
      setOwnerUidInput('');
      setGroupGidInput('');
      if (targets.length === 1) {
        void sftpApi
          .getProperties(activeTabId, targets[0], false, null)
          .then((res) => {
            setRemoteProps(res);
            setOctalMode(res.entry.octalMode);
            setOwnerUidInput(res.uid !== null ? String(res.uid) : '');
            setGroupGidInput(res.gid !== null ? String(res.gid) : '');
          })
          .catch((err) => setError(String(err)));
      } else {
        setRemoteProps(null);
      }
    } else {
      setRemoteProps(null);
      void localFsApi
        .getProperties(targets[0], false)
        .then((res) => setLocalProps(res))
        .catch((err) => setError(String(err)));
    }
  }, [activeModal, modalPane, isRemoteSftp, targets[0]]);

  if (activeModal !== 'properties') return null;

  const isDark = theme === 'dark';
  const targetEntries = pane.entries.filter((e) => targets.includes(e.path));
  const anyDir = targetEntries.some(isDirEntry);
  const singleFileRemote =
    isRemoteSftp && targets.length === 1 && firstEntry !== null && !isDirEntry(firstEntry);

  const handleCalcSize = async () => {
    if (!targets[0]) return;
    setCalculatingSize(true);
    setError(null);
    try {
      if (isRemoteSftp) {
        const res = await sftpApi.getProperties(activeTabId, targets[0], true, null);
        setRemoteProps(res);
      } else {
        const res = await localFsApi.getProperties(targets[0], true);
        setLocalProps(res);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setCalculatingSize(false);
    }
  };

  const handleCalcChecksum = async () => {
    if (!targets[0] || !isRemoteSftp) return;
    setCalculatingHash(true);
    setError(null);
    try {
      const res = await sftpApi.getProperties(activeTabId, targets[0], false, checksumAlg);
      setChecksums(res.checksums);
    } catch (err) {
      setError(String(err));
    } finally {
      setCalculatingHash(false);
    }
  };

  const handleApplyRemote = async (e: FormEvent) => {
    e.preventDefault();
    if (!isRemoteSftp || targets.length === 0) {
      closeModal();
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const uid = ownerUidInput.trim() === '' ? null : Number.parseInt(ownerUidInput.trim(), 10);
      const gid = groupGidInput.trim() === '' ? null : Number.parseInt(groupGidInput.trim(), 10);
      if (ownerUidInput.trim() !== '' && (uid === null || Number.isNaN(uid) || uid < 0)) {
        throw new Error('Owner UID must be a non-negative integer.');
      }
      if (groupGidInput.trim() !== '' && (gid === null || Number.isNaN(gid) || gid < 0)) {
        throw new Error('Group GID must be a non-negative integer.');
      }

      const uidChanged =
        targets.length > 1 || (remoteProps ? uid !== remoteProps.uid : uid !== null);
      const gidChanged =
        targets.length > 1 || (remoteProps ? gid !== remoteProps.gid : gid !== null);

      await sftpApi.setPermissions(
        activeTabId,
        targets,
        octalMode,
        uidChanged ? uid : null,
        gidChanged ? gid : null,
        addXToDirs,
        recursive,
      );
      await refreshPane('right');
      closeModal();
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  };

  const handleCopyHash = async (alg: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedHash(alg);
      setTimeout(() => setCopiedHash(null), 1500);
    } catch {
      // Ignore clipboard failure
    }
  };

  const boxCls = `p-2.5 rounded border space-y-1.5 text-[11px] ${
    isDark ? 'bg-[#1b1b1c] border-[#3c3c3c]' : 'bg-slate-50 border-slate-200'
  }`;

  const inputCls = `px-2 py-1 rounded border text-xs outline-none font-mono ${
    isDark
      ? 'bg-[#1b1b1c] border-[#454545] text-slate-100 focus:border-[#3b82f6]'
      : 'bg-white border-slate-300 text-slate-900 focus:border-blue-500'
  }`;

  const activeEntry = remoteProps?.entry ?? localProps?.entry ?? firstEntry;
  const displaySize = remoteProps?.calculatedSize ?? localProps?.calculatedSize ?? activeEntry?.size ?? 0;
  const displayCount = remoteProps?.itemCount ?? localProps?.itemCount ?? 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeModal();
      }}
    >
      <div
        className={`w-full max-w-lg rounded-lg border shadow-2xl overflow-hidden ${
          isDark
            ? 'bg-[#252526] border-[#454545] text-[#e0e0e0]'
            : 'bg-white border-slate-300 text-slate-800'
        }`}
      >
        <div
          className={`flex items-center justify-between px-4 py-2.5 border-b text-xs font-semibold ${
            isDark ? 'bg-[#1e1e1e] border-[#3c3c3c]' : 'bg-slate-100 border-slate-200'
          }`}
        >
          <div className="flex items-center gap-2 truncate">
            <FileText className="w-4 h-4 text-[#4da3ff]" />
            <span className="truncate">
              {targets.length > 1
                ? `Properties (${targets.length} selected items)`
                : `Properties - ${activeEntry?.name ?? ''}`}
            </span>
          </div>
          <button
            type="button"
            onClick={closeModal}
            className="p-0.5 rounded opacity-70 hover:opacity-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* WinSCP TPROPERTIESDIALOG Tabs (Common / Checksum) */}
        {isRemoteSftp && (
          <div
            className={`flex border-b px-3 pt-2 gap-1 text-xs ${
              isDark ? 'border-[#3c3c3c] bg-[#1e1e1e]' : 'border-slate-200 bg-slate-50'
            }`}
          >
            <button
              type="button"
              onClick={() => setTab('common')}
              className={`px-3 py-1.5 rounded-t border-t border-x inline-flex items-center gap-1.5 ${
                tab === 'common'
                  ? isDark
                    ? 'bg-[#252526] border-[#454545] font-semibold'
                    : 'bg-white border-slate-300 font-semibold'
                  : 'border-transparent opacity-70 hover:opacity-100'
              }`}
            >
              <Info className="w-3.5 h-3.5" />
              Common
            </button>
            <button
              type="button"
              disabled={!singleFileRemote}
              onClick={() => setTab('checksum')}
              className={`px-3 py-1.5 rounded-t border-t border-x inline-flex items-center gap-1.5 disabled:opacity-40 ${
                tab === 'checksum'
                  ? isDark
                    ? 'bg-[#252526] border-[#454545] font-semibold'
                    : 'bg-white border-slate-300 font-semibold'
                  : 'border-transparent opacity-70 hover:opacity-100'
              }`}
            >
              <Hash className="w-3.5 h-3.5" />
              Checksum
            </button>
          </div>
        )}

        <form onSubmit={(e) => void handleApplyRemote(e)} className="p-4 space-y-3 text-xs">
          {error && (
            <div className="p-2 rounded bg-red-500/20 border border-red-500/40 text-red-300">
              {error}
            </div>
          )}

          {tab === 'common' && activeEntry && (
            <>
              <div className={boxCls}>
                <div className="flex justify-between gap-2">
                  <span className="opacity-70">Name:</span>
                  <span className="font-mono font-medium truncate">
                    {targets.length > 1 ? `${targets.length} items selected` : activeEntry.name}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="opacity-70">Location:</span>
                  <span className="font-mono truncate">
                    {targets.length > 1 ? pane.currentPath : activeEntry.path}
                  </span>
                </div>
                {targets.length === 1 && (
                  <>
                    <div className="flex justify-between gap-2">
                      <span className="opacity-70">Type:</span>
                      <span>{activeEntry.fileType}</span>
                    </div>
                    <div className="flex justify-between gap-2 items-center">
                      <span className="opacity-70">Size:</span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono">
                          {formatBytes(displaySize)} ({displaySize.toLocaleString()} bytes)
                        </span>
                        {isDirEntry(activeEntry) && (
                          <button
                            type="button"
                            disabled={calculatingSize}
                            onClick={() => void handleCalcSize()}
                            className="px-2 py-0.5 rounded bg-[#1e4b85] hover:bg-[#255da3] text-white text-[10px]"
                          >
                            {calculatingSize ? 'Calculating...' : 'Calculate'}
                          </button>
                        )}
                      </div>
                    </div>
                    {isDirEntry(activeEntry) && displayCount > 0 && (
                      <div className="flex justify-between gap-2">
                        <span className="opacity-70">Items inside:</span>
                        <span className="font-mono">{displayCount}</span>
                      </div>
                    )}
                    {!isRemoteSftp && (
                      <div className="flex justify-between gap-2">
                        <span className="opacity-70">Permissions:</span>
                        <span className="font-mono">
                          {activeEntry.permissionsText} (Octal {activeEntry.octalMode})
                        </span>
                      </div>
                    )}
                    <div className="flex justify-between gap-2">
                      <span className="opacity-70">Modified:</span>
                      <span className="font-mono">{formatDateTime(activeEntry.modifiedMs)}</span>
                    </div>
                    {!isRemoteSftp && (
                      <div className="flex justify-between gap-2">
                        <span className="opacity-70">Created:</span>
                        <span className="font-mono">{formatDateTime(activeEntry.createdMs)}</span>
                      </div>
                    )}
                    {activeEntry.symlinkTarget && (
                      <div className="flex justify-between gap-2">
                        <span className="opacity-70">Links to:</span>
                        <span className="font-mono truncate text-cyan-400">
                          {activeEntry.symlinkTarget}
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>

              {isRemoteSftp && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block mb-1 text-[11px] opacity-80">
                        Owner (UID{remoteProps?.ownerName ? `: ${remoteProps.ownerName}` : ''}):
                      </label>
                      <input
                        type="text"
                        value={ownerUidInput}
                        onChange={(e) => setOwnerUidInput(e.target.value)}
                        placeholder={targets.length > 1 ? '(unchanged)' : 'e.g. 1000'}
                        className={`w-full ${inputCls}`}
                      />
                    </div>
                    <div>
                      <label className="block mb-1 text-[11px] opacity-80">
                        Group (GID{remoteProps?.groupName ? `: ${remoteProps.groupName}` : ''}):
                      </label>
                      <input
                        type="text"
                        value={groupGidInput}
                        onChange={(e) => setGroupGidInput(e.target.value)}
                        placeholder={targets.length > 1 ? '(unchanged)' : 'e.g. 1000'}
                        className={`w-full ${inputCls}`}
                      />
                    </div>
                  </div>

                  <PermissionsGrid
                    octal={octalMode}
                    onChange={setOctalMode}
                    isDark={isDark}
                    showAddXToDirs={anyDir || targets.length > 1}
                    addXToDirs={addXToDirs}
                    onAddXToDirsChange={setAddXToDirs}
                  />

                  {(anyDir || targets.length > 1) && (
                    <label className="flex items-center gap-2 cursor-pointer text-[11px]">
                      <input
                        type="checkbox"
                        checked={recursive}
                        onChange={(e) => setRecursive(e.target.checked)}
                      />
                      <span>Set group, owner and permissions recursively</span>
                    </label>
                  )}
                </>
              )}
            </>
          )}

          {tab === 'checksum' && isRemoteSftp && activeEntry && (
            <div className="space-y-3">
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="block mb-1 text-[11px] font-medium">Checksum Algorithm:</label>
                  <select
                    value={checksumAlg}
                    onChange={(e) =>
                      setChecksumAlg(e.target.value as 'all' | 'SHA-256' | 'SHA-512' | 'CRC32')
                    }
                    className={`w-full ${inputCls}`}
                  >
                    <option value="all">All (SHA-256, SHA-512, CRC32)</option>
                    <option value="SHA-256">SHA-256</option>
                    <option value="SHA-512">SHA-512</option>
                    <option value="CRC32">CRC32</option>
                  </select>
                </div>
                <button
                  type="button"
                  disabled={calculatingHash}
                  onClick={() => void handleCalcChecksum()}
                  className="px-3 py-1.5 rounded bg-[#1e4b85] hover:bg-[#255da3] text-white text-xs font-medium"
                >
                  {calculatingHash ? 'Calculating...' : 'Calculate'}
                </button>
              </div>

              <div className={boxCls}>
                {checksums.length === 0 ? (
                  <div className="text-center py-4 opacity-60">
                    Click Calculate to compute checksum(s) from the remote file stream.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {checksums.map((item) => (
                      <div key={item.algorithm} className="space-y-0.5">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-[#4da3ff]">{item.algorithm}</span>
                          <button
                            type="button"
                            onClick={() => void handleCopyHash(item.algorithm, item.value)}
                            className="inline-flex items-center gap-1 text-[10px] opacity-80 hover:opacity-100"
                          >
                            {copiedHash === item.algorithm ? (
                              <Check className="w-3 h-3 text-emerald-400" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                            {copiedHash === item.algorithm ? 'Copied' : 'Copy'}
                          </button>
                        </div>
                        <div className="font-mono text-[10px] break-all select-all p-1.5 rounded bg-black/20">
                          {item.value}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-black/10 dark:border-white/10">
            <button
              type="button"
              onClick={closeModal}
              className={`px-3 py-1.5 rounded border text-xs ${
                isDark ? 'border-[#454545] hover:bg-[#323233]' : 'border-slate-300 hover:bg-slate-100'
              }`}
            >
              {isRemoteSftp && tab === 'common' ? 'Cancel' : 'Close'}
            </button>
            {isRemoteSftp && tab === 'common' && (
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-1.5 rounded bg-[#10b981] hover:bg-[#059669] text-white text-xs font-medium"
              >
                {saving ? 'Applying...' : 'OK'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
