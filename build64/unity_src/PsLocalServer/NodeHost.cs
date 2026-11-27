// NodeHost：64 位 arm64 独立 Node 进程宿主（IL2CPP 专用）。
// 关键：在 Android IL2CPP 下优先使用 java.lang.ProcessBuilder（经 AndroidJNI.AttachCurrentThread）
// 拉起 /system/bin/sh run.sh，彻底规避 Unity 2017.4 IL2CPP 的 System.Diagnostics.Process 兼容隐患。
using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using UnityEngine;

namespace PsLocalServer
{
    public class NodeHost
    {
        public string BinPath;
        public string LibDir;
        public string ScriptDir;
        public string ScriptName = "start.js";
        public int HttpPort = 8081;
        public int GamePort = 9021;
        public int LuaPort = 44587;
        public string StdoutLog;
        public Action<string> Diag;

        public volatile bool IsAlive;
        public string LastError;
        public int ExitCode = int.MinValue;
        public long ReadyMs = -1;

        private Thread _waitThread;
        private AndroidJavaObject _javaProc;
        private readonly object _lock = new object();
        private volatile bool _stopping;

        public bool Start()
        {
            try
            {
                var script = Path.Combine(Path.GetDirectoryName(BinPath) ?? ".", "run.sh");
                WriteRunScript(script);
                if (Diag != null) Diag("node: starting via Java ProcessBuilder: /system/bin/sh " + script);

                // 在调用线程（后台管线线程）临时 attach JNI 即可调 Java ProcessBuilder
                bool attached = false;
                try
                {
                    if (AndroidJNI.AttachCurrentThread() == 0) attached = true;
                }
                catch { }

                try
                {
                    using (var pb = new AndroidJavaObject("java.lang.ProcessBuilder",
                        new object[] { new string[] { "/system/bin/sh", script } }))
                    {
                        using (var wd = new AndroidJavaObject("java.io.File", ScriptDir))
                        {
                            pb.Call<AndroidJavaObject>("directory", wd).Dispose();
                        }
                        pb.Call<AndroidJavaObject>("redirectErrorStream", true).Dispose();
                        var proc = pb.Call<AndroidJavaObject>("start");
                        lock (_lock) { _javaProc = proc; }
                        IsAlive = true;
                    }
                }
                finally
                {
                    if (attached)
                    {
                        try { AndroidJNI.DetachCurrentThread(); } catch { }
                    }
                }

                // 后台等待子进程退出并更新 IsAlive / ExitCode
                _waitThread = new Thread(WaitJavaProcessLoop) { IsBackground = true, Name = "PsNodeWait" };
                _waitThread.Start();
                return true;
            }
            catch (Exception e)
            {
                LastError = e.GetType().Name + ": " + e.Message;
                IsAlive = false;
                if (Diag != null) Diag("node: Start exception: " + e);
                return false;
            }
        }

        private void WaitJavaProcessLoop()
        {
            bool attached = false;
            try
            {
                if (AndroidJNI.AttachCurrentThread() == 0) attached = true;
                AndroidJavaObject proc;
                lock (_lock) { proc = _javaProc; }
                if (proc == null) return;
                int code = proc.Call<int>("waitFor");
                ExitCode = code;
                IsAlive = false;
                if (Diag != null) Diag("node: java Process exited code=" + code);
            }
            catch (Exception e)
            {
                IsAlive = false;
                if (Diag != null) Diag("node: waitFor exc: " + e.Message);
            }
            finally
            {
                if (attached)
                {
                    try { AndroidJNI.DetachCurrentThread(); } catch { }
                }
            }
        }

        public bool WaitReady(int timeoutMs)
        {
            var sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < timeoutMs)
            {
                if (!IsAlive)
                {
                    LastError = "psnode exited early (code=" + ExitCode + ")" + ReadLogTail();
                    return false;
                }
                if (ProbeHttp(800))
                {
                    ReadyMs = sw.ElapsedMilliseconds;
                    return true;
                }
                Thread.Sleep(150);
            }
            LastError = "not ready in " + timeoutMs + "ms" + ReadLogTail();
            return false;
        }

        public bool ProbeHttp(int timeoutMs)
        {
            try
            {
                using (var c = new TcpClient())
                {
                    var ar = c.BeginConnect("127.0.0.1", HttpPort, null, null);
                    if (!ar.AsyncWaitHandle.WaitOne(timeoutMs)) return false;
                    c.EndConnect(ar);
                    c.ReceiveTimeout = timeoutMs;
                    var req = Encoding.ASCII.GetBytes(
                        "GET /client_api/GetAgentConfig.php HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
                    using (var ns = c.GetStream())
                    {
                        ns.Write(req, 0, req.Length);
                        ns.Flush();
                        var buf = new byte[2048];
                        int n = ns.Read(buf, 0, buf.Length);
                        if (n <= 0) return false;
                        var s = Encoding.UTF8.GetString(buf, 0, n);
                        return s.IndexOf("\"code\":\"300\"", StringComparison.Ordinal) >= 0
                            || (s.IndexOf("300", StringComparison.Ordinal) >= 0 && s.StartsWith("HTTP/"));
                    }
                }
            }
            catch { return false; }
        }

        public void Stop()
        {
            _stopping = true;
            AndroidJavaObject proc;
            lock (_lock) { proc = _javaProc; _javaProc = null; }
            if (proc == null) return;
            bool attached = false;
            try
            {
                if (AndroidJNI.AttachCurrentThread() == 0) attached = true;
                proc.Call("destroy");
                proc.Dispose();
            }
            catch { }
            finally
            {
                IsAlive = false;
                if (attached)
                {
                    try { AndroidJNI.DetachCurrentThread(); } catch { }
                }
            }
        }

        private void WriteRunScript(string path)
        {
            var sb = new StringBuilder();
            sb.Append("export LUA_REMOTE_PORT=").Append(LuaPort).Append('\n');
            sb.Append("export PS_LUA_REMOTE_INPROC=1\n");
            if (!string.IsNullOrEmpty(LibDir))
                sb.Append("export LD_LIBRARY_PATH='").Append(LibDir).Append("'\n");
            sb.Append("cd '").Append(ScriptDir).Append("' || exit 90\n");
            sb.Append("exec '").Append(BinPath).Append("' ").Append(ScriptName)
              .Append(" --port=").Append(HttpPort)
              .Append(" --game-port=").Append(GamePort);
            if (!string.IsNullOrEmpty(StdoutLog))
                sb.Append(" >> '").Append(StdoutLog).Append("' 2>&1");
            sb.Append('\n');
            // 严禁 UTF-8 BOM！否则 sh 首行报 "\uFEFFexport: not found"
            using (var w = new StreamWriter(path, false, new UTF8Encoding(false)))
                w.Write(sb.ToString());
            NodeSeeder.Chmod755(path, Diag);
        }

        private string ReadLogTail()
        {
            if (string.IsNullOrEmpty(StdoutLog) || !File.Exists(StdoutLog)) return "";
            try
            {
                var txt = File.ReadAllText(StdoutLog, Encoding.UTF8);
                if (txt.Length > 700) txt = txt.Substring(txt.Length - 700);
                return txt.Length == 0 ? "" : "\n--- psnode_stdout tail ---\n" + txt;
            }
            catch { return ""; }
        }
    }
}
