#!/usr/bin/env python3
"""
Compile JNIBridge.java (JDK 8, target 1.7), patch bitter/jnibridge/JNIBridge*.class
into Unity 2017.4.23f1's IL2CPP Android classes.jar, AND regenerate the pre-dexed
classes.dex. Fixes Android 16 (API 36) ServiceConnection default-method crash.
"""
import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
JDK8 = Path(os.environ.get("FZZL_JDK8", r"F:\ark64_tools\jdk8\jdk8u512-b09"))
JDK8_BIN = JDK8 / "bin"
JAVAC = JDK8_BIN / ("javac.exe" if os.name == "nt" else "javac")
JAVA = JDK8_BIN / ("java.exe" if os.name == "nt" else "java")

ANDROID_SDK = Path(os.environ.get(
    "FZZL_ANDROID_SDK",
    os.environ.get("ANDROID_SDK_ROOT", str(Path(os.environ.get("LOCALAPPDATA", "")) / "Android" / "Sdk")),
))
DX_JAR = Path(os.environ.get("FZZL_DX_JAR", str(ANDROID_SDK / "build-tools" / "28.0.3" / "lib" / "dx.jar")))

JAVA_SRC = HERE / "JNIBridge.java"
OUT_DEX = HERE / "classes.dex"
UNITY_DIR = Path(os.environ.get("FZZL_UNITY_DIR", r"F:\ark64_tools\Unity2017.4.23f1"))
UNITY_IL2CPP = UNITY_DIR / "Editor" / "Data" / "PlaybackEngines" / "AndroidPlayer" / "Variations" / "il2cpp"
JARS = [
    UNITY_IL2CPP / "Release" / "Classes" / "classes.jar",
    UNITY_IL2CPP / "Development" / "Classes" / "classes.jar",
]


def main():
    env = dict(os.environ)
    env["JAVA_HOME"] = str(JDK8)
    env["PATH"] = str(JDK8_BIN) + os.pathsep + env.get("PATH", "")

    with tempfile.TemporaryDirectory(prefix="ark64_jni_") as td:
        td_path = Path(td)
        subprocess.run(
            [str(JAVAC), "-source", "1.7", "-target", "1.7", "-d", str(td_path), str(JAVA_SRC)],
            check=True,
            env=env,
        )
        compiled = {}
        for cf in (td_path / "bitter" / "jnibridge").glob("*.class"):
            compiled[f"bitter/jnibridge/{cf.name}"] = cf.read_bytes()
        print("Compiled classes:", sorted(compiled.keys()))
        assert "bitter/jnibridge/JNIBridge.class" in compiled
        assert "bitter/jnibridge/JNIBridge$a.class" in compiled

        for jar in JARS:
            if not jar.exists():
                continue
            bak = jar.with_suffix(".jar.orig")
            if not bak.exists():
                shutil.copy2(jar, bak)
                print("Backed up:", bak)
            tmp_jar = jar.with_suffix(".jar.tmp")
            with zipfile.ZipFile(bak, "r") as zin, zipfile.ZipFile(tmp_jar, "w", compression=zipfile.ZIP_DEFLATED) as zout:
                for item in zin.infolist():
                    if item.filename in compiled:
                        zout.writestr(item.filename, compiled[item.filename])
                    else:
                        zout.writestr(item, zin.read(item.filename))
            tmp_jar.replace(jar)
            print("Patched jar:", jar)

            dex = jar.with_suffix(".dex")
            dex_bak = jar.with_suffix(".dex.orig")
            if dex.exists() and not dex_bak.exists():
                shutil.copy2(dex, dex_bak)
                print("Backed up:", dex_bak)
            tmp_dex = td_path / "classes.dex"
            if tmp_dex.exists():
                tmp_dex.unlink()
            subprocess.run(
                [str(JAVA), "-Xmx1024m", "-jar", str(DX_JAR), "--dex", f"--output={tmp_dex}", str(jar)],
                check=True,
                env=env,
            )
            dex_bytes = tmp_dex.read_bytes()
            assert b"onServiceConnected" in dex_bytes, "Patched dex missing onServiceConnected!"
            shutil.copy2(tmp_dex, dex)
            print(f"Patched dex: {dex} ({len(dex_bytes):,} B, onServiceConnected=True)")
            if "Release" in str(jar):
                shutil.copy2(dex, OUT_DEX)
                print(f"Exported release dex: {OUT_DEX}")


if __name__ == "__main__":
    main()
