//! Round 8: session events and "is now a good moment to talk?" signals.
//! - Lock / unlock / logon / logoff via WTSRegisterSessionNotification on a
//!   message-only window (its own thread; independent of the keyboard hook).
//! - SHQueryUserNotificationState: full-screen app / game / presentation /
//!   quiet time (Focus / Do not disturb) → "don't greet now".
//! - The default speaker's mute state (IAudioEndpointVolume).
//! - LockWorkStation ("lock my PC").
//! Read-only except lock_workstation; nothing here sends input anywhere.

use crate::RpcResult;
use serde_json::json;
use windows::core::w;
use windows::Win32::Foundation::*;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::core::Interface;
use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
use windows::Win32::Media::Audio::{eConsole, eRender, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::RemoteDesktop::{WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION};
use windows::Win32::System::Shutdown::LockWorkStation;
use windows::Win32::UI::Shell::{SHQueryUserNotificationState, QUERY_USER_NOTIFICATION_STATE};
use windows::Win32::UI::WindowsAndMessaging::*;

const WTS_CONSOLE_CONNECT: usize = 0x1;
const WTS_SESSION_LOGON: usize = 0x5;
const WTS_SESSION_LOGOFF: usize = 0x6;
const WTS_SESSION_LOCK: usize = 0x7;
const WTS_SESSION_UNLOCK: usize = 0x8;

/// Map a WM_WTSSESSION_CHANGE wParam to an event name (pure; tested).
pub fn session_kind(wparam: usize) -> Option<&'static str> {
    match wparam {
        WTS_SESSION_LOCK => Some("lock"),
        WTS_SESSION_UNLOCK => Some("unlock"),
        WTS_SESSION_LOGON => Some("logon"),
        WTS_SESSION_LOGOFF => Some("logoff"),
        WTS_CONSOLE_CONNECT => Some("console-connect"),
        _ => None,
    }
}

unsafe extern "system" fn wndproc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if msg == WM_WTSSESSION_CHANGE {
        if let Some(kind) = session_kind(w.0) {
            crate::emit(json!({"event": "session", "kind": kind}));
        }
        return LRESULT(0);
    }
    DefWindowProcW(h, msg, w, l)
}

/// Start listening for session changes (once).
pub fn start() {
    std::thread::spawn(|| unsafe {
        let hinst = GetModuleHandleW(None).map(|h| HINSTANCE(h.0)).unwrap_or_default();
        let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: hinst, lpszClassName: w!("CadabraSessionWatch"), ..Default::default() };
        RegisterClassW(&wc);
        let hwnd = match CreateWindowExW(WINDOW_EX_STYLE(0), w!("CadabraSessionWatch"), w!(""), WINDOW_STYLE(0), 0, 0, 0, 0, Some(HWND_MESSAGE), None, Some(hinst), None) {
            Ok(h) => h,
            Err(e) => {
                crate::emit(json!({"event": "session", "kind": "watch-failed", "message": e.to_string()}));
                return;
            }
        };
        if let Err(e) = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) {
            crate::emit(json!({"event": "session", "kind": "watch-failed", "message": e.to_string()}));
            return;
        }
        let mut m = MSG::default();
        while GetMessageW(&mut m, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&m);
            DispatchMessageW(&m);
        }
    });
}

/// QUNS values → a name (pure; tested).
pub fn notification_state_name(v: i32) -> &'static str {
    match v {
        1 => "not-present",           // screen saver / locked / fast user switching
        2 => "busy",                  // full-screen app (not D3D)
        3 => "d3d-full-screen",       // game / video
        4 => "presentation",          // presentation settings
        5 => "accepts-notifications", // normal
        6 => "quiet-time",            // first hour after a new install / Focus
        7 => "app",                   // Windows Store app full screen
        _ => "unknown",
    }
}

/// Is now a good moment to speak up? (Focus / full screen / presentation, speaker muted.)
pub fn presence() -> RpcResult {
    let quns = unsafe { SHQueryUserNotificationState() }.map(|v: QUERY_USER_NOTIFICATION_STATE| v.0).unwrap_or(0);
    let muted = speaker_muted();
    Ok(json!({ "notificationState": notification_state_name(quns), "speakerMuted": muted }))
}

