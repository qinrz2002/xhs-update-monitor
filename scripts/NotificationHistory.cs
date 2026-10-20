using System;
using Windows.UI.Notifications;
internal static class NotificationHistory {
  private static int Main(string[] args) {
    try {
      if (args.Length == 3 && args[0] == "--verify-host") {
        return args[2].Length == 7 && args[2].StartsWith("测试",StringComparison.Ordinal) && System.Diagnostics.FileVersionInfo.GetVersionInfo(args[1]).ProductName == args[2] ? 0 : 2;
      }
      if (args.Length != 1 || (args[0] != "Local.XhsUpdateMonitor" && !args[0].StartsWith("Local.XhsUpdateMonitor.Test.", StringComparison.Ordinal))) return 2;
      ToastNotificationManager.History.Clear(args[0]);
      Console.WriteLine("{\"cleared\":true}");return 0;
    } catch { Console.WriteLine("{\"cleared\":false}");return 1; }
  }
}
