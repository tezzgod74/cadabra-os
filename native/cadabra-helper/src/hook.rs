//! Low-level keyboard (+ optional mouse) hooks.
//!
//! * Summon binding (configurable via `set_binding`; default Ctrl+` / "Ctrl+~"):
//!   - keyboard binding: matched in WH_KEYBOARD_LL; the key-down, its
//!     auto-repeats and the key-up are swallowed so the foreground app never
//!     sees them. A `summon` event with trigger "key" is emitted once.
//!   - mouse binding (e.g. Ctrl+right-click): WH_MOUSE_LL is installed ONLY
//!     while a mouse binding is configured. The button down/up are swallowed.
//! * Physical Escape key-down is reported (`{event:"key",key:"Escape"}`), never swallowed.
//! * Push-to-talk (Ctrl+Win held) is reported when enabled, never swallowed.
//! * Injected input (LLKHF/LLMHF_INJECTED) is ignored, so Cadabra's own
//!   SendInput can never trigger it (test-only override: allowInjected).
//!
//! Callbacks only read atomics and push to a channel; window lookups happen on
//! a worker thread so the hooks stay far below LowLevelHooksTimeout.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::OnceLock;
use windows::Win32::Foundation::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;

static ENABLED: AtomicBool = AtomicBool::new(true);
static HOOK_THREAD: AtomicU32 = AtomicU32::new(0);
static TX: OnceLock<Sender<HookMsg>> = OnceLock::new();

// Binding. MODS bits: 1 ctrl, 2 alt, 4 shift, 8 win, 16 anyShift.
static BIND_MOUSE: AtomicBool = AtomicBool::new(false);
static BIND_VK: AtomicU32 = AtomicU32::new(0xC0);
/// C1: physical key (set-1 scan code) for layout-independent bindings; 0 = match by VK.
/// The default 0x29 is the key below Esc, which is ` on US but ^ / ² / ' elsewhere.
static BIND_SCAN: AtomicU32 = AtomicU32::new(0x29);
static BIND_MODS: AtomicU32 = AtomicU32::new(1 | 16);
static BIND_BUTTON: AtomicU32 = AtomicU32::new(0); // 1 right, 2 middle, 3 x1, 4 x2
static ALLOW_INJECTED: AtomicBool = AtomicBool::new(false);
static KEY_SWALLOW_VK: AtomicU32 = AtomicU32::new(0);
static MOUSE_SWALLOW_UP: AtomicU32 = AtomicU32::new(0); // window message of the pending button-up

/// Round 10: report the FIRST keyboard/mouse input once (the user is back).
/// Armed by the app when the user went away; injected input counts too
/// (Input Director delivers this PC's input that way). While armed, a mouse
/// hook is installed; it is removed again right after the first input.
static ACTIVITY_ARMED: AtomicBool = AtomicBool::new(false);

static PTT_ENABLED: AtomicBool = AtomicBool::new(false);
static PTT_CTRL: AtomicBool = AtomicBool::new(false);
static PTT_WIN: AtomicBool = AtomicBool::new(false);
static PTT_ACTIVE: AtomicBool = AtomicBool::new(false);

const WM_APP_REINSTALL: u32 = WM_APP + 7;

enum HookMsg {
    Activity(&'static str),
    Summon { x: i32, y: i32, time: u32, key: bool },
    Escape,
    Ptt(bool),
}

pub fn set_ptt_enabled(on: bool) {
    PTT_ENABLED.store(on, Ordering::SeqCst);
    if !on {
        PTT_ACTIVE.store(false, Ordering::SeqCst);
    }
}

pub fn arm_activity(on: bool) {
    ACTIVITY_ARMED.store(on, Ordering::SeqCst);
    reinstall(); // adds / removes the mouse hook
}

/// First input after arming: report once and drop the extra mouse hook.
fn activity(source: &'static str) {
    if ACTIVITY_ARMED.swap(false, Ordering::SeqCst) {
        send(HookMsg::Activity(source));
        reinstall();
    }
}

fn want_mouse_hook() -> bool {
    BIND_MOUSE.load(Ordering::SeqCst) || ACTIVITY_ARMED.load(Ordering::SeqCst)
}

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::SeqCst);
    if !on {
        KEY_SWALLOW_VK.store(0, Ordering::SeqCst);
        MOUSE_SWALLOW_UP.store(0, Ordering::SeqCst);
    }
}

