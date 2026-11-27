#!/usr/bin/env python3
"""
Compile com.onevcat.uniwebview.UniWebViewInterface (JDK 8, target 1.7) into
build64/unity_project/Assets/Plugins/Android/uniwebview_arm64.jar, AND restore
the original C# UniWebViewInterface.cs so the in-game Notice panel renders
natively with Android WebView.
"""
import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
BUILD64 = HERE.parent.parent

JDK8 = Path(os.environ.get("FZZL_JDK8", r"F:\ark64_tools\jdk8\jdk8u512-b09"))
JAVAC = JDK8 / "bin" / ("javac.exe" if os.name == "nt" else "javac")
UNITY_SDK = Path(os.environ.get("FZZL_UNITY_ANDROID_SDK", r"F:\ark64_tools\android_sdk_u2017"))
ANDROID_JAR = UNITY_SDK / "platforms" / "android-26" / "android.jar"
UNITY_DIR = Path(os.environ.get("FZZL_UNITY_DIR", r"F:\ark64_tools\Unity2017.4.23f1"))
UNITY_JAR = UNITY_DIR / "Editor" / "Data" / "PlaybackEngines" / "AndroidPlayer" / "Variations" / "il2cpp" / "Release" / "Classes" / "classes.jar"

JAVA_SRC = HERE / "com" / "onevcat" / "uniwebview" / "UniWebViewInterface.java"
OUT_JAR = BUILD64 / "unity_project" / "Assets" / "Plugins" / "Android" / "uniwebview_arm64.jar"
CS_ORIG = BUILD64 / "staging" / "cs_clean_main" / "UniWebViewInterface.cs"
CS_DEST = BUILD64 / "unity_project" / "Assets" / "Scripts" / "UniWebViewInterface.cs"


def main():
    assert ANDROID_JAR.is_file(), f"missing {ANDROID_JAR}"
    assert UNITY_JAR.is_file(), f"missing {UNITY_JAR}"
    assert JAVA_SRC.is_file(), f"missing {JAVA_SRC}"

    with tempfile.TemporaryDirectory(prefix="ark64_uwv_") as td:
        td_path = Path(td)
        cp = os.pathsep.join([str(ANDROID_JAR), str(UNITY_JAR)])
        subprocess.run(
            [str(JAVAC), "-source", "1.7", "-target", "1.7", "-encoding", "UTF-8",
             "-cp", cp, "-d", str(td_path), str(JAVA_SRC)],
            check=True,
        )
        OUT_JAR.parent.mkdir(parents=True, exist_ok=True)
        classes = []
        with zipfile.ZipFile(OUT_JAR, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for cf in sorted(td_path.rglob("*.class")):
                arc = cf.relative_to(td_path).as_posix()
                zf.write(cf, arc)
                classes.append(arc)
        print(f"[PASS] Built {OUT_JAR} ({OUT_JAR.stat().st_size:,} B, {len(classes)} classes)")

    if CS_ORIG.is_file():
        shutil.copy2(CS_ORIG, CS_DEST)
        print(f"[PASS] Restored real UniWebViewInterface.cs -> {CS_DEST}")


if __name__ == "__main__":
    main()
