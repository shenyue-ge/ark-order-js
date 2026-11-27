#!/usr/bin/env python3
"""
Clean C# 4.0 re-decompilation of Assembly-CSharp-firstpass.dll and Assembly-CSharp.dll
from the local base game APK (FZZL_BASE_APK or <repo>/fzzl.apk) using ilspycmd with
all Managed reference DLLs (-r) and -lv CSharp4.
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
BUILD64 = HERE.parent
ROOT = BUILD64.parent
APK_PATH = Path(os.environ.get("FZZL_BASE_APK", str(ROOT / "fzzl.apk")))
STAGING = BUILD64 / "staging"
FP_OUT = STAGING / "cs_clean_fp"
MAIN_OUT = STAGING / "cs_clean_main"
REPORTS = BUILD64 / "reports"

CHECK_PATTERNS = {
    "ctor_call_artifact": re.compile(r"\._002Ector\b"),
    "redundant_cast_object": re.compile(r"\([A-Za-z_][A-Za-z0-9_<>.]*\)\(object\)"),
    "file_scoped_namespace": re.compile(r"^\s*namespace\s+[A-Za-z0-9_.]+\s*;", re.M),
    "out_var_inline": re.compile(r"\bout\s+(?:var|[A-Za-z_][A-Za-z0-9_<>.]*)\s+[A-Za-z_][A-Za-z0-9_]*\b"),
    "null_conditional": re.compile(r"\?\.|\?\["),
    "string_interpolation": re.compile(r'\$"'),
    "decompiler_error_comment": re.compile(r"//\s*(?:Error decompiling|Invalid|Unable to)"),
    "il_label_comment": re.compile(r"//\s*IL_[0-9a-fA-F]{4}"),
}


def scan(dir_path: Path):
    c = Counter()
    files = list(dir_path.rglob("*.cs"))
    for f in files:
        t = f.read_text(encoding="utf-8", errors="replace")
        for k, rx in CHECK_PATTERNS.items():
            n = len(rx.findall(t))
            if n:
                c[k] += n
    return len(files), dict(c)


def main():
    REPORTS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ark64_managed_") as td:
        td_path = Path(td)
        with zipfile.ZipFile(APK_PATH, "r") as zf:
            prefix = "assets/bin/Data/Managed/"
            for name in zf.namelist():
                if name.startswith(prefix) and name.endswith(".dll"):
                    (td_path / name[len(prefix):]).write_bytes(zf.read(name))

        for dst, dll_name in [(FP_OUT, "Assembly-CSharp-firstpass.dll"), (MAIN_OUT, "Assembly-CSharp.dll")]:
            if dst.exists():
                trash = BUILD64 / "_trash"
                trash.mkdir(parents=True, exist_ok=True)
                shutil.move(str(dst), str(trash / f"{dst.name}_{id(dst)}"))
            dst.mkdir(parents=True, exist_ok=True)
            cmd = [
                "ilspycmd",
                "-p",
                "--nested-directories",
                "-lv", "CSharp4",
                "-r", str(td_path),
                "--disable-updatecheck",
                "-o", str(dst),
                str(td_path / dll_name),
            ]
            print("Running:", " ".join(cmd), flush=True)
            res = subprocess.run(cmd, capture_output=True, text=True)
            print(f"  exit={res.returncode}")
            if res.stderr.strip():
                print("  stderr:", res.stderr[:500])
            for drop in list(dst.glob("*.csproj")) + list(dst.rglob("AssemblyInfo.cs")):
                drop.unlink(missing_ok=True)

        fp_n, fp_c = scan(FP_OUT)
        main_n, main_c = scan(MAIN_OUT)
        summary = {
            "firstpass": {"cs_files": fp_n, "pattern_hits": fp_c},
            "main": {"cs_files": main_n, "pattern_hits": main_c},
        }
        out = REPORTS / "clean_decompile.json"
        out.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
        print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
