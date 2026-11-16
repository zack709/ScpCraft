"""Extract Delphi/C++Builder binary DFM forms (RT_RCDATA) from WinSCP.exe into text.

Input : JSON from `craft-anything-cli --deep --format json native-pe-resources-list`
Output: docs/dfm/<FORMNAME>.txt  + docs/dfm/_index.md
"""
import json, os, struct, subprocess, sys

CLI = r"E:\Programs\craft-anything-0.6.1-windows-x64-portable\craft-anything-cli.exe"
EXE = r"E:\Workspace\ScpCraft\WinSCP-6.7.1\WinSCP.exe"
OUT = r"E:\Workspace\ScpCraft\docs\dfm"


class R:
    def __init__(s, b): s.b, s.p = b, 0
    def u8(s): v = s.b[s.p]; s.p += 1; return v
    def i(s, fmt, n): v = struct.unpack_from(fmt, s.b, s.p)[0]; s.p += n; return v
    def pstr(s): n = s.u8(); v = s.b[s.p:s.p + n].decode('latin-1'); s.p += n; return v


def value(r, t):
    if t == 0: return "null"
    if t == 1:
        items = []
        while r.b[r.p] != 0: items.append(value(r, r.u8()))
        r.p += 1
        return "[" + ", ".join(items) + "]"
    if t == 2: return str(r.i('<b', 1))
    if t == 3: return str(r.i('<h', 2))
    if t == 4: return str(r.i('<i', 4))
    if t == 5: r.p += 10; return "<ext>"
    if t == 6: return repr(r.pstr())
    if t == 7: return r.pstr()
    if t == 8: return "False"
    if t == 9: return "True"
    if t == 10:
        n = r.i('<I', 4); r.p += n; return f"<binary {n}b>"
    if t == 11:
        items = []
        while True:
            s = r.pstr()
            if not s: break
            items.append(s)
        return "[" + ", ".join(items) + "]"
    if t in (12, 20):
        n = r.i('<I', 4); v = r.b[r.p:r.p + n].decode('utf-8', 'replace'); r.p += n; return repr(v)
    if t == 13: return "nil"
    if t == 14:
        items = []
        while r.b[r.p] != 0:
            r.u8()  # vaList marker for the item
            if r.b[r.p] in (2, 3, 4):
                n = r.b[r.p]; nm = r.b[r.p + 1:r.p + 1 + n]
                looks_name = nm.isascii() and nm[:1].isalpha() and nm.replace(b'_', b'a').isalnum() and r.b[r.p + 1 + n] <= 21
                if not looks_name: value(r, r.u8())
            props = []
            while r.b[r.p] != 0:
                n = r.pstr(); props.append(f"{n}={value(r, r.u8())}")
            r.p += 1
            items.append("{" + "; ".join(props) + "}")
        r.p += 1
        return "<" + ", ".join(items) + ">"
    if t == 15: r.p += 4; return "<single>"
    if t == 16: r.p += 8; return "<currency>"
    if t == 17: r.p += 8; return "<date>"
    if t == 18:
        n = r.i('<I', 4); v = r.b[r.p:r.p + n * 2].decode('utf-16le', 'replace'); r.p += n * 2; return repr(v)
    if t == 19: return str(r.i('<q', 8))
    if t == 21: return str(r.i('<d', 8))
    raise ValueError(f"unknown value type {t} at {r.p}")


def component(r, out, depth):
    if r.b[r.p] & 0xF0 == 0xF0:
        flags = r.u8() & 0x0F
        if flags & 2: value(r, r.u8())
    cls = r.pstr(); name = r.pstr()
    ind = "  " * depth
    out.append(f"{ind}object {name}: {cls}")
    while r.b[r.p] != 0:
        pn = r.pstr(); out.append(f"{ind}  {pn} = {value(r, r.u8())}")
    r.p += 1
    while r.b[r.p] != 0: component(r, out, depth + 1)
    r.p += 1
    out.append(f"{ind}end")


def main():
    js = json.loads(subprocess.check_output(
        [CLI, "--deep", "--format", "json", "native-pe-resources-list", "--path", EXE, "--max-entries", "16384"]))
    entries = [e for e in js["result"]["entries"] if e["type"] == "RT_RCDATA"]
    data = open(EXE, "rb").read()
    os.makedirs(OUT, exist_ok=True)
    index = ["# DFM form index (extracted from WinSCP.exe 6.7.1)", "", "| Resource | Size | Status | Root class | Controls |", "|---|---|---|---|---|"]
    for e in entries:
        raw = data[e["file_offset"]:e["file_offset"] + e["size"]]
        if raw[:4] != b"TPF0":
            index.append(f"| {e['name']} | {e['size']} | not a DFM | - | - |"); continue
        try:
            r = R(raw); r.p = 4; out = []
            component(r, out, 0)
            text = "\n".join(out)
            open(os.path.join(OUT, e["name"] + ".dfm.txt"), "w", encoding="utf-8").write(text)
            root = out[0].split(":")[-1].strip()
            index.append(f"| {e['name']} | {e['size']} | ok | {root} | {sum(1 for l in out if l.lstrip().startswith('object '))} |")
        except Exception as ex:
            index.append(f"| {e['name']} | {e['size']} | parse error: {ex} | - | - |")
    open(os.path.join(OUT, "_index.md"), "w", encoding="utf-8").write("\n".join(index))
    print("\n".join(index))


main()
