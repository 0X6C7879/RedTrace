use napi_derive::napi;
use serde_json::{Map, Value, json};
use std::collections::HashSet;

#[napi(object)]
pub struct NoticeEvent {
    pub id: f64,
    pub event_type: String,
    pub node_id: String,
    pub evidence_seq: f64,
    pub hint_seq: f64,
}

#[napi]
pub struct NativeGraphNotice {
    after: f64,
    cursor: f64,
    step_id: Option<String>,
    critical_enabled: bool,
    stopped: bool,
    plan_version: f64,
    bound_version: f64,
    plan_changed: bool,
    project_critical_seq: f64,
    relevant: bool,
    evidence_seq: f64,
    hint_seq: f64,
    critical_seq: f64,
    omitted: bool,
    counts: Map<String, Value>,
    node_ids: Vec<String>,
    seen: HashSet<String>,
}
#[napi]
#[expect(
    clippy::too_many_arguments,
    reason = "The N-API constructor snapshots scalar graph state once rather than introducing a wrapper"
)]
impl NativeGraphNotice {
    #[napi(constructor)]
    pub fn new(
        after: f64,
        step_id: Option<String>,
        critical_enabled: bool,
        stopped: bool,
        plan_version: f64,
        bound_version: f64,
        has_step: bool,
        project_critical_seq: f64,
    ) -> Self {
        Self {
            after,
            cursor: after,
            step_id,
            critical_enabled,
            stopped,
            plan_version,
            bound_version,
            plan_changed: !stopped && has_step && plan_version != bound_version,
            project_critical_seq,
            relevant: false,
            evidence_seq: 0.0,
            hint_seq: 0.0,
            critical_seq: 0.0,
            omitted: false,
            counts: Map::new(),
            node_ids: Vec::new(),
            seen: HashSet::new(),
        }
    }
    #[napi]
    pub fn ingest(&mut self, events: Vec<NoticeEvent>) -> f64 {
        for event in events {
            self.cursor = event.id;
            let added = matches!(event.event_type.as_str(), "fact.added" | "finding.added");
            let critical = self.step_id.is_none()
                && self.critical_enabled
                && event.event_type == "planning.critical";
            let hint = matches!(event.event_type.as_str(), "hint.added" | "hint.deleted");
            let changed = match self.step_id.as_deref() {
                None => added || hint || critical,
                Some(step) => {
                    self.plan_changed
                        && event.node_id == step
                        && matches!(event.event_type.as_str(), "step.revised" | "step.updated")
                }
            };
            if hint && changed {
                self.hint_seq = self.hint_seq.max(event.hint_seq);
            }
            if added && changed {
                self.evidence_seq = self.evidence_seq.max(event.evidence_seq);
            }
            if critical {
                self.critical_seq = self.project_critical_seq;
            }
            self.relevant |= changed;
            if changed {
                let count = self
                    .counts
                    .get(&event.event_type)
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
                    + 1.0;
                self.counts.insert(event.event_type, json!(count));
                let node = event.node_id;
                if !node.is_empty() && !self.seen.contains(&node) {
                    if self.node_ids.len() < 16 {
                        self.seen.insert(node.clone());
                        self.node_ids.push(node);
                    } else {
                        self.omitted = true;
                    }
                }
            }
        }
        self.cursor
    }
    #[napi]
    pub fn finish(&self, latest_cursor: Option<f64>) -> String {
        json!({"after":self.after,"cursor":latest_cursor.unwrap_or(self.cursor),"relevant":!self.stopped&&self.relevant,
            "evidenceSeq":self.evidence_seq,"hintSeq":self.hint_seq,"criticalSeq":self.critical_seq,
            "planChanged":self.plan_changed,"stopped":self.stopped,"planVersion":self.plan_version,"boundStepVersion":self.bound_version,
            "wake":self.critical_seq!=0.0||self.plan_changed||self.step_id.is_none()&&(self.evidence_seq!=0.0||self.hint_seq!=0.0),
            "counts":self.counts,"nodeIds":self.node_ids,"omitted":self.omitted}).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notices_keep_cursor_counts_and_bounded_insertion_order_across_pages() {
        let mut notice = NativeGraphNotice::new(0.0, None, true, false, 1.0, 1.0, false, 8.0);
        let events = (1..=20)
            .map(|index| NoticeEvent {
                id: f64::from(index),
                event_type: "fact.added".into(),
                node_id: format!("f{index}"),
                evidence_seq: f64::from(index),
                hint_seq: 0.0,
            })
            .collect();
        assert_eq!(notice.ingest(events), 20.0);
        notice.ingest(vec![NoticeEvent {
            id: 21.0,
            event_type: "planning.critical".into(),
            node_id: String::new(),
            evidence_seq: 0.0,
            hint_seq: 0.0,
        }]);
        let output: Value = serde_json::from_str(&notice.finish(Some(24.0))).unwrap();
        assert_eq!(output["cursor"], 24.0);
        assert_eq!(output["counts"]["fact.added"], 20.0);
        assert_eq!(output["nodeIds"].as_array().unwrap().len(), 16);
        assert_eq!(output["omitted"], true);
        assert_eq!(output["criticalSeq"], 8.0);
    }
}
