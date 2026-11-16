import { useEffect, useState, type FormEvent } from 'react';
import { FolderPlus, X } from 'lucide-react';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { PermissionsGrid } from './PermissionsGrid';

export function CreateDirModal() {
  const {
    theme,
    activeModal,
    modalPane,
    rightPaneMode,
    leftPane,
    rightPane,
    closeModal,
    createDirectory,
  } = useWorkspaceStore();

  const [dirName, setDirName] = useState('');
  const [setRights, setSetRights] = useState(false);
  const [octalMode, setOctalMode] = useState('0755');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isRemoteSftp = modalPane === 'right' && rightPaneMode === 'remote_sftp';

  useEffect(() => {
    if (activeModal === 'mkdir') {
      setDirName('');
      setSetRights(false);
      setOctalMode('0755');
      setBusy(false);
      setError(null);
    }
  }, [activeModal]);

  if (activeModal !== 'mkdir') return null;

  const isDark = theme === 'dark';
  const pane = modalPane === 'left' ? leftPane : rightPane;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createDirectory(
        modalPane,
        dirName,
        isRemoteSftp && setRights ? octalMode : null,
      );
      closeModal();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeModal();
      }}
    >
      <div
        className={`w-full max-w-md rounded-lg border shadow-2xl overflow-hidden ${
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
          <div className="flex items-center gap-2">
            <FolderPlus className="w-4 h-4 text-[#4da3ff]" />
            <span>Create Directory</span>
          </div>
          <button
            type="button"
            onClick={closeModal}
            className="p-0.5 rounded opacity-70 hover:opacity-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="p-4 space-y-3 text-xs">
          {error && (
            <div className="p-2 rounded bg-red-500/20 border border-red-500/40 text-red-300">
              {error}
            </div>
          )}

          <div>
            <label className="block mb-1 font-medium">New folder name:</label>
            <input
              autoFocus
              type="text"
              required
              value={dirName}
              onChange={(e) => setDirName(e.target.value)}
              placeholder={isRemoteSftp ? 'folder or parent/child' : 'New Folder'}
              className={`w-full px-2.5 py-1.5 rounded border text-xs outline-none font-mono ${
                isDark
                  ? 'bg-[#1b1b1c] border-[#454545] text-slate-100 focus:border-[#3b82f6]'
                  : 'bg-white border-slate-300 text-slate-900 focus:border-blue-500'
              }`}
            />
            <div className="mt-1 text-[10px] opacity-65 font-mono truncate">
              In: {pane.currentPath}
            </div>
          </div>

          {isRemoteSftp && (
            <div className="space-y-2 pt-1">
              <label className="flex items-center gap-2 cursor-pointer font-medium">
                <input
                  type="checkbox"
                  checked={setRights}
                  onChange={(e) => setSetRights(e.target.checked)}
                />
                <span>Set permissions</span>
              </label>

              {setRights && (
                <PermissionsGrid
                  octal={octalMode}
                  onChange={setOctalMode}
                  isDark={isDark}
                />
              )}
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
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-1.5 rounded bg-[#1e4b85] hover:bg-[#255da3] text-white text-xs font-medium"
            >
              {busy ? 'Creating...' : 'OK'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
