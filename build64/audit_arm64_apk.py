#!/usr/bin/env python3
"""
Finished ARM64 APK Gate Auditor:
1. ABI purity: lib/ contains ONLY arm64-v8a/ (0 armeabi-v7a / x86 / x86_64)
2. Required native libraries present: libunity.so, libil2cpp.so, libmain.so, libtolua.so, libLive2DCubismCore.so
3. ELF64 AArch64 & PT_LOAD alignment inspection for every bundled .so
4. classes.dex Android 16 JNIBridge + UniWebView check, libmain.so Ark64ScudoFix check
5. Manifest 7-permission whitelist audit via aapt (matching build/patch_manifest_perms.py)
6. Signature verification via build-tools apksigner
7. (--standalone) Boot config systemallocator=1, loopback syscfg.json, STORE psbin/psnode,
   GC64 lua_remote_frame.bin purity (0 32-bit bytecodes), no psroot/, no 32-bit luascript/,
   luascript64/ & shaderinit.ab present.
"""
import json
import os
import struct
import subprocess
import sys
import tempfile
import zipfile
import zlib
from pathlib import Path

SDK = Path(os.environ.get(
    "FZZL_ANDROID_SDK",
    os.environ.get("ANDROID_SDK_ROOT", str(Path(os.environ.get("LOCALAPPDATA", "")) / "Android" / "Sdk")),
))
BT = Path(os.environ.get("FZZL_BUILD_TOOLS", str(SDK / "build-tools" / "36.1.0")))
AAPT = BT / ("aapt.exe" if os.name == "nt" else "aapt")
APKSIGNER = BT / ("apksigner.bat" if os.name == "nt" else "apksigner")
NDK27 = Path(os.environ.get("FZZL_NDK_27", str(SDK / "ndk" / "27.3.13750724")))
READELF = NDK27 / "toolchains" / "llvm" / "prebuilt" / ("windows-x86_64" if os.name == "nt" else "linux-x86_64") / "bin" / ("llvm-readelf.exe" if os.name == "nt" else "llvm-readelf")
JAVA_BIN = Path(os.environ["FZZL_JAVA_BIN"]) if os.environ.get("FZZL_JAVA_BIN") else None

REQUIRED_LIBS = {
    "libunity.so",
    "libil2cpp.so",
    "libmain.so",
    "libtolua.so",
    "libLive2DCubismCore.so",
}

KEEP_PERMISSIONS = {
    "android.permission.INTERNET",
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.ACCESS_WIFI_STATE",
    "android.permission.VIBRATE",
    "android.permission.WAKE_LOCK",
    "android.permission.READ_EXTERNAL_STORAGE",
    "android.permission.WRITE_EXTERNAL_STORAGE",
}

GC64_HDR = b"\x1bLJ\x02\x0a"


