# -*- coding: utf-8 -*-
r"""
build_standalone_apk64.py -- Hot-track assembly and signing for pure arm64 standalone APK (Omega):
  Cold base build64/out64/fzzl_arm64_base.apk (Unity 2017.4.23f1 IL2CPP arm64 + Main.unity + pure-Node PsLocalServer)
  + Original tools/fzzl_lua_signed.apk game assets (skipping assets/bin/Data/**, 32-bit assets/luascript/**, gp_sdk_plugin.apk)
  + Loopback assets/syscfg.json (127.0.0.1:8081)
  + assets/bin/Data/boot.config (systemallocator=1)
  + Patched 16KB-aligned lib/arm64-v8a/libmain.so (Android 11-16 Scudo 16GB allocator fix)
  + assets/psbin/** (arm64 psnode/libnode.so/libc++_shared.so, ZIP_STORED)
  + assets/psnode/** (64-bit server tree + GC64 lua_remote_frame.bin + NODE_TREE.json, ZIP_STORED)
  + AndroidManifest.xml binary permission surgery (7-permission whitelist via build/patch_manifest_perms.py)
  -> zipalign -p 4 + apksigner (v1+v2+v3) -> build64/out64/fzzl_standalone_omega.apk
"""
import os
import subprocess
import sys
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BUILD32 = os.path.join(ROOT, 'build')
sys.path.insert(0, BUILD32)
import patch_manifest_perms as PMP  # noqa: E402
import audit_apk_permissions as PERM_GATE  # noqa: E402

BASE64_APK = os.path.join(HERE, 'out64', 'fzzl_arm64_base.apk')
ORIG_ASSETS_APK = os.environ.get('FZZL_ORIG_ASSETS_APK', os.path.join(ROOT, 'tools', 'fzzl_lua_signed.apk'))
PATCHED_LIBMAIN = os.path.join(HERE, 'native', 'unity_scudo_fix', 'libmain.so')
PSBIN_ARM64 = os.path.join(BUILD32, 'pslocal', 'psbin', 'arm64')
PSNODE64_DIR = os.path.join(HERE, 'staging', 'psnode64')
KEYSTORE = os.environ.get('FZZL_KEYSTORE', os.path.join(ROOT, 'tools', 'fzzl.keystore'))

OUT_DIR = os.path.join(HERE, 'out64')
APK_UNSIGNED = os.path.join(OUT_DIR, 'fzzl_standalone_omega.unsigned.apk')
APK_ALIGNED = os.path.join(OUT_DIR, 'fzzl_standalone_omega.aligned.apk')
APK_SIGNED = os.path.join(OUT_DIR, 'fzzl_standalone_omega.apk')

