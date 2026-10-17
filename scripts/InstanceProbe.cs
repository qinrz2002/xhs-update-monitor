using System;
using System.Management;
using System.Text;
class InstanceProbe {
  static int Main(string[] args) {
    try {
      int ownPid = args.Length > 0 ? int.Parse(args[0]) : -1;
      Console.OutputEncoding = new UTF8Encoding(false);
      using (var searcher = new ManagementObjectSearcher("SELECT ProcessId, ExecutablePath, CommandLine, CreationDate FROM Win32_Process WHERE Name='小红书更新监控.exe'"))
      using (var processes = searcher.Get()) {
        foreach (ManagementObject process in processes) {
          int pid = Convert.ToInt32(process["ProcessId"]);
          string executable = process["ExecutablePath"] as string;
          string command = process["CommandLine"] as string;
          if (pid == ownPid || String.IsNullOrEmpty(executable) || command == null || command.Contains("--type=")) continue;
          long started = (long)(ManagementDateTimeConverter.ToDateTime((string)process["CreationDate"]).ToUniversalTime() - new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds;
          Console.WriteLine(pid + "\t" + started + "\t" + Convert.ToBase64String(Encoding.UTF8.GetBytes(executable)));
        }
      }
      return 0;
    } catch { Console.Error.WriteLine("Application process lookup unavailable."); return 1; }
  }
}
