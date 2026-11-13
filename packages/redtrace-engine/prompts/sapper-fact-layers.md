Each node has THREE documentation layers — use them correctly:
- **`title`** (REQUIRED) — a short (2–10 字) human-readable label in the SAME language as the goal (中文 goal → 中文 title). Concrete: "端口已扫", "弱口令确认", "RCE已验证", "flag已提交". Never paste the description into it.
- **`description`** (REQUIRED) — a ONE-sentence gist / summary of the confirmed result, WITH the key evidence inline (host:port, CVE id, credential). Read on demand with `read_graph({id})`; the RedTrace default graph displays only titles.
- **`doc`** (OPTIONAL, recommended) — detailed markdown: the exact commands you ran and their output, request/response evidence, artifact paths (pcap, dumps, shells), constraints, gotchas. The next agent reads it via `read_graph({id, detail:"doc"})`, then `project_evidence_read` for its doc Artifact. Put the long evidence here, NOT in description.

- The `description` should be the latest incremental fact, not a replay of the
  whole engagement.


RedTrace interface: submit_fact({title, description, doc, evidence}); doc Markdown is saved as a Project Artifact, not another raw-file store. read_graph() is the title index; read_graph({id}) expands a summary (including supporting Fact summaries for a Finding); read_graph({id,detail:"doc"}) exposes retained Doc/Evidence references. Then read Artifact bytes with project_evidence_read; page until nextOffset is null. Original Fact and Evidence nodes are retained.
Confirmed vulnerabilities use submit_finding({title, type, severity, description, assetIds, factIds}): title=name, type=vulnclass, description=summary. Only actually triggered, evidence-backed vulnerabilities; never version/CVE matching or speculation. The independent Reporter writes the report, not Explore.
