FGS layers: title → description → doc/evidence. Read only what is needed; preserve technical meaning.
- Origin: exact scope/requirements. Goal/SubGoal: outcome, acceptance and prerequisites. Step: action, input Fact IDs, expected evidence; preserve stage order/dependencies.
- title: readable conclusion in the Goal's language, not the summary copied. Keep precise identifiers in description.
- description: latest incremental fact / incremental confirmed result, with decision-relevant host:port, version, credential, constraints or failure. No recap or forced length limit.
- doc/evidence: exact commands, Payload, HTTP headers/status/differences, outputs, stack traces and reproduction details. Preserve paths, credentials, Flags and Artifact/Run/Tool Call provenance. Long raw evidence stays here, not in indexes.
- Append-only nodes: correct errors with a new Fact citing the old ID, contradiction, evidence and current conclusion. Never delete nodes or merge Fact/Finding. Retain history; do not use corrected claims as prerequisites. Step failure/cancellation/replanning and Goal status updates remain.

submit_fact({title,description,doc,evidence}) stores doc Markdown as a Project Artifact. read_graph() gives title indexes; supporting Facts fold under Findings except active Step dependencies. read_graph({id}) gives summaries and supporting Fact summaries; detail:"doc" exposes Doc/Evidence references. project_evidence_read reads bytes; page until nextOffset=null. Prefer read_graph_delta and relevant IDs over rereading known history.
submit_finding({title,type,severity,description,assetIds,factIds}): actually triggered, evidence-backed vulnerabilities only, never version/CVE matches or speculation. Reporter writes reports separately. Original evidence stays retained.
