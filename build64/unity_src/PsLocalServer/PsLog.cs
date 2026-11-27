using System;
using System.IO;
using System.Text;

namespace PsLocalServer
{
    public class PsLog : IDisposable
    {
        public static Action<string> Sink = delegate(string s) { };

        private readonly object _lock = new object();
        private readonly string _file;
        private readonly Action<string> _mirror;
        private StreamWriter _writer;

        public PsLog(string file, Action<string> mirror)
        {
            _file = file;
            _mirror = mirror;
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_file));
                var fs = new FileStream(_file, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
                _writer = new StreamWriter(fs, new UTF8Encoding(false)) { AutoFlush = true };
            }
            catch { }
        }

        public void W(string line)
        {
            var stamp = DateTime.UtcNow.AddHours(8).ToString("HH:mm:ss.fff");
            var full = stamp + " " + line;
            lock (_lock)
            {
                try
                {
                    if (_writer == null)
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(_file));
                        var fs = new FileStream(_file, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
                        _writer = new StreamWriter(fs, new UTF8Encoding(false)) { AutoFlush = true };
                    }
                    _writer.WriteLine(full);
                }
                catch { }
            }
            if (_mirror != null) { try { _mirror(full); } catch { } }
        }

        public void Dispose()
        {
            lock (_lock)
            {
                try { if (_writer != null) _writer.Dispose(); } catch { }
                _writer = null;
            }
        }
    }
}
