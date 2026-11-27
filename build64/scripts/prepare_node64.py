# -*- coding: utf-8 -*-
r"""
prepare_node64.py -- Pure-Node 64-bit standalone server asset tree builder (build64/staging/psnode64/).

Zero-drift architecture:
  - Directly imports build/pslocal/scripts/prepare_assets.py for:
      * ship_accounts_json / ship_player_save (player-only factory account, empty lastAccount)
      * 4 behavioral transforms: transform_guide / transform_lua_remote / transform_relic_data / transform_vit
      * generate_relic_types_json / audit_runtime_tool_reads
  - Switches lua_remote_frame.bin bytecode root to tools/lua_remote/bc64/ (LuaJIT 2.1 GC64),
    overlays plaintext Lua patches from tools/lua_remote/src/ (skipping any legacy 32-bit bytecode
    copies in src/), and verifies 100% GC64 purity (0 legacy 32-bit bytecodes).
  - Emits NODE_TREE.json with content fingerprint fp so on-device NodeSeeder detects updates.
"""
import hashlib
import io
import json
import os
import shutil
import struct
import subprocess
import sys
import time
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD64 = os.path.dirname(HERE)
ROOT = os.path.dirname(BUILD64)

# Import 32-bit prepare_assets transforms directly (single source of truth)
SCRIPTS32 = os.path.join(ROOT, 'build', 'pslocal', 'scripts')
sys.path.insert(0, SCRIPTS32)
import prepare_assets as PA  # noqa: E402

OUT_ROOT = os.path.join(BUILD64, 'staging', 'psnode64')
BC64_DIR = os.path.join(ROOT, 'tools', 'lua_remote', 'bc64')
TRASH_DIR = os.path.join(BUILD64, '_trash')

GC64_HDR = b'\x1bLJ\x02\x0a'


def safe_clear_dir(path):
    """Move stale staging dir aside before rebuilding to avoid Windows rmtree lock stalls."""
    if not os.path.isdir(path):
        return
    os.makedirs(TRASH_DIR, exist_ok=True)
    dst = os.path.join(TRASH_DIR, f'{os.path.basename(path)}_{int(time.time() * 1000)}')
    try:
        shutil.move(path, dst)
    except OSError:
        shutil.rmtree(path)
        time.sleep(0.3)


def generate_lua_frame_64(out_path):
    """Build 64-bit lua_remote_frame.bin using server/lua_remote.js with BC_ROOT pointed to bc64/."""
    if not os.path.isdir(BC64_DIR):
        raise SystemExit(f'Missing 64-bit bytecode tree: {BC64_DIR}\n  Run: python build64/scripts/extract_bc64.py')

    lua_remote_js = os.path.join(PA.SERVER, 'lua_remote.js')
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    gen_js = os.path.join(OUT_ROOT, '__gen_frame64.js')
    driver = r'''
const fs = require('fs');
const path = require('path');
const SRC = %r;
const OUT = %r;
let src = fs.readFileSync(SRC, 'utf8');
const anchor = "const BC_ROOT = path.join(ROOT, 'bc');";
if (!src.includes(anchor)) throw new Error('BC_ROOT anchor not found in server/lua_remote.js');
src = src.replace(anchor, "const BC_ROOT = path.join(ROOT, 'bc64');");
// Skip legacy 32-bit LuaJIT bytecode (\x1bLJ\x02\x02) sitting inside tools/lua_remote/src/
// so only plaintext Lua patches (and any GC64 overrides) take precedence over bc64/.
const isBc32Helper = `
function __isBc32(buf) {
  return buf && buf.length >= 5 && buf[0] === 0x1b && buf[1] === 0x4c && buf[2] === 0x4a && buf[3] === 0x02 && buf[4] !== 0x0a;
}
`;
src = isBc32Helper + src;
const rcAnchor = "if (fs.existsSync(p)) return fs.readFileSync(p);";
if (!src.includes(rcAnchor)) throw new Error('readContent anchor not found');
src = src.replace(rcAnchor, "if (fs.existsSync(p)) { const __b = fs.readFileSync(p); if (base === SRC_ROOT && __isBc32(__b)) continue; return __b; }");
const walkAnchor = "add(r.slice(0, -4), fs.readFileSync(fp));";
if (!src.includes(walkAnchor)) throw new Error('walk SRC anchor not found');
src = src.replace(walkAnchor, "{ const __b = fs.readFileSync(fp); if (!__isBc32(__b)) add(r.slice(0, -4), __b); }");
const m = src.match(/^.*net\.createServer/m);
if (!m) throw new Error('net.createServer marker not found');
const body = src.slice(0, m.index) + '\nreturn getFrame();\n';
const fn = new Function('require', 'module', 'exports', '__filename', '__dirname', 'process', 'console', body);
const moduleObj = { exports: {} };
const frame = fn(require, moduleObj, moduleObj.exports, SRC, path.dirname(SRC), process, console);
fs.writeFileSync(OUT, frame);
console.log('frame64 bytes:', frame.length);
''' % (lua_remote_js.replace('\\', '/'), out_path.replace('\\', '/'))

    with io.open(gen_js, 'w', encoding='utf-8', newline='\n') as f:
        f.write(driver)
    try:
        r = subprocess.run(['node', gen_js], capture_output=True, text=True, encoding='utf-8', errors='replace')
        print('   ' + (r.stdout.strip() or r.stderr.strip()[-400:]))
        if r.returncode != 0:
            raise SystemExit('generate_lua_frame_64 failed:\n' + (r.stderr or r.stdout)[-1000:])
    finally:
        if os.path.isfile(gen_js):
            os.remove(gen_js)


