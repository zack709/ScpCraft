export interface PosixPermState {
  ownerR: boolean;
  ownerW: boolean;
  ownerX: boolean;
  groupR: boolean;
  groupW: boolean;
  groupX: boolean;
  otherR: boolean;
  otherW: boolean;
  otherX: boolean;
  setUid: boolean;
  setGid: boolean;
  sticky: boolean;
}

export function octalToPermState(octal: string): PosixPermState {
  const clean = /^[0-7]{1,4}$/.test(octal.trim()) ? parseInt(octal.trim(), 8) : 0o644;
  return {
    ownerR: (clean & 0o400) !== 0,
    ownerW: (clean & 0o200) !== 0,
    ownerX: (clean & 0o100) !== 0,
    groupR: (clean & 0o040) !== 0,
    groupW: (clean & 0o020) !== 0,
    groupX: (clean & 0o010) !== 0,
    otherR: (clean & 0o004) !== 0,
    otherW: (clean & 0o002) !== 0,
    otherX: (clean & 0o001) !== 0,
    setUid: (clean & 0o4000) !== 0,
    setGid: (clean & 0o2000) !== 0,
    sticky: (clean & 0o1000) !== 0,
  };
}

export function permStateToOctal(s: PosixPermState): string {
  let mode = 0;
  if (s.ownerR) mode |= 0o400;
  if (s.ownerW) mode |= 0o200;
  if (s.ownerX) mode |= 0o100;
  if (s.groupR) mode |= 0o040;
  if (s.groupW) mode |= 0o020;
  if (s.groupX) mode |= 0o010;
  if (s.otherR) mode |= 0o004;
  if (s.otherW) mode |= 0o002;
  if (s.otherX) mode |= 0o001;
  if (s.setUid) mode |= 0o4000;
  if (s.setGid) mode |= 0o2000;
  if (s.sticky) mode |= 0o1000;
  return mode.toString(8).padStart(4, '0');
}

export function formatPermSymbolic(s: PosixPermState): string {
  const u = [
    s.ownerR ? 'r' : '-',
    s.ownerW ? 'w' : '-',
    s.ownerX ? (s.setUid ? 's' : 'x') : s.setUid ? 'S' : '-',
  ].join('');
  const g = [
    s.groupR ? 'r' : '-',
    s.groupW ? 'w' : '-',
    s.groupX ? (s.setGid ? 's' : 'x') : s.setGid ? 'S' : '-',
  ].join('');
  const o = [
    s.otherR ? 'r' : '-',
    s.otherW ? 'w' : '-',
    s.otherX ? (s.sticky ? 't' : 'x') : s.sticky ? 'T' : '-',
  ].join('');
  return `${u}${g}${o}`;
}

interface PermissionsGridProps {
  octal: string;
  onChange: (nextOctal: string) => void;
  isDark: boolean;
  showAddXToDirs?: boolean;
  addXToDirs?: boolean;
  onAddXToDirsChange?: (val: boolean) => void;
  disabled?: boolean;
}

