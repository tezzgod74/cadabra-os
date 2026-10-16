//! UI Automation: pruned tree snapshots and element actions.
//!
//! All UIA work happens on the RPC (main) thread, which is initialized MTA.
//! Elements returned in a snapshot get numeric ids; the helper keeps the COM
//! references (bounded LRU-ish map) so `invoke` / `set_value` / `focus_element`
//! can act on them later.

use crate::RpcResult;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};
use windows::core::BSTR;
use windows::Win32::Foundation::*;
use windows::Win32::System::Com::*;
use windows::Win32::UI::Accessibility::*;

const MAX_KEPT: usize = 4000;

struct State {
    auto: IUIAutomation,
    cache: IUIAutomationCacheRequest,
    walker: IUIAutomationTreeWalker,
    next_id: u64,
    elements: BTreeMap<u64, IUIAutomationElement>,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

pub fn init_thread() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

fn with_state<T>(f: impl FnOnce(&mut State) -> Result<T, String>) -> Result<T, String> {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        if s.is_none() {
            *s = Some(unsafe { create_state() }.map_err(|e| format!("UIA init failed: {e}"))?);
        }
        f(s.as_mut().unwrap())
    })
}

unsafe fn create_state() -> windows::core::Result<State> {
    let auto: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
    let cache = auto.CreateCacheRequest()?;
    for prop in [
        UIA_NamePropertyId,
        UIA_ControlTypePropertyId,
        UIA_AutomationIdPropertyId,
        UIA_BoundingRectanglePropertyId,
        UIA_IsEnabledPropertyId,
        UIA_IsOffscreenPropertyId,
        UIA_ValueValuePropertyId,
        UIA_HasKeyboardFocusPropertyId,
    ] {
        cache.AddProperty(prop)?;
    }
    cache.AddPattern(UIA_ValuePatternId)?;
    let walker = auto.ControlViewWalker()?;
    Ok(State { auto, cache, walker, next_id: 1, elements: BTreeMap::new() })
}

impl State {
    fn keep(&mut self, el: &IUIAutomationElement) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.elements.insert(id, el.clone());
        while self.elements.len() > MAX_KEPT {
            let first = *self.elements.keys().next().unwrap();
            self.elements.remove(&first);
        }
        id
    }
    fn get(&self, id: u64) -> Result<IUIAutomationElement, String> {
        self.elements.get(&id).cloned().ok_or_else(|| format!("unknown or expired element id {id}; call read_ui again"))
    }
}

pub fn control_type_name(id: i32) -> &'static str {
    match id {
        50000 => "button",
        50001 => "calendar",
        50002 => "checkbox",
        50003 => "combobox",
        50004 => "edit",
        50005 => "hyperlink",
        50006 => "image",
        50007 => "listitem",
        50008 => "list",
        50009 => "menu",
        50010 => "menubar",
        50011 => "menuitem",
        50012 => "progressbar",
        50013 => "radio",
        50014 => "scrollbar",
        50015 => "slider",
        50016 => "spinner",
        50017 => "statusbar",
        50018 => "tab",
        50019 => "tabitem",
        50020 => "text",
        50021 => "toolbar",
        50022 => "tooltip",
        50023 => "tree",
        50024 => "treeitem",
        50025 => "custom",
        50026 => "group",
        50027 => "thumb",
        50028 => "datagrid",
        50029 => "dataitem",
        50030 => "document",
        50031 => "splitbutton",
        50032 => "window",
        50033 => "pane",
        50034 => "header",
        50035 => "headeritem",
        50036 => "table",
        50037 => "titlebar",
        50038 => "separator",
        50039 => "semanticzoom",
        50040 => "appbar",
        _ => "unknown",
    }
}

fn trunc(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let t: String = s.chars().take(n).collect();
        format!("{t}…")
    }
}

struct Info {
    name: String,
    ctype: i32,
    aid: String,
    rect: RECT,
    enabled: bool,
    offscreen: bool,
    value: Option<String>,
    focused: bool,
}