def verify_frame64(frame_path):
    """Verify structural integrity, 100% GC64 bytecode purity, and plaintext patch presence."""
    raw = open(frame_path, 'rb').read()
    outer_len = struct.unpack_from('<i', raw, 0)[0]
    assert outer_len == len(raw), f'outer header {outer_len} != file len {len(raw)}'
    data = zlib.decompress(raw[4:])
    total = struct.unpack_from('<i', data, 0)[0]
    pos = 4
    n_entries = 0
    n_gc64 = 0
    n_plain = 0
    bad_bc = []
    while pos < total:
        nlen = data[pos]
        pos += 1
        clen = int.from_bytes(data[pos:pos + 3], 'little')
        pos += 3
        name = data[pos:pos + nlen].decode('ascii', 'replace')
        pos += nlen
        content = data[pos:pos + clen]
        pos += clen
        n_entries += 1
        if content.startswith(b'\x1bLJ'):
            if content.startswith(GC64_HDR):
                n_gc64 += 1
            else:
                bad_bc.append((name, content[:8].hex()))
        else:
            n_plain += 1

    assert pos == total, f'parse end {pos} != total {total}'
    assert not bad_bc, f'Non-GC64 bytecodes found: {bad_bc[:10]}'
    assert n_gc64 > 3000, f'Too few GC64 entries: {n_gc64}'
    assert n_plain > 10, f'Too few plaintext patch entries: {n_plain}'
    print(f'   frame64 PASS: compressed={len(raw):,} B ({len(raw)/1048576:.2f} MB), '
          f'data={total:,} B ({total/1048576:.2f} MB), entries={n_entries:,} '
          f'(GC64={n_gc64:,}, plain={n_plain:,}, bc32=0)')


