//! Cadabra OS native helper.
//!
//! Protocol: newline-delimited JSON over stdin/stdout.
//!   request:  {"id": 1, "method": "click", "params": {...}}
//!   response: {"id": 1, "result": ...} | {"id": 1, "error": {"message": "..."}}
//!   event:    {"event": "summon", ...}  (unsolicited)
//!
//! Coordinate space: the process is Per-Monitor-V2 DPI aware, so every
//! coordinate going in or out is in PHYSICAL virtual-desktop pixels (the same
//! space as GetCursorPos / GetWindowRect for a PMv2 process). Electron works
//! in DIPs; conversion happens in the Electron main process
//! (`screen.screenToDipPoint` / `dipToScreenPoint`).

mod capture;
mod hook;
mod input;
mod keys;
mod session;
mod testwin;
mod uia;
mod win;

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::mpsc;
use std::sync::OnceLock;

static OUT: OnceLock<mpsc::Sender<String>> = OnceLock::new();

/// Queue a line for stdout. Safe from any thread.
pub fn emit(v: Value) {
    if let Some(tx) = OUT.get() {
        let _ = tx.send(v.to_string());
    }
}

pub type RpcResult = Result<Value, String>;

fn main() {
    unsafe {
        use windows::Win32::UI::HiDpi::*;
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }

    // Writer thread: serializes all stdout writes.
    let (tx, rx) = mpsc::channel::<String>();
    OUT.set(tx).ok();
    std::thread::spawn(move || {
        let stdout = std::io::stdout();
        for line in rx {
            let mut lock = stdout.lock();
            let _ = lock.write_all(line.as_bytes());
            let _ = lock.write_all(b"\n");
            let _ = lock.flush();
        }
    });

    let args: Vec<String> = std::env::args().collect();
    let no_hook = args.iter().any(|a| a == "--no-hook");
    if !no_hook {
        hook::start();
    }
    // Round 8: lock / unlock / logon notifications (read-only).
    session::start();

    // H3: concurrent lanes so a long type_text or UI tree walk never blocks
    // `cancel`, `foreground` or window queries. Fast state calls run inline on
    // the reader thread; UIA has its own (COM) thread; input and capture too.
    let uia_tx = lane("uia", true);
    let input_tx = lane("input", false);
    let capture_tx = lane("capture", false);
    let control_tx = lane("control", false);

    emit(json!({"event": "ready", "version": env!("CARGO_PKG_VERSION"), "pid": std::process::id(), "hook": !no_hook}));

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                emit(json!({"event": "log", "level": "error", "message": format!("bad json: {e}")}));
                continue;
            }
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("").to_string();
        let params = req.get("params").cloned().unwrap_or(json!({}));
        if method == "shutdown" {
            input::request_cancel();
            emit(json!({"id": id, "result": true}));
            break;
        }
        let job = (id, method.clone(), params);
        match lane_of(&method) {
            Lane::Inline => run_job(job),
            Lane::Uia => { let _ = uia_tx.send(job); }
            Lane::Input => { let _ = input_tx.send(job); }
            Lane::Capture => { let _ = capture_tx.send(job); }
            Lane::Control => { let _ = control_tx.send(job); }
        }
    }
    hook::stop();
    // 0.9.6: never leave other apps ducked when the app goes away.
    session::restore_on_exit();
    // Give the writer a moment to flush.
    std::thread::sleep(std::time::Duration::from_millis(50));
}

type Job = (Value, String, Value);

#[derive(Debug, PartialEq)]
pub enum Lane {
    Inline,
    Uia,
    Input,
    Capture,
    Control,
}

pub fn lane_of(method: &str) -> Lane {
    match method {
        "ping" | "cancel" | "buffer_keys" | "take_buffered_keys" | "set_hook_enabled" | "set_binding" | "binding_status" | "set_ptt_enabled" | "arm_activity" | "reinstall_hooks" | "install_hooks" | "cursor_pos" | "input_state" => Lane::Inline,
        "ui_tree_at" | "element_at" | "element_info" | "invoke" | "set_value" | "focus_element" | "caret_rect" | "focused_element" => Lane::Uia,
        "click" | "move_cursor" | "type_text" | "press_keys" | "scroll" => Lane::Input,
        "capture" => Lane::Capture,
        _ => Lane::Control,
    }
}

fn run_job((id, method, params): Job) {
    match dispatch(&method, &params) {
        Ok(v) => emit(json!({"id": id, "result": v})),
        Err(e) => emit(json!({"id": id, "error": {"message": e}})),
    }
}

