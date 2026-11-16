import { useState } from 'react';
import { AlertTriangle, FileClock, X } from 'lucide-react';
import { transferApi, type ConflictResolution } from '../../services/transferApi';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { formatBytes, formatDateTime } from '../../utils/formatters';

export function OverwriteModal() {
  const { theme, transferSnapshot } = useWorkspaceStore();
  const [busy, setBusy] = useState(false);

  const conflict = transferSnapshot?.activeConflict ?? null;
  if (!conflict) return null;

  const isDark = theme === 'dark';
  const canResume =
    (conflict.hasFilepart &&
      conflict.filepartSize > 0 &&
      conflict.filepartSize <= conflict.sourceSize) ||
    (conflict.targetSize > 0 && conflict.targetSize < conflict.sourceSize);

  const filepartPct =
    conflict.hasFilepart && conflict.sourceSize > 0
      ? Math.min(100, Math.round((conflict.filepartSize / conflict.sourceSize) * 100))
      : 0;

  const handleResolve = async (resolution: ConflictResolution) => {
    setBusy(true);
    try {
      await transferApi.resolveConflict(conflict.itemId, resolution);
    } finally {
      setBusy(false);
    }
  };

  const btnCls = `px-2.5 py-1.5 rounded border text-xs font-medium disabled:opacity-40 transition-colors ${
    isDark
      ? 'border-[#454545] bg-[#2c2c2d] hover:bg-[#38383a] text-[#e0e0e0]'
      : 'border-slate-300 bg-white hover:bg-slate-100 text-slate-800'
  }`;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div
        className={`w-full max-w-lg rounded border shadow-2xl overflow-hidden text-xs ${
          isDark
            ? 'bg-[#252526] border-[#454545] text-[#e0e0e0]'
            : 'bg-white border-slate-300 text-slate-800'
        }`}
      >
        <div
          className={`flex items-center justify-between px-4 py-2.5 border-b font-semibold ${
            isDark ? 'bg-[#1e1e1e] border-[#3c3c3c]' : 'bg-slate-100 border-slate-200'
          }`}
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            <span>Confirm File Overwrite / Resume</span>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleResolve('cancel')}
            className="p-0.5 rounded opacity-70 hover:opacity-100"
            title="Cancel batch"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="space-y-1">
            <div className="font-medium">
              Target file already exists{conflict.hasFilepart ? ' (.filepart found)' : ''}:
            </div>
            <div className="font-mono text-[11px] text-[#4da3ff] break-all">
              {conflict.targetPath}
            </div>
          </div>

          {conflict.hasFilepart && (
            <div
              className={`p-2.5 rounded border flex items-center gap-2 text-[11px] ${
                isDark
                  ? 'bg-amber-950/40 border-amber-700/60 text-amber-200'
                  : 'bg-amber-50 border-amber-300 text-amber-900'
              }`}
            >
              <FileClock className="w-4 h-4 shrink-0 text-amber-400" />
              <span>
                Incomplete <code className="font-mono">.filepart</code> detected:{' '}
                <strong>{formatBytes(conflict.filepartSize)}</strong> of{' '}
                <strong>{formatBytes(conflict.sourceSize)}</strong> ({filepartPct}% transferred).
                Choose <strong>Resume</strong> to continue from offset{' '}
                <code className="font-mono">{conflict.filepartSize}</code>.
              </span>
            </div>
          )}

          {/* Side-by-side comparison matching WinSCP Overwrite Confirmation */}
          <div className="grid grid-cols-2 gap-2.5 text-[11px]">
            <div
              className={`p-2.5 rounded border space-y-1 ${
                isDark ? 'bg-[#1e1e1e] border-[#3c3c3c]' : 'bg-slate-50 border-slate-200'
              }`}
            >
              <div className="font-semibold text-emerald-400">Source File</div>
              <div className="font-mono truncate" title={conflict.sourcePath}>
                {conflict.fileName}
              </div>
              <div>
                Size: <strong>{formatBytes(conflict.sourceSize)}</strong>
              </div>
              <div className="opacity-75">
                Modified: {formatDateTime(conflict.sourceMtimeMs)}
              </div>
            </div>

            <div
              className={`p-2.5 rounded border space-y-1 ${
                isDark ? 'bg-[#1e1e1e] border-[#3c3c3c]' : 'bg-slate-50 border-slate-200'
              }`}
            >
              <div className="font-semibold text-amber-400">Existing Target</div>
              <div className="font-mono truncate" title={conflict.targetPath}>
                {conflict.fileName}
              </div>
              <div>
                Size: <strong>{formatBytes(conflict.targetSize)}</strong>
              </div>
              <div className="opacity-75">
                Modified: {formatDateTime(conflict.targetMtimeMs)}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 pt-1">
            {canResume && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleResolve('resume')}
                className="px-2.5 py-1.5 rounded bg-[#10b981] hover:bg-[#059669] text-white text-xs font-medium"
              >
                Resume
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleResolve('overwrite')}
              className="px-2.5 py-1.5 rounded bg-[#1e4b85] hover:bg-[#255da3] text-white text-xs font-medium"
            >
              Overwrite
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleResolve('overwrite_all')}
              className={btnCls}
            >
              Yes to All
            </button>
            {canResume && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleResolve('resume_all')}
                className={btnCls}
              >
                Resume All
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleResolve('rename')}
              className={btnCls}
            >
              Auto-Rename
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleResolve('rename_all')}
              className={btnCls}
            >
              Rename All
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleResolve('newer_only')}
              className={btnCls}
            >
              Newer Only
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleResolve('skip')}
              className={btnCls}
            >
              Skip (No)
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleResolve('skip_all')}
              className={btnCls}
            >
              Skip All
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleResolve('cancel')}
              className="px-2.5 py-1.5 rounded bg-red-600/80 hover:bg-red-600 text-white text-xs font-medium"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
