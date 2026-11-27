// BootPipeline（纯 64 位 Node 版，零 Jint / 零 PsPortHub）：
// 阶段：extcfg 自举 → 数据包检查/导入（三百二十闸门）→ Node 播种（psbin + psnode64）→ NodeHost 启动与 HTTP 探活 → 就绪。
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using PsLocalServer.Shims;

namespace PsLocalServer
{
    public class BootPipeline
    {
        public readonly HostEnvironment Env;
        public readonly Action<string, double> Progress;
        public readonly Action<string> Status;
        public readonly Action OnReady;
        public readonly Action<string> OnError;

        public NodeHost Node;
        public string Engine = "node-arm64";
        public string EngineReason = "";

        private Thread _supervisor;
        private volatile bool _stopping;

        public BootPipeline(HostEnvironment env, Action<string, double> progress, Action<string> status,
                            Action onReady, Action<string> onError)
        {
            Env = env;
            Progress = progress ?? delegate(string a, double b) { };
            Status = status ?? delegate(string a) { };
            OnReady = onReady ?? delegate { };
            OnError = onError ?? delegate(string a) { };
        }

        public void Start()
        {
            new Thread(Run) { IsBackground = true, Name = "PsBoot" }.Start();
        }

        private string DiagFile
        {
            get { return Env.PersistDir != null ? Path.Combine(Env.PersistDir, "psboot_diag.log") : null; }
        }

        private void Diag(string msg)
        {
            var line = DateTime.UtcNow.AddHours(8).ToString("HH:mm:ss.fff") + " " + msg;
            try { UnityEngine.Debug.Log("[PsBoot64] " + msg); } catch { }
            if (DiagFile == null) return;
            try { File.AppendAllText(DiagFile, line + "\n"); } catch { }
        }

        private void Run()
        {
            try
            {
                Diag("=== BootPipeline64 start (arm64 pure-node) ===");
                Diag("PersistDir=" + (Env.PersistDir ?? "(null)") + " DataDir=" + (Env.DataDir ?? "(null)")
                     + " Apk=" + (Bootstrap.ApkPath ?? "(null)")
                     + " DataApk=" + (DataPackage.CachedDataApkSource ?? "(null)"));
                PsLog.Sink = delegate(string s) { Diag("[shim] " + s); };

                // 0) 首启自举 extcfg.json（LuaRemoteIP=127.0.0.1 + isSecondZipDone=2）
                Progress("初始化配置", 0.02);
                ExtCfg.Ensure(Env);

                // 1) 数据包检查/导入（三百二十闸门：无数据包拒绝启动服务端）
                Progress("检查数据包", 0.08);
                DataPackage.Ensure(Env, delegate(string m, double p)
                {
                    Progress(m, 0.08 + p * 0.62);
                    Diag("data: " + m + " " + (p * 100).ToString("F0") + "%");
                });
                if (DataPackage.MissingData)
                {
                    const string msg = "未检测到数据包：请同时安装数据包 APK (fzzl_data.apk) 后重新启动";
                    Diag("GATE-320: " + msg);
                    EngineReason = "missing-data-package";
                    WriteEngineStatus();
                    Progress(msg, 0.99);
                    OnError(msg);
                    return;
                }

                // 2) 播种 psbin + psnode64 到 /data/user/0/<pkg>/files
                Progress("准备 64 位本地服务端", 0.72);
                SeedNode();

                // 3) 启动 psnode 并探活 HTTP 8081
                Progress("启动本地服务端 (arm64 Node)", 0.86);
                string err;
                if (!StartNode(out err))
                {
                    EngineReason = err;
                    WriteEngineStatus();
                    Diag("FATAL node start failed: " + err);
                    Progress("服务端启动失败: " + err, 1.0);
                    OnError(err);
                    return;
                }

                WriteEngineStatus();
                Diag("READY: engine=node-arm64 readyMs=" + (Node != null ? Node.ReadyMs : -1));
                Progress("本地服务端已就绪", 1.0);
                OnReady();
            }
            catch (Exception e)
            {
                Diag("FATAL: " + e);
                Progress("启动失败: " + e.Message, 1.0);
                OnError(e.ToString());
            }
        }

