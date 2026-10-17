using System;using System.IO;using System.Runtime.InteropServices;using System.Windows;using System.Windows.Controls;using System.Windows.Media;using System.Windows.Threading;
internal static class Harness {
 [StructLayout(LayoutKind.Sequential)]struct R{internal int Left,Top,Right,Bottom;}
 [StructLayout(LayoutKind.Sequential)]struct M{internal int Size;internal R Monitor,Work;internal uint Flags;}
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr h,out R r);
 [DllImport("user32.dll")]static extern IntPtr MonitorFromWindow(IntPtr h,uint f);
 [DllImport("user32.dll",CharSet=CharSet.Auto)]static extern bool GetMonitorInfo(IntPtr h,ref M m);
 static void Check(bool b,string message){if(!b)throw new Exception(message);}
 [STAThread]static int Main(string[] args){try{
   string root=args[0];Environment.SetEnvironmentVariable("TEMP",root);Environment.SetEnvironmentVariable("TMP",root);string bridge=Path.Combine(root,"bridge.txt"),plugins=Path.Combine(root,"plugins");Directory.CreateDirectory(Path.Combine(plugins,"7z-out"));
   var p=new InstallProgress();Check(p.Read(bridge)==20,"missing bridge");File.WriteAllText(bridge,plugins+"\nextract\n");Check(p.Read(bridge)==20,"empty extraction");
   File.WriteAllBytes(Path.Combine(plugins,"7z-out","a.bin"),new byte[30]);Check(p.Read(bridge)==41,"completed file bytes");
   using(var locked=new FileStream(Path.Combine(plugins,"7z-out","b.bin"),FileMode.Create,FileAccess.Write,FileShare.Read)){locked.SetLength(70);Check(p.Read(bridge)==41,"incomplete locked file excluded");}
   Check(p.Read(bridge)==90,"all extracted files");File.WriteAllText(bridge,plugins+"\nfiles\n");Check(p.Read(bridge)==95,"copy completed stage");File.WriteAllText(bridge,plugins+"\nfinalize\n");Check(p.Read(bridge)==98,"finalize never claims 100");
   InstallerProgram.SetProcessDPIAware();var app=new Application();var setup=new SetupWindow(true);var window=setup.Window;Exception failure=null;
   int phase=0;double firstPosition=0;var timer=new DispatcherTimer();timer.Interval=TimeSpan.FromMilliseconds(350);timer.Tick+=(s,e)=>{if(phase++==0){firstPosition=Canvas.GetLeft((FrameworkElement)window.FindName("ShimmerBand"));return;}timer.Stop();try{
     var hwnd=new System.Windows.Interop.WindowInteropHelper(window).Handle;R rect;GetWindowRect(hwnd,out rect);var m=new M();m.Size=Marshal.SizeOf(typeof(M));GetMonitorInfo(MonitorFromWindow(hwnd,2),ref m);
     Check(Math.Abs((rect.Left+rect.Right)-(m.Work.Left+m.Work.Right))<=2,"horizontal screen center");Check(Math.Abs((rect.Top+rect.Bottom)-(m.Work.Top+m.Work.Bottom))<=2,"vertical screen center");
     for(int i=1;i<=3;i++){var box=(Border)window.FindName("Pill"+i);var text=(TextBlock)box.Child;Point origin=text.TranslatePoint(new Point(),box);Check(Math.Abs(origin.X+text.ActualWidth/2-box.ActualWidth/2)<1,"pill horizontal center");Check(Math.Abs(origin.Y+text.ActualHeight/2-box.ActualHeight/2)<1,"pill vertical center");}
     foreach(string name in new[]{"Minimize","Close"}){var b=(Button)window.FindName(name);Check(((SolidColorBrush)b.Background).Color.A==0,"window button transparent");}
     Check(window.AllowsTransparency,"alpha-composited rounded corners");
     Check(Math.Abs(Canvas.GetLeft((FrameworkElement)window.FindName("ShimmerBand"))-firstPosition)>1,"skeleton shimmer actually moves");
     var pending=setup.ConfirmShutdown();window.UpdateLayout();Check(!pending.IsCompleted,"confirmation waits for explicit choice");Check(Object.ReferenceEquals(pending,setup.ConfirmShutdown()),"no duplicate confirmation");
     var overlay=(Grid)window.FindName("ShutdownOverlay");var card=(Border)window.FindName("ShutdownCard");Point cardAt=card.TranslatePoint(new Point(),overlay);
     Check(Math.Abs(cardAt.X+card.ActualWidth/2-overlay.ActualWidth/2)<1,"confirmation horizontally centered");Check(Math.Abs(cardAt.Y+card.ActualHeight/2-overlay.ActualHeight/2)<1,"confirmation vertically centered");
     ((Button)window.FindName("ShutdownCancel")).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));Check(pending.IsCompleted&&!pending.Result,"cancel retains background");Check(overlay.Visibility==Visibility.Collapsed,"cancel hides overlay");
     pending=setup.ConfirmShutdown();((Button)window.FindName("ShutdownConfirm")).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));Check(pending.IsCompleted&&pending.Result,"explicit confirmation continues installation");
     pending=setup.ConfirmShutdown();var key=new System.Windows.Input.KeyEventArgs(System.Windows.Input.Keyboard.PrimaryDevice,PresentationSource.FromVisual(window),0,System.Windows.Input.Key.Escape);key.RoutedEvent=System.Windows.Input.Keyboard.PreviewKeyDownEvent;window.RaiseEvent(key);Check(pending.IsCompleted&&!pending.Result,"Escape cancels safely");
   }catch(Exception ex){failure=ex;}window.Close();};window.Loaded+=(s,e)=>timer.Start();app.Run(window);if(failure!=null)throw failure;
   File.WriteAllText(Path.Combine(root,"passed.txt"),"true");return 0;
 }catch(Exception ex){File.WriteAllText(Path.Combine(args[0],"error.txt"),ex.ToString());return 1;}}
}
