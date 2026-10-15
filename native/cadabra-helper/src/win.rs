//! Window / monitor helpers. All coordinates are physical pixels.

use crate::RpcResult;
use serde_json::{json, Value};
use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Dwm::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::Threading::*;
use windows::Win32::UI::HiDpi::*;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;

pub fn hwnd_from_value(v: &Value) -> Option<HWND> {
    let n = if let Some(n) = v.as_i64() {
        n
    } else if let Some(s) = v.as_str() {
        let s = s.trim();
        if let Some(hex) = s.strip_prefix("0x") {
            i64::from_str_radix(hex, 16).ok()?
        } else {
            s.parse().ok()?
        }
    } else {
        return None;
    };
    Some(HWND(n as isize as *mut core::ffi::c_void))
}

pub fn hwnd_param(p: &Value) -> Result<HWND, String> {
    let h = p.get("hwnd").and_then(hwnd_from_value).ok_or("missing hwnd")?;
    if unsafe { !IsWindow(Some(h)).as_bool() } {
        return Err("hwnd is not a valid window".into());
    }
    Ok(h)
}

pub fn hwnd_num(h: HWND) -> i64 {
    h.0 as isize as i64
}

pub fn rect_json(r: &RECT) -> Value {
    json!({"x": r.left, "y": r.top, "width": r.right - r.left, "height": r.bottom - r.top})
}

pub fn cursor_pos() -> RpcResult {
    let mut pt = POINT::default();
    unsafe { GetCursorPos(&mut pt).map_err(|e| e.to_string())? };
    Ok(json!({"x": pt.x, "y": pt.y}))
}

/// Signals that local input may be going elsewhere (a software KVM such as
/// Input Director parks and hides the local cursor while another PC is in
/// control). Read-only: nothing is sent anywhere.
pub fn input_state() -> RpcResult {
    let mut ci = CURSORINFO { cbSize: std::mem::size_of::<CURSORINFO>() as u32, ..Default::default() };
    let showing = unsafe { GetCursorInfo(&mut ci) }.is_ok() && (ci.flags.0 & CURSOR_SHOWING.0) != 0;
    let mut li = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    let idle_ms = if unsafe { GetLastInputInfo(&mut li) }.as_bool() {
        unsafe { windows::Win32::System::SystemInformation::GetTickCount() }.wrapping_sub(li.dwTime) as u64
    } else {
        0
    };
    Ok(json!({"cursorShowing": showing, "cursorX": ci.ptScreenPos.x, "cursorY": ci.ptScreenPos.y, "idleMs": idle_ms}))
}