        private void SeedNode()
        {
            var apk = Bootstrap.ApkPath;
            if (string.IsNullOrEmpty(apk) || !File.Exists(apk))
                throw new Exception("APK path unavailable: " + apk);

            var dataDir = Env.DataDir;
            var marker = Path.Combine(dataDir, ".node_seeded");
            string wantVer;
            using (var zip = new PsZipReader(apk))
            {
                wantVer = NodeSeeder.Version(zip);
            }
            if (string.IsNullOrEmpty(wantVer))
                throw new Exception("APK 缺少 assets/psnode/NODE_TREE.json");

            var binPath = Path.Combine(Path.Combine(dataDir, "psbin"), "psnode");
            var startJs = Path.Combine(Path.Combine(Path.Combine(dataDir, "psnode_root"), "ps_server"), "start.js");
            if (File.Exists(marker) && File.ReadAllText(marker).Trim() == wantVer
                && File.Exists(binPath) && File.Exists(startJs))
            {
                Diag("node-seed: up-to-date (" + wantVer + ")");
                return;
            }

            var serverDir = Path.Combine(Path.Combine(dataDir, "psnode_root"), "ps_server");
            var savesDir = Path.Combine(serverDir, "saves");
            var accPath = Path.Combine(serverDir, "accounts.json");
            bool upgrading = File.Exists(startJs) || Directory.Exists(savesDir) || File.Exists(accPath);
            Diag("node-seed: extracting (" + wantVer + ", upgrading=" + upgrading + ")");
            long bytes = NodeSeeder.Seed(apk, dataDir,
                delegate(double p) { Progress("释放本地服务端", 0.72 + p * 0.13); },
                Diag,
                upgrading);
            File.WriteAllText(marker, wantVer, new UTF8Encoding(false));
            Diag("node-seed: done " + bytes + " bytes (" + wantVer + ")");
        }

        private bool StartNode(out string err)
        {
            err = null;
            var dataDir = Env.DataDir;
            var binDir = Path.Combine(dataDir, "psbin");
            var binPath = Path.Combine(binDir, "psnode");
            var scriptDir = Path.Combine(Path.Combine(dataDir, "psnode_root"), "ps_server");
            var stdoutLog = Env.PersistDir != null ? Path.Combine(Env.PersistDir, "psnode_stdout.log") : null;

            Node = new NodeHost
            {
                BinPath = binPath,
                LibDir = binDir,
                ScriptDir = scriptDir,
                StdoutLog = stdoutLog,
                Diag = Diag,
            };

            if (!Node.Start())
            {
                err = "NodeHost.Start failed: " + Node.LastError;
                return false;
            }
            if (!Node.WaitReady(15000))
            {
                err = "NodeHost.WaitReady failed: " + Node.LastError;
                try { Node.Stop(); } catch { }
                return false;
            }

            // 守护线程：异常退出时最多自动拉起 3 次
            _supervisor = new Thread(SuperviseLoop) { IsBackground = true, Name = "PsNodeSup" };
            _supervisor.Start();
            return true;
        }

        private void SuperviseLoop()
        {
            int restarts = 0;
            while (!_stopping)
            {
                Thread.Sleep(2000);
                if (_stopping || Node == null || Node.IsAlive) continue;
                restarts++;
                if (restarts > 3)
                {
                    Diag("supervise: psnode crashed >3 times, giving up");
                    return;
                }
                Diag("supervise: psnode exited (code=" + Node.ExitCode + "), restarting #" + restarts);
                if (Node.Start() && Node.WaitReady(15000))
                    Diag("supervise: restart #" + restarts + " ready in " + Node.ReadyMs + "ms");
                else
                    Diag("supervise: restart #" + restarts + " failed: " + Node.LastError);
            }
        }

        [DllImport("libc", EntryPoint = "getpagesize")]
        private static extern int libc_getpagesize();

        private static int SystemPageSize()
        {
            try { return libc_getpagesize(); } catch { return -1; }
        }

        private void WriteEngineStatus()
        {
            try
            {
                if (Env.PersistDir == null) return;
                var reason = (EngineReason ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
                var json = "{\"engine\":\"" + Engine + "\",\"fallback\":false"
                         + ",\"reason\":\"" + reason + "\""
                         + ",\"pagesize\":" + SystemPageSize()
                         + ",\"nodeReadyMs\":" + (Node != null ? Node.ReadyMs : -1)
                         + ",\"ts\":\"" + DateTime.UtcNow.AddHours(8).ToString("yyyy-MM-dd HH:mm:ss") + "\"}";
                File.WriteAllText(Path.Combine(Env.PersistDir, "engine_status.json"), json, new UTF8Encoding(false));
            }
            catch { }
        }

        public void Stop()
        {
            _stopping = true;
            try { if (Node != null) Node.Stop(); } catch { }
        }
    }

    public static class ExtCfg
    {
        public static void Ensure(HostEnvironment env)
        {
            if (env.PersistDir == null) return;
            var path = Path.Combine(env.PersistDir, "extcfg.json");
            string json = File.Exists(path) ? File.ReadAllText(path) : "";
            json = SetKey(json, "LuaRemoteIP", "127.0.0.1");
            json = SetKey(json, "isSecondZipDone", "2");
            json = SetKey(json, "LogUploadUrl", "");
            json = SetKey(json, "LogUploadKey", "");
            if (!json.Contains("ResFromAB"))
            {
                json = "{\"ResFromAB\":\"true\",\"LuaFromAB\":\"true\",\"CfgFromAB\":\"true\"," +
                       "\"isSecondZipDone\":\"2\",\"ResVersion\":\"138723\",\"IsReLoginLogout\":\"false\"," +
                       "\"AcceptUserProto3\":\"1\",\"AcceptUserProto4\":\"1\",\"LuaRemoteIP\":\"127.0.0.1\"}";
            }
            File.WriteAllText(path, json, new UTF8Encoding(false));
        }

