import { useEffect, useState } from 'react';
import { Check, Loader2, Settings, X } from 'lucide-react';
import { translate, type LocaleCode } from '../../i18n';
import type { AppPreferences } from '../../services/phase6Api';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';

type PrefCategory = 'environment' | 'confirmations' | 'transfer' | 'editor' | 'panels';

export function PreferencesModal() {
  const {
    theme,
    locale,
    activeModal,
    preferences,
    loadPreferences,
    savePreferences,
    closeModal,
  } = useWorkspaceStore();

  const isOpen = activeModal === 'preferences';
  const isDark = theme === 'dark';

  const [category, setCategory] = useState<PrefCategory>('environment');
  const [draft, setDraft] = useState<AppPreferences>(preferences);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setDraft(preferences);
    void loadPreferences().then(() => {
      setDraft(useWorkspaceStore.getState().preferences);
    });
  }, [isOpen]);

  if (!isOpen) return null;

  const t = (k: Parameters<typeof translate>[1]) => translate(locale, k);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await savePreferences(draft);
      closeModal();
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  };

  const categories: { id: PrefCategory; label: string }[] = [
    { id: 'environment', label: t('pref.cat.environment') },
    { id: 'confirmations', label: t('pref.cat.confirmations') },
    { id: 'transfer', label: t('pref.cat.transfer') },
    { id: 'editor', label: t('pref.cat.editor') },
    { id: 'panels', label: t('pref.cat.panels') },
  ];

  const inputCls = `w-full px-2.5 py-1.5 rounded border text-xs outline-none ${
    isDark
      ? 'bg-[#1e1e1e] border-[#3c3c3f] text-[#e0e0e0] focus:border-emerald-500'
      : 'bg-white border-slate-300 text-slate-900 focus:border-emerald-600'
  }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) closeModal();
      }}
    >
      <div
        className={`w-full max-w-2xl rounded-lg border shadow-2xl overflow-hidden text-xs ${
          isDark
            ? 'bg-[#252526] border-[#3f3f46] text-[#d4d4d4]'
            : 'bg-white border-slate-300 text-slate-800'
        }`}
      >
        <div
          className={`flex items-center justify-between px-4 py-2.5 border-b font-semibold ${
            isDark ? 'bg-[#1e1e1e] border-[#333337]' : 'bg-slate-100 border-slate-200'
          }`}
        >
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-amber-300" />
            <span>{t('pref.title')}</span>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={closeModal}
            className="p-0.5 rounded opacity-70 hover:opacity-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex min-h-[340px]">
          <div
            className={`w-48 border-r p-2 space-y-1 shrink-0 ${
              isDark ? 'bg-[#202022] border-[#333337]' : 'bg-slate-50 border-slate-200'
            }`}
          >
            {categories.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategory(c.id)}
                className={`w-full text-left px-3 py-1.5 rounded text-[11px] font-medium transition-colors ${
                  category === c.id
                    ? isDark
                      ? 'bg-[#1e4b85] text-white'
                      : 'bg-[#cce4f7] text-[#003366]'
                    : isDark
                      ? 'hover:bg-[#2d2d30] text-[#cccccc]'
                      : 'hover:bg-slate-200/70 text-slate-700'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>

          <div className="flex-1 p-4 space-y-4">
            {category === 'environment' && (
              <div className="space-y-3">
                <div>
                  <label className="block mb-1 text-[11px] opacity-80">{t('pref.language')}</label>
                  <select
                    value={draft.language}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, language: e.target.value as LocaleCode }))
                    }
                    className={inputCls}
                  >
                    <option value="zh-TW">繁體中文 (Traditional Chinese)</option>
                    <option value="en">English</option>
                  </select>
                </div>

                <div>
                  <label className="block mb-1 text-[11px] opacity-80">{t('pref.theme')}</label>
                  <select
                    value={draft.theme}
                    onChange={(e) => setDraft((d) => ({ ...d, theme: e.target.value }))}
                    className={inputCls}
                  >
                    <option value="dark">Dark (VS Code / Modern Dark)</option>
                    <option value="light">Light (Classic Clean Light)</option>
                  </select>
                </div>

                <div>
                  <label className="block mb-1 text-[11px] opacity-80">{t('pref.interfaceMode')}</label>
                  <select
                    value={draft.interfaceMode}
                    onChange={(e) => setDraft((d) => ({ ...d, interfaceMode: e.target.value }))}
                    className={inputCls}
                  >
                    <option value="commander">Commander (Dual Pane)</option>
                    <option value="explorer">Explorer (Single Pane)</option>
                  </select>
                </div>

                <label className="flex items-center gap-2 cursor-pointer pt-1 text-[11px]">
                  <input
                    type="checkbox"
                    checked={draft.rememberSessionTabs}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, rememberSessionTabs: e.target.checked }))
                    }
                  />
                  <span>{t('pref.rememberTabs')}</span>
                </label>
              </div>
            )}

            {category === 'confirmations' && (
              <div className="space-y-2.5 text-[11px]">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.confirmOverwriting}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, confirmOverwriting: e.target.checked }))
                    }
                  />
                  <span>{t('pref.confirmOverwrite')}</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.confirmDeleting}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, confirmDeleting: e.target.checked }))
                    }
                  />
                  <span>{t('pref.confirmDelete')}</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.confirmClosingSession}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, confirmClosingSession: e.target.checked }))
                    }
                  />
                  <span>{t('pref.confirmClose')}</span>
                </label>
              </div>
            )}

            {category === 'transfer' && (
              <div className="space-y-3">
                <div>
                  <label className="block mb-1 text-[11px] opacity-80">{t('pref.maxConcurrent')}</label>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={draft.maxConcurrentTransfers}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        maxConcurrentTransfers: Math.min(8, Math.max(1, Number(e.target.value) || 1)),
                      }))
                    }
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="block mb-1 text-[11px] opacity-80">{t('pref.speedLimit')}</label>
                  <input
                    type="number"
                    min={0}
                    step={64}
                    value={draft.defaultSpeedLimitKbps}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        defaultSpeedLimitKbps: Math.max(0, Number(e.target.value) || 0),
                      }))
                    }
                    className={inputCls}
                  />
                </div>
                <label className="flex items-center gap-2 cursor-pointer text-[11px]">
                  <input
                    type="checkbox"
                    checked={draft.useFilepartResume}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, useFilepartResume: e.target.checked }))
                    }
                  />
                  <span>{t('pref.useFilepart')}</span>
                </label>
              </div>
            )}

            {category === 'editor' && (
              <div className="space-y-3">
                <div>
                  <label className="block mb-1 text-[11px] opacity-80">{t('pref.externalEditor')}</label>
                  <input
                    type="text"
                    value={draft.externalEditorCommand}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, externalEditorCommand: e.target.value }))
                    }
                    placeholder="code --wait"
                    className={`${inputCls} font-mono`}
                  />
                </div>
                <div>
                  <label className="block mb-1 text-[11px] opacity-80">{t('pref.dblClick')}</label>
                  <select
                    value={draft.doubleClickAction}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, doubleClickAction: e.target.value }))
                    }
                    className={inputCls}
                  >
                    <option value="edit">Edit (Built-in / External Editor, F4)</option>
                    <option value="properties">Properties (F9)</option>
                    <option value="open">Transfer / Copy</option>
                  </select>
                </div>
              </div>
            )}

            {category === 'panels' && (
              <div className="space-y-2.5 text-[11px]">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.showHiddenFiles}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, showHiddenFiles: e.target.checked }))
                    }
                  />
                  <span>{t('pref.showHidden')}</span>
                </label>
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="px-4 py-1.5 bg-rose-500/15 border-t border-rose-500/30 text-rose-400 text-[11px]">
            {error}
          </div>
        )}

        <div
          className={`px-4 py-2.5 border-t flex justify-end gap-2 ${
            isDark ? 'bg-[#1e1e1e] border-[#333337]' : 'bg-slate-100 border-slate-200'
          }`}
        >
          <button
            type="button"
            disabled={saving}
            onClick={closeModal}
            className={`px-3 py-1.5 rounded border text-xs ${
              isDark
                ? 'border-[#454545] hover:bg-[#323233] disabled:opacity-40'
                : 'border-slate-300 hover:bg-slate-200 disabled:opacity-40'
            }`}
          >
            {t('pref.cancel')}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void handleSave()}
            className="px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-medium inline-flex items-center gap-1.5"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            {t('pref.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
