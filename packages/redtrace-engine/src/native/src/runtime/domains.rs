use napi::bindgen_prelude::Utf16String;
use napi_derive::napi;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

const DOMAIN_JSON: &str = include_str!("domain-catalog.json");

pub(super) fn domains() -> &'static Map<String, Value> {
    static VALUE: OnceLock<Map<String, Value>> = OnceLock::new();
    // INFALLIBLE: both catalogs are repository-owned JSON literals checked by the tests.
    VALUE.get_or_init(|| serde_json::from_str(DOMAIN_JSON).expect("valid domain catalog"))
}

fn word(unit: u16) -> bool {
    unit <= 127 && ((unit as u8).is_ascii_alphanumeric() || unit == u16::from(b'_'))
}
type Replacements = HashMap<Vec<u16>, (Vec<u16>, Vec<u16>)>;
fn replacements() -> &'static Replacements {
    static VALUE: OnceLock<Replacements> = OnceLock::new();
    VALUE.get_or_init(|| {
        domains()
            .iter()
            .flat_map(|(domain, actions)| {
                actions.as_object().into_iter().flat_map(move |actions| {
                    actions.iter().filter_map(move |(action, original)| {
                        original.as_str().map(|original| {
                            (
                                original.encode_utf16().collect(),
                                (
                                    format!("{domain} (action={action})")
                                        .encode_utf16()
                                        .collect(),
                                    format!(r#"{domain}({{action:"{action}","#)
                                        .encode_utf16()
                                        .collect(),
                                ),
                            )
                        })
                    })
                })
            })
            .collect()
    })
}
pub fn rewrite_units(text: Vec<u16>) -> Vec<u16> {
    let replacements = replacements();
    let mut output = Vec::with_capacity(text.len());
    let mut cursor = 0;
    while cursor < text.len() {
        let start = cursor;
        if word(text[cursor]) {
            while cursor < text.len() && word(text[cursor]) {
                cursor += 1;
            }
            if let Some((plain, invocation)) = replacements.get(&text[start..cursor]) {
                if text.get(cursor..cursor + 2) == Some(&[40, 123]) {
                    output.extend_from_slice(invocation);
                    cursor += 2;
                } else {
                    output.extend_from_slice(plain);
                }
            } else {
                output.extend_from_slice(&text[start..cursor]);
            }
        } else {
            output.push(text[cursor]);
            cursor += 1;
        }
    }
    output
}
#[napi(js_name = "rewriteToolNames")]
pub fn rewrite_tool_names(text: Utf16String) -> Utf16String {
    rewrite_units(text.to_vec()).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rewrites_invocations_and_preserves_utf16_nonword_boundaries() {
        let input: Vec<u16> =
            "submit_fact({x:1}) submit_fact xsubmit_fact submit_fact_x 中文submit_fact😀"
                .encode_utf16()
                .chain([0xd800])
                .collect();
        let output = rewrite_units(input);
        let mut expected: Vec<u16> = r#"fgs_publish({action:"fact",x:1}) fgs_publish (action=fact) xsubmit_fact submit_fact_x 中文fgs_publish (action=fact)😀"#.encode_utf16().collect();
        expected.push(0xd800);
        assert_eq!(output, expected);
    }
}
