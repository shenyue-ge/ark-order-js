#!/usr/bin/env python3
"""
Build arm64-v8a/libtolua.so (LuaJIT 2.1.0-beta3 GC64 + tolua_runtime C extensions)
purely on Windows using:
  - Host tools (minilua.exe, buildvm.exe): VS2022 x64 MSVC (cl.exe)
  - Target cross-compiler: Android NDK 27.3.13750724 (aarch64-linux-android21-clang)
  - 16 KB page-size safe:
      * -Wl,-z,max-page-size=16384 (all PT_LOAD aligned to 0x4000)
      * Runtime sysconf(_SC_PAGESIZE) for mmap/mprotect in lj_mcode.c / lj_alloc.c / lj_ccallback.c
        while preserving LJ_PAGESIZE=4096 in lj_str.c (safe on both 4KB & 16KB devices)
  - Built-in verification against apkbuild64/reports/g03_native_symbols.json
"""
import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BUILD64 = HERE.parent.parent
TOLUA_SRC = Path(os.environ.get("FZZL_TOLUA_SRC", r"F:\ark64_tools\tolua_runtime"))
WORK_DIR = Path(os.environ.get("FZZL_TOLUA_WORK", str(BUILD64 / "staging" / "tolua_build_arm64")))
_SDK = Path(os.environ.get("FZZL_ANDROID_SDK", os.environ.get("ANDROID_SDK_ROOT", str(Path(os.environ.get("LOCALAPPDATA", "")) / "Android" / "Sdk"))))
NDK27 = Path(os.environ.get("FZZL_NDK_27", str(_SDK / "ndk" / "27.3.13750724")))
LLVM_BIN = NDK27 / "toolchains" / "llvm" / "prebuilt" / "windows-x86_64" / "bin"
CLANG = LLVM_BIN / "aarch64-linux-android21-clang.cmd"
LLVM_NM = LLVM_BIN / "llvm-nm.exe"
LLVM_READELF = LLVM_BIN / "llvm-readelf.exe"
LLVM_STRIP = LLVM_BIN / "llvm-strip.exe"

VCVARS64 = Path(os.environ.get("FZZL_VCVARS64", r"C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"))

OUT_DIR = HERE
OUT_SO = OUT_DIR / "libtolua.so"
SYMBOLS_JSON = BUILD64 / "reports" / "native_symbols.json"

LJLIB_C = [
    "lib_base.c", "lib_math.c", "lib_bit.c", "lib_string.c", "lib_table.c",
    "lib_io.c", "lib_os.c", "lib_package.c", "lib_debug.c", "lib_jit.c", "lib_ffi.c",
]

LJCORE_C = [
    "lj_gc.c", "lj_err.c", "lj_char.c", "lj_bc.c", "lj_obj.c", "lj_buf.c",
    "lj_str.c", "lj_tab.c", "lj_func.c", "lj_udata.c", "lj_meta.c", "lj_debug.c",
    "lj_state.c", "lj_dispatch.c", "lj_vmevent.c", "lj_vmmath.c", "lj_strscan.c",
    "lj_strfmt.c", "lj_strfmt_num.c", "lj_api.c", "lj_profile.c",
    "lj_lex.c", "lj_parse.c", "lj_bcread.c", "lj_bcwrite.c", "lj_load.c",
    "lj_ir.c", "lj_opt_mem.c", "lj_opt_fold.c", "lj_opt_narrow.c",
    "lj_opt_dce.c", "lj_opt_loop.c", "lj_opt_split.c", "lj_opt_sink.c",
    "lj_mcode.c", "lj_snap.c", "lj_record.c", "lj_crecord.c", "lj_ffrecord.c",
    "lj_asm.c", "lj_trace.c", "lj_gdbjit.c",
    "lj_ctype.c", "lj_cdata.c", "lj_cconv.c", "lj_ccall.c", "lj_ccallback.c",
    "lj_carith.c", "lj_clib.c", "lj_cparse.c",
    "lj_lib.c", "lj_alloc.c", "lib_aux.c",
] + LJLIB_C + ["lib_init.c"]

TOLUA_C_FILES = [
    "tolua.c", "int64.c", "uint64.c", "pb.c", "lpeg.c", "struct.c",
    "cjson/strbuf.c", "cjson/lua_cjson.c", "cjson/fpconv.c",
    "luasocket/auxiliar.c", "luasocket/buffer.c", "luasocket/except.c",
    "luasocket/inet.c", "luasocket/io.c", "luasocket/luasocket.c",
    "luasocket/mime.c", "luasocket/options.c", "luasocket/select.c",
    "luasocket/tcp.c", "luasocket/timeout.c", "luasocket/udp.c",
    "luasocket/usocket.c",
]


