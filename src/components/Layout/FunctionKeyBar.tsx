import { useState } from 'react';
import { getTargetPathsForPane, useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { isMacOS } from '../../utils/platform';

export function FunctionKeyBar() {
  const {
    theme,
    activePane,
    leftPane,
    rightPane,
    showFunctionKeyBar,
    showCommandLineBar,
    openModal,
    runCommandInput,
    openFileInEditor,
  } = useWorkspaceStore();

  const [cmdText, setCmdText] = useState('');
  const isDark = theme === 'dark';
  const isMac = isMacOS();
  const paneState = activePane === 'left' ? leftPane : rightPane;
  const hasSelection = getTargetPathsForPane(paneState).length > 0;

  const buttons = [
    { keyLabel: 'F2', label: 'Rename', enabled: hasSelection, onClick: () => openModal('rename', activePane) },
    {
      keyLabel: 'F4',
      label: 'Edit',
      enabled: hasSelection,
      onClick: () => void openFileInEditor(activePane),
    },
    { keyLabel: 'F5', label: 'Copy', enabled: hasSelection, onClick: () => openModal('copy', activePane) },
    { keyLabel: 'F6', label: 'Move', enabled: hasSelection, onClick: () => openModal('move', activePane) },
    { keyLabel: 'F7', label: 'New Dir', enabled: true, onClick: () => openModal('mkdir', activePane) },
    { keyLabel: 'F8', label: 'Delete', enabled: hasSelection, onClick: () => openModal('delete', activePane) },
    { keyLabel: 'F9', label: 'Properties', enabled: hasSelection, onClick: () => openModal('properties', activePane) },
    { keyLabel: isMac ? '⌘O' : 'Ctrl+O', label: 'Open Dir', enabled: true, onClick: () => openModal('opendir', activePane) },
  ];

  return (
    <div
      className={`shrink-0 border-t ${
        isMac
          ? isDark
            ? 'bg-[#242426] border-white/10 text-[#f5f5f7]'
            : 'bg-[#f5f5f7] border-black/10 text-[#1d1d1f]'
          : isDark
          ? 'bg-slate-900 border-slate-700/80 text-slate-200'
          : 'bg-slate-100 border-slate-300 text-slate-800'
      }`}
    >
      {/* Optional CommandLineToolbar */}
      {showCommandLineBar && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            runCommandInput(cmdText);
            setCmdText('');
          }}
          className={`flex items-center gap-2 px-2 py-1 border-b text-xs ${
            isDark ? 'border-slate-800 bg-slate-950/70' : 'border-slate-200 bg-white'
          }`}
        >
          <span className="font-mono text-blue-500 font-semibold shrink-0">Command &gt;</span>
          <input
            type="text"
            value={cmdText}
            onChange={(e) => setCmdText(e.target.value)}
            placeholder="Type `cd <path>` to navigate active pane..."
            className={`flex-1 px-2 py-0.5 rounded border text-xs font-mono outline-none ${
              isDark
                ? 'bg-slate-900 border-slate-700 text-slate-100 focus:border-blue-500'
                : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-blue-500'
            }`}
          />
        </form>
      )}

      {/* Hot Keys Bar (Toolbar2Toolbar from TScpCommanderForm) */}
      {showFunctionKeyBar && (
        <div className={`grid grid-cols-4 sm:grid-cols-8 ${isMac ? 'gap-1.5 px-3 py-1.5' : 'gap-1 p-1'}`}>
          {buttons.map((btn) => (
            <button
              key={btn.keyLabel}
              type="button"
              disabled={!btn.enabled}
              onClick={btn.onClick}
              className={`flex items-center justify-center gap-1.5 px-2 ${
                isMac ? 'py-1.5 rounded-lg' : 'py-1 rounded border'
              } text-xs transition-colors ${
                btn.enabled
                  ? isMac
                    ? isDark
                      ? 'bg-white/8 hover:bg-white/14 text-[#f5f5f7]'
                      : 'bg-white hover:bg-black/4 text-[#1d1d1f] shadow-2xs ring-1 ring-black/8'
                    : isDark
                    ? 'bg-slate-800/80 border-slate-700 hover:bg-slate-700 text-slate-200'
                    : 'bg-white border-slate-300 hover:bg-blue-50 text-slate-800'
                  : isMac
                  ? isDark
                    ? 'bg-white/3 text-[#636366] cursor-not-allowed'
                    : 'bg-black/3 text-[#aeaeb2] cursor-not-allowed'
                  : isDark
                  ? 'bg-slate-900/40 border-slate-800 text-slate-600 cursor-not-allowed'
                  : 'bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed'
              }`}
            >
              <kbd
                className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold ${
                  isMac
                    ? isDark
                      ? 'bg-white/10 text-[#64d2ff]'
                      : 'bg-black/6 text-[#0066cc]'
                    : isDark
                    ? 'bg-slate-700 text-blue-300'
                    : 'bg-slate-200 text-blue-700'
                }`}
              >
                {btn.keyLabel}
              </kbd>
              <span className="truncate">{btn.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
