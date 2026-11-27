# -*- coding: utf-8 -*-
r"""
extract_bc64.py -- Extract 64-bit LuaJIT 2.1 GC64 bytecode from local luascript64/*.ab
bundles into tools/lua_remote/bc64/, maintaining 1-to-1 relative path parity with
tools/lua_remote/bc/ and 100% keymap.json target coverage.

Configure input directory via env FZZL_LUA64_AB_DIR.
"""
import glob
import json
import os
import sys
import UnityPy

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD64 = os.path.dirname(HERE)
ROOT = os.path.dirname(BUILD64)

AB64_DIR = os.environ.get('FZZL_LUA64_AB_DIR', r'H:\NEW FILES\files\res\luascript64')
BC32_DIR = os.path.join(ROOT, 'tools', 'lua_remote', 'bc')
BC64_DIR = os.path.join(ROOT, 'tools', 'lua_remote', 'bc64')
SRC_DIR = os.path.join(ROOT, 'tools', 'lua_remote', 'src')
KEYMAP_PATH = os.path.join(ROOT, 'tools', 'lua_remote', 'keymap.json')
GC64_HDR = b'\x1bLJ\x02\x0a'


def load_ab64_index():
    """Index all TextAssets across luascript64/*.ab for deterministic alignment with bc/."""
    by_rel_lower = {}
    by_ab_and_base = {}
    by_base_lower = {}
    total = 0
    for ab in sorted(glob.glob(os.path.join(AB64_DIR, '*.ab'))):
        ab_name = os.path.basename(ab)
        ab_stem = os.path.splitext(ab_name)[0].lower()
        env = UnityPy.load(ab)
        for key, obj in env.container.items():
            if obj.type.name != 'TextAsset':
                continue
            data = obj.read().m_Script.encode('utf-8', 'surrogateescape')
            total += 1
            kl = key.replace('\\', '/').lower()
            if kl.startswith('assets/luatemp/'):
                kl = kl[len('assets/luatemp/'):]
            for suf in ('.lua.bytes', '.bytes', '.lua'):
                if kl.endswith(suf):
                    kl = kl[:-len(suf)]
                    break
            by_rel_lower[kl] = (ab_name, key, data)
            base = kl.rsplit('/', 1)[-1]
            by_ab_and_base.setdefault((ab_stem, base), []).append((kl, ab_name, data))
            by_base_lower.setdefault(base, []).append((kl, ab_name, data))
    return total, by_rel_lower, by_ab_and_base, by_base_lower


def main():
    dry = '--dry-run' in sys.argv
    if not os.path.isdir(AB64_DIR):
        sys.exit(f'Missing luascript64 directory: {AB64_DIR} (override via FZZL_LUA64_AB_DIR)')
    if not os.path.isdir(BC32_DIR):
        sys.exit(f'Missing reference bc/ directory: {BC32_DIR} (run build/client_assembly.py first)')

    print('== Scanning tools/lua_remote/bc/ ...')
    bc32_rels = []
    for dp, _, fns in os.walk(BC32_DIR):
        for fn in sorted(fns):
            if not fn.endswith('.lua'):
                continue
            rel = os.path.relpath(os.path.join(dp, fn), BC32_DIR).replace('\\', '/')
            bc32_rels.append(rel)
    bc32_rels.sort()
    print(f'   bc32 files: {len(bc32_rels)}')

    print(f'== Loading {AB64_DIR}/*.ab ...')
    total64, by_rel, by_ab_base, by_base = load_ab64_index()
    print(f'   luascript64/*.ab TextAssets: {total64} (unique keys: {len(by_rel)})')

    matched = {}
    unmatched = []
    used_keys = set()

    for rel32 in bc32_rels:
        key32 = rel32[:-4].lower()
        parts = key32.split('/')
        base = parts[-1]
        hit_key = None

        if key32 in by_rel:
            hit_key = key32
        elif len(parts) == 2 and parts[0] == 'config':
            cand = 'config/data/' + base
            if cand in by_rel:
                hit_key = cand
        if hit_key is None and len(parts) >= 2 and parts[0] == 'modules':
            mod_dir = parts[1]
            prefix = f'modules/{mod_dir}/'
            cands = [k for k, _, _ in by_base.get(base, []) if k.startswith(prefix)]
            if len(cands) == 1:
                hit_key = cands[0]
            elif not cands:
                ab_cands = [k for k, _, _ in by_ab_base.get((mod_dir, base), [])]
                if len(ab_cands) == 1:
                    hit_key = ab_cands[0]
        if hit_key is None and len(parts) >= 2:
            top = parts[0] + '/'
            cands = [k for k, _, _ in by_base.get(base, []) if k.startswith(top)]
            if len(cands) == 1:
                hit_key = cands[0]
        if hit_key is None:
            cands = [k for k, _, _ in by_base.get(base, [])]
            if len(cands) == 1:
                hit_key = cands[0]

        if hit_key is not None:
            matched[rel32] = hit_key
            used_keys.add(hit_key)
        else:
            unmatched.append((rel32, [k for k, _, _ in by_base.get(base, [])]))

    unused64 = sorted(set(by_rel.keys()) - used_keys)
    print(f'   Matched: {len(matched)} / {len(bc32_rels)}, unmatched: {len(unmatched)}, unused ab64: {len(unused64)}')
    if unmatched:
        sys.exit(f'FAIL: {len(unmatched)} bc32 files had no luascript64 match: {unmatched[:10]}')

    non_gc64 = []
    for rel32, k64 in matched.items():
        data = by_rel[k64][2]
        if not data.startswith(GC64_HDR):
            non_gc64.append((rel32, k64, data[:8].hex()))
    if non_gc64:
        sys.exit(f'FAIL: {len(non_gc64)} entries lack GC64 header 1b4c4a020a: {non_gc64[:10]}')
    print(f'   GC64 header check: {len(matched)}/{len(matched)} PASS (1b4c4a020a)')

    if dry:
        print('== --dry-run done, no files written')
        return

    os.makedirs(BC64_DIR, exist_ok=True)
    written = 0
    for rel32, k64 in matched.items():
        dst = os.path.join(BC64_DIR, rel32.replace('/', os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, 'wb') as f:
            f.write(by_rel[k64][2])
        written += 1

    expected_set = set(matched.keys())
    actual_set = set()
    for dp, _, fns in os.walk(BC64_DIR):
        for fn in fns:
            actual_set.add(os.path.relpath(os.path.join(dp, fn), BC64_DIR).replace('\\', '/'))
    for ex in actual_set - expected_set:
        os.remove(os.path.join(BC64_DIR, ex.replace('/', os.sep)))

    if os.path.isfile(KEYMAP_PATH):
        km = json.load(open(KEYMAP_PATH, encoding='utf-8'))
        km_miss = []
        for alias, rel in km.items():
            found = any(
                os.path.isfile(os.path.join(base_d, rel + suf))
                for base_d in (SRC_DIR, BC64_DIR)
                for suf in ('', '.lua')
            )
            if not found:
                km_miss.append((alias, rel))
        assert not km_miss, f'keymap missing targets: {km_miss[:10]}'
        print(f'   keymap check: {len(km)}/{len(km)} targets present')

    print(f'== DONE: wrote {written} GC64 bytecode files to {BC64_DIR}')


if __name__ == '__main__':
    main()
