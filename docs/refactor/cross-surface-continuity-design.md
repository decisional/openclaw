# Cross-Surface Continuity Design

## Problem

OpenClaw continuity is session-key based. That works within a surface, but a workflow that starts on one surface and continues on another often lands in a different session key and loses operational context.

### Product scenarios this must support

- OpenClaw as **receptionist**:
  a user starts in Slack, OpenClaw investigates via API/tools, and then replies back in the same Slack conversation.
- OpenClaw as **HITL approval gateway**:
  OpenClaw coordinates human approvals in Slack, then resumes/updates workflow execution.

### Concrete failure pattern

- Turn 1 (API): OpenClaw gets instructions and context in an API session key.
- Turn 2 (Slack): user replies in Slack thread, but Slack lands on a different session key.
- Result: OpenClaw behaves as if turn 1 never happened.

This is visible today in ingress behavior:

- Chat/Responses APIs are stateless by default per request unless `user` or `x-openclaw-session-key` is provided.
- Slack routing uses the shared route/session pipeline and creates channel/thread-scoped session keys, with optional parent-thread fork behavior.
- `x-openclaw-work-context` is an API ingress concept; Slack needs a binding path (pre-seed or tool-driven) to map a work context onto a session.
- Memory and session-history tools can recover context, but recovery is agent-driven, not deterministic ingress routing.

## Reviewer Quick Start

If you are reviewing this design (human or AI), use this checklist:

1. Verify the routing objective:
   one logical task should resolve to one canonical session key across API and Slack turns.
2. Verify precedence:
   explicit `x-openclaw-session-key` must still win over any work-context mapping.
3. Verify isolation:
   work-context routing is scoped by trusted principal identity and agent (not agent-only global).
4. Verify Slack compatibility:
   API -> Slack handoff requires persisted conversation binding, not work-context lookup alone.
5. Verify ingress coverage:
   V1 covers the compat APIs first; `/hooks/agent` parity is deferred.
6. Verify constraints:
   this design should not require prompt-time sibling-session fan-out in `assemble()`.
7. Verify rollout risk:
   behavior must be unchanged for clients that do not send `x-openclaw-work-context`.

## Recommended Architecture (Best First Implementation)

### Principle

Continuity should be solved at **ingress routing time**, not prompt assembly time.

### V1: Scoped Work-Context Routing

Introduce a routing map keyed by trusted scope:

- `(scopeKey, workContextId) -> canonicalSessionKey`

Where:

- `scopeKey` is derived from trusted ingress identity + agent (for example auth subject + agentId).
- `workContextId` is caller-provided logical task id.

This prevents unrelated callers from converging on the same transcript by guessing/reusing a work context id.

For non-trusted/shared ingress, `x-openclaw-work-context` must be ignored or rejected unless a trusted scope can be established.

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

### V1 Ingress Surfaces

V1 applies the same resolution semantics to the compat APIs used by the target scenarios:

- `/v1/chat/completions`
- `/v1/responses`

### Important Nuance: Shared Routing vs Header Ingress

- Slack and gateway both rely on shared route/session primitives (`resolveAgentRoute()` and session-key builders).
- The gateway is still where HTTP headers are parsed.
- Therefore, cross-surface continuity needs three pieces:
  1. Header-driven work-context resolution for API ingress.
  2. A persisted conversation binding write path for API -> Slack handoff so Slack inbound can resolve to the same target session deterministically.
  3. Hook-ingress parity later, after the compat path is proven.

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
  - resolve `(scopeKey, workContextId) -> canonicalSessionKey` before fallback logic
  - allow binding `workContextId -> explicit session key` when both headers are present
- `src/gateway/openai-http.ts`
  - include resolved/echoed work-context metadata in response headers (if provided)
- `src/gateway/openresponses-http.ts`
  - same as OpenAI gateway path
- `src/config/sessions/session-key.ts`
  - keep explicit `ctx.SessionKey` precedence and route work-context-resolved keys through the same normalization path
- `extensions/slack/src/monitor/message-handler/prepare.ts`
  - keep shared route resolution; consume persisted conversation binding that points Slack conversation to the canonical session key
- `src/config/sessions/types.ts`
  - optional metadata on `SessionEntry` for observability (`workContextId`), not required for routing correctness
- `src/infra/outbound/session-binding-service.ts`
  - add scoped work-context binding support and explicit bind-to-session operation
- `src/infra/outbound/current-conversation-bindings.ts`
  - persist API -> Slack conversation bindings used for deterministic reroute
- `src/infra/outbound/session-binding-service.test.ts`
  - add scope isolation and precedence tests
- `src/infra/outbound/current-conversation-bindings.test.ts`
  - add API -> Slack handoff binding tests
- gateway request-context tests
  - precedence and backward compatibility tests

## Why This Is Better

1. Deterministic: one work context maps to one canonical session key.
2. Cheap: no per-turn fan-out across sibling sessions.
3. Isolated: scope key prevents cross-principal session convergence.
4. Compatible: existing session key and `user` flows still work.
5. Safe rollout: additive resolver, no context-engine interface churn.
6. Correct ownership: routing layer owns identity; context layer owns prompt assembly.

## Rollout Plan

### Phase 0 (this doc)

- Align on architecture and acceptance criteria.

### Phase 1 (small code PR)

- Add scoped `x-openclaw-work-context` parsing + resolver + tests.
- Teach Slack inbound routing to honor persisted conversation bindings.
- Add response metadata so API callers can persist/bind the resolved session.
- Keep all existing behavior unchanged when header is absent.

### Phase 2 (operator ergonomics)

- Add `/hooks/agent` work-context parity for fixer/platform-initiated flows.
- Add optional sessions API/tooling to bind/unbind/list work-context mappings.
- Add minimal diagnostics (`/status` or debug output) showing active work-context mapping.

### Phase 3 (optional improvements)

- Optional bounded `work_context_state` summary artifact for long-lived work contexts.
- Still no cross-session transcript fan-out in `assemble()`.

## Acceptance Criteria

1. Two requests on different surfaces with the same `x-openclaw-work-context` land on the same session key.
2. Calls from different trusted scopes do not converge on the same session key for the same `workContextId`.
3. Existing clients without the header see no behavior change.
4. `x-openclaw-session-key` still takes precedence over work-context routing.
5. No new `assemble()`-time sibling-session scanning is introduced.
6. End-to-end tests show continuity across OpenAI/OpenResponses + Slack handoff when the same scoped work context mapping is bound.