fn lane(name: &'static str, com: bool) -> mpsc::Sender<Job> {
    let (tx, rx) = mpsc::channel::<Job>();
    std::thread::Builder::new()
        .name(format!("lane-{name}"))
        .spawn(move || {
            unsafe {
                use windows::Win32::UI::HiDpi::*;
                let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            }
            if com {
                uia::init_thread();
            }
            for job in rx {
                run_job(job);
            }
        })
        .expect("spawn lane");
    tx
}

fn dispatch(method: &str, p: &Value) -> RpcResult {
    match method {
        "ping" => Ok(json!("pong")),
        "cancel" => {
            // Stop any in-flight type_text / press_keys / click / scroll right away,
            // and refuse later input of the cancelled run (epoch).
            match p.get("epoch").and_then(|v| v.as_u64()) {
                Some(e) if e > 0 => input::request_cancel_epoch(e),
                _ => input::request_cancel(),
            }
            Ok(json!(true))
        }
        "set_hook_enabled" => {
            hook::set_enabled(p.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true));
            Ok(json!(true))
        }
        "set_binding" => hook::set_binding(p),
        "buffer_keys" => {
            hook::start_buffer(p.get("ms").and_then(|v| v.as_u64()).unwrap_or(800));
            Ok(json!(true))
        }
        "take_buffered_keys" => Ok(hook::take_buffer()),
        "install_hooks" => {
            // For processes started with --no-hook (demo/self-test) that need them later.
            hook::start();
            Ok(json!(true))
        }
        "binding_status" => Ok(hook::status()),
        "caret_rect" => {
            let r = win::caret_rect(win::hwnd_param(p)?)?;
            if r.is_null() { uia::focused_rect() } else { Ok(r) }
        }
        "arm_activity" => {
            hook::arm_activity(p.get("on").and_then(|v| v.as_bool()).unwrap_or(false));
            Ok(json!({"hooks": hook::running()}))
        }
        "set_ptt_enabled" => {
            hook::set_ptt_enabled(p.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false));
            Ok(json!(true))
        }
        "reinstall_hooks" => {
            hook::reinstall();
            Ok(json!(true))
        }
        "cursor_pos" => win::cursor_pos(),
        "input_state" => win::input_state(),
        "presence" => session::presence(),
        "audio_sessions" => {
            let ex: Vec<u32> = p.get("exclude").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as u32)).collect()).unwrap_or_default();
            session::audio_sessions(&ex)
        }
        "lock_workstation" => session::lock_workstation(),
        "duck_audio" => {
            let ex: Vec<u32> = p.get("exclude").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as u32)).collect()).unwrap_or_default();
            let factor = p.get("factor").and_then(|v| v.as_f64()).unwrap_or(0.25) as f32;
            session::duck(&ex, factor)
        }
        "unduck_audio" => {
            let list = p.get("sessions").and_then(|v| v.as_array()).map(|a| {
                a.iter()
                    .filter_map(|x| Some((x.get("id")?.as_str()?.to_string(), x.get("volume")?.as_f64()? as f32)))
                    .collect::<Vec<_>>()
            });
            session::unduck(list)
        }
        "monitors" => win::monitors(),
        "window_info" => win::window_info(win::hwnd_param(p)?),
        "foreground_window" => Ok(win::describe_foreground()),
        "window_rect" => win::window_rect_rpc(win::hwnd_param(p)?),
        "window_at" => win::window_at(p),
        "list_windows" => win::list_windows(),
        "close_window" => win::close_window(win::hwnd_param(p)?),
        "foreground" => win::foreground(win::hwnd_param(p)?),
        "style_window" => win::style_window(p),
        "ui_tree_at" => uia::ui_tree_at(p),
        "element_at" => uia::element_at(p),
        "element_info" => uia::element_info(p.get("id").and_then(|v| v.as_u64()).ok_or("missing id")?),
        "invoke" => uia::invoke(p),
        "set_value" => uia::set_value(p),
        "focus_element" => uia::focus(p),
        "focused_element" => uia::focused_element(),
        "capture" => capture::capture(p),
        "click" => input::click(p),
        "move_cursor" => input::move_cursor(p),
        "type_text" => input::type_text(p),
        "press_keys" => input::press_keys(p),
        "scroll" => input::scroll(p),
        "test_window_open" => testwin::open(p),
        "test_window_text" => testwin::text(),
        "test_window_close" => testwin::close(),
        _ => Err(format!("unknown method: {method}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_and_state_calls_never_queue_behind_input_or_uia() {
        for m in ["cancel", "set_binding", "set_ptt_enabled", "set_hook_enabled", "ping"] {
            assert_eq!(lane_of(m), Lane::Inline, "{m}");
        }
        assert_eq!(lane_of("type_text"), Lane::Input);
        assert_eq!(lane_of("ui_tree_at"), Lane::Uia);
        assert_eq!(lane_of("foreground"), Lane::Control);
        assert_eq!(lane_of("capture"), Lane::Capture);
    }
}
