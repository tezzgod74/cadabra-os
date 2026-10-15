//! Synthetic input via SendInput. Coordinates are physical pixels.
//! After a click/scroll the user's cursor is restored to where it was, so the
//! real cursor "stays theirs" (unless `restoreCursor: false`).

use crate::RpcResult;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::sleep;
use std::time::Duration;

/// Kill switch for in-flight input. Set by a physical Esc (keyboard hook) or
/// the `cancel` RPC; checked between every keystroke, chord, click and scroll
/// step. Cleared at the start of each new input call.
pub static CANCEL: AtomicBool = AtomicBool::new(false);
/// REVIEW-2 #7 cancel epochs. Every input call carries the run's `epoch`
/// (TS increments it per run). A cancel marks the newest epoch seen (or the
/// one the `cancel` RPC names) as cancelled, so an Esc that lands *between*
/// two input calls of a run is never lost: the next call is refused.
/// Epoch 0 = legacy callers (tests/smoke): only the CANCEL flag applies.
pub static LAST_EPOCH: AtomicU64 = AtomicU64::new(0);
pub static CANCELLED_EPOCH: AtomicU64 = AtomicU64::new(0);

pub fn request_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
    CANCELLED_EPOCH.fetch_max(LAST_EPOCH.load(Ordering::SeqCst), Ordering::SeqCst);
}

/// `cancel` RPC with an explicit epoch (the run TS is stopping).
pub fn request_cancel_epoch(epoch: u64) {
    LAST_EPOCH.fetch_max(epoch, Ordering::SeqCst);
    CANCELLED_EPOCH.fetch_max(epoch, Ordering::SeqCst);
    CANCEL.store(true, Ordering::SeqCst);
}

fn cancelled() -> bool {
    CANCEL.load(Ordering::SeqCst)
}

/// Pure epoch rule (unit-tested).
pub fn epoch_allowed(epoch: u64, cancelled_epoch: u64) -> bool {
    epoch == 0 || epoch > cancelled_epoch
}

/// Start an input call: refuse a cancelled run, then clear the flag left by
/// an *earlier* run.
fn begin(p: &Value) -> Result<(), String> {
    let epoch = p.get("epoch").and_then(|v| v.as_u64()).unwrap_or(0);
    if epoch > 0 {
        LAST_EPOCH.fetch_max(epoch, Ordering::SeqCst);
    }
    if !epoch_allowed(epoch, CANCELLED_EPOCH.load(Ordering::SeqCst)) {
        return Err(CANCELLED.into());
    }
    CANCEL.store(false, Ordering::SeqCst);
    // Re-check: an Esc between the epoch check and the clear must still win.
    if !epoch_allowed(epoch, CANCELLED_EPOCH.load(Ordering::SeqCst)) {
        return Err(CANCELLED.into());
    }
    Ok(())
}

const CANCELLED: &str = "cancelled by the user (Esc)";
/// Longest text one type_text call may type (B1: no unbounded typing).
pub const MAX_TYPE_CHARS: usize = 2000;
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;

fn num(p: &Value, k: &str) -> Option<f64> {
    p.get(k).and_then(|v| v.as_f64())
}

fn send(inputs: &[INPUT]) -> Result<(), String> {
    let n = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if n as usize != inputs.len() {
        return Err(format!("SendInput inserted {n}/{} events (blocked by UIPI or another input desktop?)", inputs.len()));
    }
    Ok(())
}

fn mouse(flags: MOUSE_EVENT_FLAGS, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

fn key(vk: VIRTUAL_KEY, up: bool) -> INPUT {
    let mut flags = if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) };
    if crate::keys::is_extended(vk) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    let scan = unsafe { MapVirtualKeyW(vk.0 as u32, MAPVK_VK_TO_VSC) } as u16;
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

fn unicode(unit: u16, up: bool) -> INPUT {
    let mut flags = KEYEVENTF_UNICODE;
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0), wScan: unit, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

fn get_cursor() -> POINT {
    let mut pt = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut pt);
    }
    pt
}

fn set_cursor(x: i32, y: i32) -> Result<(), String> {
    unsafe { SetCursorPos(x, y).map_err(|e| e.to_string()) }
}

