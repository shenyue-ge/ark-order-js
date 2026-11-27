#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
make64.py -- Single build entrypoint for the pure 64-bit (arm64-v8a) standalone APK (Omega).

Usage:
  python build64/make64.py                # Hot track (~2-3 min): pure-Node tree + 8 gates + package + sign
  python build64/make64.py --rebuild-base # Cold + hot: rebuild Unity IL2CPP arm64 base APK first
  python build64/make64.py --dry-run      # Preflight checks and planned commands only
  python build64/make64.py --no-package   # Prepare 64-bit asset tree and run static gates only
"""
import os
import subprocess
import sys

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(errors='replace')
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BUILD32 = os.path.join(ROOT, 'build')
GATES = os.path.join(ROOT, 'gates')
PY = sys.executable

BASE64_APK = os.path.join(HERE, 'out64', 'fzzl_arm64_base.apk')
FRAME64 = os.path.join(HERE, 'staging', 'psnode64', 'tools', 'lua_remote_frame.bin')
OUT_APK = os.path.join(HERE, 'out64', 'fzzl_standalone_omega.apk')

UNITY_DIR = os.environ.get('FZZL_UNITY_DIR', r'F:\ark64_tools\Unity2017.4.23f1')
UNITY_EXE = os.environ.get('FZZL_UNITY_EXE', os.path.join(UNITY_DIR, 'Editor', 'Unity.exe'))
NDK_R13B = os.environ.get('FZZL_NDK_R13B', r'F:\ark64_tools\android-ndk-r13b')
UNITY_PROJ = os.path.join(HERE, 'unity_project')
UNITY_LOG = os.path.join(HERE, 'reports', 'unity_build_base.log')


def preflight(do_package, rebuild_base):
    print('== Preflight check (pure arm64-v8a pipeline)')
    checks = [
        (os.path.join(ROOT, 'tools', 'fzzl_lua_signed.apk'), 'Base game assets APK'),
        (os.path.join(ROOT, 'tools', 'lua_remote', 'bc64'), '64-bit GC64 Lua bytecode tree (bc64/)'),
        (os.path.join(BUILD32, 'pslocal', 'psbin', 'arm64', 'psnode'), 'arm64 psnode executable'),
        (os.path.join(ROOT, 'tools', 'fzzl.keystore'), 'Signing keystore'),
    ]
    if not rebuild_base:
        checks.insert(0, (BASE64_APK, '64-bit cold base APK (pass --rebuild-base to build)'))
    else:
        checks.insert(0, (UNITY_EXE, 'Unity 2017.4.23f1 Editor (FZZL_UNITY_EXE)'))

    bad = []
    for path, what in checks:
        ok = os.path.exists(path)
        print('   %s %s  %s' % ('OK  ' if ok else 'MISS', what, path))
        if not ok:
            bad.append(what)
    if do_package and not os.environ.get('FZZL_KS_PASS'):
        print('   MISS env FZZL_KS_PASS (APK signing password)')
        bad.append('FZZL_KS_PASS')
    return bad


def main():
    args = sys.argv[1:]
    dry = '--dry-run' in args
    rebuild_base = '--rebuild-base' in args
    no_pkg = '--no-package' in args

    steps = []
    if rebuild_base:
        steps.append(('0a Setup builtin resources (Resources/ + Live2D 2.1 Shaders)',
                      os.path.join(HERE, 'scripts'),
                      [PY, '-u', 'setup_builtin_resources.py'], None))
        steps.append(('0b Build Android 16 compatible UniWebView JAR',
                      os.path.join(HERE, 'native', 'uniwebview_android'),
                      [PY, '-u', 'build_uniwebview_jar.py'], None))
        steps.append(('0c Build 16KB-aligned arm64 libmain.so (Scudo 16GB allocator fix)',
                      os.path.join(HERE, 'native', 'unity_scudo_fix'),
                      [PY, '-u', 'build_libmain_arm64.py'], None))
        steps.append(('0d Unity 2017.4.23f1 cold base build (IL2CPP arm64)',
                      HERE,
                      [UNITY_EXE, '-batchmode', '-quit',
                       '-projectPath', UNITY_PROJ,
                       '-executeMethod', 'BuildArm64.BuildBaseApk',
                       '-logFile', UNITY_LOG],
                      {'ANDROID_NDK_ROOT': NDK_R13B}))

    steps.extend([
        ('1a Pure-Node 64-bit asset tree + GC64 prebuilt Lua frame (prepare_node64.py)',
         os.path.join(HERE, 'scripts'),
         [PY, '-u', '-S', 'prepare_node64.py'], None),
        ('1b Lua frame size & structure gate (1e8 offset limit)',
         GATES,
         [PY, '-u', '-S', 'lua_frame_audit.py', '--frame', FRAME64], None),
        ('1c Export-surface gate (plaintext patches vs original bc)',
         GATES,
         [PY, '-u', '-S', 'lua_surface_diff.py', '--quiet'], None),
        ('1d Feature id gate (effect.src_id / effect.id)',
         GATES,
         ['node', 'audit_feature_src_ids.js', '--fail'], None),
        ('1e desc-AOE gate',
         GATES,
         ['node', 'audit_desc_aoe.js', '--fail'], None),
        ('1f Shop type_id gate',
         GATES,
         ['node', 'audit_shop_typeids.js'], None),
        ('1g grantGoods conn passthrough gate',
         GATES,
         ['node', 'audit_grant_goods_conn.js'], None),
        ('1h Public-IP scan gate',
         GATES,
         ['node', 'audit_no_hardcoded_addr.js'], None),
        ('1i Tower enemy type gate',
         GATES,
         ['node', 'audit_tower_enemy_types.js', '--fail'], None),
    ])

    if not no_pkg:
        steps.extend([
            ('2 Hot-track assembly + permission surgery + zipalign -p 4 + sign',
             HERE,
             [PY, '-u', '-S', 'build_standalone_apk64.py'], None),
            ('3 Finished arm64 APK gate audit (ABI / ELF / perms / sig / GC64 frame)',
             HERE,
             [PY, '-u', '-S', 'audit_arm64_apk.py', '--standalone', OUT_APK], None),
        ])

    bad = preflight(not no_pkg, rebuild_base)
    print()
    for title, cwd, argv, _ in steps:
        print('   %s' % title)
        print('     cd %s && %s' % (cwd, ' '.join(argv)))
    if bad:
        print('\n== Missing prerequisites: %s' % ', '.join(bad))
        return 2
    if dry:
        print('\n== --dry-run: not executed')
        return 0

    os.makedirs(os.path.join(HERE, 'reports'), exist_ok=True)
    for title, cwd, argv, extra_env in steps:
        print('\n== %s' % title, flush=True)
        env = dict(os.environ)
        if extra_env:
            env.update(extra_env)
        r = subprocess.call(argv, cwd=cwd, env=env)
        if r != 0:
            print('\n== FAILED (exit=%d): %s' % (r, title))
            return r

    print('\n== ALL DONE: %s' % OUT_APK)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
