#!/usr/bin/env python3
"""
Verify an arm64-v8a libLive2DCubismCore.so candidate against:
  1. ELF64 AArch64 architecture
  2. PT_LOAD segment alignment (reports 4KB vs 16KB)
  3. 100% coverage of CubismCoreDll.cs EntryPoints + reference csm* exports (if report present)
"""
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BUILD64 = HERE.parent.parent

ANDROID_SDK = Path(os.environ.get(
    "FZZL_ANDROID_SDK",
    os.environ.get("ANDROID_SDK_ROOT", str(Path(os.environ.get("LOCALAPPDATA", "")) / "Android" / "Sdk")),
))
NDK27 = Path(os.environ.get("FZZL_NDK_27", str(ANDROID_SDK / "ndk" / "27.3.13750724")))
LLVM_BIN = NDK27 / "toolchains" / "llvm" / "prebuilt" / ("windows-x86_64" if os.name == "nt" else "linux-x86_64") / "bin"
LLVM_NM = LLVM_BIN / ("llvm-nm.exe" if os.name == "nt" else "llvm-nm")
LLVM_READELF = LLVM_BIN / ("llvm-readelf.exe" if os.name == "nt" else "llvm-readelf")
SYMBOLS_JSON = BUILD64 / "reports" / "native_symbols.json"
DEFAULT_SO = HERE / "libLive2DCubismCore.so"


def main():
    so_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SO
    if not so_path.exists():
        print(f"[MISSING] {so_path}")
        print("Download Live2D Cubism SDK for Native (https://www.live2d.com/en/sdk/download/native/)")
        print(f"and copy Core/dll/android/arm64-v8a/libLive2DCubismCore.so to:\n  {DEFAULT_SO}")
        sys.exit(1)

    hdr = subprocess.check_output([str(LLVM_READELF), "-h", "-l", str(so_path)], text=True)
    if "AArch64" not in hdr:
        print("FAIL: Not an AArch64 ELF binary!")
        sys.exit(2)
    loads = [l.strip() for l in hdr.splitlines() if l.strip().startswith("LOAD")]
    align_16k = all("0x4000" in l for l in loads)
    print(f"ELF: AArch64, PT_LOAD count={len(loads)}, 16KB aligned={align_16k}")
    for l in loads:
        print(" ", l)

    nm_out = subprocess.check_output([str(LLVM_NM), "-D", "--defined-only", str(so_path)], text=True)
    exports = {
        parts[2]
        for line in nm_out.splitlines()
        for parts in [line.split()]
        if len(parts) >= 3 and parts[1] in ("T", "D", "R", "B", "W", "V")
    }
    csm_exports = sorted(e for e in exports if e.startswith("csm"))
    print(f"Exported csm* symbols: {len(csm_exports)}")

    if SYMBOLS_JSON.is_file():
        base = json.loads(SYMBOLS_JSON.read_text(encoding="utf-8"))["cubism"]
        req_cs = set(base["cs_entrypoints"])
        req_ref = set(base["ref_csm_exports"])
        miss_cs = sorted(req_cs - exports)
        miss_ref = sorted(req_ref - exports)
        cubism53_mapped = False
        if "csmGetDrawableRenderOrders" in miss_cs and "csmGetRenderOrders" in exports:
            miss_cs.remove("csmGetDrawableRenderOrders")
            cubism53_mapped = True
        if "csmGetDrawableRenderOrders" in miss_ref and "csmGetRenderOrders" in exports:
            miss_ref.remove("csmGetDrawableRenderOrders")
            cubism53_mapped = True
        print(f"CubismCoreDll.cs EntryPoints: {len(req_cs) - len(miss_cs)}/{len(req_cs)} (missing: {miss_cs}, cubism5.3_mapped={cubism53_mapped})")
        print(f"32-bit ref csm* exports:      {len(req_ref) - len(miss_ref)}/{len(req_ref)} (missing: {miss_ref})")
        if miss_cs or miss_ref:
            sys.exit(3)

    print("PASS: arm64 libLive2DCubismCore.so verified!")


if __name__ == "__main__":
    main()