/// The user may still be holding Ctrl from the Ctrl+right-click trigger (or
/// another modifier). Injected keys would combine with it ("a" -> Ctrl+A), so
/// wait briefly for physical modifiers to be released.
fn wait_modifiers_released() -> Result<(), String> {
    let mods = [VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN];
    for _ in 0..75 {
        let held = mods.iter().any(|vk| unsafe { (GetAsyncKeyState(vk.0 as i32) as u16 & 0x8000) != 0 });
        if !held {
            return Ok(());
        }
        sleep(Duration::from_millis(20));
    }
    Err("a modifier key (Ctrl/Shift/Alt/Win) is being held down; release it and retry".into())
}

pub fn move_cursor(p: &Value) -> RpcResult {
    let x = num(p, "x").ok_or("missing x")?.round() as i32;
    let y = num(p, "y").ok_or("missing y")?.round() as i32;
    set_cursor(x, y)?;
    Ok(json!(true))
}

pub fn click(p: &Value) -> RpcResult {
    let x = num(p, "x").ok_or("missing x")?.round() as i32;
    let y = num(p, "y").ok_or("missing y")?.round() as i32;
    let button = p.get("button").and_then(|v| v.as_str()).unwrap_or("left");
    let count = p.get("count").and_then(|v| v.as_u64()).unwrap_or(1).clamp(1, 3);
    let restore = p.get("restoreCursor").and_then(|v| v.as_bool()).unwrap_or(true);
    let (down, up) = match button {
        "left" => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        _ => return Err(format!("bad button: {button}")),
    };
    begin(p)?;
    wait_modifiers_released()?;
    if cancelled() {
        return Err(CANCELLED.into());
    }
    let before = get_cursor();
    set_cursor(x, y)?;
    sleep(Duration::from_millis(30));
    let res = (|| {
        for _ in 0..count {
            if cancelled() {
                return Err(CANCELLED.to_string());
            }
            send(&[mouse(down, 0)])?;
            sleep(Duration::from_millis(25));
            send(&[mouse(up, 0)])?;
            sleep(Duration::from_millis(40));
        }
        Ok::<(), String>(())
    })();
    if restore {
        sleep(Duration::from_millis(30));
        let _ = set_cursor(before.x, before.y);
    }
    res?;
    Ok(json!({"x": x, "y": y, "button": button, "count": count}))
}

pub fn scroll(p: &Value) -> RpcResult {
    let dy = num(p, "dy").unwrap_or(0.0); // notches; positive = down
    let dx = num(p, "dx").unwrap_or(0.0);
    let restore = p.get("restoreCursor").and_then(|v| v.as_bool()).unwrap_or(true);
    begin(p)?;
    if cancelled() {
        return Err(CANCELLED.into());
    }
    let before = get_cursor();
    if let (Some(x), Some(y)) = (num(p, "x"), num(p, "y")) {
        set_cursor(x.round() as i32, y.round() as i32)?;
        sleep(Duration::from_millis(30));
    }
    let res = (|| {
        if dy != 0.0 {
            send(&[mouse(MOUSEEVENTF_WHEEL, (-dy * WHEEL_DELTA as f64).round() as i32)])?;
        }
        if dx != 0.0 {
            send(&[mouse(MOUSEEVENTF_HWHEEL, (dx * WHEEL_DELTA as f64).round() as i32)])?;
        }
        Ok::<(), String>(())
    })();
    if restore {
        sleep(Duration::from_millis(30));
        let _ = set_cursor(before.x, before.y);
    }
    res?;
    Ok(json!(true))
}

/// One typing step: a key event pair or a UTF-16 unit pair.
#[derive(Debug, Clone, PartialEq)]
pub enum TypeStep {
    Enter,
    Tab,
    Unit(u16),
}

pub fn type_plan(text: &str) -> Vec<TypeStep> {
    let mut out = Vec::new();
    for ch in text.chars() {
        match ch {
            '\n' => out.push(TypeStep::Enter),
            '\r' => {}
            '\t' => out.push(TypeStep::Tab),
            _ => {
                let mut buf = [0u16; 2];
                for unit in ch.encode_utf16(&mut buf) {
                    out.push(TypeStep::Unit(*unit));
                }
            }
        }
    }
    out
}

/// Type the plan, checking the kill switch before every step. `send_step`
/// performs the step (SendInput in production, a recorder in tests).
pub fn type_with(plan: &[TypeStep], delay_ms: u64, mut send_step: impl FnMut(&TypeStep) -> Result<(), String>) -> Result<usize, String> {
    let mut n = 0usize;
    for st in plan {
        if cancelled() {
            return Err(format!("{CANCELLED} after {n} keystrokes"));
        }
        send_step(st)?;
        n += 1;
        if delay_ms > 0 {
            sleep(Duration::from_millis(delay_ms));
        }
    }
    Ok(n)
}