pub fn window_text(h: HWND) -> String {
    let mut buf = [0u16; 512];
    let n = unsafe { GetWindowTextW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

pub fn class_name(h: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

/// Executable file name of a process id ('' if it can't be read).
pub fn pid_name(pid: u32) -> String {
    let mut name = String::new();
    if pid != 0 {
        unsafe {
            if let Ok(proc_) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                let mut buf = [0u16; 1024];
                let mut len = buf.len() as u32;
                if QueryFullProcessImageNameW(proc_, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok() {
                    let full = String::from_utf16_lossy(&buf[..len as usize]);
                    name = full.rsplit(['\\', '/']).next().unwrap_or("").to_string();
                }
                let _ = CloseHandle(proc_);
            }
        }
    }
    name
}

pub fn process_info(h: HWND) -> (u32, String) {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
    let mut name = String::new();
    if pid != 0 {
        unsafe {
            if let Ok(proc_) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                let mut buf = [0u16; 1024];
                let mut len = buf.len() as u32;
                if QueryFullProcessImageNameW(proc_, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok() {
                    let full = String::from_utf16_lossy(&buf[..len as usize]);
                    name = full.rsplit(['\\', '/']).next().unwrap_or("").to_string();
                }
                let _ = CloseHandle(proc_);
            }
        }
    }
    (pid, name)
}

/// Visible window bounds (DWM extended frame, i.e. without the invisible
/// resize border / shadow). Falls back to GetWindowRect.
pub fn window_rect(h: HWND) -> RECT {
    let mut r = RECT::default();
    unsafe {
        let ok = DwmGetWindowAttribute(
            h,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as *mut core::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        );
        if ok.is_err() || (r.right - r.left) <= 0 {
            let _ = GetWindowRect(h, &mut r);
        }
    }
    r
}

pub fn root_window_at(x: i32, y: i32) -> HWND {
    unsafe {
        let h = WindowFromPoint(POINT { x, y });
        if h.0.is_null() {
            return h;
        }
        let root = GetAncestor(h, GA_ROOT);
        if root.0.is_null() { h } else { root }
    }
}

/// Mandatory integrity level RID of a process (0x2000 medium, 0x3000 high...).
pub fn integrity_of(pid: u32) -> Option<u32> {
    use windows::Win32::Security::*;
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut tok = HANDLE::default();
        let r = OpenProcessToken(h, TOKEN_QUERY, &mut tok);
        let _ = CloseHandle(h);
        r.ok()?;
        let mut len = 0u32;
        let _ = GetTokenInformation(tok, TokenIntegrityLevel, None, 0, &mut len);
        if len == 0 {
            let _ = CloseHandle(tok);
            return None;
        }
        let mut buf = vec![0u8; len as usize];
        let ok = GetTokenInformation(tok, TokenIntegrityLevel, Some(buf.as_mut_ptr() as *mut _), len, &mut len);
        let _ = CloseHandle(tok);
        ok.ok()?;
        let tml = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let sid = tml.Label.Sid;
        let count = *GetSidSubAuthorityCount(sid);
        if count == 0 {
            return None;
        }
        Some(*GetSidSubAuthority(sid, (count - 1) as u32))
    }
}

/// true = target runs at a higher integrity level than the helper (e.g. an
/// elevated/admin window): UIPI silently drops our injected input there.
/// null = could not determine (usually also means protected/elevated).
pub fn elevated_json(pid: u32) -> Value {
    if pid == 0 {
        return Value::Null;
    }
    let ours = integrity_of(std::process::id());
    match (integrity_of(pid), ours) {
        (Some(t), Some(o)) => json!(t > o),
        _ => Value::Null,
    }
}

pub fn describe_window(h: HWND) -> Value {
    if h.0.is_null() {
        return json!({"hwnd": 0});
    }
    let (pid, process) = process_info(h);
    let r = window_rect(h);
    let dpi = unsafe { GetDpiForWindow(h) };
    json!({
        "hwnd": hwnd_num(h),
        "title": window_text(h),
        "className": class_name(h),
        "pid": pid,
        "process": process,
        "rect": rect_json(&r),
        "dpi": dpi,
        "elevated": elevated_json(pid),
        // REVIEW-2 S9: popups/menus are owned by their app window.
        "owner": hwnd_num(unsafe { GetAncestor(h, GA_ROOTOWNER) }),
    })
}

pub fn describe_point(x: i32, y: i32) -> Value {
    describe_window(root_window_at(x, y))
}

pub fn window_info(h: HWND) -> RpcResult {
    Ok(describe_window(h))
}

pub fn window_rect_rpc(h: HWND) -> RpcResult {
    Ok(rect_json(&window_rect(h)))
}

pub fn window_at(p: &Value) -> RpcResult {
    let x = p.get("x").and_then(|v| v.as_f64()).ok_or("missing x")? as i32;
    let y = p.get("y").and_then(|v| v.as_f64()).ok_or("missing y")? as i32;
    Ok(describe_point(x, y))
}

pub fn monitors() -> RpcResult {
    unsafe extern "system" fn cb(hm: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        let out = &mut *(data.0 as *mut Vec<Value>);
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if GetMonitorInfoW(hm, &mut mi).as_bool() {
            let (mut dx, mut dy) = (0u32, 0u32);
            let _ = GetDpiForMonitor(hm, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
            out.push(json!({
                "rect": rect_json(&mi.rcMonitor),
                "work": rect_json(&mi.rcWork),
                "primary": (mi.dwFlags & MONITORINFOF_PRIMARY) != 0,
                "dpi": dx,
                "scale": dx as f64 / 96.0,
            }));
        }
        TRUE
    }
    let mut v: Vec<Value> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(cb), LPARAM(&mut v as *mut _ as isize));
    }
    Ok(json!(v))
}

/// Bring a window to the foreground. Uses AttachThreadInput so the request is
/// honored even though the helper is a background process.
pub fn foreground(h: HWND) -> RpcResult {
    unsafe {
        if IsIconic(h).as_bool() {
            let _ = ShowWindow(h, SW_RESTORE);
        }
        let fg = GetForegroundWindow();
        let cur = GetCurrentThreadId();
        let fg_thread = GetWindowThreadProcessId(fg, None);
        let target_thread = GetWindowThreadProcessId(h, None);
        let attached = fg_thread != 0 && fg_thread != cur && AttachThreadInput(cur, fg_thread, true).as_bool();
        let ok = SetForegroundWindow(h).as_bool();
        let _ = BringWindowToTop(h);
        let _ = SetFocus(Some(h));
        if attached {
            let _ = AttachThreadInput(cur, fg_thread, false);
        }
        let _ = target_thread;
        Ok(json!({"ok": ok, "foreground": hwnd_num(GetForegroundWindow())}))
    }
}

/// Style one of Cadabra's own windows: DWM border colour ("none" or 0xRRGGBB)
/// and rounded corners. Used to drop the Win11 accent border on the panel.
pub fn style_window(p: &Value) -> RpcResult {
    let h = hwnd_param(p)?;
    unsafe {
        if let Some(b) = p.get("border") {
            let color: u32 = if b.as_str() == Some("none") {
                0xFFFF_FFFE // DWMWA_COLOR_NONE
            } else {
                let rgb = b.as_u64().ok_or("border must be \"none\" or 0xRRGGBB")? as u32;
                // COLORREF is 0x00BBGGRR
                ((rgb & 0xFF) << 16) | (rgb & 0xFF00) | ((rgb >> 16) & 0xFF)
            };
            DwmSetWindowAttribute(h, DWMWA_BORDER_COLOR, &color as *const u32 as *const core::ffi::c_void, 4).map_err(|e| e.to_string())?;
        }
        if p.get("round").and_then(|v| v.as_bool()) == Some(true) {
            let pref: i32 = 2; // DWMWCP_ROUND
            DwmSetWindowAttribute(h, DWMWA_WINDOW_CORNER_PREFERENCE, &pref as *const i32 as *const core::ffi::c_void, 4).map_err(|e| e.to_string())?;
        }
    }
    Ok(json!(true))
}

/// Visible, uncloaked, top-level app windows (what Alt+Tab would show).
pub fn list_windows() -> RpcResult {
    unsafe extern "system" fn cb(h: HWND, data: LPARAM) -> BOOL {
        let out = &mut *(data.0 as *mut Vec<Value>);
        if !IsWindowVisible(h).as_bool() {
            return TRUE;
        }
        if GetWindow(h, GW_OWNER).map(|o| !o.0.is_null()).unwrap_or(false) {
            return TRUE;
        }
        let ex = GetWindowLongW(h, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TOOLWINDOW.0 != 0 {
            return TRUE;
        }
        let mut cloaked: u32 = 0;
        let _ = DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut core::ffi::c_void, 4);
        if cloaked != 0 {
            return TRUE;
        }
        let title = window_text(h);
        if title.is_empty() {
            return TRUE;
        }
        let (pid, process) = process_info(h);
        out.push(json!({
            "hwnd": hwnd_num(h),
            "title": title,
            "pid": pid,
            "process": process,
            "className": class_name(h),
            "rect": rect_json(&window_rect(h)),
            "minimized": IsIconic(h).as_bool(),
        }));
        TRUE
    }
    let mut v: Vec<Value> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut v as *mut _ as isize));
    }
    Ok(json!(v))
}

