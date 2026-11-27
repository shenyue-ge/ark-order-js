// 极简 ZIP 读取器（STORE 专用，64 位 arm64 LP64 ABI）：
// 覆盖读主 APK 自身的 assets/psbin/** + assets/psnode/**（STORE）以及读数据包 APK（~3.8 GB）的 assets/res/**（STORE）。
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

namespace PsLocalServer.Shims
{
    public class PsZipReader : IDisposable
    {
        private interface IRandomIo : IDisposable
        {
            long Length { get; }
            void ReadAt(long offset, byte[] buf, int count);
        }

        private sealed class LibcIo : IRandomIo
        {
            private int _fd = -1;
            public LibcIo(string path)
            {
                _fd = Native.open(path, 0 /* O_RDONLY */);
                if (_fd < 0) throw new IOException("open failed (errno=" + Marshal.GetLastWin32Error() + "): " + path);
                long len = GetLength(path);
                if (len < 0) { Native.close(_fd); _fd = -1; throw new IOException("cannot determine file length: " + path); }
                Length = len;
            }

            private long GetLength(string path)
            {
                try
                {
                    long len = Native.lseek64(_fd, 0, 2 /* SEEK_END */);
                    if (len >= 0) return len;
                    PsLog.Sink("zip: lseek64(END) failed (errno=" + Marshal.GetLastWin32Error() + "), probing via pread64: " + path);
                }
                catch (EntryPointNotFoundException)
                {
                    PsLog.Sink("zip: lseek64 missing, probing via pread64: " + path);
                }
                long size;
                if (!ProbeLength(out size)) return -1;
                PsLog.Sink("zip: length via pread64 probe = " + size + "B: " + path);
                return size;
            }

            private bool ProbeLength(out long size)
            {
                size = 0;
                var one = new byte[1];
                if (Native.pread64(_fd, one, 1UL, 0L) <= 0) return true;
                long lo = 0, hi = 1L << 36;
                while (lo + 1 < hi)
                {
                    long mid = lo + ((hi - lo) >> 1);
                    if (Native.pread64(_fd, one, 1UL, mid) > 0) lo = mid; else hi = mid;
                }
                size = lo + 1;
                return true;
            }

            public long Length { get; private set; }

            public void ReadAt(long offset, byte[] buf, int count)
            {
                int got = 0;
                while (got < count)
                {
                    long n;
                    if (got == 0)
                    {
                        n = Native.pread64(_fd, buf, (ulong)count, offset);
                    }
                    else
                    {
                        var tmp = new byte[count - got];
                        n = Native.pread64(_fd, tmp, (ulong)tmp.Length, offset + got);
                        if (n > 0) Buffer.BlockCopy(tmp, 0, buf, got, (int)n);
                    }
                    if (n <= 0) throw new EndOfStreamException("pread64 short read @" + (offset + got));
                    got += (int)n;
                }
            }

            public void Dispose() { if (_fd >= 0) { Native.close(_fd); _fd = -1; } }
        }

        private sealed class StreamIo : IRandomIo
        {
            private readonly FileStream _fs;
            public StreamIo(string path)
            {
                _fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 256 * 1024);
                Length = _fs.Length;
            }
            public long Length { get; private set; }
            public void ReadAt(long offset, byte[] buf, int count)
            {
                _fs.Position = offset;
                int got = 0;
                while (got < count)
                {
                    int n = _fs.Read(buf, got, count - got);
                    if (n <= 0) throw new EndOfStreamException("short read @" + offset);
                    got += n;
                }
            }
            public void Dispose() { _fs.Dispose(); }
        }

        private static class Native
        {
            [DllImport("libc", EntryPoint = "open", SetLastError = true)]
            public static extern int open(string pathname, int flags);
            [DllImport("libc", EntryPoint = "close", SetLastError = true)]
            public static extern int close(int fd);
            // AArch64 LP64 ABI: size_t=ulong(64), ssize_t=long(64), off64_t=long(64)
            [DllImport("libc", EntryPoint = "pread64", SetLastError = true)]
            public static extern long pread64(int fd, byte[] buf, ulong count, long offset);
            [DllImport("libc", EntryPoint = "lseek64", SetLastError = true)]
            public static extern long lseek64(int fd, long offset, int whence);
        }

        private static IRandomIo CreateIo(string path)
        {
            try
            {
                var io = new LibcIo(path);
                PsLog.Sink("zip: libc pread64 (" + io.Length + "B) " + path);
                return io;
            }
            catch (DllNotFoundException)
            {
                return new StreamIo(path);
            }
            catch (EntryPointNotFoundException)
            {
                return new StreamIo(path);
            }
        }

