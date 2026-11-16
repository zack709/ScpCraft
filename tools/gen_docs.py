"""Generate docs/winscp-actions.md (action/shortcut table) and docs/winscp-forms.md (per-form control summary)."""
import re, os, glob
D = r"E:\Workspace\ScpCraft\docs"

def vk(code):
    names = {8:"Backspace",9:"Tab",13:"Enter",27:"Esc",32:"Space",33:"PgUp",34:"PgDn",35:"End",36:"Home",37:"Left",38:"Up",39:"Right",40:"Down",45:"Ins",46:"Del",
             106:"Num*",107:"Num+",109:"Num-",111:"Num/",187:"=",189:"-"}
    if code in names: return names[code]
    if 112 <= code <= 135: return f"F{code-111}"
    if 48 <= code <= 90: return chr(code)
    return f"VK{code}"

def shortcut(v):
    v = int(v); mods = []
    if v & 0x2000: mods.append("Shift")
    if v & 0x4000: mods.append("Ctrl")
    if v & 0x8000: mods.append("Alt")
    return "+".join(mods + [vk(v & 0xFFF)])

def unq(s):  # python-literal-ish string
    s = s.strip()
    try: return eval(s) if s[:1] in "'\"" else s
    except Exception: return s

t = open(os.path.join(D, "dfm", "TNONVISUALDATAMODULE.dfm.txt"), encoding="utf-8").read()
rows = []
for m in re.finditer(r"\n    object (\w+): TAction\n(.*?)\n    end", t, re.S):
    name, body = m.groups()
    g = lambda k: (re.search(rf"\n      {k} = (.+)", "\n" + body) or [None, ""])[1]
    sc = g("ShortCut"); sc2 = re.findall(r"SecondaryShortCuts.*", body)
    rows.append((g("Category"), name, unq(g("Caption")).replace("&", ""), unq(g("Hint")).split("|")[0], shortcut(sc) if sc else ""))
rows.sort(key=lambda r: (unq(r[0]), r[1]))
out = ["# WinSCP 6.7.1 action & shortcut table", "", f"Source: `TNonVisualDataModule` (RT_RCDATA) of WinSCP.exe, {len(rows)} TAction entries. Shortcut = Delphi ShortCut int decoded.", "",
       "| Category | Action | Caption | Hint | Shortcut |", "|---|---|---|---|---|"]
for c, n, cap, h, s in rows:
    out.append(f"| {unq(c)} | {n} | {cap} | {h} | {s} |")
open(os.path.join(D, "winscp-actions.md"), "w", encoding="utf-8").write("\n".join(out))
print("actions", len(rows), "with shortcut", sum(1 for r in rows if r[4]))

# per form summary
forms = ["# WinSCP forms: visible controls (caption / hint text only)", ""]
for f in sorted(glob.glob(os.path.join(D, "dfm", "T*.dfm.txt"))):
    name = os.path.basename(f)[:-8]
    if name in ("TNONVISUALDATAMODULE",) or "MODULE" in name: continue
    txt = open(f, encoding="utf-8").read()
    forms.append(f"## {name}")
    seen = []
    for m in re.finditer(r"object (\w+): (T\w+)\n((?:\s+(?!object ).+\n?)*)", txt):
        n, c, body = m.groups()
        cap = re.search(r"\n?\s+Caption = (.+)", body)
        if cap and c not in ("TTBXItem", "TAction"):
            seen.append(f"- `{c}` {n}: {unq(cap.group(1)).replace('&','')}")
    forms += seen[:60] or ["- (no captions)"]
    forms.append("")
open(os.path.join(D, "winscp-forms.md"), "w", encoding="utf-8").write("\n".join(forms))
print("forms doc lines", len(forms))