/// `{kind:"key"|"mouse", vk, button, ctrl, alt, shift, win, anyShift, allowInjected?}`
pub fn set_binding(p: &Value) -> Result<Value, String> {
    let b = |k: &str| p.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
    let mouse = p.get("kind").and_then(|v| v.as_str()) == Some("mouse");
    let mut mods = 0u32;
    if b("ctrl") {
        mods |= 1;
    }
    if b("alt") {
        mods |= 2;
    }
    if b("shift") {
        mods |= 4;
    }
    if b("win") {
        mods |= 8;
    }
    if b("anyShift") {
        mods |= 16;
    }
    if mouse {
        let btn = match p.get("button").and_then(|v| v.as_str()) {
            Some("right") => 1,
            Some("middle") => 2,
            Some("x1") => 3,
            Some("x2") => 4,
            _ => return Err("mouse binding needs button right|middle|x1|x2".into()),
        };
        BIND_BUTTON.store(btn, Ordering::SeqCst);
    } else {
        let vk = p.get("vk").and_then(|v| v.as_u64()).ok_or("key binding needs vk")? as u32;
        if vk == 0 || vk > 0xFE {
            return Err("bad vk".into());
        }
        BIND_VK.store(vk, Ordering::SeqCst);
        let scan = p.get("scan").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        BIND_SCAN.store(if scan > 0 && scan < 0x80 { scan } else { 0 }, Ordering::SeqCst);
    }
    BIND_MODS.store(mods, Ordering::SeqCst);
    BIND_MOUSE.store(mouse, Ordering::SeqCst);
    ALLOW_INJECTED.store(b("allowInjected"), Ordering::SeqCst);
    KEY_SWALLOW_VK.store(0, Ordering::SeqCst);
    MOUSE_SWALLOW_UP.store(0, Ordering::SeqCst);
    reinstall(); // installs / removes the mouse hook as needed
    Ok(json!({"mouseHook": mouse}))
}

fn send(msg: HookMsg) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(msg);
    }
}

fn key_down(vk: VIRTUAL_KEY) -> bool {
    unsafe { (GetAsyncKeyState(vk.0 as i32) as u16 & 0x8000) != 0 }
}

/// Pure modifier match: `m` bits 1 ctrl, 2 alt, 4 shift, 8 win, 16 anyShift.
pub fn mods_match_bits(m: u32, ctrl: bool, alt: bool, shift: bool, win: bool) -> bool {
    ctrl == (m & 1 != 0) && alt == (m & 2 != 0) && win == (m & 8 != 0) && (m & 16 != 0 || shift == (m & 4 != 0))
}

fn mods_match() -> bool {
    mods_match_bits(
        BIND_MODS.load(Ordering::Relaxed),
        key_down(VK_CONTROL),
        key_down(VK_MENU),
        key_down(VK_SHIFT),
        key_down(VK_LWIN) || key_down(VK_RWIN),
    )
}

/// Keyboard swallow state machine (pure; mirrors kbd_proc).
#[derive(Debug, PartialEq)]
pub enum KeyDecision {
    PassThrough,
    /// Swallow and emit a summon.
    Summon,
    /// Swallow silently (auto-repeat or the matching key-up).
    Swallow,
}

