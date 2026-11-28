use napi::bindgen_prelude::Utf16String;
use napi_derive::napi;
use std::collections::HashMap;

#[napi]
pub struct NativePlanGuard {
    roots: HashMap<Vec<u16>, f64>,
    turn_version: f64,
}
#[napi]
#[expect(
    clippy::too_many_arguments,
    reason = "N-API methods keep their scalar JS contract without allocating an argument wrapper"
)]
impl NativePlanGuard {
    #[napi(constructor)]
    pub fn new(turn_version: f64) -> Self {
        Self {
            roots: HashMap::new(),
            turn_version,
        }
    }
    #[napi]
    pub fn begin_turn(&mut self, version: f64) {
        self.turn_version = version;
    }
    #[napi]
    pub fn settled(&mut self, root_call_id: Utf16String) {
        self.roots.remove(root_call_id.as_ref());
    }
    #[napi]
    pub fn check(
        &mut self,
        name: String,
        root_call_id: Utf16String,
        plan_required: bool,
        plan_ready: bool,
        plan_version: f64,
        bound_version: f64,
        step_json_id: String,
    ) -> Option<String> {
        let safe = matches!(
            name.as_str(),
            "read_graph"
                | "read_graph_delta"
                | "evidence_read"
                | "sync_step"
                | "submit_fact"
                | "submit_finding"
        );
        if plan_required
            && !plan_ready
            && !safe
            && !name.starts_with("legion_")
            && name != "TodoWrite"
        {
            return Some(
                "执行前由任务 Planner 用 TodoWrite 写实际阶段/验收标准；初始 Goal 占位不算计划。"
                    .into(),
            );
        }
        let version = self
            .roots
            .entry(root_call_id.to_vec())
            .or_insert(self.turn_version);
        if !safe && (*version != plan_version || bound_version != plan_version) {
            return Some(format!(
                "Plan changed: fgs_query({{action:\"overview\",id:{step_json_id}}}), then sync_step({{planVersion:{plan_version}}}). Old call trees cannot execute actions after synchronization."
            ));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_call_roots_keep_their_model_turn_version_after_sync() {
        let mut guard = NativePlanGuard::new(1.0);
        let root = || Utf16String::from("root".encode_utf16().collect::<Vec<_>>());
        assert!(
            guard
                .check(
                    "bash".into(),
                    root(),
                    false,
                    true,
                    1.0,
                    1.0,
                    "\"step\"".into()
                )
                .is_none()
        );
        guard.begin_turn(2.0);
        assert!(
            guard
                .check(
                    "bash".into(),
                    root(),
                    false,
                    true,
                    2.0,
                    2.0,
                    "\"step\"".into()
                )
                .is_some()
        );
        assert!(
            guard
                .check(
                    "read_graph".into(),
                    root(),
                    false,
                    true,
                    2.0,
                    2.0,
                    "\"step\"".into()
                )
                .is_none()
        );
        guard.settled(root());
        assert!(
            guard
                .check(
                    "bash".into(),
                    root(),
                    false,
                    true,
                    2.0,
                    2.0,
                    "\"step\"".into()
                )
                .is_none()
        );
    }
}