ANDROID_SDK = os.environ.get(
    'FZZL_ANDROID_SDK',
    os.environ.get('ANDROID_SDK_ROOT', os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Android', 'Sdk')),
)
BT = os.environ.get('FZZL_BUILD_TOOLS', os.path.join(ANDROID_SDK, 'build-tools', '36.1.0'))
JAVA_BIN = os.environ.get('FZZL_JAVA_BIN', '')

SYSCFG_REPLACES = [
    ('"Router": "http://web-fzzly.mingchaoyouxi.com/"', '"Router": "http://127.0.0.1:8081/"'),
    ('"NLog": "http://cdh-log.mingchao.com/metl/v1"', '"NLog": "http://127.0.0.1:8081/metl/v1"'),
    ('"Log": "http://cdh-log.mingchaoyouxi.com/metl/v1"', '"Log": "http://127.0.0.1:8081/metl/v1"'),
]


def ks_pass():
    v = os.environ.get('FZZL_KS_PASS')
    if not v:
        sys.exit('Missing env FZZL_KS_PASS (APK signing password).\n'
                 '  PowerShell: $env:FZZL_KS_PASS = "..."\n'
                 '  cmd:        set FZZL_KS_PASS=...')
    return v


def run_tool(cmd, desc):
    print('== ' + desc, flush=True)
    env = dict(os.environ)
    if JAVA_BIN and os.path.isdir(JAVA_BIN):
        env['PATH'] = JAVA_BIN + os.pathsep + env.get('PATH', '')
        env['JAVA_HOME'] = os.path.dirname(JAVA_BIN)
    r = subprocess.run(cmd, env=env)
    if r.returncode != 0:
        sys.exit('FAILED: ' + desc)


def ensure_systemallocator(raw_bytes):
    text = raw_bytes.decode('utf-8', errors='replace') if raw_bytes else ''
    lines = [l for l in text.splitlines() if l.strip()]
    if not any(l.strip().startswith('systemallocator=') for l in lines):
        lines.append('systemallocator=1')
    return ('\n'.join(lines) + '\n').encode('utf-8')


def main():
    t0 = time.time()
    pw = ks_pass()
    for path, label in (
        (BASE64_APK, '64-bit cold base APK'),
        (ORIG_ASSETS_APK, 'Base game assets APK'),
        (PSBIN_ARM64, 'arm64 psbin directory'),
        (os.path.join(PSNODE64_DIR, 'NODE_TREE.json'), '64-bit psnode asset tree'),
        (KEYSTORE, 'Signing keystore'),
    ):
        if not os.path.exists(path):
            sys.exit(f'Missing prerequisite ({label}): {path}')

    os.makedirs(OUT_DIR, exist_ok=True)

    with zipfile.ZipFile(ORIG_ASSETS_APK, 'r') as z_orig:
        syscfg = z_orig.read('assets/syscfg.json').decode('utf-8')
        for old, new in SYSCFG_REPLACES:
            assert old in syscfg, f'syscfg anchor missing: {old}'
            syscfg = syscfg.replace(old, new)
        assert '"DebugMode": "true"' in syscfg

    print(f'== Assembling unsigned 64-bit standalone APK -> {APK_UNSIGNED}', flush=True)
    written_names = set()
    has_boot_cfg = False
    n_base = 0
    n_orig = 0
    n_skip_orig = 0

    with zipfile.ZipFile(BASE64_APK, 'r') as z_base, \
         zipfile.ZipFile(ORIG_ASSETS_APK, 'r') as z_orig, \
         zipfile.ZipFile(APK_UNSIGNED, 'w', zipfile.ZIP_DEFLATED) as zout:

        # 1) Copy core entries from the 64-bit cold base
        for item in z_base.infolist():
            fn = item.filename
            if fn.endswith('/') or fn.startswith('META-INF/'):
                continue
            if fn == 'AndroidManifest.xml':
                mdata, removed = PMP.patch_manifest(z_base.read(fn))
                print(f'   AndroidManifest permission surgery: removed {len(removed)} ({removed}) -> kept {len(PMP.KEEP_PERMISSIONS)}')
                zi = zipfile.ZipInfo(fn, date_time=item.date_time)
                zi.compress_type = zipfile.ZIP_DEFLATED
                zout.writestr(zi, mdata)
            elif fn == 'classes.dex':
                dex_raw = z_base.read(fn)
                assert b'onServiceConnected' in dex_raw, 'classes.dex missing Android 16 JNIBridge fix!'
                assert b'UniWebViewInterface' in dex_raw, 'classes.dex missing UniWebViewInterface!'
                zi = zipfile.ZipInfo(fn, date_time=item.date_time)
                zi.compress_type = zipfile.ZIP_DEFLATED
                zout.writestr(zi, dex_raw)
                print(f'   classes.dex: verified Android 16 JNIBridge + UniWebView ({len(dex_raw):,} B)')
            elif fn == 'lib/arm64-v8a/libmain.so' and os.path.isfile(PATCHED_LIBMAIN):
                zi = zipfile.ZipInfo(fn, date_time=item.date_time)
                zi.compress_type = zipfile.ZIP_STORED
                zout.writestr(zi, open(PATCHED_LIBMAIN, 'rb').read())
                print(f'   libmain.so: injected Android 11-16 Scudo 16GB fix ({os.path.getsize(PATCHED_LIBMAIN):,} B, 16KB aligned)')
            elif fn == 'assets/bin/Data/boot.config':
                has_boot_cfg = True
                bc = ensure_systemallocator(z_base.read(fn))
                zi = zipfile.ZipInfo(fn, date_time=item.date_time)
                zi.compress_type = zipfile.ZIP_DEFLATED
                zout.writestr(zi, bc)
                print('   boot.config: injected systemallocator=1')
            elif fn.startswith('lib/') and fn.endswith('.so'):
                # Store uncompressed for page alignment & extractNativeLibs=false compatibility
                zi = zipfile.ZipInfo(fn, date_time=item.date_time)
                zi.compress_type = zipfile.ZIP_STORED
                zout.writestr(zi, z_base.read(fn))
            else:
                zi = zipfile.ZipInfo(fn, date_time=item.date_time)
                zi.compress_type = item.compress_type
                zout.writestr(zi, z_base.read(fn))
            written_names.add(fn)
            n_base += 1

        if not has_boot_cfg:
            zout.writestr('assets/bin/Data/boot.config', ensure_systemallocator(b'wait-for-native-debugger=0\n'))
            written_names.add('assets/bin/Data/boot.config')
            print('   boot.config: created with systemallocator=1')

        # 2) Copy built-in game assets from original APK (skip 32-bit luascript & old SDK plugins)
        for item in z_orig.infolist():
            fn = item.filename
            if fn.endswith('/') or not fn.startswith('assets/'):
                continue
            if (fn.startswith('assets/bin/Data/')
                    or fn.startswith('assets/luascript/')
                    or fn == 'assets/gp_sdk_plugin.apk'
                    or fn == 'assets/syscfg.json'
                    or fn in written_names):
                n_skip_orig += 1
                continue
            zi = zipfile.ZipInfo(fn, date_time=item.date_time)
            zi.compress_type = item.compress_type
            zout.writestr(zi, z_orig.read(fn))
            written_names.add(fn)
            n_orig += 1

        # 3) Write loopback assets/syscfg.json
        zout.writestr('assets/syscfg.json', syscfg.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)
        written_names.add('assets/syscfg.json')
        print(f'   base entries: {n_base}, orig assets: {n_orig} (skipped {n_skip_orig})')

        # 4) Write assets/psbin/** and assets/psnode/** as ZIP_STORED for PsZipReader
        for sub, root_dir in (('psbin', PSBIN_ARM64), ('psnode', PSNODE64_DIR)):
            cnt = 0
            tot = 0
            for dp, _, fns in os.walk(root_dir):
                for f in sorted(fns):
                    fp = os.path.join(dp, f)
                    arc = f'assets/{sub}/' + os.path.relpath(fp, root_dir).replace('\\', '/')
                    zout.write(fp, arc, compress_type=zipfile.ZIP_STORED)
                    cnt += 1
                    tot += os.path.getsize(fp)
            print(f'   assets/{sub}/: {cnt} files / {tot / 1048576.0:.2f} MB (STORE)')

    # Pre-sign fail-fast permission audit
    try:
        perms = PERM_GATE.audit_apk(APK_UNSIGNED)
        print(f'== Permission gate (pre-sign fail-fast): {len(perms)} == whitelist')
    except AssertionError as e:
        sys.exit(f'Permission gate failed: {e}')

    # zipalign -p 4 + apksigner v1+v2+v3
    zipalign = os.path.join(BT, 'zipalign.exe' if os.name == 'nt' else 'zipalign')
    apksigner = os.path.join(BT, 'apksigner.bat' if os.name == 'nt' else 'apksigner')
    run_tool([zipalign, '-f', '-p', '4', APK_UNSIGNED, APK_ALIGNED], 'zipalign -p 4')
    run_tool([
        apksigner, 'sign',
        '--ks', KEYSTORE, '--ks-pass', 'pass:' + pw, '--ks-key-alias', 'fzzl',
        '--v1-signing-enabled', 'true', '--v2-signing-enabled', 'true', '--v3-signing-enabled', 'true',
        '--out', APK_SIGNED, APK_ALIGNED,
    ], 'apksigner sign (v1+v2+v3)')
    run_tool([apksigner, 'verify', '--print-certs', APK_SIGNED], 'apksigner verify')

    for tmp in (APK_UNSIGNED, APK_ALIGNED):
        if os.path.isfile(tmp):
            os.remove(tmp)

    sz = os.path.getsize(APK_SIGNED)
    print(f'\n== Package complete ({time.time() - t0:.1f}s): {APK_SIGNED}')
    print(f'   Size: {sz:,} bytes ({sz / 1048576.0:.1f} MB / {sz / 1e9:.2f} GB)')


if __name__ == '__main__':
    main()
