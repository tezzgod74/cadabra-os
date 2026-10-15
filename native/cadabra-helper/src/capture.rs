//! Screen capture to PNG.
//!
//! Default mode copies pixels from the screen DC (what the user actually sees).
//! Windows marked with WDA_EXCLUDEFROMCAPTURE (Electron `setContentProtection`)
//! are omitted by DWM, so Cadabra's own panel/overlay never appear.
//! `mode: "window"` uses PrintWindow(PW_RENDERFULLCONTENT) for occluded windows.
//!
//! The image is downscaled (HALFTONE) so its longest side is <= `maxSize`
//! (default 1568). The returned `scale` maps image px -> physical screen px:
//!   screen_x = rect.x + img_x * scale

use crate::RpcResult;
use base64::Engine;
use serde_json::{json, Value};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::Storage::Xps::*;
use windows::Win32::UI::WindowsAndMessaging::*;

pub fn capture(p: &Value) -> RpcResult {
    let max_size = p.get("maxSize").and_then(|v| v.as_u64()).unwrap_or(1568).clamp(64, 8192) as i32;
    let mode = p.get("mode").and_then(|v| v.as_str()).unwrap_or("screen");
    let (rect, hwnd) = if p.get("hwnd").is_some() {
        let h = crate::win::hwnd_param(p)?;
        (crate::win::window_rect(h), Some(h))
    } else if let Some(r) = p.get("rect") {
        let g = |k: &str| r.get(k).and_then(|v| v.as_f64()).map(|f| f.round() as i32);
        let (x, y, w, h) = (g("x").ok_or("rect.x")?, g("y").ok_or("rect.y")?, g("width").ok_or("rect.width")?, g("height").ok_or("rect.height")?);
        (RECT { left: x, top: y, right: x + w, bottom: y + h }, None)
    } else {
        // Whole virtual desktop.
        unsafe {
            let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            let h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            (RECT { left: x, top: y, right: x + w, bottom: y + h }, None)
        }
    };
    let sw = rect.right - rect.left;
    let sh = rect.bottom - rect.top;
    if sw <= 0 || sh <= 0 {
        return Err("empty capture rect".into());
    }
    let scale = (sw.max(sh) as f64 / max_size as f64).max(1.0);
    let dw = ((sw as f64) / scale).round().max(1.0) as i32;
    let dh = ((sh as f64) / scale).round().max(1.0) as i32;

    let pixels = unsafe { grab(rect, dw, dh, if mode == "window" { hwnd } else { None })? };

    // BGRA top-down -> RGB
    let mut rgb = Vec::with_capacity((dw * dh * 3) as usize);
    for px in pixels.chunks_exact(4) {
        rgb.extend_from_slice(&[px[2], px[1], px[0]]);
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, dw as u32, dh as u32);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut w = enc.write_header().map_err(|e| e.to_string())?;
        w.write_image_data(&rgb).map_err(|e| e.to_string())?;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&out);
    Ok(json!({
        "png": b64,
        "width": dw,
        "height": dh,
        "scale": scale,
        "rect": crate::win::rect_json(&rect),
        "bytes": out.len(),
    }))
}

unsafe fn grab(rect: RECT, dw: i32, dh: i32, hwnd: Option<HWND>) -> Result<Vec<u8>, String> {
    let sw = rect.right - rect.left;
    let sh = rect.bottom - rect.top;
    let screen = GetDC(None);
    if screen.is_invalid() {
        return Err("GetDC failed".into());
    }
    let mem = CreateCompatibleDC(Some(screen));
    let mut bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: dw,
            biHeight: -dh, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
    let dib = CreateDIBSection(Some(mem), &mut bmi, DIB_RGB_COLORS, &mut bits, None, 0).map_err(|e| e.to_string())?;
    let old = SelectObject(mem, dib.into());

    let mut result = Ok(());
    if let Some(h) = hwnd {
        // Render the window into a full-size bitmap first, then scale.
        let full_dc = CreateCompatibleDC(Some(screen));
        let full_bmp = CreateCompatibleBitmap(screen, sw, sh);
        let old2 = SelectObject(full_dc, full_bmp.into());
        // PW_RENDERFULLCONTENT = 2
        let ok = PrintWindow(h, full_dc, PRINT_WINDOW_FLAGS(2)).as_bool();
        if !ok {
            result = Err("PrintWindow failed".to_string());
        } else {
            SetStretchBltMode(mem, HALFTONE);
            let _ = SetBrushOrgEx(mem, 0, 0, None);
            // PrintWindow renders the whole window rect (incl. invisible border);
            // offset by the difference between GetWindowRect and visible rect.
            let mut wr = RECT::default();
            let _ = GetWindowRect(h, &mut wr);
            let ox = rect.left - wr.left;
            let oy = rect.top - wr.top;
            let _ = StretchBlt(mem, 0, 0, dw, dh, Some(full_dc), ox, oy, sw, sh, SRCCOPY);
        }
        SelectObject(full_dc, old2);
        let _ = DeleteObject(full_bmp.into());
        let _ = DeleteDC(full_dc);
    } else {
        SetStretchBltMode(mem, HALFTONE);
        let _ = SetBrushOrgEx(mem, 0, 0, None);
        let ok = StretchBlt(mem, 0, 0, dw, dh, Some(screen), rect.left, rect.top, sw, sh, SRCCOPY).as_bool();
        if !ok {
            result = Err("StretchBlt failed".to_string());
        }
    }

    let len = (dw * dh * 4) as usize;
    let data = if result.is_ok() { std::slice::from_raw_parts(bits as *const u8, len).to_vec() } else { Vec::new() };
    SelectObject(mem, old);
    let _ = DeleteObject(dib.into());
    let _ = DeleteDC(mem);
    ReleaseDC(None, screen);
    result.map(|_| data)
}
