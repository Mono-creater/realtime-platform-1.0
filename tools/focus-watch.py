# -*- coding: utf-8 -*-
"""
焦点/窗口状态监视器 —— 抓"最小化的窗口为什么自己弹回来"。

原理：只用 Win32 API（ctypes，不编译任何东西），每 0.1s 采样
  1) 当前前台窗口是谁（进程名 + 标题）
  2) 所有可见顶层窗口的 最小化/还原 状态变化
输出：同目录 focus-watch.log（UTF-8）

用法：
    python focus-watch.py            # 默认 120 秒
    python focus-watch.py 600        # 监视 10 分钟

判读方法：
  - 先最小化目标窗口（浏览器），盯着日志。
  - 若出现 "RESTORE  chrome.exe ..." 说明窗口是被【程序调用】还原的，
    上一行 FOREGROUND 的进程就是嫌疑对象。
  - 若没有 RESTORE 记录却弹回来了，说明是同一个窗口被 SetForegroundWindow
    或打开了新的标签/窗口，看紧邻的 FOREGROUND 行。
"""

import ctypes
import ctypes.wintypes as wt
import datetime
import os
import sys
import time

try:
    sys.stdout.reconfigure(errors="replace")
except Exception:
    pass

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

user32.GetForegroundWindow.restype = wt.HWND
user32.GetWindowTextLengthW.argtypes = [wt.HWND]
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [wt.HWND, ctypes.c_wchar_p, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int
user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
user32.GetWindowThreadProcessId.restype = wt.DWORD
user32.IsIconic.argtypes = [wt.HWND]
user32.IsIconic.restype = wt.BOOL
user32.IsWindowVisible.argtypes = [wt.HWND]
user32.IsWindowVisible.restype = wt.BOOL
user32.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
user32.GetWindowRect.restype = wt.BOOL

kernel32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
kernel32.OpenProcess.restype = wt.HANDLE
kernel32.QueryFullProcessImageNameW.argtypes = [
    wt.HANDLE,
    wt.DWORD,
    ctypes.c_wchar_p,
    ctypes.POINTER(wt.DWORD),
]
kernel32.QueryFullProcessImageNameW.restype = wt.BOOL
kernel32.CloseHandle.argtypes = [wt.HANDLE]
kernel32.CloseHandle.restype = wt.BOOL

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
WNDENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
user32.EnumWindows.argtypes = [WNDENUMPROC, wt.LPARAM]
user32.EnumWindows.restype = wt.BOOL


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", wt.UINT), ("dwTime", wt.DWORD)]


user32.GetLastInputInfo.argtypes = [ctypes.POINTER(LASTINPUTINFO)]
user32.GetLastInputInfo.restype = wt.BOOL
kernel32.GetTickCount.restype = wt.DWORD

WM_GETTEXT = 0x000D
WM_GETTEXTLENGTH = 0x000E
SMTO_ABORTIFHUNG = 0x0002
user32.SendMessageTimeoutW.argtypes = [
    wt.HWND,
    wt.UINT,
    wt.WPARAM,
    wt.LPARAM,
    wt.UINT,
    wt.UINT,
    ctypes.POINTER(ctypes.c_size_t),
]
user32.SendMessageTimeoutW.restype = ctypes.c_size_t


def win_title(hwnd):
    """取窗口标题。用 SendMessageTimeoutW + ABORTIFHUNG：
    直接 GetWindowTextW 遇到无响应的窗口会一直阻塞，把整个监视器卡死。"""
    out = ctypes.c_size_t(0)
    ok = user32.SendMessageTimeoutW(
        hwnd, WM_GETTEXTLENGTH, 0, 0, SMTO_ABORTIFHUNG, 100, ctypes.byref(out)
    )
    n = int(out.value) if ok else 0
    if n <= 0 or n > 512:
        return ""
    buf = ctypes.create_unicode_buffer(n + 2)
    ok = user32.SendMessageTimeoutW(
        hwnd,
        WM_GETTEXT,
        n + 1,
        ctypes.cast(buf, ctypes.c_void_p).value,
        SMTO_ABORTIFHUNG,
        100,
        ctypes.byref(out),
    )
    return buf.value if ok else ""


def idle_ms():
    """距上一次鼠标/键盘输入的毫秒数。>3000 基本可认为"人手没动过"。"""
    lii = LASTINPUTINFO()
    lii.cbSize = ctypes.sizeof(LASTINPUTINFO)
    if not user32.GetLastInputInfo(ctypes.byref(lii)):
        return -1
    return (int(kernel32.GetTickCount()) - int(lii.dwTime)) & 0xFFFFFFFF


_proc_cache = {}


def proc_name(pid):
    if pid in _proc_cache:
        return _proc_cache[pid]
    name = "?"
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if h:
        try:
            buf = ctypes.create_unicode_buffer(1024)
            size = wt.DWORD(1024)
            if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                name = os.path.basename(buf.value)
        finally:
            kernel32.CloseHandle(h)
    _proc_cache[pid] = name
    return name


def pid_of(hwnd):
    p = wt.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
    return p.value


_title_cache = {}


def collect_windows():
    """{hwnd: (iconic, title, proc, pid, rect)}
    标题走缓存：每轮对所有窗口发 WM_GETTEXT 太费 CPU，而进程名+native 句柄已够定位。"""
    out = {}

    def cb(hwnd, _lparam):
        try:
            if not user32.IsWindowVisible(hwnd):
                return True
            title = _title_cache.get(hwnd)
            if title is None:
                title = win_title(hwnd)
                if title:
                    _title_cache[hwnd] = title
            if not title:
                return True
            pid = pid_of(hwnd)
            r = wt.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r))
            out[hwnd] = (
                bool(user32.IsIconic(hwnd)),
                title,
                proc_name(pid),
                pid,
                (r.left, r.top, r.right, r.bottom),
            )
        except Exception:
            pass
        return True

    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return out


