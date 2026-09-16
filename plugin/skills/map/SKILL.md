---
name: map
description: Scan the project with AgentAtlas and refresh SYSTEM.md and .agentatlas/atlas.yaml. Use when the user asks to map the system, refresh or update the system map, or check the map for drift.
argument-hint: "[check]"
disable-model-invocation: true
allowed-tools: Bash(npx -y agentatlas@0.1 *)
---

# /agentatlas:map

1. If `$ARGUMENTS` is `check`, run `npx -y agentatlas@0.1 check` and report the result. Stop there.
2. If `agentatlas.yaml` doesn't exist, run `npx -y agentatlas@0.1 init`, then set `system.name` and `system.description` in it from what you know about the project.
3. Run `npx -y agentatlas@0.1 scan`.
4. Read the new `SYSTEM.md` and report:
   - counts of services, data stores, messaging, external systems, and flows
   - anything that looks wrong: nodes with names like `<service>-sql-server` (inferred stores that need a real name), unexpected `external` nodes, missing services you know exist
5. For each problem, propose the fix in `agentatlas.yaml` (`aliases`, `ignore`, `nodes`, or `edges`) and apply it only after the user agrees, then rescan.
6. Remind the user to commit `agentatlas.yaml`, `.agentatlas/atlas.yaml`, and `SYSTEM.md` together.
