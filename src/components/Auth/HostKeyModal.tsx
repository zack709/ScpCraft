import { useState } from 'react';
import { AlertTriangle, Check, Copy, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';

export function HostKeyModal() {
  const {
    theme,
    hostKeyPrompt,
    connectingSession,
    trustAndReconnectHostKey,
    cancelHostKeyPrompt,
  } = useWorkspaceStore();
  const [copied, setCopied] = useState(false);

  if (!hostKeyPrompt) return null;

  const isDark = theme === 'dark';
  const isMismatch = hostKeyPrompt.status === 'mismatch';

  const handleCopyKey = async () => {
    try {
      await navigator.clipboard.writeText(hostKeyPrompt.publicKeyOpenssh);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Ignore clipboard write restrictions
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 p-4">
      <div
        className={`w-full max-w-lg rounded-lg border shadow-2xl overflow-hidden ${
          isDark
            ? 'bg-[#252526] border-[#454545] text-[#e0e0e0]'
            : 'bg-white border-slate-300 text-slate-800'
        }`}
      >
        <div
          className={`flex items-center justify-between px-4 py-2.5 border-b text-xs font-semibold ${
            isMismatch
              ? 'bg-red-900/40 border-red-500/40 text-red-200'
              : isDark
              ? 'bg-[#1e1e1e] border-[#3c3c3c]'
              : 'bg-amber-50 border-amber-200 text-amber-900'
          }`}
        >
          <div className="flex items-center gap-2">
            {isMismatch ? (
              <ShieldAlert className="w-4 h-4 text-red-400 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            )}
            <span>
              {isMismatch
                ? 'WARNING - POTENTIAL SECURITY BREACH! Host Key Changed'
                : 'Unknown Server Host Key'}
            </span>
          </div>
          <button
            type="button"
            disabled={connectingSession}
            onClick={() => void cancelHostKeyPrompt()}
            className="p-0.5 rounded opacity-75 hover:opacity-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3 text-xs">
          {isMismatch ? (
            <div className="p-2.5 rounded border border-red-500/40 bg-red-500/15 text-[11px] leading-relaxed">
              The host key cached for{' '}
              <span className="font-mono font-semibold">
                {hostKeyPrompt.host}:{hostKeyPrompt.port}
              </span>{' '}
              does not match the key presented by the server
              {hostKeyPrompt.mismatchLine ? ` (known_hosts line ${hostKeyPrompt.mismatchLine})` : ''}.
              Either the server administrator regenerated the host key or an attacker is intercepting
              the connection.
            </div>
          ) : (
            <p className="text-[11px] leading-relaxed opacity-90">
              The server&apos;s {hostKeyPrompt.keyAlgorithm} host key is not cached in{' '}
              <span className="font-mono">{hostKeyPrompt.knownHostsPath}</span>. Verify the
              fingerprint below matches your administrator&apos;s record before continuing.
            </p>
          )}

          <div
            className={`p-3 rounded border space-y-2 font-mono text-[11px] ${
              isDark ? 'bg-[#1b1b1c] border-[#3c3c3c]' : 'bg-slate-50 border-slate-200'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-sans opacity-70">Target Host:</span>
              <span className="font-semibold">
                {hostKeyPrompt.host}:{hostKeyPrompt.port}
                {hostKeyPrompt.isTunnel ? ' (Jump Host)' : ''}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-sans opacity-70">Key Algorithm:</span>
              <span>{hostKeyPrompt.keyAlgorithm}</span>
            </div>
            <div>
              <div className="font-sans opacity-70 mb-0.5">SHA-256 Fingerprint:</div>
              <div className="break-all select-all">{hostKeyPrompt.fingerprintSha256}</div>
            </div>
            <div>
              <div className="font-sans opacity-70 mb-0.5">SHA-512 Fingerprint:</div>
              <div className="break-all select-all text-[10px] opacity-85">
                {hostKeyPrompt.fingerprintSha512}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => void handleCopyKey()}
              className={`px-2.5 py-1 rounded border text-[11px] inline-flex items-center gap-1.5 ${
                isDark
                  ? 'border-[#454545] hover:bg-[#323233]'
                  : 'border-slate-300 hover:bg-slate-100'
              }`}
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied Public Key' : 'Copy OpenSSH Key'}
            </button>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-black/10 dark:border-white/10">
            <button
              type="button"
              disabled={connectingSession}
              onClick={() => void cancelHostKeyPrompt()}
              className={`px-3 py-1.5 rounded border text-xs ${
                isDark ? 'border-[#454545] hover:bg-[#323233]' : 'border-slate-300 hover:bg-slate-100'
              }`}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={connectingSession}
              onClick={() => void trustAndReconnectHostKey(false)}
              className={`px-3 py-1.5 rounded border text-xs ${
                isDark
                  ? 'border-amber-600/60 bg-amber-600/20 hover:bg-amber-600/35 text-amber-200'
                  : 'border-amber-400 bg-amber-50 hover:bg-amber-100 text-amber-900'
              }`}
            >
              Accept Once
            </button>
            <button
              type="button"
              disabled={connectingSession}
              onClick={() => void trustAndReconnectHostKey(true)}
              className="px-3 py-1.5 rounded bg-[#10b981] hover:bg-[#059669] text-white text-xs font-medium inline-flex items-center gap-1.5"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              {connectingSession
                ? 'Connecting...'
                : isMismatch
                ? 'Update known_hosts'
                : 'Accept & Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