export function PermissionsGrid({
  octal,
  onChange,
  isDark,
  showAddXToDirs = false,
  addXToDirs = false,
  onAddXToDirsChange,
  disabled = false,
}: PermissionsGridProps) {
  const state = octalToPermState(octal);
  const symbolic = formatPermSymbolic(state);

  const toggleKey = (key: keyof PosixPermState) => {
    if (disabled) return;
    const next = { ...state, [key]: !state[key] };
    onChange(permStateToOctal(next));
  };

  const toggleRow = (keys: [keyof PosixPermState, keyof PosixPermState, keyof PosixPermState]) => {
    if (disabled) return;
    const allChecked = keys.every((k) => state[k]);
    const next = { ...state };
    for (const k of keys) {
      next[k] = !allChecked;
    }
    onChange(permStateToOctal(next));
  };

  const boxCls = `p-2.5 rounded border space-y-2 text-[11px] ${
    isDark ? 'bg-[#1b1b1c] border-[#3c3c3c]' : 'bg-slate-50 border-slate-200'
  }`;

  const rowBtnCls = `text-left px-1.5 py-0.5 rounded font-medium ${
    disabled
      ? 'opacity-50'
      : isDark
      ? 'hover:bg-[#323233] text-slate-200'
      : 'hover:bg-slate-200 text-slate-800'
  }`;

  return (
    <div className={boxCls}>
      <div className="flex items-center justify-between border-b pb-1.5 border-black/10 dark:border-white/10">
        <span className="font-semibold">Permissions</span>
        <span className="font-mono text-[11px] text-[#4da3ff]">{symbolic}</span>
      </div>

      <div className="grid grid-cols-[80px_repeat(3,48px)_1fr] items-center gap-y-1.5 gap-x-1">
        <div />
        <div className="text-center opacity-70 font-medium">R</div>
        <div className="text-center opacity-70 font-medium">W</div>
        <div className="text-center opacity-70 font-medium">X</div>
        <div className="text-right opacity-70 font-medium pr-1">Special</div>

        {/* Owner row */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => toggleRow(['ownerR', 'ownerW', 'ownerX'])}
          className={rowBtnCls}
          title="Toggle all Owner bits"
        >
          Owner
        </button>
        <label className="flex justify-center cursor-pointer">
          <input
            type="checkbox"
            disabled={disabled}
            checked={state.ownerR}
            onChange={() => toggleKey('ownerR')}
          />
        </label>
        <label className="flex justify-center cursor-pointer">
          <input
            type="checkbox"
            disabled={disabled}
            checked={state.ownerW}
            onChange={() => toggleKey('ownerW')}
          />
        </label>
        <label className="flex justify-center cursor-pointer">
          <input
            type="checkbox"
            disabled={disabled}
            checked={state.ownerX}
            onChange={() => toggleKey('ownerX')}
          />
        </label>
        <label className="flex items-center justify-end gap-1.5 cursor-pointer pr-1">
          <span>Set UID</span>
          <input
            type="checkbox"
            disabled={disabled}
            checked={state.setUid}
            onChange={() => toggleKey('setUid')}
          />
        </label>

        {/* Group row */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => toggleRow(['groupR', 'groupW', 'groupX'])}
          className={rowBtnCls}
          title="Toggle all Group bits"
        >
          Group
        </button>
        <label className="flex justify-center cursor-pointer">
          <input
            type="checkbox"
            disabled={disabled}
            checked={state.groupR}
            onChange={() => toggleKey('groupR')}
          />
        </label>
        <label className="flex justify-center cursor-pointer">
          <input
            type="checkbox"
            disabled={disabled}
            checked={state.groupW}
            onChange={() => toggleKey('groupW')}
          />
        </label>
        <label className="flex justify-center cursor-pointer">
          <input
            type="checkbox"
            disabled={disabled}
            checked={state.groupX}
            onChange={() => toggleKey('groupX')}
          />
        </label>
        <label className="flex items-center justify-end gap-1.5 cursor-pointer pr-1">
          <span>Set GID</span>
          <input
            type="checkbox"
            disabled={disabled}
            checked={state.setGid}
            onChange={() => toggleKey('setGid')}
          />
        </label>

        {/* Others row */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => toggleRow(['otherR', 'otherW', 'otherX'])}
          className={rowBtnCls}
          title="Toggle all Others bits"
        >
          Others
        </button>
        <label className="flex justify-center cursor-pointer">
          <input
            type="checkbox"
            disabled={disabled}
            checked={state.otherR}
            onChange={() => toggleKey('otherR')}
          />
        </label>
        <label className="flex justify-center cursor-pointer">
          <input
            type="checkbox"
            disabled={disabled}
            checked={state.otherW}
            onChange={() => toggleKey('otherW')}
          />
        </label>
        <label className="flex justify-center cursor-pointer">
          <input
            type="checkbox"
            disabled={disabled}
            checked={state.otherX}
            onChange={() => toggleKey('otherX')}
          />
        </label>
        <label className="flex items-center justify-end gap-1.5 cursor-pointer pr-1">
          <span>Sticky bit</span>
          <input
            type="checkbox"
            disabled={disabled}
            checked={state.sticky}
            onChange={() => toggleKey('sticky')}
          />
        </label>
      </div>

      <div className="flex items-center justify-between gap-3 pt-1.5 border-t border-black/10 dark:border-white/10">
        <label className="flex items-center gap-2">
          <span>Octal:</span>
          <input
            type="text"
            maxLength={4}
            disabled={disabled}
            value={octal}
            onChange={(e) => {
              const cleaned = e.target.value.replace(/[^0-7]/g, '').slice(0, 4);
              onChange(cleaned);
            }}
            onBlur={() => {
              if (!/^[0-7]{3,4}$/.test(octal.trim())) {
                onChange(permStateToOctal(state));
              } else if (octal.length === 3) {
                onChange(`0${octal}`);
              }
            }}
            className={`w-16 px-2 py-1 rounded border font-mono text-center text-xs outline-none ${
              isDark
                ? 'bg-[#252526] border-[#454545] text-slate-100 focus:border-[#3b82f6]'
                : 'bg-white border-slate-300 text-slate-900 focus:border-blue-500'
            }`}
          />
        </label>

        {showAddXToDirs && onAddXToDirsChange && (
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              disabled={disabled}
              checked={addXToDirs}
              onChange={(e) => onAddXToDirsChange(e.target.checked)}
            />
            <span>Add X to directories</span>
          </label>
        )}
      </div>
    </div>
  );
}
