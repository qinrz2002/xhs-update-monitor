using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Management;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Collections.Generic;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Forms = System.Windows.Forms;

internal static class InstallerProgram {
  [DllImport("user32.dll")] internal static extern bool SetProcessDPIAware();
  [STAThread] static int Main(string[] args) {
    try {
      if(args.Length==1&&args[0]=="--verify-package"){string directory;Extract(out directory);TryDelete(directory);Console.WriteLine("{\"passed\":true,\"embeddedPackageHashVerified\":true,\"installerExecuted\":false}");return 0;}
      if(args.Contains("--updated")){
        SetProcessDPIAware();var updateApp=new Application();var update=new UpdateWindow(args);updateApp.Run(update.Window);return update.ExitCode;
      }
      if(args.Length==2&&args[0].StartsWith("--render-update-preview")){
        SetProcessDPIAware();var previewApp=new Application();var update=new UpdateWindow(new string[0]);update.Render(args[0],args[1]);return 0;
      }
      if(args.Contains("/S")){
        string directory,file=Extract(out directory);
        try{var forwarded=args.Where(a=>!a.StartsWith("/D=",StringComparison.OrdinalIgnoreCase)).Select(Quote).ToList();if(!args.Contains("/S"))forwarded.Add("/S");var destination=args.FirstOrDefault(a=>a.StartsWith("/D=",StringComparison.OrdinalIgnoreCase));if(destination!=null)forwarded.Add(destination);using(var p=Process.Start(new ProcessStartInfo(file,String.Join(" ",forwarded.ToArray())){UseShellExecute=false})){p.WaitForExit();return p.ExitCode;}}
        finally{TryDelete(directory);}
      }
      SetProcessDPIAware();var app=new Application();var setup=new SetupWindow(args.Contains("--preview")||args.Any(a=>a.StartsWith("--render-preview")));
      if(args.Length==2&&args[0].StartsWith("--render-preview")){setup.Render(args[0],args[1]);return 0;}
      app.Run(setup.Window);return 0;
    }catch(Exception ex){MessageBox.Show("安装程序无法启动，请重新下载安装包。\n"+ex.Message,"小红书更新监控",MessageBoxButton.OK,MessageBoxImage.Error);return 1;}
  }
  internal static string Quote(string value){return "\""+value.Replace("\"","\\\"")+"\"";}
  internal static string Extract(out string directory){return Extract(out directory,null);}
  internal static string Extract(out string directory,Action<int> progress){
    directory=Path.Combine(Path.GetTempPath(),"XhsMonitorSetup-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(directory);string file=Path.Combine(directory,"XhsMonitor-Install.exe");
    try{
      using(var input=Assembly.GetExecutingAssembly().GetManifestResourceStream("InstallerPayload"))using(var output=new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.None)){
        if(input==null)throw new IOException("安装文件缺失");byte[] buffer=new byte[1024*1024];long total=input.Length,read=0;int n;
        while((n=input.Read(buffer,0,buffer.Length))>0){output.Write(buffer,0,n);read+=n;if(progress!=null)progress((int)(read*15/total));}
      }
      using(var sha=SHA256.Create())using(var stream=File.OpenRead(file)){var actual=BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();if(actual!=EmbeddedPackage.Sha256)throw new IOException("安装文件校验失败");}
      if(progress!=null)progress(20);return file;
    }catch{TryDelete(directory);throw;}
  }
  internal static void TryDelete(string directory){try{if(Path.GetFileName(directory).StartsWith("XhsMonitorSetup-")&&Path.GetFullPath(Path.GetDirectoryName(directory)).TrimEnd('\\')==Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\'))Directory.Delete(directory,true);}catch{}}
}

// Count completed, closed files in this installer's unique extraction directory.
// Time, old installation files and the user's data directory never contribute.
internal sealed class InstallProgress {
  private readonly Dictionary<string,long> files=new Dictionary<string,long>(StringComparer.OrdinalIgnoreCase);
  private readonly HashSet<string> complete=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  private long total,finished;
  internal InstallProgress(){using(var s=Assembly.GetExecutingAssembly().GetManifestResourceStream("InstalledFileSizes"))if(s!=null)using(var r=new StreamReader(s)){string line;while((line=r.ReadLine())!=null){int tab=line.IndexOf('\t');long size;if(tab>0&&Int64.TryParse(line.Substring(0,tab),out size)){files[line.Substring(tab+1)]=size;total+=size;}}}}
  internal int Read(string bridge){
    if(!File.Exists(bridge))return 20;string[] lines;try{lines=File.ReadAllLines(bridge);}catch(IOException){return 20;}if(lines.Length<2)return 20;
    string root=lines[0];if(!Path.IsPathRooted(root)||!Path.GetFullPath(root).StartsWith(Path.GetFullPath(Path.GetTempPath()),StringComparison.OrdinalIgnoreCase))return 20;
    if(lines[1]=="finalize")return 98;if(lines[1]=="files")return 95;
    foreach(var pair in files){if(complete.Contains(pair.Key))continue;string file=Path.Combine(root,"7z-out",pair.Key);try{using(var s=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.None)){if(s.Length!=pair.Value)continue;}complete.Add(pair.Key);finished+=pair.Value;}catch(IOException){}catch(UnauthorizedAccessException){}}
    return total>0?20+(int)(finished*70/total):20;
  }
}

// This small independent window remains alive while Electron exits and NSIS works.
// Only completed file bytes/backend stages advance the bar; the spinner shows activity.
internal sealed class UpdateWindow {
  internal readonly Window Window;
  internal int ExitCode=1;
  private readonly string[] args;
  private readonly TextBlock title,status,percent,hint;
  private readonly Border fill;
  private readonly Button close;
  private readonly System.Windows.Media.Animation.DoubleAnimation rotation;
  private readonly RotateTransform spinner;
  private bool working,started;
  private int progress;
  internal UpdateWindow(string[] arguments){
    args=arguments;
    using(var s=Assembly.GetExecutingAssembly().GetManifestResourceStream("UpdateLayout"))Window=(Window)XamlReader.Load(s);
    title=(TextBlock)Window.FindName("UpdateTitle");status=(TextBlock)Window.FindName("UpdateStatus");percent=(TextBlock)Window.FindName("UpdatePercent");hint=(TextBlock)Window.FindName("UpdateHint");fill=(Border)Window.FindName("UpdateFill");close=(Button)Window.FindName("UpdateClose");
    ((TextBlock)Window.FindName("UpdateVersion")).Text="小红书更新监控  /  v"+EmbeddedPackage.Version;
    spinner=(RotateTransform)((System.Windows.Shapes.Path)Window.FindName("UpdateSpinner")).RenderTransform;
    rotation=new System.Windows.Media.Animation.DoubleAnimation(0,360,TimeSpan.FromSeconds(1.2)){RepeatBehavior=System.Windows.Media.Animation.RepeatBehavior.Forever};
    close.Click+=(s,e)=>Window.Close();Window.Closing+=(s,e)=>{if(working)e.Cancel=true;};
    Window.ContentRendered+=async(s,e)=>{if(started)return;started=true;await Run();};
  }
  internal void Update(int value,string text){progress=Math.Max(progress,Math.Min(100,value));status.Text=text;percent.Text=progress+"%";fill.Width=458*progress/100.0;}
  internal void Animate(){if(SystemParameters.ClientAreaAnimation)spinner.BeginAnimation(RotateTransform.AngleProperty,rotation);}
  internal void Failed(string message){spinner.BeginAnimation(RotateTransform.AngleProperty,null);title.Text="更新未完成";status.Text=message;hint.Text="请关闭此窗口，稍后重试安装。";close.Visibility=Visibility.Visible;working=false;}
  private async Task Run(){
    working=true;Animate();string temp=null;
    try{
      // Extraction and checksum verification run off the UI thread so animation stays responsive.
      string localTemp=null;string payload=await Task.Run(()=>InstallerProgram.Extract(out localTemp,p=>Window.Dispatcher.BeginInvoke(new Action(()=>Update(p,p<15?"正在读取安装文件…":"正在校验安装文件…")))));temp=localTemp;
      string bridge=Path.Combine(temp,"progress.txt");var reporter=new InstallProgress();
      var forwarded=args.Where(a=>!a.StartsWith("/D=",StringComparison.OrdinalIgnoreCase)).Select(InstallerProgram.Quote).ToList();if(!args.Contains("/S"))forwarded.Add("/S");
      var destination=args.FirstOrDefault(a=>a.StartsWith("/D=",StringComparison.OrdinalIgnoreCase));if(destination!=null)forwarded.Add(destination);
      var info=new ProcessStartInfo(payload,String.Join(" ",forwarded.ToArray())){UseShellExecute=false,CreateNoWindow=true};info.EnvironmentVariables["XHS_SETUP_PROGRESS_FILE"]=bridge;
      using(var process=Process.Start(info)){
        while(!process.HasExited){int value=await Task.Run(()=>reporter.Read(bridge));Update(value,value>=95?"正在完成安装并准备启动新版…":"正在解包并安装程序文件…");await Task.Delay(160);}
        if(process.ExitCode!=0)throw new IOException("安装未完成（代码 "+process.ExitCode+"）。");
      }
      Update(100,"更新完成，正在打开新版…");ExitCode=0;await Window.Dispatcher.InvokeAsync(()=>{},DispatcherPriority.Render);await Task.Delay(600);spinner.BeginAnimation(RotateTransform.AngleProperty,null);working=false;Window.Close();
    }catch(Exception ex){Failed(ex.Message);}
    finally{if(temp!=null)InstallerProgram.TryDelete(temp);}
  }
  internal void Render(string mode,string file){
    started=true;Window.ShowInTaskbar=false;Window.WindowStartupLocation=WindowStartupLocation.Manual;Window.Left=Window.Top=-10000;
    Update(62,"正在解包并安装程序文件…");if(mode.EndsWith("-error"))Failed("安装未完成（代码 2）。");
    Window.Show();Window.UpdateLayout();var target=(FrameworkElement)Window.Content;var bitmap=new RenderTargetBitmap((int)Math.Ceiling(target.ActualWidth*1.25),(int)Math.Ceiling(target.ActualHeight*1.25),120,120,PixelFormats.Pbgra32);bitmap.Render(target);var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));using(var output=File.Create(file))encoder.Save(output);Window.Close();
  }
}