pub fn type_text(p: &Value) -> RpcResult {
    let text = p.get("text").and_then(|v| v.as_str()).ok_or("missing text")?;
    if text.chars().count() > MAX_TYPE_CHARS {
        return Err(format!("text is longer than {MAX_TYPE_CHARS} characters; type it in smaller parts"));
    }
    let delay = p.get("delayMs").and_then(|v| v.as_u64()).unwrap_or(4).min(200);
    begin(p)?;
    wait_modifiers_released()?;
    let plan = type_plan(text);
    let n = type_with(&plan, delay, |st| match st {
        TypeStep::Enter => send(&[key(VK_RETURN, false), key(VK_RETURN, true)]),
        TypeStep::Tab => send(&[key(VK_TAB, false), key(VK_TAB, true)]),
        TypeStep::Unit(u) => send(&[unicode(*u, false), unicode(*u, true)]),
    })?;
    Ok(json!({"typed": n}))
}

pub fn press_keys(p: &Value) -> RpcResult {
    let chord = p.get("keys").and_then(|v| v.as_str()).ok_or("missing keys")?;
    let repeat = p.get("repeat").and_then(|v| v.as_u64()).unwrap_or(1).clamp(1, 50);
    let vks = crate::keys::parse_chord(chord)?;
    begin(p)?;
    wait_modifiers_released()?;
    for _ in 0..repeat {
        if cancelled() {
            return Err(CANCELLED.into());
        }
        let mut seq: Vec<INPUT> = vks.iter().map(|vk| key(*vk, false)).collect();
        seq.extend(vks.iter().rev().map(|vk| key(*vk, true)));
        send(&seq)?;
        sleep(Duration::from_millis(30));
    }
    Ok(json!({"keys": chord, "repeat": repeat}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // CANCEL is process-global; serialize the tests that touch it.
    static LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn plan_handles_newlines_tabs_and_surrogates() {
        assert_eq!(type_plan("a\r\nb\t"), vec![TypeStep::Unit(b'a' as u16), TypeStep::Enter, TypeStep::Unit(b'b' as u16), TypeStep::Tab]);
        assert_eq!(type_plan("✨").len(), 1);
        assert_eq!(type_plan("😀").len(), 2); // surrogate pair
    }

    #[test]
    fn cancel_stops_typing_between_keystrokes() {
        let _g = LOCK.lock().unwrap();
        CANCEL.store(false, Ordering::SeqCst);
        let plan = type_plan("hello world, this is a long paragraph");
        let mut sent = 0;
        let r = type_with(&plan, 0, |_| {
            sent += 1;
            if sent == 5 {
                request_cancel(); // the user presses Esc mid-typing
            }
            Ok(())
        });
        assert!(r.is_err(), "typing must stop");
        assert_eq!(sent, 5, "no keystroke after the cancel");
        CANCEL.store(false, Ordering::SeqCst);
    }

    #[test]
    fn a_cancel_between_calls_is_not_cleared_by_the_next_call() {
        let _g = LOCK.lock().unwrap();
        CANCEL.store(false, Ordering::SeqCst);
        // Run 7 starts typing...
        assert!(begin(&json!({"epoch": 7})).is_ok());
        // ...Esc lands while TS is animating the ghost (between helper calls).
        request_cancel();
        // The next input call of the same run must be refused, not reset the flag.
        assert!(begin(&json!({"epoch": 7})).is_err());
        assert!(begin(&json!({"epoch": 7})).is_err());
        // A new run (epoch 8) works again.
        assert!(begin(&json!({"epoch": 8})).is_ok());
        // cancel RPC naming run 9 refuses run 9 even before it typed anything.
        request_cancel_epoch(9);
        assert!(begin(&json!({"epoch": 9})).is_err());
        assert!(begin(&json!({"epoch": 10})).is_ok());
        assert!(epoch_allowed(0, 99), "legacy callers are unaffected by epochs");
        CANCEL.store(false, Ordering::SeqCst);
    }

    #[test]
    fn typing_completes_when_not_cancelled() {
        let _g = LOCK.lock().unwrap();
        CANCEL.store(false, Ordering::SeqCst);
        let plan = type_plan("abc");
        let mut sent = 0;
        assert_eq!(type_with(&plan, 0, |_| { sent += 1; Ok(()) }), Ok(3));
        assert_eq!(sent, 3);
    }
}