/// Politely close a window (WM_CLOSE). Used only by Cadabra's own self-tests.
pub fn close_window(h: HWND) -> RpcResult {
    unsafe {
        PostMessageW(Some(h), WM_CLOSE, WPARAM(0), LPARAM(0)).map_err(|e| e.to_string())?;
    }
    Ok(json!(true))
}

/// The foreground top-level window (keyboard summons have no click point).
pub fn describe_foreground() -> Value {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            return json!({"hwnd": 0});
        }
        let root = GetAncestor(fg, GA_ROOT);
        describe_window(if root.0.is_null() { fg } else { root })
    }
}

/// Text caret of a window's GUI thread in screen px (Win32 caret), or null.
pub fn caret_rect(h: HWND) -> RpcResult {
    unsafe {
        let tid = GetWindowThreadProcessId(h, None);
        let mut gi = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
        if tid != 0 && GetGUIThreadInfo(tid, &mut gi).is_ok() && !gi.hwndCaret.0.is_null() {
            let r = gi.rcCaret;
            let mut tl = POINT { x: r.left, y: r.top };
            let mut br = POINT { x: r.right, y: r.bottom };
            let _ = windows::Win32::Graphics::Gdi::ClientToScreen(gi.hwndCaret, &mut tl);
            let _ = windows::Win32::Graphics::Gdi::ClientToScreen(gi.hwndCaret, &mut br);
            if br.y > tl.y {
                return Ok(json!({"source": "win32", "rect": {"x": tl.x, "y": tl.y, "width": (br.x - tl.x).max(1), "height": br.y - tl.y}}));
            }
        }
    }
    Ok(Value::Null)
}