internal sealed class SetupWindow {
  internal readonly Window Window;
  private readonly bool preview;
  private readonly Button install,change,close,minimize;
  private readonly TextBlock location,status,percent,headline,subtitle;
  private readonly Border track,fill;
  private bool working,done,rendering;
  private int progress;
  private string installPath;
  private TaskCompletionSource<bool> shutdownConfirmation;
  internal Task<bool> ConfirmShutdown(){
    if(shutdownConfirmation!=null)return shutdownConfirmation.Task;
    shutdownConfirmation=new TaskCompletionSource<bool>();Get<Grid>("ShutdownOverlay").Visibility=Visibility.Visible;
    Get<Button>("ShutdownCancel").Focus();return shutdownConfirmation.Task;
  }
  private void ResolveShutdown(bool accepted){
    if(shutdownConfirmation==null)return;var pending=shutdownConfirmation;shutdownConfirmation=null;
    Get<Grid>("ShutdownOverlay").Visibility=Visibility.Collapsed;pending.TrySetResult(accepted);
  }
  [StructLayout(LayoutKind.Sequential)] private struct Rect{internal int Left,Top,Right,Bottom;}
  [StructLayout(LayoutKind.Sequential)] private struct MonitorInfo{internal int Size;internal Rect Monitor,Work;internal uint Flags;}
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr window,uint flags);
  [DllImport("user32.dll",CharSet=CharSet.Auto)] private static extern bool GetMonitorInfo(IntPtr monitor,ref MonitorInfo info);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window,out Rect rect);
  [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int cx,int cy,uint flags);
  private readonly IntPtr monitor;
  private T Get<T>(string name)where T:class{return Window.FindName(name)as T;}
  internal SetupWindow(bool previewMode){
    preview=previewMode;monitor=MonitorFromWindow(GetForegroundWindow(),2);
    using(var s=Assembly.GetExecutingAssembly().GetManifestResourceStream("InstallerLayout"))Window=(Window)XamlReader.Load(s);
    install=Get<Button>("Install");change=Get<Button>("Change");close=Get<Button>("Close");minimize=Get<Button>("Minimize");
    location=Get<TextBlock>("Location");status=Get<TextBlock>("Status");percent=Get<TextBlock>("Percent");headline=Get<TextBlock>("Headline");subtitle=Get<TextBlock>("Subtitle");track=Get<Border>("ProgressTrack");fill=Get<Border>("ProgressFill");
    Get<TextBlock>("Version").Text="WINDOWS DESKTOP  /  "+EmbeddedPackage.Version;if(preview)Get<TextBlock>("Footer").Text="界面预览 · 不执行安装";
    installPath=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs","xhs-update-monitor");location.Text=installPath;
    close.Click+=(s,e)=>Window.Close();minimize.Click+=(s,e)=>Window.WindowState=WindowState.Minimized;
    Get<Button>("ShutdownCancel").Click+=(s,e)=>ResolveShutdown(false);Get<Button>("ShutdownConfirm").Click+=(s,e)=>ResolveShutdown(true);
    Window.PreviewKeyDown+=(s,e)=>{if(shutdownConfirmation!=null&&e.Key==System.Windows.Input.Key.Escape){e.Handled=true;ResolveShutdown(false);}};
    change.Click+=(s,e)=>{using(var dialog=new Forms.FolderBrowserDialog()){dialog.Description="选择安装文件夹，程序会放入 xhs-update-monitor 子文件夹。";dialog.SelectedPath=Path.GetDirectoryName(installPath);if(dialog.ShowDialog(new NativeOwner(new WindowInteropHelper(Window).Handle))==Forms.DialogResult.OK){var chosen=Path.GetFullPath(dialog.SelectedPath);installPath=String.Equals(Path.GetFileName(chosen),"xhs-update-monitor",StringComparison.OrdinalIgnoreCase)?chosen:Path.Combine(chosen,"xhs-update-monitor");location.Text=installPath;}}};
    install.Click+=async(s,e)=>{if(done){if(!preview){var exe=Path.Combine(installPath,"小红书更新监控.exe");if(File.Exists(exe))Process.Start(new ProcessStartInfo(exe){UseShellExecute=true});}Window.Close();return;}await Install();};
    Window.MouseLeftButtonDown+=(s,e)=>{if(shutdownConfirmation==null&&e.GetPosition(Window).Y<320){try{Window.DragMove();}catch(InvalidOperationException){}}};
    Window.Opacity=0;Window.Closing+=(s,e)=>{if(working)e.Cancel=true;};Window.ContentRendered+=(s,e)=>{if(!rendering){Center();Window.Opacity=1;}};
  }
  private sealed class NativeOwner:Forms.IWin32Window{private readonly IntPtr handle;internal NativeOwner(IntPtr h){handle=h;}public IntPtr Handle{get{return handle;}}}
  private void Center(){
    var info=new MonitorInfo();info.Size=Marshal.SizeOf(typeof(MonitorInfo));if(!GetMonitorInfo(monitor,ref info))return;
    IntPtr hwnd=new WindowInteropHelper(Window).Handle;Rect actual;if(!GetWindowRect(hwnd,out actual))return;
    int width=actual.Right-actual.Left,height=actual.Bottom-actual.Top,availableWidth=info.Work.Right-info.Work.Left-32,availableHeight=info.Work.Bottom-info.Work.Top-32;
    double ratio=Math.Min(1,Math.Min((double)availableWidth/width,(double)availableHeight/height));width=(int)(width*ratio);height=(int)(height*ratio);
    SetWindowPos(hwnd,IntPtr.Zero,info.Work.Left+(info.Work.Right-info.Work.Left-width)/2,info.Work.Top+(info.Work.Bottom-info.Work.Top-height)/2,width,height,0x14);
  }
  private void Update(int value,string text){progress=Math.Max(progress,Math.Min(100,value));status.Text=text;percent.Text=progress+"%";percent.Visibility=track.Visibility=fill.Visibility=Visibility.Visible;fill.Width=496*progress/100.0;}
  private void Complete(){done=true;Update(100,"安装完成，已为你准备就绪");headline.Text="准备好了，开始关注。";subtitle.Text="你的监控面板已安装完成。\n添加喜欢的博主，接住每一次更新。";install.Content="立即体验";status.Foreground=new SolidColorBrush(Color.FromRgb(94,211,149));}
  private async Task Install(){
    working=true;progress=0;install.IsEnabled=change.IsEnabled=close.IsEnabled=false;install.Content="正在安装";Update(0,"正在准备安装文件…");string temp=null;
    try{
      if(preview){for(int p=0;p<=95;p+=5){Update(p,"预览：正在安装程序…");await Task.Delay(70);}}else{
        bool ready=await MonitorShutdown.ConfirmAndCloseAsync(MonitorShutdown.HasRunning,
          ConfirmShutdown,
          async()=>{Update(0,"正在保存数据并退出后台监控…");await Task.Run(()=>MonitorShutdown.Close());});
        if(!ready){status.Text="已取消安装，后台监控继续运行。";install.Content="立即安装";return;}
        string localTemp=null;var payload=await Task.Run(()=>InstallerProgram.Extract(out localTemp,p=>Window.Dispatcher.BeginInvoke(new Action(()=>Update(p,p<15?"正在读取安装文件…":"正在校验安装文件…")))));temp=localTemp;
        string bridge=Path.Combine(temp,"progress.txt");var reporter=new InstallProgress();var info=new ProcessStartInfo(payload,"/S /D="+installPath){UseShellExecute=false,CreateNoWindow=true};info.EnvironmentVariables["XHS_SETUP_PROGRESS_FILE"]=bridge;
        using(var process=Process.Start(info)){
          while(!process.HasExited){int value=await Task.Run(()=>reporter.Read(bridge));Update(value,value>=95?"正在创建快捷方式并完成安装…":"正在解包并安装程序文件…");await Task.Delay(160);}
          if(process.ExitCode!=0)throw new IOException(process.ExitCode==2?"请先退出正在运行的监控面板，再重试安装。":"安装未完成（代码 "+process.ExitCode+"），原有 data 文件夹会保留。");
        }
        if(!File.Exists(Path.Combine(installPath,"小红书更新监控.exe")))throw new IOException("未找到安装后的程序，请选择其他安装位置重试。");
        Update(99,"正在核验安装结果…");await Task.Run(()=>VerifyInstalledFiles(installPath));
      }
      Complete();
    }catch(Exception ex){status.Text=ex.Message;install.Content="重新安装";}
    finally{if(temp!=null)InstallerProgram.TryDelete(temp);working=false;install.IsEnabled=close.IsEnabled=true;change.IsEnabled=!done;}
  }
  private static void VerifyInstalledFiles(string root){using(var s=Assembly.GetExecutingAssembly().GetManifestResourceStream("InstalledFileSizes"))if(s!=null)using(var r=new StreamReader(s)){string line;while((line=r.ReadLine())!=null){int tab=line.IndexOf('\t');if(tab<1)continue;long size=Int64.Parse(line.Substring(0,tab));string relative=line.Substring(tab+1),full=Path.GetFullPath(Path.Combine(root,relative));if(!full.StartsWith(Path.GetFullPath(root).TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase))throw new IOException("安装清单路径无效");var f=new FileInfo(full);if(!f.Exists||f.Length!=size)throw new IOException("安装文件不完整："+relative);}}}
  internal void Render(string mode,string file){
    rendering=true;Window.Opacity=1;Window.ShowInTaskbar=false;Window.Left=Window.Top=-10000;
    if(mode.EndsWith("-progress")){Update(62,"正在解包并安装程序文件…");install.Content="正在安装";install.IsEnabled=change.IsEnabled=close.IsEnabled=false;}
    if(mode.EndsWith("-complete")){Complete();change.IsEnabled=false;}
    if(mode.EndsWith("-confirm")){install.IsEnabled=change.IsEnabled=close.IsEnabled=false;ConfirmShutdown();}
    Window.Show();Window.UpdateLayout();
    if(mode.EndsWith("-animation")){Directory.CreateDirectory(file);for(int i=0;i<32;i++){var frame=new DispatcherFrame();var timer=new DispatcherTimer(DispatcherPriority.Background);timer.Interval=TimeSpan.FromMilliseconds(100);timer.Tick+=(s,e)=>{timer.Stop();frame.Continue=false;};timer.Start();Dispatcher.PushFrame(frame);SaveFrame(Path.Combine(file,i.ToString("D2")+".png"));}}
    else SaveFrame(file);Window.Close();
  }
  private void SaveFrame(string file){var target=(FrameworkElement)Window.Content;var bitmap=new RenderTargetBitmap((int)Math.Ceiling(target.ActualWidth*1.25),(int)Math.Ceiling(target.ActualHeight*1.25),120,120,PixelFormats.Pbgra32);bitmap.Render(target);var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));using(var output=File.Create(file))encoder.Save(output);}
}

