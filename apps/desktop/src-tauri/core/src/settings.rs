//! The settings as the protocol has them (`SettingsSchema` and
//! `SettingsPatchSchema` in `packages/protocol/src/chat.ts`): the same
//! defaults the desktop service answers, the same checks on a change.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value, json};

const THEMES: &[&str] = &["system", "light", "dark"];
const ACCENTS: &[&str] = &[
    "graphite", "blue", "teal", "green", "violet", "rose", "amber",
];
const DARK_STYLES: &[&str] = &["default", "dim", "midnight"];
const LIGHT_STYLES: &[&str] = &["default", "warm"];
const UI_FONTS: &[&str] = &["inter", "system"];
/// Longest code font value a patch may carry, in UTF-16 units (as JavaScript counts).
const CODE_FONT_MAX: usize = 256;
const FONT_NAME_MAX: usize = 64;
const FONT_NAMES_MAX: usize = 4;

#[derive(Clone, Copy)]
enum Kind {
    NullableString,
    Number,
    /// An integer from 5 to 1440, or null (never).
    Minutes,
    Bool,
    OneOf(&'static [&'static str]),
    CodeFont,
}

/// Every setting, in the protocol's order, with its default.
fn fields() -> [(&'static str, Kind, Value); 15] {
    [
        ("claudePath", Kind::NullableString, Value::Null),
        ("idleReclaimMinutes", Kind::Number, json!(15)),
        ("idleShutdownMinutes", Kind::Minutes, json!(60)),
        ("notifications", Kind::Bool, json!(true)),
        ("enterToSend", Kind::Bool, json!(true)),
        ("theme", Kind::OneOf(THEMES), json!("system")),
        ("startOnLogin", Kind::Bool, json!(false)),
        ("externalPolling", Kind::Bool, json!(true)),
        ("notifyOnFinish", Kind::Bool, json!(true)),
        ("autoTitles", Kind::Bool, json!(true)),
        ("accent", Kind::OneOf(ACCENTS), json!("graphite")),
        ("darkStyle", Kind::OneOf(DARK_STYLES), json!("default")),
        ("lightStyle", Kind::OneOf(LIGHT_STYLES), json!("default")),
        ("uiFont", Kind::OneOf(UI_FONTS), json!("inter")),
        ("codeFont", Kind::CodeFont, Value::Null),
    ]
}

/// A whole number as an integer, so 60.0 reads back as 60, as in JavaScript.
fn integral(v: &Value) -> Option<i64> {
    if let Some(i) = v.as_i64() {
        return Some(i);
    }
    let f = v.as_f64()?;
    (f.fract() == 0.0 && f.abs() < 9.0e15).then_some(f as i64)
}

/// `value` checked against `kind`: the value to keep, or why it can't be.
fn check(kind: Kind, value: &Value, patch: bool) -> Result<Value, &'static str> {
    match kind {
        Kind::NullableString if value.is_null() || value.is_string() => Ok(value.clone()),
        Kind::NullableString => Err("expected a string or null"),
        Kind::Number => match integral(value) {
            Some(i) => Ok(json!(i)),
            None if value.is_number() => Ok(value.clone()),
            None => Err("expected a number"),
        },
        Kind::Minutes if value.is_null() => Ok(Value::Null),
        Kind::Minutes => match integral(value) {
            Some(i) if (5..=1440).contains(&i) => Ok(json!(i)),
            _ => Err("expected a whole number of minutes from 5 to 1440, or null"),
        },
        Kind::Bool if value.is_boolean() => Ok(value.clone()),
        Kind::Bool => Err("expected true or false"),
        Kind::OneOf(choices) => match value.as_str() {
            Some(s) if choices.contains(&s) => Ok(value.clone()),
            _ => Err("not one of the choices"),
        },
        Kind::CodeFont => match value {
            Value::Null => Ok(Value::Null),
            Value::String(s) if patch && s.encode_utf16().count() > CODE_FONT_MAX => {
                Err("at most 256 characters")
            }
            Value::String(s) => Ok(sanitize_font_family(s).map_or(Value::Null, Value::String)),
            _ => Err("expected a string or null"),
        },
    }
}

