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

/// A real key press for one character (0.9.12): the virtual key with the
/// layout's scan code, plus the modifiers the layout needs for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyStroke {
    pub vk: u16,
    pub scan: u16,
    pub shift: bool,
    /// AltGr (sent as Ctrl+Alt, which Windows treats as AltGr).
    pub altgr: bool,
}

/// One typing step: Enter/Tab, a real keystroke, or a UTF-16 unit (VK_PACKET).
#[derive(Debug, Clone, PartialEq)]
pub enum TypeStep {
    Enter,
    Tab,
    Unit(u16),
    Key(KeyStroke),
}

/// Settings → Advanced → Typing method (0.9.12).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TypeMethod {
    /// Real keystrokes for every character on the target's keyboard layout, Unicode for the rest.
    Auto,
    /// Real keystrokes only (fails up front if a character isn't on the layout).
    Keys,
    /// Every character as a Unicode packet (the pre-0.9.12 behaviour).
    Unicode,
}

impl TypeMethod {
    pub fn parse(s: Option<&str>) -> TypeMethod {
        match s {
            Some("keys") => TypeMethod::Keys,
            Some("unicode") => TypeMethod::Unicode,
            _ => TypeMethod::Auto,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            TypeMethod::Auto => "auto",
            TypeMethod::Keys => "keys",
            TypeMethod::Unicode => "unicode",
        }
    }
}

/// Modifier bits as VkKeyScanEx reports them.
pub const MOD_SHIFT_BIT: u8 = 1;
pub const MOD_CTRL_BIT: u8 = 2;
pub const MOD_ALT_BIT: u8 = 4;

/// A keyboard layout, abstracted so the plan can be unit-tested with tables.
pub trait KeyLayout {
    /// VkKeyScanEx: the key and modifier bits for `ch`, or None.
    fn key_for(&self, ch: char) -> Option<(u16, u8)>;
    /// Does pressing `vk` with `mods` (current Caps Lock included) type exactly
    /// `ch` straight away? False for dead keys and anything else.
    fn produces(&self, vk: u16, mods: u8, ch: char) -> bool;
    /// The layout's scan code for `vk`.
    fn scan(&self, vk: u16) -> u16;
}

/// The keystroke for `ch` on `layout`, if it can be typed with one real key
/// press (no modifiers besides Shift / AltGr, and not through a dead key).
pub fn keystroke_for(ch: char, layout: &dyn KeyLayout) -> Option<KeyStroke> {
    if (ch as u32) > 0xFFFF || ch.is_control() {
        return None;
    }
    let (vk, mods) = layout.key_for(ch)?;
    if vk == 0 || mods & !(MOD_SHIFT_BIT | MOD_CTRL_BIT | MOD_ALT_BIT) != 0 {
        return None; // Kana / OEM modifier states: not ours to fake
    }
    let altgr = mods & (MOD_CTRL_BIT | MOD_ALT_BIT);
    if altgr != 0 && altgr != (MOD_CTRL_BIT | MOD_ALT_BIT) {
        return None; // Ctrl-only or Alt-only would be a shortcut, not a character
    }
    // Caps Lock can invert Shift for letters: try the reported state, then the other.
    for m in [mods, mods ^ MOD_SHIFT_BIT] {
        if layout.produces(vk, m, ch) {
            return Some(KeyStroke { vk, scan: layout.scan(vk), shift: m & MOD_SHIFT_BIT != 0, altgr: altgr != 0 });
        }
    }
    None
}

/// The typing plan for `text` with the given method and target layout.
pub fn plan_for(text: &str, method: TypeMethod, layout: &dyn KeyLayout) -> Result<Vec<TypeStep>, String> {
    let mut out = Vec::new();
    let mut missing: Vec<char> = Vec::new();
    for ch in text.chars() {
        match ch {
            '\n' => out.push(TypeStep::Enter),
            '\r' => {}
            '\t' => out.push(TypeStep::Tab),
            _ => {
                let k = if method == TypeMethod::Unicode { None } else { keystroke_for(ch, layout) };
                match k {
                    Some(k) => out.push(TypeStep::Key(k)),
                    None => {
                        if method == TypeMethod::Keys && !missing.contains(&ch) {
                            missing.push(ch);
                        }
                        let mut buf = [0u16; 2];
                        for unit in ch.encode_utf16(&mut buf) {
                            out.push(TypeStep::Unit(*unit));
                        }
                    }
                }
            }
        }
    }
    if !missing.is_empty() {
        let list: String = missing.iter().take(10).map(|c| format!("“{c}” ")).collect();
        return Err(format!(
            "these characters aren't on this keyboard layout, so they can't be typed with real keystrokes: {}(set Typing method to Auto to send them as Unicode)",
            list
        ));
    }
    Ok(out)
}