unsafe fn cached_info(el: &IUIAutomationElement) -> Info {
    let name = el.CachedName().map(|b| b.to_string()).unwrap_or_default();
    let ctype = el.CachedControlType().map(|c| c.0).unwrap_or(0);
    let aid = el.CachedAutomationId().map(|b| b.to_string()).unwrap_or_default();
    let rect = el.CachedBoundingRectangle().unwrap_or_default();
    let enabled = el.CachedIsEnabled().map(|b| b.as_bool()).unwrap_or(true);
    let offscreen = el.CachedIsOffscreen().map(|b| b.as_bool()).unwrap_or(false);
    let focused = el.CachedHasKeyboardFocus().map(|b| b.as_bool()).unwrap_or(false);
    let value = el
        .GetCachedPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
        .ok()
        .and_then(|vp| vp.CachedValue().ok())
        .map(|b| b.to_string())
        .filter(|s| !s.is_empty());
    Info { name, ctype, aid, rect, enabled, offscreen, value, focused }
}

unsafe fn current_info(st: &State, el: &IUIAutomationElement) -> Result<Info, String> {
    let c = el.BuildUpdatedCache(&st.cache).map_err(|e| e.to_string())?;
    Ok(cached_info(&c))
}

fn node_json(id: u64, depth: usize, i: &Info) -> Value {
    let r = &i.rect;
    let mut v = json!({
        "id": id,
        "depth": depth,
        "role": control_type_name(i.ctype),
        "name": trunc(&i.name, 120),
        "rect": [r.left, r.top, r.right - r.left, r.bottom - r.top],
    });
    let o = v.as_object_mut().unwrap();
    if !i.aid.is_empty() && i.aid.len() < 64 {
        o.insert("aid".into(), json!(i.aid));
    }
    if !i.enabled {
        o.insert("enabled".into(), json!(false));
    }
    if let Some(val) = &i.value {
        o.insert("value".into(), json!(trunc(val, 200)));
    }
    if i.focused {
        o.insert("focused".into(), json!(true));
    }
    v
}

fn is_noise(i: &Info) -> bool {
    // Anonymous structural containers: don't emit, but do descend.
    i.name.trim().is_empty() && i.value.is_none() && matches!(i.ctype, 50033 | 50026 | 50025 | 50021 | 50038 | 50027 | 50014)
}

struct Walk<'a> {
    st: &'a mut State,
    out: Vec<Value>,
    max_nodes: usize,
    max_depth: usize,
    deadline: Instant,
    truncated: bool,
    clip: Option<RECT>,
}

fn intersects(a: &RECT, b: &RECT) -> bool {
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

impl Walk<'_> {
    unsafe fn visit(&mut self, el: &IUIAutomationElement, depth: usize, emit_depth: usize) {
        if self.out.len() >= self.max_nodes || Instant::now() > self.deadline {
            self.truncated = true;
            return;
        }
        let info = cached_info(el);
        let r = info.rect;
        let empty = r.right - r.left <= 0 || r.bottom - r.top <= 0;
        if depth > 0 && (info.offscreen || empty) {
            return;
        }
        if let Some(clip) = &self.clip {
            if depth > 0 && !intersects(&r, clip) {
                return;
            }
        }
        let mut child_depth = emit_depth;
        if depth == 0 || !is_noise(&info) {
            let id = self.st.keep(el);
            self.out.push(node_json(id, emit_depth, &info));
            child_depth = emit_depth + 1;
        }
        if depth >= self.max_depth {
            return;
        }
        // Text leaves rarely have useful children.
        if info.ctype == 50020 {
            return;
        }
        let walker = self.st.walker.clone();
        let cache = self.st.cache.clone();
        let mut child = walker.GetFirstChildElementBuildCache(el, &cache).ok();
        let mut guard = 0;
        while let Some(c) = child {
            self.visit(&c, depth + 1, child_depth);
            if self.truncated {
                return;
            }
            guard += 1;
            if guard > 2000 {
                break;
            }
            child = walker.GetNextSiblingElementBuildCache(&c, &cache).ok();
        }
    }
}

fn get_u(p: &Value, k: &str, d: u64) -> u64 {
    p.get(k).and_then(|v| v.as_u64()).unwrap_or(d)
}

