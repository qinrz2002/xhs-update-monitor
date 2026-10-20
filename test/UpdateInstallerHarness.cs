using System;using System.IO;using System.Linq;using System.Windows;using System.Windows.Controls;using System.Windows.Media;using System.Windows.Media.Imaging;using System.Windows.Threading;
internal static class UpdateHarness {
 static void Check(bool value,string message){if(!value)throw new Exception(message);}
 static void Save(Window window,string file){var target=(FrameworkElement)window.Content;var bitmap=new RenderTargetBitmap((int)target.ActualWidth,(int)target.ActualHeight,96,96,PixelFormats.Pbgra32);bitmap.Render(target);var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));using(var output=File.Create(file))encoder.Save(output);}
 [STAThread]static int Main(string[] args){
  string root=args[0];bool fail=args.Length>1;try{
   Environment.SetEnvironmentVariable("XHS_UPDATE_FIXTURE_ROOT",root);
   InstallerProgram.SetProcessDPIAware();var app=new Application();var destination=Path.Combine(root,"Chosen location");
   var forwarded=new[]{"--updated","--force-run","/D="+destination}.ToList();if(fail)forwarded.Insert(0,"--fixture-failure");
   var setup=new UpdateWindow(forwarded.ToArray());var window=setup.Window;int ticks=0,last=0;bool intermediate=false,sawComplete=false,shot=false,blockedClose=false,animationMoved=false;double? initial=null;
   var timer=new DispatcherTimer();timer.Interval=TimeSpan.FromMilliseconds(100);timer.Tick+=(s,e)=>{try{
    if(++ticks>250)throw new Exception("update fixture timed out");
    int value=Int32.Parse(((TextBlock)window.FindName("UpdatePercent")).Text.TrimEnd('%'));Check(value>=last&&value<=100,"progress must be monotonic and bounded");last=value;File.AppendAllText(Path.Combine(root,"samples.txt"),value+" "+((TextBlock)window.FindName("UpdateStatus")).Text+"\n");
    var rotate=(RotateTransform)((System.Windows.Shapes.Path)window.FindName("UpdateSpinner")).RenderTransform;if(initial==null)initial=rotate.Angle;else if(Math.Abs(rotate.Angle-initial.Value)>2)animationMoved=true;
    if(value>20&&value<95){intermediate=true;if(!blockedClose){window.Close();Check(window.IsVisible,"window cannot close during installation");blockedClose=true;}if(!shot){Save(window,Path.Combine(root,"progress.png"));shot=true;}}
    if(value==100)sawComplete=true;
    if(fail&&((TextBlock)window.FindName("UpdateTitle")).Text=="更新未完成"){
     Check(((Button)window.FindName("UpdateClose")).Visibility==Visibility.Visible,"error must expose close action");Check(value<100,"failed installation must never claim completion");Check(((TextBlock)window.FindName("UpdateStatus")).Text.Contains("23"),"backend error must be visible");Save(window,Path.Combine(root,"error.png"));timer.Stop();((Button)window.FindName("UpdateClose")).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
    }
   }catch(Exception ex){File.WriteAllText(Path.Combine(root,"error.txt"),ex.ToString());Environment.Exit(1);}};
   window.Loaded+=(s,e)=>timer.Start();app.Run(window);timer.Stop();Check(intermediate,"actual completed file bytes must advance the bar");Check(!SystemParameters.ClientAreaAnimation||animationMoved,"activity animation must run while installing");Check(setup.ExitCode==(fail?1:0),"exit code must reflect installation outcome");Check(fail?!sawComplete:sawComplete,"100 is only displayed after successful backend exit; last="+last+", ticks="+ticks+", fail="+fail);
   // NSIS deliberately reads an unquoted /D= destination as the whole trailing command line.
   string[] received=File.ReadAllLines(Path.Combine(root,"received.txt"));Check(received.Contains("--updated")&&received.Contains("--force-run")&&received.Contains("/S"),"updater arguments must reach silent backend");Check(String.Join(" ",received.SkipWhile(a=>!a.StartsWith("/D=")).ToArray())=="/D="+destination,"NSIS destination with spaces must be last and preserved");string extracted=File.ReadAllText(Path.Combine(root,"payload-path.txt"));Check(!Directory.Exists(Path.GetDirectoryName(extracted)),"temporary payload must be removed");
   File.WriteAllText(Path.Combine(root,"passed.txt"),"true");return 0;
  }catch(Exception ex){File.WriteAllText(Path.Combine(root,"error.txt"),ex.ToString());return 1;}
 }
}
