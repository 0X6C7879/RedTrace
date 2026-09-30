---
name: jev-decision
description: Use during Explore when several available scanners, PoC files, wordlists, or search sources compete for one objective, or when the confirmed Facts leave an attack's prerequisites uncertain. Call RedTrace's Jev advisory tools before a costly choice.
---

# Jev decision assistance for Explore

When available, use `jev_choose` only when 2–8 real candidates can serve the same concrete objective and a poor choice would waste meaningful time. Check that commands or files exist first. Supply each candidate's stable ID, name, actual executable/file/URL reference, and a short `detail` based on observed capabilities or requirements. Pass relevant confirmed Fact IDs. For search results, inspect the original sources; the automatic Jev note is only a reading suggestion.

When available, use `jev_assess_attack` before a costly proposed approach when its necessary prerequisites are uncertain. List the prerequisites explicitly and cite confirmed Fact IDs. The returned Score measures how well those Facts support the stated prerequisites. It is not a probability of exploitation.

Jev never runs a candidate, verifies a vulnerability, or decides the next Step. Compare its advice with the original evidence and choose the next action yourself. If the tool is disabled, times out, or returns no useful advice, continue with the evidence already available. Avoid Jev calls for obvious or cheap choices.