/// params: { hwnd } | { x, y } ; optional maxNodes, maxDepth, timeoutMs, clipToWindow
pub fn ui_tree_at(p: &Value) -> RpcResult {
    let max_nodes = get_u(p, "maxNodes", 350).clamp(10, 3000) as usize;
    let max_depth = get_u(p, "maxDepth", 30).clamp(1, 80) as usize;
    let timeout = get_u(p, "timeoutMs", 3000).clamp(200, 20000);
    with_state(|st| unsafe {
        let mut hit: Option<Value> = None;
        let hwnd = if p.get("hwnd").is_some() {
            crate::win::hwnd_param(p)?
        } else {
            let x = p.get("x").and_then(|v| v.as_f64()).ok_or("need hwnd or x,y")? as i32;
            let y = p.get("y").and_then(|v| v.as_f64()).ok_or("need hwnd or x,y")? as i32;
            if let Ok(el) = st.auto.ElementFromPointBuildCache(POINT { x, y }, &st.cache) {
                let info = cached_info(&el);
                let id = st.keep(&el);
                hit = Some(node_json(id, 0, &info));
            }
            crate::win::root_window_at(x, y)
        };
        if hwnd.0.is_null() {
            return Err("no window at that point".into());
        }
        let root = st.auto.ElementFromHandleBuildCache(hwnd, &st.cache).map_err(|e| format!("ElementFromHandle: {e}"))?;
        let clip = crate::win::window_rect(hwnd);
        let mut w = Walk {
            st,
            out: Vec::new(),
            max_nodes,
            max_depth,
            deadline: Instant::now() + Duration::from_millis(timeout),
            truncated: false,
            clip: Some(clip),
        };
        w.visit(&root, 0, 0);
        let truncated = w.truncated;
        let nodes = std::mem::take(&mut w.out);
        Ok(json!({
            "window": crate::win::describe_window(hwnd),
            "hit": hit,
            "nodes": nodes,
            "truncated": truncated,
        }))
    })
}

pub fn element_at(p: &Value) -> RpcResult {
    let x = p.get("x").and_then(|v| v.as_f64()).ok_or("missing x")? as i32;
    let y = p.get("y").and_then(|v| v.as_f64()).ok_or("missing y")? as i32;
    with_state(|st| unsafe {
        let el = st.auto.ElementFromPointBuildCache(POINT { x, y }, &st.cache).map_err(|e| e.to_string())?;
        let info = cached_info(&el);
        let id = st.keep(&el);
        Ok(node_json(id, 0, &info))
    })
}

fn elem_id(p: &Value) -> Result<u64, String> {
    p.get("id").and_then(|v| v.as_u64()).ok_or_else(|| "missing element id".to_string())
}

/// Fresh bounding rect + info for an element (used before acting so the ghost
/// cursor targets the current position).
pub fn element_info(id: u64) -> RpcResult {
    with_state(|st| unsafe {
        let el = st.get(id)?;
        let info = current_info(st, &el)?;
        Ok(node_json(id, 0, &info))
    })
}

pub fn invoke(p: &Value) -> RpcResult {
    let id = elem_id(p)?;
    with_state(|st| unsafe {
        let el = st.get(id)?;
        if let Ok(ip) = el.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
            ip.Invoke().map_err(|e| e.to_string())?;
            return Ok(json!({"via": "invoke"}));
        }
        if let Ok(tp) = el.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) {
            tp.Toggle().map_err(|e| e.to_string())?;
            return Ok(json!({"via": "toggle"}));
        }
        if let Ok(sp) = el.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) {
            sp.Select().map_err(|e| e.to_string())?;
            return Ok(json!({"via": "select"}));
        }
        if let Ok(ep) = el.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId) {
            let state = ep.CurrentExpandCollapseState().map_err(|e| e.to_string())?;
            if state == ExpandCollapseState_Collapsed {
                ep.Expand().map_err(|e| e.to_string())?;
            } else {
                ep.Collapse().map_err(|e| e.to_string())?;
            }
            return Ok(json!({"via": "expandcollapse"}));
        }
        if let Ok(lp) = el.GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(UIA_LegacyIAccessiblePatternId) {
            lp.DoDefaultAction().map_err(|e| e.to_string())?;
            return Ok(json!({"via": "legacy"}));
        }
        Err("element supports no invoke-like pattern; use click on its rect".into())
    })
}

