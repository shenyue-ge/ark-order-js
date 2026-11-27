#!/usr/bin/env python3
"""
Deterministic post-decompile patcher for build64/staging/cs_clean_main (or unity_project/Assets/Scripts):
1. Fixes the 6 Live2D.Cubism.Core files where ILSpy emits C# 7.2 `ref` conditional +
   `Unsafe.Add(ref *ptr, i)` instead of standard C# 4 `fixed (T* ptr = arr)` + `ptr[i]`.
2. Patches Live2DGraphic.cs to suppress Live2DUnity.dll's IL2CPP StackTrace false positive
   (`firstError_drawMeshNowInUpdate = false` in OnMocLoad).
"""
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BUILD64 = HERE.parent
DEFAULT_MAIN = BUILD64 / "staging" / "cs_clean_main"

CUBISM_FILES = [
    "Live2D/Cubism/Core/ArrayExtensionMethods.cs",
    "Live2D/Cubism/Core/Unmanaged/CubismUnmanagedCanvasInformation.cs",
    "Live2D/Cubism/Core/Unmanaged/CubismUnmanagedByteArrayView.cs",
    "Live2D/Cubism/Core/Unmanaged/CubismUnmanagedFloatArrayView.cs",
    "Live2D/Cubism/Core/Unmanaged/CubismUnmanagedIntArrayView.cs",
    "Live2D/Cubism/Core/Unmanaged/CubismUnmanagedUshortArrayView.cs",
]

L2D_HELPER = """\t\tprivate static bool _l2dIl2CppFixApplied;

\t\tprivate static void SuppressIl2CppDrawMeshNowFalsePositive()
\t\t{
\t\t\tif (_l2dIl2CppFixApplied)
\t\t\t{
\t\t\t\treturn;
\t\t\t}
\t\t\t_l2dIl2CppFixApplied = true;
\t\t\ttry
\t\t\t{
\t\t\t\tType[] types = typeof(Live2DModelUnity).Assembly.GetTypes();
\t\t\t\tfor (int i = 0; i < types.Length; i++)
\t\t\t\t{
\t\t\t\t\tFieldInfo fi = types[i].GetField("firstError_drawMeshNowInUpdate",
\t\t\t\t\t\tBindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public);
\t\t\t\t\tif (fi != null && fi.FieldType == typeof(bool))
\t\t\t\t\t{
\t\t\t\t\t\tfi.SetValue(null, false);
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t\tcatch
\t\t\t{
\t\t\t}
\t\t}

"""


def patch_cubism_fixed(text: str) -> str:
    text = re.sub(
        r"fixed\s*\(\s*([A-Za-z0-9_]+)\*\s+([A-Za-z0-9_]+)\s*=\s*&\(\(([A-Za-z0-9_]+)\s*=\s*([^)]+)\)\s*!=\s*null\s*&&\s*\3\.Length\s*!=\s*0\s*\?\s*ref\s+\3\[0\]\s*:\s*ref\s+\*\(\1\*\)null\)\)",
        r"fixed (\1* \2 = \3 = \4)",
        text,
    )
    text = re.sub(
        r"fixed\s*\(\s*([A-Za-z0-9_]+)\*\s+([A-Za-z0-9_]+)\s*=\s*&\(([A-Za-z0-9_]+)\s*!=\s*null\s*&&\s*\3\.Length\s*!=\s*0\s*\?\s*ref\s+\3\[0\]\s*:\s*ref\s+\*\(\1\*\)null\)\)",
        r"fixed (\1* \2 = \3)",
        text,
    )
    text = re.sub(
        r"System\.Runtime\.CompilerServices\.Unsafe\.Add\s*\(\s*ref\s+\*([A-Za-z0-9_]+)\s*,\s*([^)]+)\)",
        r"\1[\2]",
        text,
    )
    return text


def patch_live2d_graphic(text: str) -> str:
    if "SuppressIl2CppDrawMeshNowFalsePositive" in text:
        return text
    if "using System.Reflection;" not in text:
        text = text.replace("using System.Linq;\n", "using System.Linq;\nusing System.Reflection;\n", 1)
    anchor = "\t\tprivate void OnMocLoad(AssetVO assetVo, object arg)"
    if anchor in text:
        text = text.replace(anchor, L2D_HELPER + anchor, 1)
    load_anchor = "\t\t\tbyte[] bytes = (assetVo.GetObject() as TextAsset).bytes;"
    if load_anchor in text:
        text = text.replace(load_anchor, "\t\t\tSuppressIl2CppDrawMeshNowFalsePositive();\n" + load_anchor, 1)
    return text


def main():
    main_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_MAIN
    changed = 0
    for rel in CUBISM_FILES:
        p = main_dir / rel
        if not p.is_file():
            continue
        orig = p.read_text(encoding="utf-8")
        new = patch_cubism_fixed(orig)
        if new != orig:
            p.write_text(new, encoding="utf-8", newline="\n")
            changed += 1
            print(f"[PATCHED] {rel}")

    l2d_path = main_dir / "Assets/Script/Live2D/Live2DGraphic.cs"
    if l2d_path.is_file():
        orig = l2d_path.read_text(encoding="utf-8")
        new = patch_live2d_graphic(orig)
        if new != orig:
            l2d_path.write_text(new, encoding="utf-8", newline="\n")
            changed += 1
            print("[PATCHED] Assets/Script/Live2D/Live2DGraphic.cs (IL2CPP DrawMeshNow fix)")

    print(f"Done: {changed} files updated under {main_dir}")


if __name__ == "__main__":
    main()
