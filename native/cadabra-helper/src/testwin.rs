//! A throwaway test window owned by the helper, used ONLY to verify input
//! injection (click / type_text / press_keys) without touching other apps.

use crate::RpcResult;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::mpsc;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::*;

static MAIN: AtomicIsize = AtomicIsize::new(0);
static EDIT: AtomicIsize = AtomicIsize::new(0);

unsafe extern "system" fn wndproc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if msg == WM_DESTROY {
        PostQuitMessage(0);
        return LRESULT(0);
    }
    DefWindowProcW(h, msg, wp, lp)
}

fn h(v: isize) -> HWND {
    HWND(v as *mut core::ffi::c_void)
}

pub fn open(p: &Value) -> RpcResult {
    if MAIN.load(Ordering::SeqCst) != 0 {
        return Err("test window already open".into());
    }
    let x = p.get("x").and_then(|v| v.as_i64()).unwrap_or(200) as i32;
    let y = p.get("y").and_then(|v| v.as_i64()).unwrap_or(200) as i32;
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    std::thread::spawn(move || unsafe {
        let inst: HINSTANCE = GetModuleHandleW(None).map(|m| HINSTANCE(m.0)).unwrap_or_default();
        let class = w!("CadabraHelperTestWindow");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: inst,
            lpszClassName: class,
            hbrBackground: HBRUSH((COLOR_WINDOW.0 + 1) as isize as *mut core::ffi::c_void),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            ..Default::default()
        };
        RegisterClassW(&wc);
        let main = match CreateWindowExW(
            WS_EX_TOPMOST,
            class,
            w!("Cadabra helper test window"),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            x,
            y,
            520,
            260,
            None,
            None,
            Some(inst),
            None,
        ) {
            Ok(m) => m,
            Err(e) => {
                let _ = tx.send(Err(e.to_string()));
                return;
            }
        };
        let edit = CreateWindowExW(
            WS_EX_CLIENTEDGE,
            w!("EDIT"),
            PCWSTR::null(),
            WS_CHILD | WS_VISIBLE | WINDOW_STYLE((ES_MULTILINE | ES_AUTOVSCROLL) as u32),
            16,
            16,
            470,
            170,
            Some(main),
            None,
            Some(inst),
            None,
        )
        .unwrap_or_default();
        // A helper spawned hidden (windowsHide → STARTUPINFO SW_HIDE) must still
        // show its test window and paint the edit (found by the live harness).
        let _ = ShowWindow(main, SW_SHOWNORMAL);
        let _ = ShowWindow(edit, SW_SHOW);
        let _ = UpdateWindow(main);
        MAIN.store(main.0 as isize, Ordering::SeqCst);
        EDIT.store(edit.0 as isize, Ordering::SeqCst);
        let _ = tx.send(Ok(()));
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        MAIN.store(0, Ordering::SeqCst);
        EDIT.store(0, Ordering::SeqCst);
        let _ = UnregisterClassW(class, Some(inst));
    });
    rx.recv().map_err(|e| e.to_string())??;
    let main = h(MAIN.load(Ordering::SeqCst));
    let edit = h(EDIT.load(Ordering::SeqCst));
    let mut er = RECT::default();
    unsafe {
        let _ = GetWindowRect(edit, &mut er);
    }
    Ok(json!({
        "hwnd": crate::win::hwnd_num(main),
        "editHwnd": crate::win::hwnd_num(edit),
        "editRect": crate::win::rect_json(&er),
        "windowRect": crate::win::rect_json(&crate::win::window_rect(main)),
    }))
}

pub fn text() -> RpcResult {
    let edit = EDIT.load(Ordering::SeqCst);
    if edit == 0 {
        return Err("no test window".into());
    }
    Ok(json!(crate::win::window_text(h(edit))))
}

pub fn close() -> RpcResult {
    let m = MAIN.load(Ordering::SeqCst);
    if m == 0 {
        return Ok(json!(false));
    }
    unsafe {
        let _ = PostMessageW(Some(h(m)), WM_CLOSE, WPARAM(0), LPARAM(0));
    }
    for _ in 0..50 {
        if MAIN.load(Ordering::SeqCst) == 0 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    Ok(json!(true))
}