def audit_frame64_bytes(raw: bytes):
    outer = struct.unpack_from("<i", raw, 0)[0]
    if outer != len(raw):
        return False, f"outer header {outer} != len {len(raw)}"
    data = zlib.decompress(raw[4:])
    total = struct.unpack_from("<i", data, 0)[0]
    pos = 4
    n_gc64 = 0
    n_plain = 0
    bad = []
    while pos < total:
        nlen = data[pos]
        pos += 1
        clen = int.from_bytes(data[pos:pos + 3], "little")
        pos += 3
        name = data[pos:pos + nlen].decode("ascii", "replace")
        pos += nlen
        content = data[pos:pos + clen]
        pos += clen
        if content.startswith(b"\x1bLJ"):
            if content.startswith(GC64_HDR):
                n_gc64 += 1
            else:
                bad.append((name, content[:6].hex()))
        else:
            n_plain += 1
    if pos != total:
        return False, f"parse end {pos} != total {total}"
    if bad:
        return False, f"found {len(bad)} non-GC64 bytecodes: {bad[:5]}"
    return True, f"GC64={n_gc64}, plain={n_plain}, data={total:,}B"


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    standalone = "--standalone" in sys.argv[1:]
    if not args:
        print("Usage: python audit_arm64_apk.py [--standalone] <apk_path>")
        sys.exit(1)
    apk = Path(args[0])
    if not apk.exists():
        print(f"[FAIL] APK not found: {apk}")
        sys.exit(1)

    print(f"=== Auditing ARM64 APK: {apk} ({apk.stat().st_size:,} bytes) ===")
    failed = False

    with zipfile.ZipFile(apk, "r") as zf:
        infos = {i.filename: i for i in zf.infolist()}
        names = list(infos.keys())

        lib_entries = [n for n in names if n.startswith("lib/") and n.endswith(".so")]
        abis = sorted({n.split("/")[1] for n in lib_entries})
        arm64_libs = sorted(Path(n).name for n in lib_entries if n.startswith("lib/arm64-v8a/"))
        print(f"ABIs found: {abis}")
        if abis != ["arm64-v8a"]:
            print(f"[FAIL] ABI purity violation! Expected ['arm64-v8a'], got {abis}")
            failed = True
        else:
            print("[PASS] ABI purity: pure arm64-v8a")

        miss_libs = sorted(REQUIRED_LIBS - set(arm64_libs))
        print(f"arm64-v8a libs ({len(arm64_libs)}): {arm64_libs}")
        if miss_libs:
            print(f"[FAIL] Missing required native libs: {miss_libs}")
            failed = True
        else:
            print("[PASS] All 5 required native libs present")

        # ELF check
        with tempfile.TemporaryDirectory(prefix="ark64_elf_") as td:
            for entry in sorted(lib_entries):
                p = Path(td) / Path(entry).name
                p.write_bytes(zf.read(entry))
                out = subprocess.check_output([str(READELF), "-h", "-l", str(p)], text=True)
                is_a64 = "AArch64" in out
                aligns = sorted({
                    l.split()[-1]
                    for l in out.splitlines()
                    if l.strip().startswith("LOAD")
                })
                print(f"  ELF {p.name:28s} AArch64={is_a64} PT_LOAD_align={aligns} size={p.stat().st_size:,}")
                if not is_a64:
                    print(f"[FAIL] {p.name} is not AArch64!")
                    failed = True

        psroot_entries = [n for n in names if n.startswith("assets/psroot/")]
        if psroot_entries:
            print(f"[FAIL] Found legacy Jint psroot entries ({len(psroot_entries)})!")
            failed = True
        else:
            print("[PASS] 0 legacy Jint psroot/ entries")

        # classes.dex Android 16 JNIBridge + UniWebView fix gate
        if "classes.dex" in infos:
            dex_raw = zf.read("classes.dex")
            if b"onServiceConnected" in dex_raw and b"UniWebViewInterface" in dex_raw:
                print(f"[PASS] classes.dex has Android 16 JNIBridge + UniWebView ({len(dex_raw):,} B)")
            else:
                print(f"[FAIL] classes.dex missing fix! onServiceConnected={b'onServiceConnected' in dex_raw} UniWebView={b'UniWebViewInterface' in dex_raw}")
                failed = True
        else:
            print("[FAIL] Missing classes.dex")
            failed = True

        # libmain.so Scudo 16GB fix gate
        if "lib/arm64-v8a/libmain.so" in infos:
            if b"Ark64ScudoFix" in zf.read("lib/arm64-v8a/libmain.so"):
                print("[PASS] libmain.so has Android 11-16 Scudo 16GB allocator fix")
            else:
                print("[FAIL] libmain.so missing Ark64ScudoFix!")
                failed = True

        # boot.config systemallocator=1
        if "assets/bin/Data/boot.config" in infos:
            bc = zf.read("assets/bin/Data/boot.config").decode("utf-8", errors="replace")
            if "systemallocator=1" in bc:
                print("[PASS] boot.config has systemallocator=1")
            else:
                print(f"[FAIL] boot.config missing systemallocator=1: {bc!r}")
                failed = True
        else:
            print("[FAIL] Missing assets/bin/Data/boot.config")
            failed = True

        if standalone:
            lua32 = [n for n in names if n.startswith("assets/luascript/")]
            lua64 = [n for n in names if n.startswith("assets/luascript64/")]
            if lua32:
                print(f"[FAIL] Found 32-bit assets/luascript/ entries ({len(lua32)})")
                failed = True
            else:
                print("[PASS] 0 32-bit assets/luascript/ entries")
            if len(lua64) == 0:
                print("[FAIL] Missing assets/luascript64/ entries")
                failed = True
            else:
                print(f"[PASS] assets/luascript64/: {len(lua64)} entries")
            if "assets/shaders/shaderinit.ab" not in infos:
                print("[FAIL] Missing assets/shaders/shaderinit.ab")
                failed = True
            else:
                print("[PASS] assets/shaders/shaderinit.ab present")

            if "assets/syscfg.json" in infos:
                sc = json.loads(zf.read("assets/syscfg.json").decode("utf-8"))
                if "127.0.0.1:8081" in sc.get("Router", ""):
                    print(f"[PASS] syscfg.json loopback Router={sc.get('Router')}")
                else:
                    print(f"[FAIL] syscfg.json Router not loopback: {sc.get('Router')}")
                    failed = True
            else:
                print("[FAIL] Missing assets/syscfg.json")
                failed = True

            for req in (
                "assets/psbin/psnode",
                "assets/psbin/libnode.so",
                "assets/psbin/libc++_shared.so",
                "assets/psnode/NODE_TREE.json",
                "assets/psnode/ps_server/start.js",
                "assets/psnode/tools/lua_remote_frame.bin",
            ):
                if req not in infos:
                    print(f"[FAIL] Missing required standalone entry: {req}")
                    failed = True
                elif infos[req].compress_type != zipfile.ZIP_STORED:
                    print(f"[FAIL] {req} is not ZIP_STORED (compress_type={infos[req].compress_type})")
                    failed = True
            non_stored = [
                n for n in names
                if (n.startswith("assets/psbin/") or n.startswith("assets/psnode/"))
                and infos[n].compress_type != zipfile.ZIP_STORED
            ]
            if non_stored:
                print(f"[FAIL] Non-STORE psbin/psnode entries: {non_stored[:5]}")
                failed = True
            else:
                print("[PASS] All assets/psbin/ and assets/psnode/ entries are ZIP_STORED")

            if "assets/psnode/tools/lua_remote_frame.bin" in infos:
                ok_f, msg_f = audit_frame64_bytes(zf.read("assets/psnode/tools/lua_remote_frame.bin"))
                if ok_f:
                    print(f"[PASS] APK lua_remote_frame.bin GC64 purity: {msg_f}")
                else:
                    print(f"[FAIL] APK lua_remote_frame.bin invalid: {msg_f}")
                    failed = True

    perm_out = subprocess.check_output([str(AAPT), "dump", "permissions", str(apk)], text=True)
    perms = set()
    for line in perm_out.splitlines():
        line = line.strip()
        if line.startswith("uses-permission:") and "name='" in line:
            perms.add(line.split("name='", 1)[1].split("'", 1)[0])
    extra_p = sorted(perms - KEEP_PERMISSIONS)
    miss_p = sorted(KEEP_PERMISSIONS - perms)
    print(f"Manifest permissions ({len(perms)}): {sorted(perms)}")
    if extra_p or miss_p:
        print(f"[FAIL] Permission mismatch! extra={extra_p} missing={miss_p}")
        failed = True
    else:
        print("[PASS] Manifest permissions == exact 7-permission whitelist")

    env = dict(os.environ)
    if JAVA_BIN and JAVA_BIN.is_dir():
        env["PATH"] = str(JAVA_BIN) + os.pathsep + env.get("PATH", "")
        env["JAVA_HOME"] = str(JAVA_BIN.parent)
    sig = subprocess.run([str(APKSIGNER), "verify", "--print-certs", str(apk)], capture_output=True, text=True, env=env)
    if sig.returncode == 0:
        first_cert = [l.strip() for l in sig.stdout.splitlines() if "Signer #1 certificate DN" in l]
        print(f"[PASS] apksigner verify OK ({first_cert[0] if first_cert else ''})")
    else:
        print(f"[FAIL] apksigner verify failed:\n{sig.stderr}")
        failed = True

    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