// Restart Manager asks legacy builds to end their session; it never force-kills them.
internal static class MonitorShutdown {
  internal static async Task<bool> ConfirmAndClose(Func<bool> hasRunning,Func<bool> confirm,Func<Task> close){return await ConfirmAndCloseAsync(hasRunning,()=>Task.FromResult(confirm()),close);}
  internal static async Task<bool> ConfirmAndCloseAsync(Func<bool> hasRunning,Func<Task<bool>> confirm,Func<Task> close){if(!hasRunning())return true;if(!await confirm())return false;await close();return true;}
  [StructLayout(LayoutKind.Sequential)] internal struct UniqueProcess{internal int Pid;internal System.Runtime.InteropServices.ComTypes.FILETIME Started;}
  [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] private static extern int RmStartSession(out uint handle,int flags,string key);
  [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] private static extern int RmRegisterResources(uint handle,uint files,string[] names,uint applications,UniqueProcess[] processes,uint services,string[] serviceNames);
  [DllImport("rstrtmgr.dll")] private static extern int RmShutdown(uint handle,uint flags,IntPtr callback);
  [DllImport("rstrtmgr.dll")] private static extern int RmEndSession(uint handle);
  private static Process[] Running(){int session=Process.GetCurrentProcess().SessionId;return Process.GetProcessesByName("小红书更新监控").Where(p=>{try{if(p.SessionId==session)return true;}catch{}p.Dispose();return false;}).ToArray();}
  internal static bool HasRunning(){var found=Running();try{return found.Length>0;}finally{foreach(var p in found)p.Dispose();}}
  internal static void Close(){
    bool accepted=false;
    try{string scope=Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData).ToLowerInvariant(),hash;using(var sha=SHA256.Create())hash=BitConverter.ToString(sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes(scope))).Replace("-","").ToLowerInvariant().Substring(0,32);
      using(var pipe=new NamedPipeClientStream(".","XhsUpdateMonitor-"+hash,PipeDirection.InOut,PipeOptions.Asynchronous)){pipe.Connect(750);var bytes=System.Text.Encoding.UTF8.GetBytes("shutdown-for-update\n");pipe.Write(bytes,0,bytes.Length);pipe.Flush();var reader=new StreamReader(pipe);var reply=reader.ReadLineAsync();if(reply.Wait(1500))accepted=reply.Result=="shutting-down";}
    }catch(IOException){}catch(TimeoutException){}catch(AggregateException){}catch(UnauthorizedAccessException){}
    if(accepted){for(int i=0;i<150&&HasRunning();i++)System.Threading.Thread.Sleep(100);if(!HasRunning())return;throw new IOException("后台尚未完成退出，未覆盖程序文件。请稍后重试。");}
    var legacy=Running();try{ShutdownProcesses(legacy);}finally{foreach(var p in legacy)p.Dispose();}
    for(int i=0;i<100&&HasRunning();i++)System.Threading.Thread.Sleep(100);
    if(HasRunning())throw new IOException("后台未能安全退出，请从托盘退出后重试。原有数据已保留。");
  }
  internal static void ShutdownProcesses(Process[] processes){
    if(processes.Length==0)return;
    // Electron renderer/GPU helpers have no application window and must not be
    // registered as independent applications (Restart Manager returns 351).
    var candidates=new HashSet<int>(processes.Select(p=>p.Id));var mainIds=new HashSet<int>();
    using(var lookup=new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE "+String.Join(" OR ",candidates.Select(id=>"ProcessId="+id).ToArray())))
    using(var found=lookup.Get())foreach(ManagementObject item in found){string command=item["CommandLine"] as string;if(command==null)throw new IOException("无法确认后台主进程，请从托盘退出后重试。");if(!command.Contains("--type="))mainIds.Add(Convert.ToInt32(item["ProcessId"]));}
    var ids=processes.Where(p=>mainIds.Contains(p.Id)).Select(p=>{long time=p.StartTime.ToUniversalTime().ToFileTimeUtc();return new UniqueProcess{Pid=p.Id,Started=new System.Runtime.InteropServices.ComTypes.FILETIME{dwLowDateTime=unchecked((int)time),dwHighDateTime=(int)(time>>32)}};}).ToArray();
    if(ids.Length==0)return;
    uint handle;int result=RmStartSession(out handle,0,Guid.NewGuid().ToString("N"));if(result!=0)throw new IOException("无法创建后台退出会话（"+result+"）。");
    try{result=RmRegisterResources(handle,0,null,(uint)ids.Length,ids,0,null);if(result==0)result=RmShutdown(handle,0,IntPtr.Zero);if(result!=0)throw new IOException("后台暂时不能安全退出（"+result+"），请从托盘退出后重试。");}finally{RmEndSession(handle);}
  }
}