/// The pre-0.9.12 plan: every character as Unicode (tests).
#[cfg(test)]
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
#[cfg(test)]
pub fn type_with(plan: &[TypeStep], delay_ms: u64, send_step: impl FnMut(&TypeStep) -> Result<(), String>) -> Result<usize, String> {
    type_with_paced(plan, |_| delay_ms, send_step)
}

/// Like type_with, with a per-step pause (0.9.13: Unicode packets need more room).
pub fn type_with_paced(plan: &[TypeStep], pause: impl Fn(&TypeStep) -> u64, mut send_step: impl FnMut(&TypeStep) -> Result<(), String>) -> Result<usize, String> {
    let mut n = 0usize;
    for st in plan {
        if cancelled() {
            return Err(format!("{CANCELLED} after {n} keystrokes"));
        }
        send_step(st)?;
        n += 1;
        let ms = pause(st);
        if ms > 0 {
            sleep(Duration::from_millis(ms));
        }
    }
    Ok(n)
}

/// The keyboard layout of the window that will receive the keys (0.9.12).
pub struct WinLayout {
    hkl: HKL,
}

impl WinLayout {
    /// The layout of `hwnd`'s thread, or of the foreground window's.
    pub fn for_window(hwnd: Option<windows::Win32::Foundation::HWND>) -> WinLayout {
        unsafe {
            let h = hwnd.unwrap_or_else(|| GetForegroundWindow());
            let tid = GetWindowThreadProcessId(h, None);
            WinLayout { hkl: GetKeyboardLayout(tid) }
        }
    }
    /// This thread's layout (tests).
    #[cfg(test)]
    pub fn current_thread() -> WinLayout {
        WinLayout { hkl: unsafe { GetKeyboardLayout(0) } }
    }
    pub fn id(&self) -> String {
        format!("{:08x}", self.hkl.0 as usize as u32)
    }
}

impl KeyLayout for WinLayout {
    fn key_for(&self, ch: char) -> Option<(u16, u8)> {
        let r = unsafe { VkKeyScanExW(ch as u16, self.hkl) };
        if r == -1 {
            return None;
        }
        Some(((r as u16) & 0xff, ((r as u16) >> 8) as u8))
    }
    fn produces(&self, vk: u16, mods: u8, ch: char) -> bool {
        let mut state = [0u8; 256];
        if mods & MOD_SHIFT_BIT != 0 {
            state[VK_SHIFT.0 as usize] = 0x80;
            state[VK_LSHIFT.0 as usize] = 0x80;
        }
        if mods & MOD_CTRL_BIT != 0 {
            state[VK_CONTROL.0 as usize] = 0x80;
            state[VK_LCONTROL.0 as usize] = 0x80;
        }
        if mods & MOD_ALT_BIT != 0 {
            state[VK_MENU.0 as usize] = 0x80;
            state[VK_RMENU.0 as usize] = 0x80;
        }
        if unsafe { GetKeyState(VK_CAPITAL.0 as i32) } & 1 != 0 {
            state[VK_CAPITAL.0 as usize] = 0x01;
        }
        let mut buf = [0u16; 8];
        // Flag 4: don't change the keyboard state (no dead key left pending).
        let n = unsafe { ToUnicodeEx(vk as u32, self.scan(vk) as u32, &state, &mut buf, 4, Some(self.hkl)) };
        n == 1 && buf[0] == ch as u16
    }
    fn scan(&self, vk: u16) -> u16 {
        unsafe { MapVirtualKeyExW(vk as u32, MAPVK_VK_TO_VSC, Some(self.hkl)) as u16 }
    }
}

fn key_scan(vk: VIRTUAL_KEY, scan: u16, up: bool, extended: bool) -> INPUT {
    let mut flags = if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) };
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