def run(cmd, cwd=None, env=None):
    res = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)
    if res.returncode != 0:
        print("CMD FAILED:", cmd)
        print("STDOUT:", res.stdout[-2000:])
        print("STDERR:", res.stderr[-2000:])
        sys.exit(res.returncode)
    return res.stdout


def get_msvc_env():
    cmd = f'"{VCVARS64}" >nul && set'
    out = subprocess.check_output(cmd, shell=True, text=True)
    env = os.environ.copy()
    for line in out.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            env[k] = v
    return env


def patch_pagesize(lj_src: Path):
    """Use runtime sysconf(_SC_PAGESIZE) for mmap/mprotect while keeping LJ_PAGESIZE=4096 for lj_str.c."""
    helper = """
#if defined(__ANDROID__) || defined(__linux__)
#include <unistd.h>
static size_t lj_runtime_pagesize(void) {
  static size_t ps = 0;
  if (!ps) {
    long v = sysconf(_SC_PAGESIZE);
    ps = (v > 0) ? (size_t)v : 4096;
  }
  return ps;
}
#define LJ_OS_PAGESIZE (lj_runtime_pagesize())
#else
#define LJ_OS_PAGESIZE LJ_PAGESIZE
#endif
"""
    for fname in ("lj_mcode.c", "lj_alloc.c"):
        p = lj_src / fname
        txt = p.read_text(encoding="utf-8", errors="replace")
        if "LJ_OS_PAGESIZE" in txt:
            continue
        # Insert helper after #include "lj_obj.h" or first #include
        m = re.search(r'^#include\s+"[^"]+"\s*$', txt, re.M)
        assert m, f"No include found in {fname}"
        txt = txt[:m.end()] + "\n" + helper + "\n" + txt[m.end():]
        txt = txt.replace("LJ_PAGESIZE", "LJ_OS_PAGESIZE")
        p.write_text(txt, encoding="utf-8")
        print(f"[PATCHED 16KB] {fname}")

    # lj_ccallback.c uses CALLBACK_MCODE_SIZE in `#if CALLBACK_MAX_SLOT`, so it needs a
    # compile-time constant. 16384 is an exact multiple of both 4KB and 16KB OS pages.
    cb_p = lj_src / "lj_ccallback.c"
    cb_txt = cb_p.read_text(encoding="utf-8", errors="replace")
    if "#define CALLBACK_MCODE_SIZE\t(LJ_PAGESIZE * LJ_NUM_CBPAGE)" in cb_txt:
        cb_txt = cb_txt.replace(
            "#define CALLBACK_MCODE_SIZE\t(LJ_PAGESIZE * LJ_NUM_CBPAGE)",
            "#define CALLBACK_MCODE_SIZE\t(16384 * LJ_NUM_CBPAGE)",
        )
        cb_p.write_text(cb_txt, encoding="utf-8")
        print("[PATCHED 16KB] lj_ccallback.c (16384 compile-time multiple)")

    # On ARM64, LJ_K64__MAX and LJ_K32__MAX are 0; GCC/Clang allow T[0] in struct (0 bytes),
    # while MSVC rejects it. Guard with #if !LJ_TARGET_ARM64 so host buildvm & target clang match identically.
    lj_jit = lj_src / "lj_jit.h"
    jtxt = lj_jit.read_text(encoding="utf-8", errors="replace")
    target_block = (
        "  TValue k64[LJ_K64__MAX];  /* Common 8 byte constants used by backends. */\n"
        "  uint32_t k32[LJ_K32__MAX];  /* Ditto for 4 byte constants. */"
    )
    if target_block in jtxt:
        jtxt = jtxt.replace(target_block, "#if !LJ_TARGET_ARM64\n" + target_block + "\n#endif")
        lj_jit.write_text(jtxt, encoding="utf-8")
        print("[PATCHED MSVC-ARM64] lj_jit.h")


