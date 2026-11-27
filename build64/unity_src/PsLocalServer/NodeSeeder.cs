// NodeSeeder：把 APK 里的 assets/psbin/** 与 assets/psnode/** 播到内部存储 /data/user/0/<pkg>/files。
// 64 位 IL2CPP 改进：Chmod755 直接 P/Invoke libc chmod(path, 0755)，零子进程开销、兼容任意 Android 版本。
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace PsLocalServer
{
    public static class NodeSeeder
    {
        public const string BinPrefix = "assets/psbin/";
        public const string TreePrefix = "assets/psnode/";
        public const string MetaEntry = "assets/psnode/NODE_TREE.json";

        [DllImport("libc", EntryPoint = "chmod", SetLastError = true)]
        private static extern int libc_chmod(string pathname, uint mode);

        public static string Version(Shims.PsZipReader zip)
        {
            try
            {
                using (var ms = new MemoryStream())
                {
                    zip.ReadTo(MetaEntry, ms);
                    using (var md5 = MD5.Create())
                    {
                        var h = md5.ComputeHash(ms.ToArray());
                        var sb = new StringBuilder("node-");
                        for (int i = 0; i < 6; i++) sb.Append(h[i].ToString("x2"));
                        return sb.ToString();
                    }
                }
            }
            catch { return null; }
        }

        public static long Seed(string apkPath, string dataDir, Action<double> report, Action<string> diag,
                                bool preserveUserData)
        {
            using (var zip = new Shims.PsZipReader(apkPath))
            {
                var binNames = zip.NamesByPrefix(BinPrefix);
                var treeNames = zip.NamesByPrefix(TreePrefix);
                if (binNames.Count == 0 && treeNames.Count == 0)
                    throw new Exception("APK 缺少 assets/psbin 或 assets/psnode");

                long total = 0, done = 0;
                foreach (var n in binNames) total += zip.EntrySize(n);
                foreach (var n in treeNames) total += zip.EntrySize(n);
                if (diag != null) diag("seed-node: " + binNames.Count + " bin + " + treeNames.Count
                                       + " tree entries, " + total + " bytes"
                                       + (preserveUserData ? "（升级：保护玩家数据）" : ""));

                foreach (var n in binNames) done = Extract(zip, n, BinPrefix, "psbin", dataDir, done, total, report, false);
                foreach (var n in treeNames) done = Extract(zip, n, TreePrefix, "psnode_root", dataDir, done, total, report, preserveUserData);

                foreach (var f in new[] { "psnode", "libnode.so", "libc++_shared.so" })
                    Chmod755(Path.Combine(Path.Combine(dataDir, "psbin"), f), diag);
                return done;
            }
        }

        static long Extract(Shims.PsZipReader zip, string entry, string prefix, string dstSub,
                            string dataDir, long done, long total, Action<double> report,
                            bool preserveUserData)
        {
            var rel = entry.Substring(prefix.Length);
            var size = zip.EntrySize(entry);

            if (preserveUserData && dstSub == "psnode_root")
            {
                var relSlash = rel.Replace('\\', '/');
                bool isUserData = relSlash == "ps_server/accounts.json"
                                  || relSlash.StartsWith("ps_server/saves/", StringComparison.Ordinal);
                if (isUserData)
                {
                    if (size > 0) done += size;
                    if (report != null && total > 0) report((double)done / total);
                    return done;
                }
            }

            var target = Path.Combine(Path.Combine(dataDir, dstSub),
                                      rel.Replace('/', Path.DirectorySeparatorChar));
            if (size <= 0)
            {
                if (!Directory.Exists(target)) Directory.CreateDirectory(target);
                return done;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            using (var fs = new FileStream(target, FileMode.Create, FileAccess.Write))
            {
                zip.ReadTo(entry, fs);
                done += size;
                if (report != null && total > 0) report((double)done / total);
            }
            return done;
        }

        public static bool Chmod755(string path, Action<string> diag)
        {
            try
            {
                if (!File.Exists(path)) { if (diag != null) diag("chmod: missing " + path); return false; }
                int rc = libc_chmod(path, 0x1EDu /* 0755 octal */);
                if (rc != 0 && diag != null)
                    diag("chmod fail " + path + ": errno=" + Marshal.GetLastWin32Error());
                return rc == 0;
            }
            catch (Exception e)
            {
                if (diag != null) diag("chmod exc " + path + ": " + e.Message);
                return false;
            }
        }
    }
}
