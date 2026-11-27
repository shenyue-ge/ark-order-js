// Bootstrap（纯 64 位 Node 版，源码级直连 Launcher.Awake & Main.OnSysCfgComplete，零 dnlib / 零反射）。
using System;
using System.Collections.Generic;
using System.Threading;
using UnityEngine;
using PsLocalServer.Shims;

namespace PsLocalServer
{
    public static class Bootstrap
    {
        public static string PackageName = "com.bilibili.fzzl.guopan";
        public static string ApkPath;

        private static bool _started;
        private static volatile bool _ready;
        private static volatile bool _uiGone;
        private static BootPipeline _pipe;
        private static BootUi _ui;
        private static Action _gatedResume;

        private static readonly Queue<Action> _mainQueue = new Queue<Action>();
        private static readonly object _qLock = new object();

        public static void Init()
        {
            if (_started) return;
            _started = true;
            try
            {
                ApkPath = Application.dataPath;
                PackageName = ResolvePackageName();
                string dataDir = ResolveDataDir();
                string persist = Application.persistentDataPath;

                // 必须在主线程、闸门前预查数据包 APK 源
                DataPackage.CacheDataApkSource();

                // 挂载主线程派发驱动
                var drvGo = new GameObject("PsBootstrapDriver");
                UnityEngine.Object.DontDestroyOnLoad(drvGo);
                drvGo.AddComponent<MainQueueDriver>();

                // 首启进度条 UI
                _ui = new BootUi();
                _ui.OnGone = OnUiGone;
                _ui.Build();

                var env = new DeviceEnvironment(persist, dataDir);
                _pipe = new BootPipeline(env,
                    delegate(string stage, double pct)
                    {
                        PostMain(delegate
                        {
                            if (_ui != null) _ui.Set(stage, pct);
                        });
                    },
                    delegate(string status) { },
                    delegate
                    {
                        _ready = true;
                    },
                    delegate(string err)
                    {
                        Debug.LogError("[PsLocal64] BootPipeline error: " + err);
                    });
                _pipe.Start();
            }
            catch (Exception e)
            {
                Debug.LogError("[PsLocal64] Bootstrap.Init failed: " + e);
                _ready = true;
                _uiGone = true;
            }
        }

        /// <summary>
        /// Main.OnSysCfgComplete 首行闸门：进度条未淡出前返回 false 并挂起回调；
        /// 服务端就绪 + 进度条淡出完成后在主线程回调 resume，二次进入返回 true 放行 logo。
        /// </summary>
        public static bool SplashGate(Action resume)
        {
            if (_uiGone) return true;
            _gatedResume = resume;
            return false;
        }

        private static void OnUiGone()
        {
            _uiGone = true;
            var cb = _gatedResume;
            _gatedResume = null;
            if (cb != null)
            {
                try { cb(); }
                catch (Exception e) { Debug.LogError("[PsLocal64] SplashGate resume failed: " + e); }
            }
        }

        private static void PostMain(Action a)
        {
            if (a == null) return;
            lock (_qLock) _mainQueue.Enqueue(a);
        }

        private static string ResolvePackageName()
        {
            try
            {
                using (var up = new AndroidJavaClass("com.unity3d.player.UnityPlayer"))
                using (var act = up.GetStatic<AndroidJavaObject>("currentActivity"))
                {
                    var pkg = act.Call<string>("getPackageName");
                    if (!string.IsNullOrEmpty(pkg)) return pkg;
                }
            }
            catch { }
            return "com.bilibili.fzzl.guopan";
        }

        private static string ResolveDataDir()
        {
            try
            {
                using (var up = new AndroidJavaClass("com.unity3d.player.UnityPlayer"))
                using (var act = up.GetStatic<AndroidJavaObject>("currentActivity"))
                using (var fd = act.Call<AndroidJavaObject>("getFilesDir"))
                {
                    var p = fd.Call<string>("getAbsolutePath");
                    if (!string.IsNullOrEmpty(p)) return p;
                }
            }
            catch { }
            return "/data/user/0/" + PackageName + "/files";
        }

        private class MainQueueDriver : MonoBehaviour
        {
            private void Update()
            {
                while (true)
                {
                    Action a = null;
                    lock (_qLock)
                    {
                        if (_mainQueue.Count > 0) a = _mainQueue.Dequeue();
                    }
                    if (a == null) break;
                    try { a(); }
                    catch (Exception e) { Debug.LogError("[PsLocal64] MainQueue exc: " + e); }
                }
            }

            private void OnApplicationQuit()
            {
                try { if (_pipe != null) _pipe.Stop(); } catch { }
            }
        }
    }
}
