//! Key-chord parsing: "ctrl+shift+t", "enter", "alt+f4", "win+d", "f5", "a".

use windows::Win32::UI::Input::KeyboardAndMouse::*;

pub fn parse_key(name: &str) -> Option<VIRTUAL_KEY> {
    let n = name.trim().to_ascii_lowercase();
    let vk = match n.as_str() {
        "ctrl" | "control" => VK_CONTROL,
        "shift" => VK_SHIFT,
        "alt" | "menu" | "option" => VK_MENU,
        "win" | "meta" | "cmd" | "super" => VK_LWIN,
        "enter" | "return" => VK_RETURN,
        "tab" => VK_TAB,
        "esc" | "escape" => VK_ESCAPE,
        "space" | "spacebar" => VK_SPACE,
        "backspace" | "back" => VK_BACK,
        "delete" | "del" => VK_DELETE,
        "insert" | "ins" => VK_INSERT,
        "home" => VK_HOME,
        "end" => VK_END,
        "pageup" | "pgup" => VK_PRIOR,
        "pagedown" | "pgdn" => VK_NEXT,
        "up" | "arrowup" => VK_UP,
        "down" | "arrowdown" => VK_DOWN,
        "left" | "arrowleft" => VK_LEFT,
        "right" | "arrowright" => VK_RIGHT,
        "capslock" => VK_CAPITAL,
        "printscreen" => VK_SNAPSHOT,
        "apps" | "contextmenu" => VK_APPS,
        "plus" | "=" => VK_OEM_PLUS,
        "minus" | "-" => VK_OEM_MINUS,
        "," | "comma" => VK_OEM_COMMA,
        "." | "period" => VK_OEM_PERIOD,
        "/" | "slash" => VK_OEM_2,
        ";" => VK_OEM_1,
        "'" => VK_OEM_7,
        "[" => VK_OEM_4,
        "]" => VK_OEM_6,
        "\\" => VK_OEM_5,
        "`" => VK_OEM_3,
        _ => {
            if let Some(num) = n.strip_prefix('f') {
                if let Ok(k) = num.parse::<u16>() {
                    if (1..=24).contains(&k) {
                        return Some(VIRTUAL_KEY(VK_F1.0 + k - 1));
                    }
                }
            }
            let chars: Vec<char> = n.chars().collect();
            if chars.len() == 1 {
                let c = chars[0];
                if c.is_ascii_alphabetic() {
                    return Some(VIRTUAL_KEY(c.to_ascii_uppercase() as u16));
                }
                if c.is_ascii_digit() {
                    return Some(VIRTUAL_KEY(c as u16));
                }
            }
            return None;
        }
    };
    Some(vk)
}

pub fn is_extended(vk: VIRTUAL_KEY) -> bool {
    matches!(
        vk,
        VK_UP | VK_DOWN | VK_LEFT | VK_RIGHT | VK_HOME | VK_END | VK_PRIOR | VK_NEXT | VK_INSERT | VK_DELETE | VK_LWIN | VK_RWIN | VK_APPS
    )
}

/// Parse a chord into an ordered list of keys (modifiers first as written).
pub fn parse_chord(chord: &str) -> Result<Vec<VIRTUAL_KEY>, String> {
    let parts: Vec<&str> = if chord.trim() == "+" { vec!["plus"] } else { chord.split('+').collect() };
    let mut out = Vec::new();
    for p in parts {
        let p = if p.is_empty() { "plus" } else { p };
        out.push(parse_key(p).ok_or_else(|| format!("unknown key: {p}"))?);
    }
    if out.is_empty() {
        return Err("empty chord".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chords() {
        assert_eq!(parse_chord("ctrl+shift+t").unwrap(), vec![VK_CONTROL, VK_SHIFT, VIRTUAL_KEY(b'T' as u16)]);
        assert_eq!(parse_chord("Enter").unwrap(), vec![VK_RETURN]);
        assert_eq!(parse_chord("alt+f4").unwrap(), vec![VK_MENU, VK_F4]);
        assert!(parse_chord("ctrl+nope").is_err());
    }
}