pub fn key_decision(swallowing_vk: &mut u32, bind_vk: u32, vk: u32, down: bool, up: bool, mods_ok: bool) -> KeyDecision {
    if *swallowing_vk != 0 && vk == *swallowing_vk {
        if up {
            *swallowing_vk = 0;
        }
        return KeyDecision::Swallow;
    }
    if down && vk == bind_vk && mods_ok {
        *swallowing_vk = vk;
        return KeyDecision::Summon;
    }
    KeyDecision::PassThrough
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && ACTIVITY_ARMED.load(Ordering::Relaxed) {
        activity("mouse");
    }
    if code == HC_ACTION as i32 && ENABLED.load(Ordering::Relaxed) && BIND_MOUSE.load(Ordering::Relaxed) {
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        let injected = (info.flags & LLMHF_INJECTED) != 0;
        let msg = wparam.0 as u32;
        if !injected || ALLOW_INJECTED.load(Ordering::Relaxed) {
            let pending = MOUSE_SWALLOW_UP.load(Ordering::SeqCst);
            if pending != 0 && msg == pending {
                MOUSE_SWALLOW_UP.store(0, Ordering::SeqCst);
                return LRESULT(1);
            }
            let xb = (info.mouseData >> 16) as u16;
            let (want_down, up) = match BIND_BUTTON.load(Ordering::Relaxed) {
                1 => (msg == WM_RBUTTONDOWN, WM_RBUTTONUP),
                2 => (msg == WM_MBUTTONDOWN, WM_MBUTTONUP),
                3 => (msg == WM_XBUTTONDOWN && xb == 1, WM_XBUTTONUP),
                4 => (msg == WM_XBUTTONDOWN && xb == 2, WM_XBUTTONUP),
                _ => (false, 0),
            };
            if want_down && mods_match() {
                MOUSE_SWALLOW_UP.store(up, Ordering::SeqCst);
                send(HookMsg::Summon { x: info.pt.x, y: info.pt.y, time: info.time, key: false });
                return LRESULT(1);
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

unsafe extern "system" fn kbd_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && ACTIVITY_ARMED.load(Ordering::Relaxed) {
        activity("key");
    }
    if code == HC_ACTION as i32 {
        let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let injected = (info.flags.0 & LLKHF_INJECTED.0) != 0;
        let msg = wparam.0 as u32;
        let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
        let up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
        let vk = effective_vk(info.vkCode, info.scanCode, (info.flags.0 & LLKHF_EXTENDED.0) != 0, BIND_VK.load(Ordering::Relaxed), BIND_SCAN.load(Ordering::Relaxed));

        // Summon binding (keyboard)
        if ENABLED.load(Ordering::Relaxed) && !BIND_MOUSE.load(Ordering::Relaxed) && (!injected || ALLOW_INJECTED.load(Ordering::Relaxed)) {
            let mut sw = KEY_SWALLOW_VK.load(Ordering::SeqCst);
            let mods_ok = down && vk == BIND_VK.load(Ordering::Relaxed) && mods_match();
            let d = key_decision(&mut sw, BIND_VK.load(Ordering::Relaxed), vk, down, up, mods_ok);
            KEY_SWALLOW_VK.store(sw, Ordering::SeqCst);
            match d {
                KeyDecision::Swallow => return LRESULT(1),
                KeyDecision::Summon => {
                    let mut pt = POINT::default();
                    let _ = GetCursorPos(&mut pt);
                    send(HookMsg::Summon { x: pt.x, y: pt.y, time: info.time, key: true });
                    return LRESULT(1);
                }
                KeyDecision::PassThrough => {}
            }
        }

        // REVIEW-2 #6: while Cadabra's panel is opening, keystrokes typed right
        // after the shortcut are held here instead of reaching the user's app;
        // the app takes them and puts them into the panel's input.
        if !injected && buffering() {
            let mods = key_down(VK_CONTROL) || key_down(VK_MENU) || key_down(VK_LWIN) || key_down(VK_RWIN);
            match buffer_decision(vk, down, up, mods) {
                BufferDecision::Hold => {
                    if down {
                        let shift = key_down(VK_SHIFT);
                        let caps = (GetKeyState(VK_CAPITAL.0 as i32) & 1) != 0;
                        if let Ok(mut b) = KEY_BUFFER.lock() {
                            if b.len() < 200 {
                                b.push((vk, info.scanCode, shift, caps));
                            }
                        }
                    }
                    return LRESULT(1);
                }
                BufferDecision::Stop => BUFFER_UNTIL.store(0, Ordering::SeqCst),
                BufferDecision::Pass => {}
            }
        }

        if !injected && down && vk == VK_ESCAPE.0 as u32 {
            crate::input::request_cancel();
            send(HookMsg::Escape);
        }
        if !injected && PTT_ENABLED.load(Ordering::Relaxed) && (down || up) {
            if vk == VK_LCONTROL.0 as u32 || vk == VK_RCONTROL.0 as u32 || vk == VK_CONTROL.0 as u32 {
                PTT_CTRL.store(down, Ordering::Relaxed);
            } else if vk == VK_LWIN.0 as u32 || vk == VK_RWIN.0 as u32 {
                PTT_WIN.store(down, Ordering::Relaxed);
            }
            let both = PTT_CTRL.load(Ordering::Relaxed) && PTT_WIN.load(Ordering::Relaxed);
            if both != PTT_ACTIVE.swap(both, Ordering::SeqCst) {
                send(HookMsg::Ptt(both));
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

pub fn start() {
    if HOOK_THREAD.load(Ordering::SeqCst) != 0 || TX.get().is_some() {
        return; // already running
    }
    let (tx, rx) = mpsc::channel::<HookMsg>();
    TX.set(tx).ok();

    // Worker: enrich events off the hook thread.
    std::thread::spawn(move || {
        for m in rx {
            match m {
                HookMsg::Summon { x, y, time, key } => {
                    // Keyboard summons describe the FOREGROUND window; mouse summons the window under the click.
                    let info = if key { crate::win::describe_foreground() } else { crate::win::describe_point(x, y) };
                    let mut ev = json!({"event": "summon", "trigger": if key { "key" } else { "mouse" }, "x": x, "y": y, "time": time});
                    if let (Some(obj), Some(extra)) = (ev.as_object_mut(), info.as_object()) {
                        for (k, v) in extra {
                            obj.insert(k.clone(), v.clone());
                        }
                    }
                    crate::emit(ev);
                }
                HookMsg::Escape => crate::emit(json!({"event": "key", "key": "Escape"})),
                HookMsg::Activity(source) => crate::emit(json!({"event": "activity", "source": source})),
                HookMsg::Ptt(down) => crate::emit(json!({"event": "ptt", "down": down})),
            }
        }
    });

    std::thread::spawn(|| unsafe {
        use windows::Win32::UI::HiDpi::*;
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        HOOK_THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
        let hmod = GetModuleHandleW(None).ok().map(|h| HINSTANCE(h.0));
        let mut kh = SetWindowsHookExW(WH_KEYBOARD_LL, Some(kbd_proc), hmod, 0);
        let mut mh: Option<HHOOK> = None;
        if want_mouse_hook() {
            mh = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), hmod, 0).ok();
        }
        match &kh {
            Ok(_) => crate::emit(json!({"event": "hook", "status": "installed", "mouse": mh.is_some()})),
            Err(e) => crate::emit(json!({"event": "hook", "status": "failed", "message": e.to_string()})),
        }
        // Watchdog: Windows silently removes LL hooks that ever exceed
        // LowLevelHooksTimeout. Re-install periodically (new first, then drop
        // the old, so there is no gap). No input is injected, so this never
        // resets the user's idle timer.
        let _ = SetTimer(None, 0, 30_000, None);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.message == WM_TIMER || msg.message == WM_APP_REINSTALL {
                if let Ok(nk) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(kbd_proc), hmod, 0) {
                    if let Ok(h) = kh {
                        let _ = UnhookWindowsHookEx(h);
                    }
                    kh = Ok(nk);
                } else {
                    crate::emit(json!({"event": "hook", "status": "reinstall_failed"}));
                }
                let want_mouse = want_mouse_hook();
                if want_mouse {
                    if let Ok(nm) = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), hmod, 0) {
                        if let Some(h) = mh.take() {
                            let _ = UnhookWindowsHookEx(h);
                        }
                        mh = Some(nm);
                    }
                } else if let Some(h) = mh.take() {
                    let _ = UnhookWindowsHookEx(h);
                }
                continue;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if let Ok(h) = kh {
            let _ = UnhookWindowsHookEx(h);
        }
        if let Some(h) = mh {
            let _ = UnhookWindowsHookEx(h);
        }
    });
}

/// Are the hooks running (false with --no-hook)?
pub fn running() -> bool {
    HOOK_THREAD.load(Ordering::SeqCst) != 0
}

/// Ask the hook thread to re-install hooks now (also reconciles the mouse hook).
pub fn reinstall() {
    let tid = HOOK_THREAD.load(Ordering::SeqCst);
    if tid != 0 {
        unsafe {
            let _ = PostThreadMessageW(tid, WM_APP_REINSTALL, WPARAM(0), LPARAM(0));
        }
    }
}

pub fn stop() {
    let tid = HOOK_THREAD.load(Ordering::SeqCst);
    if tid != 0 {
        unsafe {
            let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
}

/// C1: with a scan-code binding, the physical key counts as the bound VK on any
/// layout, and a different key that happens to produce the bound VK doesn't.
pub fn effective_vk(vk: u32, scan: u32, extended: bool, bind_vk: u32, bind_scan: u32) -> u32 {
    if bind_scan == 0 {
        return vk;
    }
    if scan == bind_scan && !extended {
        bind_vk
    } else if vk == bind_vk {
        0x1_0000 // never matches a binding
    } else {
        vk
    }
}

// ------------------------------------------------------------ key buffer --

static BUFFER_UNTIL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static KEY_BUFFER: std::sync::Mutex<Vec<(u32, u32, bool, bool)>> = std::sync::Mutex::new(Vec::new());
/// REVIEW-3 KB-2: the keyboard layout of the app the user was typing in.
static BUFFER_HKL: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

fn now_ms() -> u64 {
    static T0: OnceLock<std::time::Instant> = OnceLock::new();
    T0.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64 + 1
}

fn buffering() -> bool {
    let until = BUFFER_UNTIL.load(Ordering::Relaxed);
    until != 0 && now_ms() < until
}

#[derive(Debug, PartialEq, Eq)]
pub enum BufferDecision {
    Hold,
    Pass,
    Stop,
}

/// Pure rule: printable keys, Space and Backspace are held; Shift/CapsLock pass
/// (they shape the text); any Ctrl/Alt/Win chord, Esc, Enter or navigation key
/// ends buffering and passes through untouched.
pub fn buffer_decision(vk: u32, down: bool, up: bool, mods_held: bool) -> BufferDecision {
    let shiftish = matches!(vk, 0x10 | 0xA0 | 0xA1 | 0x14);
    if shiftish {
        return BufferDecision::Pass;
    }
    // REVIEW-3 KB-1: Enter is held too (it becomes "submit" in the panel), so a
    // fast "Ctrl+~ hello⏎" never sends the chat line underneath.
    let printable = vk == 0x0D || vk == 0x20 || vk == 0x08 || (0x30..=0x39).contains(&vk) || (0x41..=0x5A).contains(&vk) || (0x60..=0x6F).contains(&vk) || (0xBA..=0xC0).contains(&vk) || (0xDB..=0xDF).contains(&vk) || vk == 0xE2;
    if mods_held || !printable {
        return if down { BufferDecision::Stop } else { BufferDecision::Pass };
    }
    if down || up {
        BufferDecision::Hold
    } else {
        BufferDecision::Pass
    }
}

/// `buffer_keys {ms}`: start holding keystrokes (called the moment a summon opens the panel).
pub fn start_buffer(ms: u64) {
    if let Ok(mut b) = KEY_BUFFER.lock() {
        b.clear();
    }
    unsafe {
        let fg = GetForegroundWindow();
        let tid = GetWindowThreadProcessId(fg, None);
        BUFFER_HKL.store(GetKeyboardLayout(tid).0 as isize, Ordering::SeqCst);
    }
    BUFFER_UNTIL.store(now_ms() + ms.clamp(50, 2000), Ordering::SeqCst);
}

/// `take_buffered_keys`: stop holding and return the held keys as text (Backspace applied).
pub fn take_buffer() -> Value {
    BUFFER_UNTIL.store(0, Ordering::SeqCst);
    let keys: Vec<(u32, u32, bool, bool)> = KEY_BUFFER.lock().map(|mut b| std::mem::take(&mut *b)).unwrap_or_default();
    let mut text = String::new();
    let mut submit = false;
    unsafe {
        let saved = BUFFER_HKL.load(Ordering::SeqCst);
        let layout = if saved != 0 { HKL(saved as *mut core::ffi::c_void) } else { GetKeyboardLayout(0) };
        for (vk, scan, shift, caps) in keys {
            if vk == 0x08 {
                text.pop();
                continue;
            }
            if vk == 0x0D {
                // Enter submits what was typed; anything after it is dropped.
                submit = true;
                break;
            }
            let mut state = [0u8; 256];
            if shift {
                state[0x10] = 0x80;
            }
            if caps {
                state[0x14] = 0x01;
            }
            let mut buf = [0u16; 8];
            // flags bit 2: don't change the keyboard state (Win10 1607+).
            let n = ToUnicodeEx(vk, scan, &state, &mut buf, 4, Some(layout));
            if n > 0 {
                text.push_str(&String::from_utf16_lossy(&buf[..n as usize]));
            }
        }
    }
    json!({"text": text, "submit": submit})
}

pub fn status() -> Value {
    json!({
        "mouseHook": BIND_MOUSE.load(Ordering::SeqCst),
        "vk": BIND_VK.load(Ordering::SeqCst),
        "scan": BIND_SCAN.load(Ordering::SeqCst),
        "mods": BIND_MODS.load(Ordering::SeqCst),
        "button": BIND_BUTTON.load(Ordering::SeqCst),
        "enabled": ENABLED.load(Ordering::SeqCst),
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn keys_after_the_shortcut_are_held_until_the_panel_takes_them() {
        use super::{buffer_decision, BufferDecision::*};
        assert_eq!(buffer_decision(0x41, true, false, false), Hold, "letters are held");
        assert_eq!(buffer_decision(0x41, false, true, false), Hold, "and their key-ups");
        assert_eq!(buffer_decision(0x20, true, false, false), Hold, "space");
        assert_eq!(buffer_decision(0x08, true, false, false), Hold, "backspace edits the held text");
        assert_eq!(buffer_decision(0xA0, true, false, false), Pass, "shift shapes the text");
        assert_eq!(buffer_decision(0x41, true, false, true), Stop, "a Ctrl/Alt/Win chord ends buffering");
        assert_eq!(buffer_decision(0x0D, true, false, false), Hold, "Enter is held and becomes submit (KB-1)");
        assert_eq!(buffer_decision(0x1B, true, false, false), Stop, "Esc is never swallowed");
    }

    #[test]
    fn set_binding_round_trips_so_a_restart_resend_restores_it() {
        use super::{set_binding, status};
        // What the app re-sends after every helper (re)start (H1): a custom key binding...
        set_binding(&serde_json::json!({"kind":"key","vk":0x4A,"scan":0,"ctrl":true,"alt":true,"shift":false,"win":false,"anyShift":false})).unwrap();
        let st = status();
        assert_eq!(st["vk"], 0x4A);
        assert_eq!(st["scan"], 0);
        assert_eq!(st["mods"].as_u64().unwrap() & 3, 3);
        // ...and back to the layout-independent default.
        set_binding(&serde_json::json!({"kind":"key","vk":0xC0,"scan":0x29,"ctrl":true,"alt":false,"shift":false,"win":false,"anyShift":true})).unwrap();
        let st = status();
        assert_eq!(st["vk"], 0xC0);
        assert_eq!(st["scan"], 0x29);
        assert!(set_binding(&serde_json::json!({"kind":"key","vk":0})).is_err());
    }

    #[test]
    fn scan_code_bindings_are_layout_independent() {
        use super::effective_vk;
        // US: the key below Esc is VK_OEM_3 (0xC0), scan 0x29.
        assert_eq!(effective_vk(0xC0, 0x29, false, 0xC0, 0x29), 0xC0);
        // German layout: same physical key reports VK_OEM_5 (^) -> still the binding.
        assert_eq!(effective_vk(0xDC, 0x29, false, 0xC0, 0x29), 0xC0);
        // UK layout: VK_OEM_3 is the ' key (scan 0x28) -> must NOT summon.
        assert_ne!(effective_vk(0xC0, 0x28, false, 0xC0, 0x29), 0xC0);
        // VK-only bindings are unchanged.
        assert_eq!(effective_vk(0x4A, 0x24, false, 0x4A, 0), 0x4A);
        assert_eq!(effective_vk(0x41, 0x1E, false, 0xC0, 0x29), 0x41);
    }

    use super::*;

    const DEFAULT: u32 = 1 | 16; // Ctrl + any Shift

    #[test]
    fn default_binding_matches_ctrl_backtick_and_ctrl_shift_backtick() {
        assert!(mods_match_bits(DEFAULT, true, false, false, false));
        assert!(mods_match_bits(DEFAULT, true, false, true, false));
        assert!(!mods_match_bits(DEFAULT, false, false, false, false), "plain ` must type");
        assert!(!mods_match_bits(DEFAULT, true, true, false, false), "Ctrl+Alt+` is not the binding");
        assert!(!mods_match_bits(DEFAULT, true, false, false, true), "Win must not be held");
    }

    #[test]
    fn exact_shift_when_any_shift_is_off() {
        let ctrl_alt_j = 1 | 2;
        assert!(mods_match_bits(ctrl_alt_j, true, true, false, false));
        assert!(!mods_match_bits(ctrl_alt_j, true, true, true, false));
    }

    #[test]
    fn swallow_fsm_swallows_down_repeats_and_up_then_resets() {
        let mut sw = 0u32;
        let vk = 0xC0;
        assert_eq!(key_decision(&mut sw, vk, vk, true, false, true), KeyDecision::Summon);
        assert_eq!(key_decision(&mut sw, vk, vk, true, false, true), KeyDecision::Swallow, "auto-repeat");
        assert_eq!(key_decision(&mut sw, vk, vk, false, true, true), KeyDecision::Swallow, "key-up");
        assert_eq!(sw, 0);
        assert_eq!(key_decision(&mut sw, vk, vk, true, false, false), KeyDecision::PassThrough, "no modifiers -> types");
        assert_eq!(key_decision(&mut sw, vk, 0x41, true, false, true), KeyDecision::PassThrough, "other keys untouched");
    }
}
