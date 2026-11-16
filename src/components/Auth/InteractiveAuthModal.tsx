import { useEffect, useState, type FormEvent } from 'react';
import { ChevronDown, ChevronRight, KeyRound, Lock, X } from 'lucide-react';
import { translate, type TranslationKey } from '../../i18n';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';

export function InteractiveAuthModal() {
  const {
    theme,
    locale,
    authChallenge,
    connectingSession,
    submitAuthChallenge,
    cancelAuthChallenge,
  } = useWorkspaceStore();
  const t = (key: TranslationKey) => translate(locale, key);

  const [responses, setResponses] = useState<string[]>([]);
  const [saveSecret, setSaveSecret] = useState(false);
  const [showLog, setShowLog] = useState(false);

  useEffect(() => {
    if (!authChallenge) return;
    setResponses(authChallenge.prompts.map(() => ''));
    setSaveSecret(false);
    setShowLog(Boolean(authChallenge.errorMessage));
  }, [authChallenge?.challengeId]);

  if (!authChallenge) return null;

  const isDark = theme === 'dark';
  const canPersistSecret =
    (authChallenge.authKind === 'password' || authChallenge.authKind === 'passphrase') &&
    Boolean(authChallenge.siteId);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await submitAuthChallenge(responses, canPersistSecret && saveSecret);
  };

  const inputCls = `w-full px-2.5 py-1.5 rounded border text-xs outline-none font-mono ${
    isDark
      ? 'bg-[#1b1b1c] border-[#454545] text-[#f0f0f0] focus:border-[#3b82f6]'
      : 'bg-white border-slate-300 text-slate-900 focus:border-blue-500'
  }`;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 p-4">
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
          <div className="flex items-center gap-2 truncate">
            {authChallenge.authKind === 'passphrase' ? (
              <KeyRound className="w-4 h-4 text-amber-400 shrink-0" />
            ) : (
              <Lock className="w-4 h-4 text-[#4da3ff] shrink-0" />
            )}
            <span className="truncate">{authChallenge.title || t('auth.title')}</span>
          </div>
          <button
            type="button"
            disabled={connectingSession}
            onClick={() => void cancelAuthChallenge()}
            className="p-0.5 rounded opacity-70 hover:opacity-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="p-4 space-y-3 text-xs">
          <div className="text-[11px] opacity-80 font-mono">
            {authChallenge.userName}@{authChallenge.host}:{authChallenge.port}
          </div>

          {authChallenge.logLines.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setShowLog((v) => !v)}
                className="inline-flex items-center gap-1 text-[11px] opacity-75 hover:opacity-100"
              >
                {showLog ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
                {t('auth.log')} ({authChallenge.logLines.length})
              </button>
              {showLog && (
                <div
                  className={`mt-1 max-h-24 overflow-y-auto p-2 rounded border font-mono text-[10px] space-y-0.5 ${
                    isDark ? 'bg-[#1b1b1c] border-[#3c3c3c]' : 'bg-slate-50 border-slate-200'
                  }`}
                >
                  {authChallenge.logLines.map((line, i) => (
                    <div key={i} className="truncate">
                      {line}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {authChallenge.errorMessage && (
            <div className="p-2 rounded bg-red-500/20 border border-red-500/40 text-red-300 text-[11px]">
              {authChallenge.errorMessage}
            </div>
          )}

          {authChallenge.instructions && (
            <div className="text-[11px] whitespace-pre-wrap leading-relaxed">
              {authChallenge.instructions}
            </div>
          )}

          <div className="space-y-2.5">
            {authChallenge.prompts.map((item, idx) => (
              <div key={item.id}>
                <label className="block mb-1 font-medium text-[11px]">{item.prompt}</label>
                <input
                  autoFocus={idx === 0}
                  type={item.echo ? 'text' : 'password'}
                  value={responses[idx] ?? ''}
                  onChange={(e) => {
                    const next = [...responses];
                    next[idx] = e.target.value;
                    setResponses(next);
                  }}
                  className={inputCls}
                />
              </div>
            ))}
          </div>

          {canPersistSecret && (
            <label className="flex items-center gap-2 cursor-pointer pt-1 text-[11px]">
              <input
                type="checkbox"
                checked={saveSecret}
                onChange={(e) => setSaveSecret(e.target.checked)}
              />
              <span>{t('auth.saveSecret')}</span>
            </label>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-black/10 dark:border-white/10">
            <button
              type="button"
              disabled={connectingSession}
              onClick={() => void cancelAuthChallenge()}
              className={`px-3 py-1.5 rounded border text-xs ${
                isDark ? 'border-[#454545] hover:bg-[#323233]' : 'border-slate-300 hover:bg-slate-100'
              }`}
            >
              {t('site.cancel')}
            </button>
            <button
              type="submit"
              disabled={connectingSession}
              className="px-4 py-1.5 rounded bg-[#1e4b85] hover:bg-[#255da3] text-white text-xs font-medium"
            >
              {connectingSession ? t('auth.authenticating') : t('site.ok')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