/// 0.9.12: the text of the focused control, to check what type_text produced.
/// TextPattern (documents, e.g. Notepad) or ValuePattern (edit fields). Never
/// reads password fields. `text` is null when it can't be read.
pub const FOCUSED_TEXT_MAX: i32 = 200_000;

pub fn focused_text() -> RpcResult {
    with_state(|st| unsafe {
        let el = st.auto.GetFocusedElement().map_err(|e| e.to_string())?;
        let ct = el.CurrentControlType().map(|c| c.0).unwrap_or(0);
        let class = el.CurrentClassName().map(|b| b.to_string()).unwrap_or_default();
        let pid = el.CurrentProcessId().unwrap_or(0);
        let hwnd = el.CurrentNativeWindowHandle().map(|h| h.0 as isize).unwrap_or(0);
        let base = json!({"role": control_type_name(ct), "className": class, "pid": pid, "hwnd": hwnd});
        if el.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(false) {
            return Ok(json!({"info": base, "text": null, "why": "password"}));
        }
        if let Ok(tp) = el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
            if let Ok(t) = tp.DocumentRange().and_then(|r| r.GetText(FOCUSED_TEXT_MAX + 1)) {
                let s = t.to_string();
                if s.chars().count() > FOCUSED_TEXT_MAX as usize {
                    return Ok(json!({"info": base, "text": null, "why": "too long"}));
                }
                return Ok(json!({"info": base, "text": s, "source": "text"}));
            }
        }
        if let Ok(vp) = el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
            if let Ok(v) = vp.CurrentValue() {
                return Ok(json!({"info": base, "text": v.to_string(), "source": "value"}));
            }
        }
        Ok(json!({"info": base, "text": null, "why": "unreadable"}))
    })
}

pub fn set_value(p: &Value) -> RpcResult {
    let id = elem_id(p)?;
    let value = p.get("value").and_then(|v| v.as_str()).ok_or("missing value")?.to_string();
    with_state(|st| unsafe {
        let el = st.get(id)?;
        let vp = el
            .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .map_err(|_| "element does not support ValuePattern; focus it and use type_text".to_string())?;
        if vp.CurrentIsReadOnly().map(|b| b.as_bool()).unwrap_or(false) {
            return Err("element is read-only".into());
        }
        vp.SetValue(&BSTR::from(value)).map_err(|e| e.to_string())?;
        Ok(json!(true))
    })
}

pub fn focus(p: &Value) -> RpcResult {
    let id = elem_id(p)?;
    with_state(|st| unsafe {
        let el = st.get(id)?;
        el.SetFocus().map_err(|e| e.to_string())?;
        Ok(json!(true))
    })
}


/// Bounding rect of the element with keyboard focus (caret fallback for UIA apps).
pub fn focused_rect() -> RpcResult {
    with_state(|st| unsafe {
        let el = st.auto.GetFocusedElement().map_err(|e| e.to_string())?;
        let r = el.CurrentBoundingRectangle().map_err(|e| e.to_string())?;
        if r.right - r.left <= 0 || r.bottom - r.top <= 0 {
            return Ok(Value::Null);
        }
        let ct = el.CurrentControlType().map(|c| c.0).unwrap_or(0);
        Ok(json!({"source": "uia", "role": control_type_name(ct), "rect": crate::win::rect_json(&r)}))
    })
}

/// REVIEW-2 #3: what has keyboard focus (to spot IDE terminals, the Explorer
/// address bar and search boxes as shell-like targets).
pub fn focused_element() -> RpcResult {
    with_state(|st| unsafe {
        let el = st.auto.GetFocusedElement().map_err(|e| e.to_string())?;
        let ct = el.CurrentControlType().map(|c| c.0).unwrap_or(0);
        let name = el.CurrentName().map(|b| b.to_string()).unwrap_or_default();
        let aid = el.CurrentAutomationId().map(|b| b.to_string()).unwrap_or_default();
        let class = el.CurrentClassName().map(|b| b.to_string()).unwrap_or_default();
        let framework = el.CurrentFrameworkId().map(|b| b.to_string()).unwrap_or_default();
        let pid = el.CurrentProcessId().unwrap_or(0);
        Ok(json!({"role": control_type_name(ct), "name": name, "aid": aid, "className": class, "framework": framework, "pid": pid}))
    })
}
