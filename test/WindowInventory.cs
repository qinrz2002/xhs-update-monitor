using System;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Text;
class WindowInventory {
 delegate bool Callback(IntPtr h,IntPtr l);
 [DllImport("user32.dll")]static extern bool EnumWindows(Callback cb,IntPtr data);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr h,StringBuilder b,int n);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")]static extern bool PostMessage(IntPtr h,uint message,IntPtr w,IntPtr l);
 static string Describe(IntPtr h){uint pid;GetWindowThreadProcessId(h,out pid);var name=new StringBuilder(128);GetClassName(h,name,128);return "{\"pid\":"+pid+",\"handle\":\""+h.ToInt64()+"\",\"className\":\""+name.ToString()+"\",\"exists\":"+(IsWindow(h)?"true":"false")+",\"visible\":"+(IsWindowVisible(h)?"true":"false")+",\"minimized\":"+(IsIconic(h)?"true":"false")+"}";}
 static void Main(string[] args){if(args.Length==3&&args[0]=="--close-owned"){var h=new IntPtr(Int64.Parse(args[1]));uint pid;GetWindowThreadProcessId(h,out pid);if(pid!=UInt32.Parse(args[2])||!IsWindow(h))throw new Exception("Target is not the owned test window");if(!PostMessage(h,0x0010,IntPtr.Zero,IntPtr.Zero))throw new Exception("Close message rejected");Console.WriteLine("true");return;}if(args.Length==2&&args[0]=="--handle"){Console.WriteLine(Describe(new IntPtr(Int64.Parse(args[1]))));return;}var wanted=new HashSet<uint>();foreach(string a in args)wanted.Add(UInt32.Parse(a));var rows=new List<string>();EnumWindows((h,l)=>{uint pid;GetWindowThreadProcessId(h,out pid);if(!wanted.Contains(pid))return true;var name=new StringBuilder(128);GetClassName(h,name,128);if(name.ToString().StartsWith("Chrome_WidgetWin_"))rows.Add(Describe(h));return true;},IntPtr.Zero);Console.WriteLine("["+String.Join(",",rows.ToArray())+"]");}
}
