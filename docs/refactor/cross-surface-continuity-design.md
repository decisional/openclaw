# Cross-Surface Continuity Design Review

## Problem

OpenClaw continuity is session-key based. That works within a surface, but a workflow that starts on one surface and continues on another often lands in a different session key and loses operational context.

This is visible today in ingress behavior:

- Chat/Responses APIs are stateless by default per request unless `user` or `x-openclaw-session-key` is provided.
- Slack routing uses the shared route/session pipeline and creates channel/thread-scoped session keys, with optional parent-thread fork behavior.
- `x-openclaw-work-context` is an API ingress concept; Slack needs a binding path (pre-seed or tool-driven) to map a work context onto a session.
- Memory and session-history tools can recover context, but recovery is agent-driven, not deterministic ingress routing.

## Review Of Proposed `workContextId + assemble()` Fan-Out

The proposed direction identifies the right missing concept (`workContextId`) but puts too much logic in the wrong layer.

What is good:

- Adds a logical cross-surface key.
- Uses explicit transport metadata instead of fuzzy inference.
- Aims to support receptionist/fixer/HITL workflows.

What should change:

1. `assemble()` should not scan sibling sessions every turn.
2. Cross-session transcript fan-out in `assemble()` increases latency and token use on the hottest path.
3. Fan-out creates non-deterministic ordering/merge behavior under concurrency.
4. Extending `session-memory` for “surface switch” events is a lifecycle mismatch; the hook is command-oriented (`/new`, `/reset`) today.
5. Making retrieval the primary continuity mechanism is fragile compared to deterministic routing.

Bottom line: keep `workContextId`, but do not make prompt-time cross-session retrieval the correctness path.

## Recommended Architecture (Best First Implementation)

### Principle

Continuity should be solved at **ingress routing time**, not prompt assembly time.

### V1: Canonical Session Routing Via Work-Context Registry

Introduce a small agent-scoped registry that maps:

- `workContextId -> canonicalSessionKey`

Then resolve session keys in this precedence order:

1. `x-openclaw-session-key` (explicit override; existing behavior)
2. `x-openclaw-work-context` mapped to canonical session key
3. `user`-derived stable key (existing behavior)
4. generated ephemeral key (existing behavior)

If `x-openclaw-work-context` is present but unknown:

- create a canonical session key for that work context
- persist the mapping
- use that canonical key for the run

This keeps cross-surface continuity deterministic without scanning multiple sessions per turn.

### Important Nuance: Shared Routing vs Header Ingress

- Slack and gateway both rely on shared route/session primitives (`resolveAgentRoute()` and session-key builders).
- The gateway is still where HTTP headers are parsed.
- Therefore, cross-surface continuity needs two pieces:
  1. Header-driven work-context resolution for API ingress.
  2. A way for Slack turns to reuse that mapping (for example, pre-seeding or a `set_work_context` style bind that yields an explicit session key).

### V1 Scope Boundaries

Keep unchanged:

- context-engine `assemble()` semantics
- legacy engine behavior
- `session-memory` command hook behavior
- Slack thread inheritance/fork mechanism

Use existing mechanisms as intended:

- thread inherit/fork for same-surface bootstrap
- memory retrieval for sparse durable recall
- context engine as final prompt shaping, not identity resolution

## Suggested File-Level Changes (OpenClaw)

Minimal v1 implementation:

- `src/gateway/http-utils.ts`
  - parse `x-openclaw-work-context`
  - resolve `workContextId -> canonicalSessionKey` before fallback logic
  - allow binding `workContextId -> explicit session key` when both headers are present
- `src/gateway/openai-http.ts`
  - include resolved/echoed work-context metadata in response headers (if provided)
- `src/gateway/openresponses-http.ts`
  - same as OpenAI gateway path
- `src/config/sessions/session-key.ts`
  - keep explicit `ctx.SessionKey` precedence and route work-context-resolved keys through the same normalization path
- `extensions/slack/src/monitor/message-handler/prepare.ts`
  - keep shared route resolution; optionally hydrate explicit session key from a persisted work-context binding when available
- `src/config/sessions/types.ts`
  - optional metadata on `SessionEntry` for observability (`workContextId`), not required for routing correctness
- `src/gateway/protocol/schema/sessions.ts`
  - optional patch/create fields only if we expose admin/session APIs for binding
- `src/sessions/work-context-store.ts` (new)
  - small persisted map with atomic write helper
  - agent-scoped location near session store
- `src/sessions/work-context-store.test.ts` (new)
  - load/save/overwrite/invalid-input tests
- gateway request-context tests
  - precedence and backward compatibility tests

## Why This Is Better

1. Deterministic: one work context maps to one canonical session key.
2. Cheap: no per-turn fan-out across sibling sessions.
3. Compatible: existing session key and `user` flows still work.
4. Safe rollout: additive header + resolver, no context-engine interface churn.
5. Correct ownership: routing layer owns identity; context layer owns prompt assembly.

## Rollout Plan

### Phase 0 (this doc)

- Align on architecture and acceptance criteria.

### Phase 1 (small code PR)

- Add `x-openclaw-work-context` parsing + resolver + tests.
- Keep all existing behavior unchanged when header is absent.

### Phase 2 (operator ergonomics)

- Add optional sessions API/tooling to bind/unbind/list work-context mappings.
- Add minimal diagnostics (`/status` or debug output) showing active work-context mapping.

### Phase 3 (optional improvements)

- Optional bounded `work_context_state` summary artifact for long-lived work contexts.
- Still no cross-session transcript fan-out in `assemble()`.

## Acceptance Criteria

1. Two requests on different surfaces with the same `x-openclaw-work-context` land on the same session key.
2. Existing clients without the header see no behavior change.
3. `x-openclaw-session-key` still takes precedence over work-context routing.
4. No new `assemble()`-time sibling-session scanning is introduced.
5. End-to-end tests show continuity across OpenAI/OpenResponses + Slack handoff when the same work context mapping is bound.