/// The settings to answer: each stored value that still reads, the default for the rest
/// (`SettingsSchema` over the stored values, as the service's `getSettings`).
pub fn read(stored: &Map<String, Value>) -> Value {
    let mut out = Map::new();
    for (name, kind, default) in fields() {
        let value = stored
            .get(name)
            .and_then(|v| check(kind, v, false).ok())
            .unwrap_or(default);
        out.insert(name.to_string(), value);
    }
    Value::Object(out)
}

/// A `settings.set` patch checked as `SettingsPatchSchema` does: every known
/// field present must be valid (or nothing is stored), unknown ones are dropped.
pub fn check_patch(params: &Value) -> Result<Map<String, Value>, String> {
    let Some(given) = params.as_object() else {
        return Err("Expected an object".into());
    };
    let mut patch = Map::new();
    let mut problems = Vec::new();
    for (name, kind, _) in fields() {
        let Some(value) = given.get(name) else {
            continue;
        };
        match check(kind, value, true) {
            Ok(v) => {
                patch.insert(name.to_string(), v);
            }
            Err(why) => problems.push(format!("{name}: {why}")),
        }
    }
    if problems.is_empty() {
        Ok(patch)
    } else {
        Err(problems.join("; "))
    }
}

/// `sanitizeFontFamily` of the protocol: only letters, digits, spaces, `_`,
/// `-` and `.` survive, at most four names of 64 characters; None when
/// nothing usable is left. A name is cut at 64 UTF-16 units, as JavaScript's
/// `slice` does (where that would split a pair, the whole character goes).
pub fn sanitize_font_family(raw: &str) -> Option<String> {
    static UNSAFE: OnceLock<Regex> = OnceLock::new();
    let unsafe_chars =
        UNSAFE.get_or_init(|| Regex::new(r"[^\p{L}\p{N} _.\-]").expect("a valid pattern"));
    let names: Vec<String> = raw
        .split(',')
        .map(|n| {
            let cleaned = unsafe_chars.replace_all(n, " ");
            // Only plain spaces are left to collapse: no letter or digit is whitespace.
            let collapsed = cleaned
                .split(' ')
                .filter(|w| !w.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            let mut units = 0;
            let cut: String = collapsed
                .chars()
                .take_while(|c| {
                    units += c.len_utf16();
                    units <= FONT_NAME_MAX
                })
                .collect();
            cut.trim().to_string()
        })
        .filter(|n| !n.is_empty())
        .take(FONT_NAMES_MAX)
        .collect();
    (!names.is_empty()).then(|| names.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fonts_are_sanitised_as_the_protocol_does() {
        assert_eq!(
            sanitize_font_family("Fira Code; x"),
            Some("Fira Code x".into())
        );
        assert_eq!(
            sanitize_font_family(r#"a"b, c\d , , e{f}, g, h"#),
            Some("a b, c d, e f, g".into())
        );
        assert_eq!(
            sanitize_font_family("Ünïcode Mono, 思源黑体"),
            Some("Ünïcode Mono, 思源黑体".into())
        );
        assert_eq!(sanitize_font_family(" ;; , /* */ "), None);
        assert_eq!(sanitize_font_family(&"x".repeat(70)), Some("x".repeat(64)));
        // A combining mark is not a letter (\p{L}) to JavaScript: it becomes a space.
        assert_eq!(sanitize_font_family("e\u{301}x"), Some("e x".into()));
    }

    #[test]
    fn a_stored_value_that_no_longer_reads_falls_back_to_its_default() {
        let stored: Map<String, Value> = serde_json::from_value(json!({
            "theme": "dark",
            "accent": "neon",
            "idleShutdownMinutes": 2,
            "notifications": "yes",
            "codeFont": "Mono; x",
            "unknown": 1,
        }))
        .unwrap();
        let s = read(&stored);
        assert_eq!(s["theme"], "dark");
        assert_eq!(s["accent"], "graphite");
        assert_eq!(s["idleShutdownMinutes"], 60);
        assert_eq!(s["notifications"], true);
        assert_eq!(s["codeFont"], "Mono x");
        assert!(s.get("unknown").is_none());
    }

    #[test]
    fn whole_numbers_read_as_integers() {
        let patch = check_patch(&json!({ "idleShutdownMinutes": 30.0, "idleReclaimMinutes": 2.5 }))
            .unwrap();
        assert_eq!(
            serde_json::to_string(&patch["idleShutdownMinutes"]).unwrap(),
            "30"
        );
        assert_eq!(patch["idleReclaimMinutes"], json!(2.5));
    }
}