/// The events for one real keystroke: modifiers down, key down/up, modifiers up
/// (in one SendInput batch so nothing interleaves and no modifier stays held).
pub fn keystroke_events(k: &KeyStroke) -> Vec<(u16, u16, bool, bool)> {
    // (vk, scan, up, extended)
    let mut down: Vec<(u16, u16, bool, bool)> = Vec::new();
    if k.altgr {
        down.push((VK_LCONTROL.0, 0x1D, false, false));
        down.push((VK_RMENU.0, 0x38, false, true));
    }
    if k.shift {
        down.push((VK_LSHIFT.0, 0x2A, false, false));
    }
    let mut ev = down.clone();
    ev.push((k.vk, k.scan, false, false));
    ev.push((k.vk, k.scan, true, false));
    for (vk, scan, _, ext) in down.into_iter().rev() {
        ev.push((vk, scan, true, ext));
    }
    ev
}

/// 0.9.13 (the garbled-Notepad bug): Windows turns a Unicode packet (VK_PACKET)
/// into its character when the TARGET translates the key message, and a target
/// that falls behind (Windows 11 Notepad pauses while it autocorrects a word)
/// turned queued packets into repeats of one character ("organized          that",
/// "ooooooof ......"). Measured on Notepad: packets 0 and 4 ms apart garble,
/// 15 / 40 / 100 ms apart arrive intact; real keystrokes arrive intact even 0 ms
/// apart. A WM_NULL round trip to the target doesn't help (Notepad handles text
/// input asynchronously), so Unicode packets are paced at twice the measured
/// safe gap. Real keys keep the normal pace.
pub const UNICODE_MIN_DELAY_MS: u64 = 30;

/// The pause after a step.
pub fn step_delay(st: &TypeStep, delay_ms: u64) -> u64 {
    match st {
        TypeStep::Unit(_) => delay_ms.max(UNICODE_MIN_DELAY_MS),
        _ => delay_ms,
    }
}

