using System.IO;

namespace PsLocalServer.Shims
{
    public abstract class HostEnvironment
    {
        public abstract string RootDir { get; }
        public abstract string ResDir { get; }
        public virtual string PersistDir { get { return null; } }
        public virtual string DataDir { get { return RootDir; } }
    }

    public sealed class DeviceEnvironment : HostEnvironment
    {
        private readonly string _root;
        private readonly string _res;
        private readonly string _persist;
        private readonly string _data;

        public DeviceEnvironment(string persist, string dataDir)
        {
            _persist = persist;
            _root = Path.Combine(persist, "psroot");
            _res = Path.Combine(persist, "res");
            _data = string.IsNullOrEmpty(dataDir)
                ? Path.Combine(Path.Combine("/data/user/0", Bootstrap.PackageName), "files")
                : dataDir;
        }

        public override string RootDir { get { return _root; } }
        public override string ResDir { get { return _res; } }
        public override string PersistDir { get { return _persist; } }
        public override string DataDir { get { return _data; } }
    }
}