fn speaker_muted() -> Option<bool> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let dev = en.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
        let vol: IAudioEndpointVolume = dev.Activate(CLSCTX_ALL, None).ok()?;
        vol.GetMute().ok().map(|b| b.as_bool())
    }
}

/// Round 10.5: which OTHER apps are playing sound right now (a video, music,
/// a call). Enumerates the audio sessions of every active render device and
/// reads each session's peak meter. Read-only. `exclude` = Cadabra's own
/// process ids (its own speech must not count); system sounds are skipped.
pub fn audio_sessions(exclude: &[u32]) -> RpcResult {
    // REVIEW-10.5 #5: COM is initialised once per RPC thread and the device
    // enumerator is cached; it is recreated if enumerating fails (e.g. after
    // an audio device change or an audio service restart).
    let out = match collect_sessions(exclude, false) {
        Ok(v) => v,
        Err(_) => collect_sessions(exclude, true)?,
    };
    Ok(json!({ "sessions": out }))
}

thread_local! {
    static ENUMERATOR: std::cell::RefCell<Option<IMMDeviceEnumerator>> = const { std::cell::RefCell::new(None) };
    static COM_READY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn enumerator(fresh: bool) -> Result<IMMDeviceEnumerator, String> {
    COM_READY.with(|c| {
        if !c.get() {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            c.set(true);
        }
    });
    ENUMERATOR.with(|e| {
        let mut slot = e.borrow_mut();
        if fresh {
            *slot = None;
        }
        if slot.is_none() {
            *slot = Some(unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.map_err(|x: windows::core::Error| x.to_string())?);
        }
        Ok(slot.as_ref().unwrap().clone())
    })
}

fn collect_sessions(exclude: &[u32], fresh: bool) -> Result<Vec<serde_json::Value>, String> {
    let me = std::process::id();
    let mut out = Vec::new();
    let en = enumerator(fresh)?;
    unsafe {
        let devs = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE).map_err(|e| e.to_string())?;
        let n = devs.GetCount().unwrap_or(0);
        for i in 0..n {
            let Ok(dev) = devs.Item(i) else { continue };
            let Ok(mgr) = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
            let Ok(sessions) = mgr.GetSessionEnumerator() else { continue };
            let count = sessions.GetCount().unwrap_or(0);
            for j in 0..count {
                let Ok(ctl) = sessions.GetSession(j) else { continue };
                let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else { continue };
                if ctl2.IsSystemSoundsSession() == S_OK {
                    continue;
                }
                let pid = ctl2.GetProcessId().unwrap_or(0);
                if pid == 0 || pid == me || exclude.contains(&pid) {
                    continue;
                }
                let active = ctl.GetState().map(|s| s == AudioSessionStateActive).unwrap_or(false);
                if !active {
                    continue;
                }
                let peak = ctl.cast::<IAudioMeterInformation>().ok().and_then(|m| m.GetPeakValue().ok()).unwrap_or(0.0);
                out.push(json!({ "pid": pid, "exe": crate::win::pid_name(pid).to_lowercase(), "peak": peak }));
            }
        }
    }
    Ok(out)
}

/// "Lock my PC": exactly like Win+L. Unlocking stays with Windows (Hello / PIN / password).
pub fn lock_workstation() -> RpcResult {
    unsafe { LockWorkStation() }.map_err(|e| e.to_string())?;
    Ok(json!(true))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn session_and_notification_state_names() {
        assert_eq!(session_kind(0x7), Some("lock"));
        assert_eq!(session_kind(0x8), Some("unlock"));
        assert_eq!(session_kind(0x5), Some("logon"));
        assert_eq!(session_kind(0x3), None);
        assert_eq!(notification_state_name(3), "d3d-full-screen");
        assert_eq!(notification_state_name(5), "accepts-notifications");
    }
}
