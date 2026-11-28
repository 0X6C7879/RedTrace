use napi::bindgen_prelude::{Buffer, Utf16String};
use napi_derive::napi;
use serde::{Deserialize, Deserializer};
use serde_json::value::RawValue;
use std::fmt::Write;

mod runtime;
mod knowledge;

fn raw_field<'de, D: Deserializer<'de>>(value: D) -> Result<Option<&'de RawValue>, D::Error> {
    <&RawValue>::deserialize(value).map(Some)
}

#[derive(Deserialize)]
struct AuditEvent<'a> {
    #[serde(default, borrow, deserialize_with = "raw_field")]
    kind: Option<&'a RawValue>,
    #[serde(default, borrow, deserialize_with = "raw_field")]
    title: Option<&'a RawValue>,
    #[serde(default, borrow, deserialize_with = "raw_field")]
    call_id: Option<&'a RawValue>,
    #[serde(default, borrow, deserialize_with = "raw_field")]
    timestamp: Option<&'a RawValue>,
    #[serde(default, borrow, deserialize_with = "raw_field")]
    error: Option<&'a RawValue>,
    #[serde(default, borrow, deserialize_with = "raw_field")]
    content: Option<&'a RawValue>,
}

// Copy a JSON string prefix in UTF-16 units, including a split surrogate just as JS slice does.
fn string_prefix(raw: &str, output: &mut String) {
    let bytes = raw.as_bytes();
    let mut position = 1;
    let mut remaining = 180;
    output.push('"');
    while remaining > 0 && bytes[position] != b'"' {
        let start = position;
        if bytes[position] == b'\\' {
            position += if bytes[position + 1] == b'u' { 6 } else { 2 };
            remaining -= 1;
        } else {
            let ch = raw[position..].chars().next().unwrap();
            if ch.len_utf16() > remaining {
                let mut units = [0; 2];
                let high = ch.encode_utf16(&mut units)[0];
                write!(output, "\\u{high:04x}").unwrap();
                break;
            }
            position += ch.len_utf8();
            remaining -= ch.len_utf16();
        }
        output.push_str(&raw[start..position]);
    }
    output.push('"');
}

fn project_row(row: &[u8], output: &mut String) -> serde_json::Result<()> {
    let event: AuditEvent<'_> = serde_json::from_slice(row)?;
    output.push('{');
    let mut separator = "";
    for (name, value) in [
        ("kind", event.kind), ("title", event.title), ("callId", event.call_id),
        ("timestamp", event.timestamp), ("error", event.error),
    ] {
        if let Some(value) = value {
            output.push_str(separator);
            write!(output, "\"{name}\":{}", value.get()).unwrap();
            separator = ",";
        }
    }
    if let Some(content) = event.content.filter(|value| value.get().starts_with('"')) {
        output.push_str(separator);
        output.push_str("\"summary\":");
        string_prefix(content.get(), output);
    }
    output.push('}');
    Ok(())
}

#[napi(js_name = "projectAuditEvents", catch_unwind)]
pub fn project_audit_events(rows: Vec<Buffer>) -> napi::Result<String> {
    let mut output = String::with_capacity(rows.len() * 512);
    output.push('[');
    for (index, row) in rows.iter().enumerate() {
        if index > 0 { output.push(','); }
        project_row(row, &mut output).map_err(|error| napi::Error::from_reason(format!("Invalid audit JSON at row {index}: {error}")))?;
    }
    output.push(']');
    Ok(output)
}

fn fold_lines(text: &[u16]) -> Option<Vec<u16>> {
    let mut output: Option<Vec<u16>> = None;
    let mut start = 0;
    while start < text.len() {
        let line_end = text[start..].iter().position(|&unit| unit == 10).map_or(text.len(), |index| start + index + 1);
        let line = &text[start..line_end];
        let mut end = line_end;
        let mut count = 1;
        while text[end..].starts_with(line) {
            end += line.len();
            count += 1;
        }
        let marker: Vec<u16> = if count >= 3 {
            format!("[上一行另重复 {} 次]\n", count - 1).encode_utf16().collect()
        } else { Vec::new() };
        if count >= 3 && line.len() + marker.len() < end - start {
            let target = output.get_or_insert_with(|| {
                let mut prefix = Vec::with_capacity(start + line.len() + marker.len());
                prefix.extend_from_slice(&text[..start]);
                prefix
            });
            target.extend_from_slice(line);
            target.extend_from_slice(&marker);
        } else if let Some(target) = output.as_mut() {
            target.extend_from_slice(&text[start..end]);
        }
        start = end;
    }
    output
}

#[napi(js_name = "compactToolTexts", catch_unwind)]
pub fn compact_tool_texts(texts: Vec<Utf16String>) -> Vec<Option<Utf16String>> {
    texts.iter().map(|text| fold_lines(text).map(Utf16String::from)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_raw_fields_and_skips_payloads() {
        let mut output = String::new();
        project_row(br#"{"kind":"tool.completed","title":null,"call_id":17,"error":false,"arguments":{"nested":[1,2]},"content":"hello"}"#, &mut output).unwrap();
        assert_eq!(output, r#"{"kind":"tool.completed","title":null,"callId":17,"error":false,"summary":"hello"}"#);
        assert!(project_row(b"{broken", &mut String::new()).is_err());
    }

    #[test]
    fn prefix_preserves_escapes_and_utf16_boundaries() {
        for raw in [r#""plain\ntext\t\"quoted\"""#, r#""𐏿""#, r#""中文😀""#] {
            let mut output = String::new();
            string_prefix(raw, &mut output);
            assert_eq!(output, raw);
        }
        let mut output = String::new();
        string_prefix(&format!("\"{}😀tail\"", "x".repeat(179)), &mut output);
        assert_eq!(output, format!("\"{}\\ud83d\"", "x".repeat(179)));
    }
}
