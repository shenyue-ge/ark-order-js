<p align="center">
  <img src=".github/assets/logo.png" alt="Ark Order JS" width="480">
</p>

<p align="center">
  <a href="https://github.com/shenyue-ge/ark-order-js/releases"><img src="https://img.shields.io/github/v/tag/shenyue-ge/ark-order-js?sort=semver&label=version" alt="version"></a>
  <img src="https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-lightgrey" alt="license">
  <img src="https://img.shields.io/badge/status-maintained-brightgreen" alt="status">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D16-brightgreen" alt="node">
  <img src="https://img.shields.io/badge/.NET%20SDK-8.0-blue" alt="dotnet">
  <img src="https://img.shields.io/badge/android%20build--tools-36.1.0-green" alt="android">
  <img src="https://img.shields.io/badge/engine-LuaJIT%20%2B%20Node.js-orange" alt="engine">
</p>

<p align="center">
  <img src="https://img.shields.io/github/stars/shenyue-ge/ark-order-js?style=flat" alt="stars">
  <img src="https://img.shields.io/github/issues/shenyue-ge/ark-order-js" alt="issues">
</p>

<p align="center">
  <i>An unofficial offline server, client patch layer, and Android repack pipeline<br>
  for the mobile game <b>Ark Order</b>. Fan project — not affiliated with the original developers or publishers.</i>
</p>

---

## About

This repository merges the two halves of a personal server-repack project into one place:

- **`server/`** — a from-scratch game server for Ark Order, written in plain Node.js
  (standard library only, no npm dependencies). It implements the game protocol end to
  end: accounts and per-account saves, battle, gacha, guild, dorm, activities, shop,
  tower, dream realm, achievements, and dozens of other systems.
- **`client/`** — the client patch layer. The game client runs Lua locally, so the
  patches are shipped as plaintext Lua files (network core with runtime hooks, patched
  config tables, a handful of module fixes). At build time they are overlaid onto the
  original game bytecode; at runtime the patched tree is served to the client by the
  server itself.
- **`build/`** — the 32-bit Android repack pipeline: asset preparation, standalone-server APK
  packaging and signing, data APK packaging, manifest permission surgery, icon/logo
  pipeline, and the C# boot host that runs the server on-device.
- **`build64/`** — the pure 64-bit (`arm64-v8a`) standalone Android pipeline (Omega) for
  modern Android 11–16 devices: Unity 2017.4 IL2CPP arm64 cold base, pure-Node C# boot
  host (zero Jint/Babel), LuaJIT 2.1 GC64 + 16 KB page-aligned native builds, Android 16
  `JNIBridge` & `UniWebView` Java shims, and the Android 11–16 Scudo 16 GB allocator fix.
- **`gates/`** — the factory quality gates that run inside the build before a package
  ships (frame size audit, Lua export-surface diff, asset reference audits, public-IP
  scan, post-package permission/verification suite).

## Repository layout

