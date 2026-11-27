#!/usr/bin/env python3
"""
Build 16 KB aligned arm64-v8a libmain.so with deterministic Android 11-16 Scudo
16GB UnityDefaultAllocator fix using Android NDK r27+.
"""
import os
import subprocess
from pathlib import Path

ANDROID_SDK = Path(os.environ.get(
    "FZZL_ANDROID_SDK",
    os.environ.get("ANDROID_SDK_ROOT", str(Path(os.environ.get("LOCALAPPDATA", "")) / "Android" / "Sdk")),
))
NDK27 = Path(os.environ.get("FZZL_NDK_27", str(ANDROID_SDK / "ndk" / "27.3.13750724")))
NDK_BIN = NDK27 / "toolchains" / "llvm" / "prebuilt" / ("windows-x86_64" if os.name == "nt" else "linux-x86_64") / "bin"
CLANG = NDK_BIN / ("aarch64-linux-android21-clang.cmd" if os.name == "nt" else "aarch64-linux-android21-clang")
READELF = NDK_BIN / ("llvm-readelf.exe" if os.name == "nt" else "llvm-readelf")

HERE = Path(__file__).resolve().parent
SRC = HERE / "libmain.c"
OUT = HERE / "libmain.so"


def main():
    cmd = [
        str(CLANG),
        "-shared", "-fPIC", "-O2", "-Wall", "-Wextra",
        "-Wl,-z,max-page-size=16384",
        "-Wl,-z,common-page-size=16384",
        "-Wl,--build-id=sha1",
        str(SRC),
        "-llog", "-ldl",
        "-o", str(OUT),
    ]
    print("Building:", " ".join(cmd))
    subprocess.run(cmd, check=True)
    out = subprocess.check_output([str(READELF), "-h", "-l", "--dyn-syms", str(OUT)], text=True)
    assert "AArch64" in out
    assert "JNI_OnLoad" in out
    aligns = sorted({l.split()[-1] for l in out.splitlines() if l.strip().startswith("LOAD")})
    assert aligns == ["0x4000"], f"Expected 0x4000 PT_LOAD align, got {aligns}"
    assert b"Ark64ScudoFix" in OUT.read_bytes()
    print(f"[PASS] Built {OUT} ({OUT.stat().st_size:,} B, AArch64, PT_LOAD={aligns})")


if __name__ == "__main__":
    main()