def main():
    if WORK_DIR.exists():
        shutil.rmtree(WORK_DIR)
    shutil.copytree(TOLUA_SRC, WORK_DIR, ignore=shutil.ignore_patterns(".git", "Plugins"))
    lj_src = WORK_DIR / "luajit-2.1" / "src"
    patch_pagesize(lj_src)

    # 1. Probe target architecture defines via NDK clang (mirrors LuaJIT Makefile)
    target_defines = [
        "-DLUAJIT_ENABLE_GC64=1",
        "-DLJ_ARCH_HASFPU=1",
        "-DLJ_ABI_SOFTFP=0",
    ]
    probe = run([str(CLANG), "-E", "-dM", *target_defines, str(lj_src / "lj_arch.h")])
    def has_macro(pat):
        return re.search(pat, probe, re.M) is not None
    ver_m = re.search(r"^#define\s+LJ_ARCH_VERSION\s+(\d+)", probe, re.M)
    arch_ver = ver_m.group(1) if ver_m else "80"

    dasm_flags = []
    dasm_flags += ["-D", "ENDIAN_LE" if has_macro(r"^#define\s+LJ_LE\s+1\b") else "ENDIAN_BE"]
    if has_macro(r"^#define\s+LJ_ARCH_BITS\s+64\b"):
        dasm_flags += ["-D", "P64"]
    if has_macro(r"^#define\s+LJ_HASJIT\s+1\b"):
        dasm_flags += ["-D", "JIT"]
    if has_macro(r"^#define\s+LJ_HASFFI\s+1\b"):
        dasm_flags += ["-D", "FFI"]
    if has_macro(r"^#define\s+LJ_DUALNUM\s+1\b"):
        dasm_flags += ["-D", "DUALNUM"]
    if has_macro(r"^#define\s+LJ_ARCH_HASFPU\s+1\b"):
        dasm_flags += ["-D", "FPU"]
    if not has_macro(r"^#define\s+LJ_ABI_SOFTFP\s+1\b"):
        dasm_flags += ["-D", "HFABI"]
    if has_macro(r"^#define\s+LJ_NO_UNWIND\s+1\b"):
        dasm_flags += ["-D", "NO_UNWIND"]
    dasm_flags += ["-D", f"VER={arch_ver}"]
    print("Detected DASM flags:", " ".join(dasm_flags))

    # 2. Build host minilua.exe and buildvm.exe using MSVC x64
    msvc_env = get_msvc_env()
    cl_exe = shutil.which("cl", path=msvc_env.get("PATH") or msvc_env.get("Path"))
    assert cl_exe, "cl.exe not found after vcvars64.bat!"
    print(f"[HOST] Building minilua.exe with {cl_exe}...")
    run([cl_exe, "/nologo", "/O2", "/D_CRT_SECURE_NO_DEPRECATE", "host\\minilua.c", "/Fe:host\\minilua.exe"], cwd=lj_src, env=msvc_env)

    print("[HOST] Generating host/buildvm_arch.h...")
    run([str(lj_src / "host" / "minilua.exe"), "../dynasm/dynasm.lua", *dasm_flags, "-o", "host/buildvm_arch.h", "vm_arm64.dasc"], cwd=lj_src)

    print("[HOST] Building buildvm.exe...")
    buildvm_srcs = ["host\\buildvm.c", "host\\buildvm_asm.c", "host\\buildvm_peobj.c", "host\\buildvm_lib.c", "host\\buildvm_fold.c"]
    buildvm_defs = [
        "/DLUAJIT_TARGET=LUAJIT_ARCH_arm64",
        "/DLUAJIT_OS=LUAJIT_OS_LINUX",
        "/DLUAJIT_ENABLE_GC64=1",
        "/DLJ_ARCH_HASFPU=1",
        "/DLJ_ABI_SOFTFP=0",
        "/D_CRT_SECURE_NO_DEPRECATE",
    ]
    run([cl_exe, "/nologo", "/O2", "/I.", "/I..\\dynasm", *buildvm_defs, *buildvm_srcs, "/Fe:host\\buildvm.exe"], cwd=lj_src, env=msvc_env)

    buildvm = str(lj_src / "host" / "buildvm.exe")
    print("[HOST] Running buildvm codegen...")
    run([buildvm, "-m", "elfasm", "-o", "lj_vm.S"], cwd=lj_src)
    run([buildvm, "-m", "bcdef", "-o", "lj_bcdef.h", *LJLIB_C], cwd=lj_src)
    run([buildvm, "-m", "ffdef", "-o", "lj_ffdef.h", *LJLIB_C], cwd=lj_src)
    run([buildvm, "-m", "libdef", "-o", "lj_libdef.h", *LJLIB_C], cwd=lj_src)
    run([buildvm, "-m", "recdef", "-o", "lj_recdef.h", *LJLIB_C], cwd=lj_src)
    (lj_src / "jit").mkdir(exist_ok=True)
    run([buildvm, "-m", "vmdef", "-o", "jit/vmdef.lua", *LJLIB_C], cwd=lj_src)
    run([buildvm, "-m", "folddef", "-o", "lj_folddef.h", "lj_opt_fold.c"], cwd=lj_src)

    # 3. Cross-compile LuaJIT + tolua C files with NDK 27.3 arm64 clang
    obj_dir = WORK_DIR / "obj_arm64"
    obj_dir.mkdir(parents=True, exist_ok=True)

    lj_cflags = [
        "-O2", "-fPIC", "-fno-stack-protector", "-fomit-frame-pointer",
        "-D_FILE_OFFSET_BITS=64", "-D_LARGEFILE_SOURCE", "-U_FORTIFY_SOURCE",
        "-DLUAJIT_ENABLE_GC64=1", "-DLJ_ARCH_HASFPU=1", "-DLJ_ABI_SOFTFP=0",
        f"-I{lj_src}",
    ]
    tolua_cflags = [
        "-O2", "-fPIC", "-std=gnu99",
        "-DLUAJIT_ENABLE_GC64=1",
        f"-I{lj_src}", f"-I{WORK_DIR}",
    ]

    jobs = []
    # lj_vm.S
    jobs.append((lj_src / "lj_vm.S", obj_dir / "lj_vm.o", lj_cflags))
    for c in LJCORE_C:
        jobs.append((lj_src / c, obj_dir / (Path(c).stem + ".o"), lj_cflags))
    for c in TOLUA_C_FILES:
        safe = c.replace("/", "_").replace(".c", ".o")
        jobs.append((WORK_DIR / c, obj_dir / f"tolua_{safe}", tolua_cflags))

    print(f"[TARGET] Cross-compiling {len(jobs)} units for aarch64-linux-android21...")
    def compile_one(job):
        src, obj, flags = job
        run([str(CLANG), *flags, "-c", str(src), "-o", str(obj)])
        return obj

    objs = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        for obj in ex.map(compile_one, jobs):
            objs.append(obj)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    unstripped = WORK_DIR / "libtolua_unstripped.so"
    print("[LINK] Linking libtolua.so with -Wl,-z,max-page-size=16384...")
    run([
        str(CLANG), "-shared",
        "-Wl,-soname,libtolua.so",
        "-Wl,-z,max-page-size=16384",
        "-Wl,-z,common-page-size=16384",
        *(str(o) for o in objs),
        "-lm", "-ldl",
        "-o", str(unstripped),
    ])
    run([str(LLVM_STRIP), "--strip-unneeded", str(unstripped), "-o", str(OUT_SO)])
    print(f"[OK] Built {OUT_SO} ({OUT_SO.stat().st_size:,} bytes)")

    # 4. Automated verification: ELF64 AArch64, 16KB PT_LOAD alignment, symbol coverage
    print("\n=== Automated Verification ===")
    hdr = run([str(LLVM_READELF), "-h", "-l", str(OUT_SO)])
    assert "AArch64" in hdr, "Not an AArch64 ELF!"
    loads = [l for l in hdr.splitlines() if l.strip().startswith("LOAD")]
    print("PT_LOAD segments:")
    for l in loads:
        print(" ", l)
        assert "0x4000" in l, f"PT_LOAD not 16KB aligned: {l}"

    nm_out = run([str(LLVM_NM), "-D", "--defined-only", str(OUT_SO)])
    exports = set()
    for line in nm_out.splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[1] in ("T", "D", "R", "B", "W", "V"):
            exports.add(parts[2])

    baseline = json.loads(SYMBOLS_JSON.read_text(encoding="utf-8"))
    req_dll = set(baseline["tolua"]["dll_imports"])
    req_luaopen = set(baseline["tolua"]["ref_luaopen"])

    miss_dll = sorted(req_dll - exports)
    miss_open = sorted(req_luaopen - exports)
    print(f"Total dynamic exports: {len(exports)}")
    print(f"ToLuaLib.dll DllImport coverage: {len(req_dll) - len(miss_dll)}/{len(req_dll)} (missing: {miss_dll})")
    print(f"luaopen_* extension coverage: {len(req_luaopen) - len(miss_open)}/{len(req_luaopen)} (missing: {miss_open})")

    if miss_dll or miss_open:
        sys.exit(2)
    print("PASS: arm64 libtolua.so verified (AArch64, 16KB aligned, 100% symbols present)!")


if __name__ == "__main__":
    main()
