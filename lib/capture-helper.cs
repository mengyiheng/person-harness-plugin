// PersonHarness Capture Helper —— 常驻原生采集进程（P3 窗口视频通道的采集端）
// 协议：stdin/stdout 逐行，竖线分隔（base64 不含 '|'，天然安全）
//   请求:  id|win|hwnd|maxW|q      → 窗口采集（PrintWindow PW_RENDERFULLCONTENT，最小化自动恢复）
//         id|screen|maxW|q        → 虚拟整屏采集（含微缩图容差变化检测）
//   响应:  id|ok|w|h|b64           /  id|still          /  id|err|message
// 设计要点：
//   - 进程常驻、类型/编码器只初始化一次（消灭 PS 冷启动 ~900ms，目标 <100ms/帧）
//   - 变化检测在 64x24 微缩图域做逐像素容差比对（≤8 像素判静止）——光标闪烁/时钟秒数被吸收
//   - 每 hwnd 一份微缩图缓存（窗口模式），整屏一份（screen 模式）
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

class PHCap {
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int n);

  public struct RECT { public int Left, Top, Right, Bottom; }

  const int TW = 64;
  const int TOL = 10;     // 单通道容差
  const int MAXDIFF = 8;  // 微缩图差异像素阈值（≤8 判静止）

  static ImageCodecInfo jpegCodec;
  static EncoderParameters ep;
  static int epQ = -1;
  static Dictionary<long, byte[]> prevTiny = new Dictionary<long, byte[]>();

  static void EnsureEP(long q) {
    if (ep == null || epQ != q) {
      if (ep != null) ep.Dispose();
      ep = new EncoderParameters(1);
      ep.Param[0] = new EncoderParameter(Encoder.Quality, q);
      epQ = (int)q;
    }
  }

  static string B64(Bitmap bmp, long q) {
    EnsureEP(q);
    using (var ms = new MemoryStream()) {
      bmp.Save(ms, jpegCodec, ep);
      return Convert.ToBase64String(ms.ToArray());
    }
  }

  // 微缩图 + 容差差异比对；变化时更新缓存并返回 true
  static bool Changed(Bitmap bmp, long key) {
    int th = Math.Max(1, (int)(TW * bmp.Height / (double)bmp.Width));
    using (var tiny = new Bitmap(TW, th)) {
      using (var g = Graphics.FromImage(tiny)) {
        g.InterpolationMode = InterpolationMode.Bilinear;
        g.DrawImage(bmp, 0, 0, TW, th);
      }
      var rect = new Rectangle(0, 0, TW, th);
      var data = tiny.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
      int stride = data.Stride;
      byte[] buf = new byte[stride * th];
      Marshal.Copy(data.Scan0, buf, 0, buf.Length);
      tiny.UnlockBits(data);
      byte[] prev;
      bool changed = true;
      if (prevTiny.TryGetValue(key, out prev) && prev.Length == buf.Length) {
        int diff = 0;
        for (int x = 0; x < TW && diff <= MAXDIFF; x++) {
          for (int y = 0; y < th; y++) {
            int o = y * stride + x * 3;
            if (Math.Abs(buf[o] - prev[o]) > TOL || Math.Abs(buf[o + 1] - prev[o + 1]) > TOL || Math.Abs(buf[o + 2] - prev[o + 2]) > TOL) {
              diff++;
              if (diff > MAXDIFF) break;
            }
          }
        }
        changed = diff > MAXDIFF;
      }
      if (changed) {
        if (prevTiny.Count > 200) prevTiny.Clear(); // 防膨胀
        prevTiny[key] = buf;
      }
      return changed;
    }
  }

  static Bitmap ScaleTo(Bitmap src, int maxW) {
    if (src.Width <= maxW) return src;
    double sc = maxW / (double)src.Width;
    var dst = new Bitmap(src, (int)(src.Width * sc), (int)(src.Height * sc));
    src.Dispose();
    return dst;
  }

  // 2026-10-27：PrintWindow 黑帧检测（采样像素均亮 <10 判黑）
  static bool IsMostlyBlack(Bitmap bmp) {
    var rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
    var data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
    int stride = data.Stride;
    byte[] buf = new byte[stride * bmp.Height];
    Marshal.Copy(data.Scan0, buf, 0, buf.Length);
    bmp.UnlockBits(data);
    long sum = 0; int n = 0;
    for (int y = 0; y < bmp.Height; y += Math.Max(1, bmp.Height / 16)) {
      for (int x = 0; x < bmp.Width; x += Math.Max(1, bmp.Width / 16)) {
        int o = y * stride + x * 3;
        sum += (buf[o] + buf[o + 1] + buf[o + 2]) / 3;
        n++;
      }
    }
    return n > 0 && sum / n < 10;
  }

  static string Esc(string s) { return s.Replace("|", "/").Replace("\r", " ").Replace("\n", " "); }

  static void Main() {
    Console.OutputEncoding = System.Text.Encoding.UTF8;
    Console.InputEncoding = System.Text.Encoding.UTF8;
    jpegCodec = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.MimeType == "image/jpeg");
    if (jpegCodec == null) { Console.Error.WriteLine("no jpeg codec"); return; }
    string line;
    while ((line = Console.ReadLine()) != null) {
      line = line.Trim();
      if (line.Length == 0) continue;
      var p = line.Split('|');
      if (p.Length < 3) { Console.WriteLine("0|err|bad request"); continue; }
      string id = p[0], cmd = p[1];
      try {
        if (cmd == "win") {
          long hwnd = long.Parse(p[2]);
          int maxW = int.Parse(p[3]);
          long q = long.Parse(p[4]);
          int force = (p.Length > 5 && p[5] == "1") ? 1 : 0; // 2026-10-27：force=1 跳过静止判定（新观看会话强制全帧）
          var h = new IntPtr(hwnd);
          if (!IsWindow(h)) { Console.WriteLine(id + "|err|bad hwnd"); continue; }
          if (IsIconic(h)) { ShowWindow(h, 9); System.Threading.Thread.Sleep(300); }
          RECT r;
          GetWindowRect(h, out r);
          int wd = Math.Max(1, r.Right - r.Left), ht = Math.Max(1, r.Bottom - r.Top);
          var bmp = new Bitmap(wd, ht);
          using (var g = Graphics.FromImage(bmp)) {
            var hdc = g.GetHdc();
            PrintWindow(h, hdc, 2);
            g.ReleaseHdc(hdc);
          }
          // 2026-10-27：PrintWindow 黑帧自愈——本机（Win 26200 当前状态）PrintWindow 对多数窗口
          // 返回纯黑；检测到黑帧时改用 CopyFromScreen 整屏截取窗口区域（仅前台可见内容，可接受）。
          try {
            if (IsMostlyBlack(bmp)) {
              RECT wr2;
              GetWindowRect(h, out wr2);
              int ww = Math.Max(1, wr2.Right - wr2.Left), wh2 = Math.Max(1, wr2.Bottom - wr2.Top);
              var sc2 = new Bitmap(ww, wh2);
              using (var g2 = Graphics.FromImage(sc2)) g2.CopyFromScreen(wr2.Left, wr2.Top, 0, 0, sc2.Size);
              bmp.Dispose();
              bmp = sc2;
              wd = ww; ht = wh2;
            }
          } catch { /* 回退失败保留原黑帧（下层还有 PS 兜底） */ }
          bmp = ScaleTo(bmp, maxW);
          bool ch = Changed(bmp, hwnd); // 无论 force 与否都跑一遍：静止时也刷新微缩缓存
          if (force == 0 && !ch) { bmp.Dispose(); Console.WriteLine(id + "|still"); continue; }
          string b64 = B64(bmp, q);
          Console.WriteLine(id + "|ok|" + bmp.Width + "|" + bmp.Height + "|" + b64);
          bmp.Dispose();
        } else if (cmd == "screen") {
          int maxW = int.Parse(p[2]);
          long q = long.Parse(p[3]);
          int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77);
          int vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
          var bmp = new Bitmap(vw, vh);
          using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(vx, vy, 0, 0, bmp.Size);
          bmp = ScaleTo(bmp, maxW);
          if (!Changed(bmp, -1)) { bmp.Dispose(); Console.WriteLine(id + "|still"); continue; }
          string b64 = B64(bmp, q);
          Console.WriteLine(id + "|ok|" + bmp.Width + "|" + bmp.Height + "|" + b64);
          bmp.Dispose();
        } else {
          Console.WriteLine(id + "|err|unknown cmd");
        }
      } catch (Exception e) {
        Console.WriteLine(id + "|err|" + Esc(e.Message));
      }
    }
  }
}
