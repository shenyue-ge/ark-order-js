# build64 — Pure 64-bit (`arm64-v8a`) Standalone Android Pipeline (Omega)

This directory contains the pure 64-bit (`arm64-v8a`) standalone repack pipeline for
Ark Order, targeting modern Android 11–16 arm64-only devices (verified on Samsung S24
Ultra / Android 16 API-36, Xiaomi Pad 7 / Android 15 API-35, and Redmi Note 9 5G /
Android 10 API-29).

It shares the same `server/`, `client/`, `gates/`, and `fzzl_data.apk` data package as
the 32-bit `build/` pipeline, with zero Jint / zero Babel ES5 transpilation.

## Cold + Hot Dual-Track Architecture

- **Cold base track** (`build64/out64/fzzl_arm64_base.apk`, rebuilt only when C#, native
  `.so`, Java shims, or `Main.unity` change):
  - Unity 2017.4.23f1 + IL2CPP `arm64-v8a` (NDK r13b, JDK 8, Android SDK platform 26)
  - Clean C#4 re-decompilation of local `Assembly-CSharp*.dll` with deterministic patcher
    (`scripts/patch_cs_clean.py`), 1:1 `Main.unity` reconstruction (`unity_src/Editor/BuildArm64.cs`),
    30+ `AlwaysIncludedShaders` (particles, UI, Live2D 2.1, video decode), and offline
    `SDKInterfaceAndroid.cs`
  - 16 KB `PT_LOAD`-aligned native arm64 libraries: `libtolua.so` (LuaJIT 2.1 GC64 +
    runtime `sysconf(_SC_PAGESIZE)`), `libLive2DCubismCore.so` (Cubism Core 5.3+/6.x),
    and patched `libmain.so`
  - Source-wired pure-Node `PsLocalServer` (`unity_src/PsLocalServer/`): LP64 `pread64`
    APK reader, `libc chmod`, Android `java.lang.ProcessBuilder` arm64 `psnode` host,
    upgrade save preservation (`saves/` + `accounts.json`), and `.data_imported` integrity gate
- **Hot asset track** (`python build64/make64.py`, ~2–3 min, no Unity required):
  - `scripts/prepare_node64.py` directly imports `build/pslocal/scripts/prepare_assets.py`
    transforms (single source of truth, no copy-paste drift), packs modern ES6+ `server/`
    unchanged for arm64 Node/V8, and builds a 100% GC64 `lua_remote_frame.bin` from
    `tools/lua_remote/bc64/` + plaintext patches in `tools/lua_remote/src/` (automatically
    skipping legacy 32-bit bytecode copies)
  - Runs all 8 factory gates in `gates/` (`①b`–`①i`)
  - `build_standalone_apk64.py` merges the cold base, original game assets (skipping
    32-bit `luascript/`), loopback `syscfg.json`, `boot.config`, `STORE`-compressed
    `assets/psbin/` & `assets/psnode/`, patched `libmain.so`, 7-permission manifest surgery,
    `zipalign -p 4`, and `apksigner` v1+v2+v3 signing -> `out64/fzzl_standalone_omega.apk`
  - `audit_arm64_apk.py --standalone` verifies ABI purity, ELF64 AArch64 + alignment,
    `classes.dex` patches, Scudo `libmain.so` fix, GC64 frame purity, 7-permission
    whitelist, and APK signature

## Android 11–16 Compatibility Fixes

1. **Android 11–16 Scudo 16 GB allocator fix** (`native/unity_scudo_fix/libmain.c`):
   Unity 2017.4.23f1 `libunity.so` hardcodes a 5-slot 4 GB high-word table in
   `UnityDefaultAllocator<LowLevelAllocator>::AllocationPage<0/1/2>` and ignores
   `systemallocator=1` in `boot.config`. Under Android 11–16 Scudo's randomized 64-bit
   virtual address space, the 6th distinct high-32 region triggers
   `Using memoryadresses from more that 16GB of memory` + `SIGSEGV`. Our 16 KB-aligned
   `libmain.so` hooks those 3 entry points right after `dlopen("libunity.so")` and before
   `JNI_OnLoad`, redirecting them to per-allocator `mmap`-backed 64-bit open-addressing
   hash sets with unlimited address range.
2. **Android 16 `JNIBridge` fix** (`native/android16_fix/`):
   Patches `bitter.jnibridge.JNIBridge` in Unity's Android `classes.jar` and pre-dexed
   `classes.dex` to handle Android 16's 3-argument default `ServiceConnection.onServiceConnected`.
3. **Android 16 compatible `UniWebView` shim** (`native/uniwebview_android/`):
   Zero-dependency native `android.webkit.WebView` overlay (`uniwebview_arm64.jar`)
   restoring the in-game announcement panel (`http://127.0.0.1:8081/notice`).
4. **Particle shaders & Live2D 2.1 IL2CPP fix**:
   Includes all 30+ built-in particle/UI/video shaders in `AlwaysIncludedShaders` and
   suppresses `Live2DUnity.dll`'s IL2CPP `StackTrace` false positive
   (`firstError_drawMeshNowInUpdate = false`).

## Usage

Set the signing password via environment variable (never hardcode it) and configure any
machine-local tool paths via environment variables if they differ from defaults:

```powershell
$env:FZZL_KS_PASS = "<keystore-password>"

# Optional machine-local path overrides:
# $env:FZZL_UNITY_EXE        = "path/to/Unity2017.4.23f1/Editor/Unity.exe"
# $env:FZZL_UNITY_DIR        = "path/to/Unity2017.4.23f1"
# $env:FZZL_NDK_R13B         = "path/to/android-ndk-r13b"
# $env:FZZL_ANDROID_SDK      = "path/to/Android/Sdk"
# $env:FZZL_UNITY_ANDROID_SDK = "path/to/android_sdk_u2017"
# $env:FZZL_NDK_27           = "path/to/Android/Sdk/ndk/27.3.13750724"
# $env:FZZL_JDK8             = "path/to/jdk8"
# $env:FZZL_LUA64_AB_DIR     = "path/to/res/luascript64"
# $env:FZZL_BASE_APK         = "path/to/fzzl.apk"
# $env:FZZL_ICON_SRC         = "path/to/icon.webp"

# One-time: extract 64-bit GC64 Lua bytecode tree from local luascript64/*.ab
python build64/scripts/extract_bc64.py

# Daily hot-track build (after editing server/ or client/ Lua patches)
python build64/make64.py

# Cold + hot build (after editing C#, native C/Java shims, or Unity scene)
python build64/make64.py --rebuild-base

# Preflight only
python build64/make64.py --dry-run
```

## Directory Layout

- `make64.py` — single entry point (`--rebuild-base`, `--dry-run`, `--no-package`)
- `build_standalone_apk64.py` — hot-track APK assembly, permission surgery, alignment & signing
- `audit_arm64_apk.py` — finished arm64 APK gate auditor
- `scripts/` — `extract_bc64.py`, `verify_bc64.py`, `prepare_node64.py`, `decompile_clean_cs.py`, `patch_cs_clean.py`, `setup_builtin_resources.py`
- `native/` — `unity_scudo_fix/`, `android16_fix/`, `uniwebview_android/`, `tolua_arm64/`, `live2d_arm64/`
- `unity_src/` — original Unity Editor builder (`Editor/BuildArm64.cs`), pure-Node `PsLocalServer/`, and offline `SDKInterfaceAndroid.cs`