def main():
    seconds = int(sys.argv[1]) if len(sys.argv) > 1 else 120
    log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "focus-watch.log")
    fh = open(log_path, "w", encoding="utf-8")

    def log(line):
        stamp = datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]
        text = "%s  %s" % (stamp, line)
        fh.write(text + "\n")
        fh.flush()
        # 只在交互式终端里回显：后台运行时 stdout 管道写满会把进程阻塞住
        if sys.stdout.isatty():
            print(text)

    log("=== 开始监视 %d 秒 — 现在去最小化目标窗口 ===" % seconds)

    prev_state = {}   # hwnd -> iconic
    prev_fg = None
    end = time.time() + seconds
    last_tick = 0.0

    while time.time() < end:
        # 1) 前台窗口变化
        fg = user32.GetForegroundWindow()
        if fg != prev_fg:
            title = win_title(fg)
            pid = pid_of(fg)
            log(
                "FOREGROUND  %-18s pid=%-6s iconic=%-5s idle=%-7d %s"
                % (proc_name(pid), pid, bool(user32.IsIconic(fg)), idle_ms(), title[:70])
            )
            prev_fg = fg

        # 2) 窗口最小化/还原状态变化 + 新出现的窗口
        cur = collect_windows()
        for hwnd, (iconic, title, pname, pid, _rect) in cur.items():
            was = prev_state.get(hwnd)
            if was is None:
                if prev_state:  # 首轮不刷屏
                    log(
                        "NEWWIN    %-18s pid=%-6s idle=%-7d %s"
                        % (pname, pid, idle_ms(), title[:70])
                    )
            elif was != iconic:
                log(
                    "%-9s %-18s pid=%-6s idle=%-7d %s"
                    % ("RESTORE" if was else "MINIMIZE", pname, pid, idle_ms(), title[:70])
                )
        prev_state = {h: v[0] for h, v in cur.items()}

        # 3) 每 5s 心跳：证明这段时间人手是否动过
        now = time.time()
        if now - last_tick >= 5:
            last_tick = now
            pid = pid_of(fg)
            log(
                "  tick    idle=%-7d fg=%s  %s"
                % (idle_ms(), proc_name(pid), win_title(fg)[:60])
            )

        time.sleep(0.1)

    log("=== 结束，日志已写入 %s ===" % log_path)
    fh.close()


if __name__ == "__main__":
    main()