        private readonly IRandomIo _io;
        private readonly Dictionary<string, PsZipEntry> _entries = new Dictionary<string, PsZipEntry>(StringComparer.Ordinal);

        public class PsZipEntry
        {
            public string Name;
            public long LocalHeaderOffset;
            public uint Size;
            public uint Crc;
            public bool Stored;
        }

        public PsZipReader(string apkPath)
        {
            _io = CreateIo(apkPath);

            long scanLen = Math.Min(_io.Length, 64 * 1024);
            var tail = new byte[scanLen];
            _io.ReadAt(_io.Length - scanLen, tail, (int)scanLen);
            int eocd = -1;
            for (int i = tail.Length - 22; i >= 0; i--)
            {
                if (tail[i] == 0x50 && tail[i + 1] == 0x4b && tail[i + 2] == 0x05 && tail[i + 3] == 0x06)
                {
                    eocd = i;
                    break;
                }
            }
            if (eocd < 0) throw new IOException("EOCD not found: " + apkPath);

            ushort count = (ushort)(tail[eocd + 10] | (tail[eocd + 11] << 8));
            long cdOff = (uint)(tail[eocd + 16] | (tail[eocd + 17] << 8) | (tail[eocd + 18] << 16) | (tail[eocd + 19] << 24));

            var hdr = new byte[46];
            long cur = cdOff;
            for (int i = 0; i < count; i++)
            {
                _io.ReadAt(cur, hdr, 46);
                if (hdr[0] != 0x50 || hdr[1] != 0x4b || hdr[2] != 0x01 || hdr[3] != 0x02)
                    throw new IOException("bad CDH at " + i);
                ushort method = (ushort)(hdr[10] | (hdr[11] << 8));
                uint crc = (uint)(hdr[16] | (hdr[17] << 8) | (hdr[18] << 16) | (hdr[19] << 24));
                uint size = (uint)(hdr[24] | (hdr[25] << 8) | (hdr[26] << 16) | (hdr[27] << 24));
                ushort nl = (ushort)(hdr[28] | (hdr[29] << 8));
                ushort el = (ushort)(hdr[30] | (hdr[31] << 8));
                ushort cl = (ushort)(hdr[32] | (hdr[33] << 8));
                long lfh = (uint)(hdr[42] | (hdr[43] << 8) | (hdr[44] << 16) | (hdr[45] << 24));
                cur += 46;

                var nameBuf = new byte[nl];
                if (nl > 0) _io.ReadAt(cur, nameBuf, nl);
                cur += nl + el + cl;

                var name = System.Text.Encoding.UTF8.GetString(nameBuf, 0, nl);
                if (!_entries.ContainsKey(name))
                    _entries[name] = new PsZipEntry { Name = name, LocalHeaderOffset = lfh, Size = size, Crc = crc, Stored = method == 0 };
            }
        }

        public List<string> NamesByPrefix(string prefix)
        {
            var r = new List<string>();
            foreach (var kv in _entries)
                if (kv.Key.StartsWith(prefix, StringComparison.Ordinal)) r.Add(kv.Key);
            return r;
        }

        public bool Has(string name) { return _entries.ContainsKey(name); }

        public uint EntrySize(string name)
        {
            PsZipEntry e;
            return _entries.TryGetValue(name, out e) ? e.Size : 0;
        }

        public long ReadTo(string name, Stream dst)
        {
            var e = _entries[name];
            if (!e.Stored) throw new NotSupportedException("deflate entry not supported: " + name);
            var lfh = new byte[30];
            _io.ReadAt(e.LocalHeaderOffset, lfh, 30);
            if (lfh[0] != 0x50 || lfh[1] != 0x4b || lfh[2] != 0x03 || lfh[3] != 0x04)
                throw new IOException("bad LFH: " + name);
            ushort nl = (ushort)(lfh[26] | (lfh[27] << 8));
            ushort el = (ushort)(lfh[28] | (lfh[29] << 8));
            long dataOff = e.LocalHeaderOffset + 30 + nl + el;

            var buf = new byte[256 * 1024];
            long left = e.Size, total = 0;
            while (left > 0)
            {
                int want = (int)Math.Min(buf.Length, left);
                _io.ReadAt(dataOff + total, buf, want);
                dst.Write(buf, 0, want);
                total += want;
                left -= want;
            }
            return total;
        }

        public byte[] ReadAllBytes(string name)
        {
            using (var ms = new MemoryStream())
            {
                ReadTo(name, ms);
                return ms.ToArray();
            }
        }

        public void Dispose() { _io.Dispose(); }
    }
}
