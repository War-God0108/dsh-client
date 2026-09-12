"""Smoke test for the desktop client's "spawn our own host" path.

Why: the black window the user hit always happened when the app started its own
DSH host (probe false -> spawn), never when it reused one already running. This
test drives exactly that path on a spare port and checks that

  1. the app really spawns a host and binds the port,
  2. the window that appears renders the official UI (not a bare dark page),
  3. no watchdog/recovery page was triggered,
  4. closing the window cleans the host up again.

Usage (the app must NOT already be running - the single-instance lock would
make this test exit immediately):

    python .smoke-spawn-test.py [path\\to\\Deepseek Harness.exe]

Defaults to the packaged, installed build. Everything it starts, it kills.
"""
import ctypes
import json
import os
import subprocess
import sys
import time
from ctypes import wintypes
from pathlib import Path

PORT = 3099
URL = f"http://127.0.0.1:{PORT}"
APPDATA = Path(os.environ["APPDATA"]) / "dsh-client"
APP_LOG = APPDATA / "app.log"

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

DEFAULT_EXE = Path(r"D:\应用\Deepseek Harness\Deepseek Harness.exe")


def listeners(port):
    """PIDs LISTENing on the port."""
    out = subprocess.run(["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True).stdout
    pids = set()
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[3] == "LISTENING" and parts[1].endswith(f":{port}"):
            pids.add(int(parts[4]))
    return pids


def kill(pid):
    subprocess.run(["taskkill", "/pid", str(pid), "/T", "/F"], capture_output=True)


def process_tree(root):
    """All PIDs in root's process tree, via Toolhelp (wmic is gone)."""
    TH32CS_SNAPPROCESS = 0x2

    class PROCESSENTRY32(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                    ("th32ProcessID", wintypes.DWORD),
                    ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
                    ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD),
                    ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
                    ("szExeFile", ctypes.c_char * 260)]

    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    parent = {}
    entry = PROCESSENTRY32()
    entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
    if kernel32.Process32First(snap, ctypes.byref(entry)):
        while True:
            parent[entry.th32ProcessID] = entry.th32ParentProcessID
            if not kernel32.Process32Next(snap, ctypes.byref(entry)):
                break
    kernel32.CloseHandle(snap)

    wanted = {root}
    changed = True
    while changed:
        changed = False
        for pid, ppid in parent.items():
            if ppid in wanted and pid not in wanted:
                wanted.add(pid)
                changed = True
    return wanted


def visible_windows(pids):
    """[(hwnd, title)] of visible top-level windows owned by those PIDs."""
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _lparam):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value in pids and user32.IsWindowVisible(hwnd):
            n = user32.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            if buf.value:
                found.append((hwnd, buf.value))
        return True

    user32.EnumWindows(cb, 0)
    return found