def main():
    t0 = time.time()
    print('== prepare_node64 ->', OUT_ROOT)
    safe_clear_dir(OUT_ROOT)
    ps_server = os.path.join(OUT_ROOT, 'ps_server')
    os.makedirs(ps_server, exist_ok=True)

    # 1) Copy server/ JS & data files (pure ES6+, zero Jint/Babel transpilation)
    for name in os.listdir(PA.SERVER):
        s = os.path.join(PA.SERVER, name)
        if os.path.isdir(s):
            if name in ('logs', 'node_modules', 'saves'):
                continue
            shutil.copytree(s, os.path.join(ps_server, name))
        elif name.endswith('.js') or name in ('missions_data.json', 'skin_config.json'):
            shutil.copy2(s, os.path.join(ps_server, name))

    # 2) Factory account & save (single source of truth from prepare_assets)
    PA.ship_accounts_json(os.path.join(ps_server, 'accounts.json'))
    PA.ship_player_save(os.path.join(ps_server, 'saves'))

    # 3) 4 behavioral transforms (single source of truth from prepare_assets)
    def rewrite(rel, fn):
        fp = os.path.join(ps_server, rel)
        text = io.open(fp, encoding='utf-8').read()
        io.open(fp, 'w', encoding='utf-8', newline='\n').write(fn(text))

    rewrite(os.path.join('handlers', 'guide.js'), PA.transform_guide)
    rewrite('lua_remote.js', PA.transform_lua_remote)
    rewrite(os.path.join('data', 'relic_data.js'), PA.transform_relic_data)
    rewrite(os.path.join('handlers', 'vit.js'), PA.transform_vit)
    PA.generate_relic_types_json(os.path.join(ps_server, 'data', 'relic_types_parsed.json'))

    # 3b) Sanity check BigInt etf.js + syntax check every JS file with node --check
    etf_txt = io.open(os.path.join(ps_server, 'etf.js'), encoding='utf-8').read()
    assert '0n' in etf_txt and '__psLong.' not in etf_txt, 'etf.js unexpected: not native BigInt'
    js_files = []
    for dp, _, fns in os.walk(ps_server):
        for fn in fns:
            if fn.endswith('.js'):
                js_files.append(os.path.join(dp, fn))
    for jp in js_files:
        r = subprocess.run(['node', '--check', jp], capture_output=True, text=True)
        if r.returncode != 0:
            raise SystemExit(f'node --check failed: {jp}\n{r.stderr}')
    print(f'   JS check PASS: {len(js_files)} files passed node --check, native BigInt intact')

    # 4) Runtime tools assets
    kl = os.path.join(OUT_ROOT, 'tools', 'key_lua')
    shutil.copytree(PA.KEY_LUA, kl)
    for rel in (os.path.join('bc_cmp', 'vit_new', 'CfgItems.lua'),
                os.path.join('bc_cmp', 'CfgItems_ljd.lua'),
                os.path.join('bc_cmp', 'grow_parts.json'),
                os.path.join('lua_src', 'CfgItems.lua'),
                os.path.join('lua_src', 'CfgMain.lua')):
        s = os.path.join(ROOT, 'tools', rel)
        d = os.path.join(OUT_ROOT, 'tools', rel)
        if os.path.isfile(s):
            os.makedirs(os.path.dirname(d), exist_ok=True)
            shutil.copy2(s, d)

    # 5) Build & verify GC64 prebuilt Lua frame
    frame_out = os.path.join(OUT_ROOT, 'tools', 'lua_remote_frame.bin')
    generate_lua_frame_64(frame_out)
    verify_frame64(frame_out)

    # 6) Audit runtime tools/ reads
    bad = PA.audit_runtime_tool_reads(ps_server, os.path.join(OUT_ROOT, 'tools'))
    if bad:
        raise SystemExit('prepare_node64: missing runtime tools dependencies:\n  ' + '\n  '.join(bad))

    # 7) Emit NODE_TREE.json with fingerprint fp
    files = []
    h = hashlib.md5()
    skip_fp = ('ps_server/logs/', 'ps_server/saves/')
    for dirpath, dirnames, filenames in os.walk(OUT_ROOT):
        dirnames.sort()
        for fn in sorted(filenames):
            if fn == 'NODE_TREE.json':
                continue
            fp = os.path.join(dirpath, fn)
            rel = os.path.relpath(fp, OUT_ROOT).replace('\\', '/')
            sz = os.path.getsize(fp)
            files.append((rel, sz))
            if rel.startswith(skip_fp) or rel == 'ps_server/accounts.json':
                continue
            h.update(rel.encode('utf-8'))
            h.update(b'\0')
            with io.open(fp, 'rb') as f:
                while True:
                    b = f.read(1 << 20)
                    if not b:
                        break
                    h.update(b)

    tree_meta = {
        'fp': h.hexdigest()[:16],
        'arch': 'arm64-gc64',
        'files': [{'p': rel, 's': sz} for rel, sz in files],
    }
    tree_path = os.path.join(OUT_ROOT, 'NODE_TREE.json')
    with io.open(tree_path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(tree_meta, f, ensure_ascii=False, separators=(',', ':'))

    total_bytes = sum(sz for _, sz in files)
    print(f'== prepare_node64 DONE ({time.time()-t0:.1f}s): {len(files)} files, '
          f'{total_bytes/1048576:.2f} MB, fp={tree_meta["fp"]}')


if __name__ == '__main__':
    main()
