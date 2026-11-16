import { useEffect, useState, type FormEvent } from 'react';
import { Link2, X } from 'lucide-react';
import { getTargetPathsForPane, useWorkspaceStore } from '../../stores/useWorkspaceStore';

export function SymlinkModal() {
  const {
    theme,
    activeModal,
    modalPane,
    rightPaneMode,
    leftPane,
    rightPane,
    closeModal,
    createSymlink,
  } = useWorkspaceStore();

  const [linkName, setLinkName] = useState('');
  const [targetPath, setTargetPath] = useState('');
  const [isHardLink, setIsHardLink] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pane = modalPane === 'left' ? leftPane : rightPane;
  const targets = getTargetPathsForPane(pane);
  const firstEntry = pane.entries.find((e) => e.path === targets[0]);

  useEffect(() => {
    if (activeModal === 'symlink') {
      const initialTarget = firstEntry ? firstEntry.path : '';
      const initialLink = firstEntry ? `${firstEntry.name}-link` : '';
      setLinkName(initialLink);
      setTargetPath(initialTarget);
      setIsHardLink(false);
      setBusy(false);
      setError(null);
    }
  }, [activeModal, firstEntry?.path]);

  if (activeModal !== 'symlink') return null;

  const isDark = theme === 'dark';
  const isRemoteSftp = modalPane === 'right' && rightPaneMode === 'remote_sftp';

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isRemoteSftp) {
      setError('Remote symlinks are only available while connected to an SFTP session.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createSymlink(modalPane, linkName, targetPath, isHardLink);
      closeModal();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  const inputCls = `w-full px-2.5 py-1.5 rounded border text-xs outline-none font-mono ${
    isDark
      ? 'bg-[#1b1b1c] border-[#454545] text-slate-100 focus:border-[#3b82f6]'
      : 'bg-white border-slate-300 text-slate-900 focus:border-blue-500'
  }`;

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
            <Link2 className="w-4 h-4 text-cyan-400" />
            <span>Add Link / Symlink</span>
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
            <label className="block mb-1 font-medium">Link / shortcut file name:</label>
            <input
              autoFocus
              type="text"
              required
              value={linkName}
              onChange={(e) => setLinkName(e.target.value)}
              placeholder="my-link"
              className={inputCls}
            />
          </div>

          <div>
            <label className="block mb-1 font-medium">Point link to:</label>
            <input
              type="text"
              required
              value={targetPath}
              onChange={(e) => setTargetPath(e.target.value)}
              placeholder="/var/www/current"
              className={inputCls}
            />
          </div>

          <label className="flex items-center gap-2 cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={isHardLink}
              onChange={(e) => setIsHardLink(e.target.checked)}
            />
            <span>Create hard link (requires OpenSSH hardlink@openssh.com)</span>
          </label>

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