def render_stats(hwnd):
    """Sample the window's pixels from the SCREEN (not PrintWindow: Chromium
    reports a stale/blank bitmap through PrintWindow while the window is not
    active, which reads as a false "black window").

    The window is brought to the front first, so this measures what a user
    would actually see.
    """
    user32.ShowWindow(hwnd, 9)          # SW_RESTORE
    user32.SetForegroundWindow(hwnd)
    time.sleep(1.5)
    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    w, h = rect.right - rect.left, rect.bottom - rect.top

    screen = user32.GetDC(0)
    mem = gdi32.CreateCompatibleDC(screen)
    bmp = gdi32.CreateCompatibleBitmap(screen, w, h)
    gdi32.SelectObject(mem, bmp)
    SRCCOPY = 0x00CC0020
    gdi32.BitBlt(mem, 0, 0, w, h, screen, rect.left, rect.top, SRCCOPY)

    class BMIH(ctypes.Structure):
        _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG),
                    ("biHeight", wintypes.LONG), ("biPlanes", wintypes.WORD),
                    ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                    ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                    ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD),
                    ("biClrImportant", wintypes.DWORD)]

    bi = BMIH(ctypes.sizeof(BMIH), w, -h, 1, 32, 0, 0, 0, 0, 0, 0)
    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(bi), 0)
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mem)
    user32.ReleaseDC(0, screen)

    px = buf.raw
    step = 4 * 53
    colors, nonbg, total = set(), 0, 0
    for i in range(0, len(px) - 4, step):
        b, g, r = px[i], px[i + 1], px[i + 2]
        total += 1
        colors.add((r // 12, g // 12, b // 12))
        if abs(r - 7) > 14 or abs(g - 11) > 14 or abs(b - 16) > 14:
            nonbg += 1
    shot = Path(os.environ["TEMP"]) / "dsh-smoke-window.png"
    save_png(px, w, h, shot)
    return {"size": f"{w}x{h}", "sampled": total, "distinct_colors": len(colors),
            "non_background_ratio": round(nonbg / max(total, 1), 3), "screenshot": str(shot)}


def save_png(bgra, w, h, path):
    """Write the BGRA buffer as a 24-bit BMP (no Pillow dependency)."""
    row = w * 3
    pad = (-row) % 4
    with open(path, "wb") as f:
        size = 54 + (row + pad) * h
        f.write(b"BM" + size.to_bytes(4, "little") + b"\0\0\0\0" + (54).to_bytes(4, "little"))
        f.write((40).to_bytes(4, "little") + w.to_bytes(4, "little", signed=True) +
                h.to_bytes(4, "little", signed=True) + (1).to_bytes(2, "little") +
                (24).to_bytes(2, "little") + (0).to_bytes(4, "little") +
                ((row + pad) * h).to_bytes(4, "little") + (2835).to_bytes(4, "little") * 2 +
                (0).to_bytes(4, "little") * 2)
        for y in range(h):
            line = bytearray()
            base = y * w * 4
            for x in range(w):
                i = base + x * 4
                line += bytes((bgra[i], bgra[i + 1], bgra[i + 2]))
            line += b"\0" * pad
            f.write(bytes(line))


def exe_running():
    """True when an instance of the packaged app is running. tasklist's
    "nothing found" message is localized, so only count lines that actually
    carry a PID."""
    out = subprocess.run(["tasklist", "/fi", "imagename eq Deepseek Harness.exe", "/nh"],
                         capture_output=True, text=True, errors="replace").stdout
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1].isdigit():
            return True, line.strip()
    return False, ""


def main():
    arg = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_EXE
    if not arg.exists():
        print(f"!! 找不到可执行文件：{arg}")
        return 2
    # A directory argument means "run Electron against this unpacked app dir"
    # (used for one-off debug builds); a file argument is a packaged exe.
    if arg.is_dir():
        exe = arg / "node_modules" / "electron" / "dist" / "electron.exe"
        launch_args = [str(arg)]
        if not exe.exists():
            exe = Path(r"E:\Agent projects\Deepseek Harness\dsh-client\node_modules\electron\dist\electron.exe")
    else:
        exe = arg
        launch_args = []
    running, which = exe_running()
    if running:
        print("!! 已有 Deepseek Harness 实例在运行，单实例锁会让本次测试无法进行。")
        print("   请先关闭桌面窗口，再重跑本测试：", which)
        return 2

    before = len(APP_LOG.read_text(encoding="utf-8", errors="replace").splitlines())
    env = dict(os.environ, DSH_URL=URL, DSH_OPEN_BROWSER="0",
               DSH_CLIENT_DEBUG=str(Path(os.environ["TEMP"]) / "dsh-smoke-debug.log"))
    Path(env["DSH_CLIENT_DEBUG"]).unlink(missing_ok=True)
    proc = subprocess.Popen([str(exe), *launch_args], env=env)
    print(f"启动 {exe.name} {' '.join(launch_args)} pid={proc.pid}，DSH_URL={URL}（应用将自行拉起宿主）")

    result = {"spawned_host": False, "window": None, "render": None, "watchdog": False,
              "recovery_page": False}
    try:
        seen_ui_loaded = False
        for i in range(1, 26):
            time.sleep(2)
            ls = listeners(PORT)
            tree = process_tree(proc.pid)
            wins = visible_windows(tree)
            log_now = APP_LOG.read_text(encoding="utf-8", errors="replace").splitlines()[before:]
            if any("official UI loaded" in l for l in log_now):
                seen_ui_loaded = True
            if any("watchdog fired" in l for l in log_now):
                result["watchdog"] = True
            print(f"t+{i*2:>2}s alive={proc.poll() is None} 3099={'yes' if ls else 'no'} "
                  f"ui_loaded={seen_ui_loaded} windows={[t for _h, t in wins]}")
            if ls:
                result["spawned_host"] = True
            # Sample the pixels once the app says the UI is loaded (the window
            # title is the session's own title, so it is no marker by itself).
            if seen_ui_loaded and wins:
                # Track the window over time: how long after "official UI
                # loaded" does the first real frame appear?
                try:
                    hwnd = wins[0][0]
                    result["window"] = wins[0][1]
                    timeline = []
                    for step in range(1, 16):  # up to ~30s more
                        time.sleep(2)
                        st = render_stats(hwnd)
                        timeline.append({"t": step * 2, **{k: st[k] for k in
                                         ("distinct_colors", "non_background_ratio")}})
                        print(f"    首帧追踪 t+{step*2:>2}s 颜色={st['distinct_colors']:>4} "
                              f"非背景={st['non_background_ratio']:.3f}")
                        if st["distinct_colors"] > 40 and st["non_background_ratio"] > 0.10:
                            result["render"] = st
                            break
                    result["first_frame_timeline"] = timeline
                except Exception as exc:  # noqa: BLE001 - report, never mask
                    print(f"!! 追踪阶段出错: {type(exc).__name__}: {exc}")
                    result["track_error"] = f"{type(exc).__name__}: {exc}"
                break
            if proc.poll() is not None:
                print("!! 进程提前退出")
                break
    finally:
        log = APP_LOG.read_text(encoding="utf-8", errors="replace").splitlines()[before:]
        result["watchdog"] = any("watchdog fired" in l for l in log)
        result["recovery_page"] = any("recovery page" in l for l in log) or \
            any("did-fail-load" in l or "render-process-gone" in l for l in log)
        print("\n--- app.log（本次新增）---")
        for line in log:
            print("   ", line)
        print("\n--- 渲染采样 ---")
        print(json.dumps(result["render"], ensure_ascii=False))
        print("\n--- 清理 ---")
        kill(proc.pid)
        time.sleep(2)
        for pid in listeners(PORT):
            print("   结束残留监听进程", pid)
            kill(pid)
        print("   3099 残留监听:", sorted(listeners(PORT)) or "无")

        ok = (result["spawned_host"] and result["window"] and result["render"]
              and result["render"]["distinct_colors"] > 40
              and result["render"]["non_background_ratio"] > 0.10
              and not result["watchdog"])
        print("\n=== 结论:", "通过（自己拉起宿主 -> 窗口正常渲染）" if ok else "未通过/需人工确认", "===")
        return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