| Path | Contents |
|---|---|
| `server/` | Game server: entry points (`start.js`, `game_server.js`), protocol layer (`proto.js`, `etf.js`, `lib.js`), 39 protocol handlers (`handlers/`), 72 runtime data tables (`data/`), per-account saves (`accounts.js`, `save_admin.js`), HTTP router and admin endpoints |
| `client/` | 29 plaintext Lua patch files, stored with the same relative paths as the generated remote tree they are overlaid onto |
| `build/` | 32-bit `make.py` (single build entry), APK packaging/signing scripts, `pslocal/` (C# boot host, asset preparation, babel ES5 transpile, node binary rebuild), `data_apk/` (data pack tool), `save_manager/` and `gateprobe/` (companion APK sources) |
| `build64/` | Pure 64-bit (`arm64-v8a`) pipeline: `make64.py` (cold+hot entry), `build_standalone_apk64.py`, `audit_arm64_apk.py`, `scripts/` (GC64 extraction, pure-Node asset prep, C#4 decompile/patch), `native/` (tolua GC64, Cubism Core check, Android 16 `JNIBridge`, Scudo `libmain.c`, `UniWebView`), and `unity_src/` (Editor builder & pure-Node `PsLocalServer`) |
| `gates/` | Factory quality gates wired into `make.py` and `make64.py` |
| `tools/` | Small runtime-required reference data: protocol key tables (`key_lua/`), CfgItems/CfgSkillDetail/CfgMain extracts, vendored LuaJIT decompiler (`ljd/`, GPL-3.0) |
| `client/` + `tools/lua_remote/` | The remote Lua tree (`tools/lua_remote/{bc,src}`) is **generated at build time** by `build/client_assembly.py` from your local game asset bundles; only the patch overlay (`client/`) is tracked |

## Requirements

**Running the server** (PC or packaged on-device):

- Node.js ≥ 16 — no npm install required, everything is standard library.

**Building the APK** additionally needs machine-local inputs that are **not** part of
this repository (see `.gitignore` — none of them are distributable):

- The base game APK and unpacked game tree (`tools/fzzl_lua_signed.apk`, `fzzl/`)
- The game's `res/luascript/*.ab` asset bundles (for `client_assembly.py`)
- A signing keystore (`tools/fzzl.keystore`) and the `FZZL_KS_PASS` environment variable
- .NET SDK (local copy expected at `tools/dotnetsdk/`), Android build-tools 36.1.0 +
  platform android-35
- Pillow (Python) for the icon pipeline; the icon source image is configured via
  `FZZL_ICON_SRC`
- Paths default to historical machine-local conventions and can be overridden via
  `FZZL_LUA_AB_DIR` / `FZZL_BASE_APK` environment variables.

## Quick start (server)

```
node server/start.js
```

- HTTP endpoints on `:8081`, game protocol on `:9021`, Lua remote frame on `:44587`.
- Accounts live in `server/accounts.json`, per-account saves in `server/saves/`
  (runtime files, never committed). A fresh start bootstraps a default account.
- Point the game client at this host to log in.

## Building the APK

```
# 32-bit pipeline (Alpha)
python build/make.py            # full pipeline: client assembly + gates + package + sign
python build/make.py --dry-run  # preflight only

# Pure 64-bit arm64-v8a pipeline (Omega, Android 11-16)
python build64/make64.py                # hot track: pure-Node + GC64 frame + gates + package + sign
python build64/make64.py --rebuild-base # cold + hot: rebuild Unity IL2CPP arm64 base first
python build64/make64.py --dry-run      # preflight only
```

See [build64/README.md](build64/README.md) for 64-bit toolchain requirements and architecture details.

`make.py` runs, in order: client Lua tree assembly (⓪), asset preparation + seeding
fingerprint (①), the factory gates (①b–①i: frame size, Lua export surface, feature ids,
desc-AOE, shop type ids, grantGoods conn, public-IP scan, tower enemy types), the boot
host compile (②), icon generation (②c), packaging + signing (③), and the post-package
permission audit (④). Every gate is fail-fast: the build refuses to produce a package
that would break at runtime.

## Legal notice

This is an unofficial fan project, for personal and educational use only. It is not
affiliated with, endorsed by, or sponsored by the original developers, publishers, or
licensors of Ark Order. All trademarks, copyrights, and game assets belong to their
respective owners.

Original source code in this repository is licensed under
[CC BY-NC-SA 4.0](LICENSE). Game-derived data files (`server/data/`, `tools/` reference
tables) are **excluded** from that license, remain the property of their respective
owners, and are included solely for interoperability with this project's own server
implementation. The vendored `tools/ljd/` decompiler keeps its own GPL-3.0 license.
See [NOTICE](NOTICE) for details.

## Development conventions

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org),
  in English: `type(scope): summary` with `scope` ∈ `server` / `client` / `build` / `gates`.
- All text files are LF (enforced by `.gitattributes`); batch files stay CRLF.
- Non-code files (README, LICENSE, NOTICE, config) are English-only. Code comments may
  be bilingual.
- Never commit: runtime saves/accounts/logs, keystores or any secrets, generated
  build trees, or game asset bundles.