pub fn type_text(p: &Value) -> RpcResult {
    let text = p.get("text").and_then(|v| v.as_str()).ok_or("missing text")?;
    if text.chars().count() > MAX_TYPE_CHARS {
        return Err(format!("text is longer than {MAX_TYPE_CHARS} characters; type it in smaller parts"));
    }
    let delay = p.get("delayMs").and_then(|v| v.as_u64()).unwrap_or(4).min(200);
    let method = TypeMethod::parse(p.get("method").and_then(|v| v.as_str()));
    begin(p)?;
    wait_modifiers_released()?;
    let hwnd = if p.get("hwnd").is_some() { crate::win::hwnd_param(p).ok() } else { None };
    let layout = WinLayout::for_window(hwnd);
    let plan = plan_for(text, method, &layout)?;
    let (mut keys, mut units) = (0usize, 0usize);
    for st in &plan {
        match st {
            TypeStep::Key(_) => keys += 1,
            TypeStep::Unit(_) => units += 1,
            _ => {}
        }
    }
    let n = type_with_paced(&plan, |st| step_delay(st, delay), |st| match st {
        TypeStep::Enter => send(&[key(VK_RETURN, false), key(VK_RETURN, true)]),
        TypeStep::Tab => send(&[key(VK_TAB, false), key(VK_TAB, true)]),
        TypeStep::Unit(u) => send(&[unicode(*u, false), unicode(*u, true)]),
        TypeStep::Key(k) => {
            let ev: Vec<INPUT> = keystroke_events(k).into_iter().map(|(vk, scan, up, ext)| key_scan(VIRTUAL_KEY(vk), scan, up, ext)).collect();
            send(&ev)
        }
    })?;
    Ok(json!({"typed": n, "method": method.name(), "keystrokes": keys, "unicode": units, "layout": layout.id(), "delayMs": delay}))
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

    use std::collections::HashMap;

    /// A layout from a table: char -> (vk, mods, dead).
    struct Table {
        map: HashMap<char, (u16, u8, bool)>,
        caps: bool,
    }
    impl KeyLayout for Table {
        fn key_for(&self, ch: char) -> Option<(u16, u8)> {
            self.map.get(&ch).map(|&(vk, m, _)| (vk, m))
        }
        fn produces(&self, vk: u16, mods: u8, ch: char) -> bool {
            let Some(&(v, m, dead)) = self.map.get(&ch) else { return false };
            if dead || v != vk {
                return false;
            }
            // Caps Lock inverts Shift for letters.
            let want = if self.caps && ch.is_alphabetic() { m ^ MOD_SHIFT_BIT } else { m };
            mods == want
        }
        fn scan(&self, vk: u16) -> u16 {
            vk + 0x100 // recognisable fake scan codes
        }
    }

    /// en-US: letters, digits, punctuation (shifted and not).
    fn us(caps: bool) -> Table {
        let mut map = HashMap::new();
        for c in 'a'..='z' {
            map.insert(c, (c.to_ascii_uppercase() as u16, 0, false));
            map.insert(c.to_ascii_uppercase(), (c.to_ascii_uppercase() as u16, MOD_SHIFT_BIT, false));
        }
        for (i, c) in "0123456789".chars().enumerate() {
            map.insert(c, (0x30 + i as u16, 0, false));
        }
        for (i, c) in ")!@#$%^&*(".chars().enumerate() {
            map.insert(c, (0x30 + i as u16, MOD_SHIFT_BIT, false));
        }
        map.insert(' ', (0x20, 0, false));
        map.insert('.', (0xBE, 0, false));
        map.insert(',', (0xBC, 0, false));
        map.insert('?', (0xBF, MOD_SHIFT_BIT, false));
        map.insert('/', (0xBF, 0, false));
        Table { map, caps }
    }

    /// de-DE: z/y swapped, AltGr for @ € { and a dead ^ / ´.
    fn de() -> Table {
        let mut map = HashMap::new();
        map.insert('z', (0x59, 0, false)); // the key labelled Z is VK_Y on QWERTZ
        map.insert('y', (0x5A, 0, false));
        map.insert('ö', (0xC0, 0, false));
        map.insert('@', (0x51, MOD_CTRL_BIT | MOD_ALT_BIT, false)); // AltGr+Q
        map.insert('€', (0x45, MOD_CTRL_BIT | MOD_ALT_BIT, false)); // AltGr+E
        map.insert('{', (0x37, MOD_CTRL_BIT | MOD_ALT_BIT, false)); // AltGr+7
        map.insert('^', (0xDC, 0, true)); // dead key
        map.insert('´', (0xDD, 0, true)); // dead key
        map.insert('"', (0x32, MOD_SHIFT_BIT, false));
        map.insert('\u{1}', (0x41, MOD_CTRL_BIT, false)); // Ctrl+A: never typed as a key
        Table { map, caps: false }
    }

    fn k(vk: u16, shift: bool, altgr: bool) -> TypeStep {
        TypeStep::Key(KeyStroke { vk, scan: vk + 0x100, shift, altgr })
    }

    #[test]
    fn letters_digits_punctuation_and_shifted_chars_become_real_keystrokes() {
        let plan = plan_for("aZ9!? ,", TypeMethod::Auto, &us(false)).unwrap();
        assert_eq!(plan, vec![k(0x41, false, false), k(0x5A, true, false), k(0x39, false, false), k(0x31, true, false), k(0xBF, true, false), k(0x20, false, false), k(0xBC, false, false)]);
    }

    #[test]
    fn caps_lock_flips_shift_for_letters_only() {
        let plan = plan_for("aA1!", TypeMethod::Auto, &us(true)).unwrap();
        assert_eq!(plan, vec![k(0x41, true, false), k(0x41, false, false), k(0x31, false, false), k(0x31, true, false)]);
    }

    #[test]
    fn german_layout_uses_its_own_keys_and_altgr() {
        let plan = plan_for("zy@€{ö\"", TypeMethod::Auto, &de()).unwrap();
        assert_eq!(plan, vec![k(0x59, false, false), k(0x5A, false, false), k(0x51, false, true), k(0x45, false, true), k(0x37, false, true), k(0xC0, false, false), k(0x32, true, false)]);
    }

    #[test]
    fn dead_keys_and_missing_chars_fall_back_to_unicode_in_auto() {
        let plan = plan_for("^´ñ😀", TypeMethod::Auto, &de()).unwrap();
        assert_eq!(plan, vec![TypeStep::Unit('^' as u16), TypeStep::Unit('´' as u16), TypeStep::Unit('ñ' as u16), TypeStep::Unit(0xD83D), TypeStep::Unit(0xDE00)]);
    }

    #[test]
    fn ctrl_only_or_control_chars_are_never_sent_as_shortcuts() {
        assert_eq!(keystroke_for('\u{1}', &de()), None);
    }

    #[test]
    fn newline_and_tab_stay_enter_and_tab_in_every_method() {
        for m in [TypeMethod::Auto, TypeMethod::Keys, TypeMethod::Unicode] {
            assert_eq!(plan_for("a\r\nb\t", m, &us(false)).unwrap()[1..], [TypeStep::Enter, if m == TypeMethod::Unicode { TypeStep::Unit('b' as u16) } else { k(0x42, false, false) }, TypeStep::Tab]);
        }
    }

    #[test]
    fn unicode_method_never_sends_keystrokes() {
        assert_eq!(plan_for("aZ", TypeMethod::Unicode, &us(false)).unwrap(), vec![TypeStep::Unit('a' as u16), TypeStep::Unit('Z' as u16)]);
    }

    #[test]
    fn keys_only_refuses_up_front_when_a_char_is_not_on_the_layout() {
        let e = plan_for("hi 😀", TypeMethod::Keys, &us(false)).unwrap_err();
        assert!(e.contains("😀"), "{e}");
        assert!(plan_for("hi", TypeMethod::Keys, &us(false)).is_ok());
    }

    #[test]
    fn keystroke_events_press_and_release_modifiers_around_the_key() {
        let ev = keystroke_events(&KeyStroke { vk: 0x51, scan: 0x10, shift: false, altgr: true });
        let names: Vec<(u16, bool)> = ev.iter().map(|e| (e.0, e.2)).collect();
        assert_eq!(names, vec![(VK_LCONTROL.0, false), (VK_RMENU.0, false), (0x51, false), (0x51, true), (VK_RMENU.0, true), (VK_LCONTROL.0, true)]);
        assert!(ev[1].3 && ev[4].3, "right Alt is an extended key");
        let ev = keystroke_events(&KeyStroke { vk: 0x41, scan: 0x1E, shift: true, altgr: false });
        assert_eq!(ev.iter().map(|e| (e.0, e.1, e.2)).collect::<Vec<_>>(), vec![(VK_LSHIFT.0, 0x2A, false), (0x41, 0x1E, false), (0x41, 0x1E, true), (VK_LSHIFT.0, 0x2A, true)]);
        assert_eq!(TypeMethod::parse(Some("keys")), TypeMethod::Keys);
        assert_eq!(TypeMethod::parse(Some("bogus")), TypeMethod::Auto);
        assert_eq!(TypeMethod::parse(None), TypeMethod::Auto);
    }

    #[test]
    fn real_windows_layout_maps_ascii_to_keystrokes() {
        // The real VkKeyScanEx / ToUnicodeEx path on this PC's layout (en-US here; other
        // Latin layouts also have these characters). Emoji always fall back to Unicode.
        let l = WinLayout::current_thread();
        let plan = plan_for("Hello, World! 123", TypeMethod::Auto, &l).unwrap();
        assert!(plan.iter().all(|s| matches!(s, TypeStep::Key(_))), "layout {}: {:?}", l.id(), plan);
        if let TypeStep::Key(k) = plan[0] {
            assert_eq!(k.vk, 0x48);
            assert!(k.scan != 0);
        }
        assert_eq!(plan_for("😀", TypeMethod::Auto, &l).unwrap(), vec![TypeStep::Unit(0xD83D), TypeStep::Unit(0xDE00)]);
    }

    #[test]
    fn unicode_packets_are_paced_but_real_keys_keep_the_normal_pace() {
        let k = TypeStep::Key(KeyStroke { vk: 0x41, scan: 0x1E, shift: false, altgr: false });
        assert_eq!(step_delay(&TypeStep::Unit(0x61), 4), UNICODE_MIN_DELAY_MS);
        assert_eq!(step_delay(&TypeStep::Unit(0x61), 0), UNICODE_MIN_DELAY_MS);
        assert_eq!(step_delay(&TypeStep::Unit(0x61), 50), 50);
        assert!(UNICODE_MIN_DELAY_MS >= 2 * 15, "twice the gap measured safe on Windows 11 Notepad");
        assert_eq!(step_delay(&k, 4), 4);
        assert_eq!(step_delay(&TypeStep::Enter, 0), 0);
    }

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