        static string SetKey(string json, string key, string value)
        {
            var token = "\"" + key + "\":";
            var i = json.IndexOf(token, StringComparison.Ordinal);
            var pair = "\"" + key + "\":\"" + value + "\"";
            if (i < 0)
            {
                if (json.Trim().Length == 0) return "{" + pair + "}";
                var trimmed = json.TrimEnd();
                if (trimmed.EndsWith("}"))
                {
                    var head = trimmed.Substring(0, trimmed.Length - 1).TrimEnd();
                    return (head.Length > 1 ? head + "," : head) + pair + "}";
                }
                return json;
            }
            var start = i + token.Length;
            while (start < json.Length && json[start] != '"') start++;
            var end = json.IndexOf('"', start + 1);
            if (end < 0) return json;
            return json.Substring(0, start) + "\"" + value + "\"" + json.Substring(end + 1);
        }
    }

    public static class DataPackage
    {
        public const string DataPkgName = "com.bilibili.fzzl.guopan.data";
        public static string CachedDataApkSource = null;
        public static bool MissingData;

        public static void CacheDataApkSource()
        {
            if (!string.IsNullOrEmpty(CachedDataApkSource)) return;
            try
            {
                using (var up = new UnityEngine.AndroidJavaClass("com.unity3d.player.UnityPlayer"))
                using (var act = up.GetStatic<UnityEngine.AndroidJavaObject>("currentActivity"))
                using (var pm = act.Call<UnityEngine.AndroidJavaObject>("getPackageManager"))
                using (var info = pm.Call<UnityEngine.AndroidJavaObject>("getApplicationInfo", DataPkgName, 0))
                {
                    var src = info.Get<string>("sourceDir");
                    if (!string.IsNullOrEmpty(src) && File.Exists(src)) CachedDataApkSource = src;
                }
            }
            catch { }
            if (!string.IsNullOrEmpty(CachedDataApkSource)) return;
            foreach (var dir in new[] { "/sdcard/Download", "/storage/emulated/0/Download" })
            {
                try
                {
                    var p = Path.Combine(dir, "fzzl_data.apk");
                    if (File.Exists(p)) { CachedDataApkSource = p; return; }
                }
                catch { }
            }
        }

        public static void Ensure(HostEnvironment env, Action<string, double> progress)
        {
            var resInfo = Path.Combine(env.ResDir, "resInfo.json");
            var doneMarker = Path.Combine(env.ResDir, ".data_imported");
            if (File.Exists(resInfo) && File.Exists(doneMarker))
            {
                progress("数据包就绪", 1.0);
                return;
            }

            var apkSource = CachedDataApkSource;
            if (!string.IsNullOrEmpty(apkSource) && File.Exists(apkSource))
            {
                ImportFromApk(env, apkSource, progress);
                if (File.Exists(resInfo))
                {
                    try { File.WriteAllText(doneMarker, "ok\n", new UTF8Encoding(false)); } catch { }
                    progress("数据包就绪", 1.0);
                    return;
                }
                throw new Exception("数据包导入完成但缺少 resInfo.json: " + apkSource);
            }

            if (File.Exists(resInfo))
            {
                progress("数据包就绪", 1.0);
                return;
            }

            MissingData = env.PersistDir != null;
            progress("未检测到数据包", 0.0);
        }

        static void ImportFromApk(HostEnvironment env, string apkPath, Action<string, double> progress)
        {
            progress("从数据包 APK 导入资源", 0.0);
            using (var zip = new PsZipReader(apkPath))
            {
                var names = zip.NamesByPrefix("assets/res/");
                long total = 0, done = 0;
                foreach (var n in names) total += zip.EntrySize(n);
                Directory.CreateDirectory(env.ResDir);
                long lastReport = 0;
                foreach (var name in names)
                {
                    var tail = name.Substring("assets/res/".Length);
                    if (string.IsNullOrEmpty(tail)) continue;
                    var size = zip.EntrySize(name);
                    var target = Path.Combine(env.ResDir, tail.Replace('/', Path.DirectorySeparatorChar));
                    if (size == 0)
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    if (File.Exists(target) && new FileInfo(target).Length == size)
                    {
                        done += size;
                    }
                    else
                    {
                        using (var fsOut = new FileStream(target, FileMode.Create, FileAccess.Write))
                        {
                            zip.ReadTo(name, fsOut);
                        }
                        done += size;
                    }
                    if (done - lastReport >= 16L * 1024 * 1024 || done >= total)
                    {
                        lastReport = done;
                        progress("从数据包 APK 导入资源", (double)done / Math.Max(total, 1));
                    }
                }
            }
        }
    }
}
