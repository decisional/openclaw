# Credential Manager Slot Design

## Problem

Restricted fixer and agent work currently rely on `hiddenEnv` to move scoped `DECISIONAL_TOKEN` values into exec sessions. That transport works, but it keeps credential routing tied to per-run plaintext env payloads instead of stable internal references.

The follow-up PR should introduce an internal credential manager that makes token resolution deterministic across long-lived sessions and work contexts without copying plaintext tokens into every binding record.

## Goals

- Keep a baseline Decisional credential available for normal channel sessions.
- Support long-lived channel session bindings.
- Support per-work-context scoped credentials for restricted fixer or agent work.
- Resolve exec credentials in a single deterministic order.
- Store bindings as references to credential slots, not plaintext token copies.

## Non-Goals

- Replacing the current `hiddenEnv` transport in the same PR as the manager introduction.
- Generalizing the first version to arbitrary secret types beyond Decisional credentials.
- Changing unrelated auth-profile or model-provider credential resolution.

## Proposed Model

### Credential slots

Introduce a credential manager with named slots. Each slot owns the plaintext material plus metadata such as source, created time, and rotation time.

Required initial slot:

- `baseline_decisional`
  loaded once at startup from the gateway environment or equivalent startup credential source

Scoped slots can be created later for restricted work:

- `scoped_decisional:<opaque-id>`
  created when the gateway receives or mints a scoped Decisional token for restricted work

### Bindings

Bindings point to slot ids. They do not duplicate token material.

Required binding surfaces:

- `session_key -> credential_slot_id`
  for long-lived channel sessions that should keep full-access Decisional behavior
- `work_context_id -> credential_slot_id`
  for restricted fixer or agent work that should resolve to a scoped credential

Bindings should be persisted in a small internal store so they survive process restarts and let channel sessions continue to resolve consistently.

## Resolution Rules

Exec-time Decisional token resolution must be:

1. `work_context_id` binding
2. `session_key` binding
3. no token

This is intentionally fail-closed. If neither binding exists, exec should not inject a Decisional token implicitly.

The baseline behavior for normal sessions comes from creating the session binding, not from ambient fallback at exec time.

## Default Access Model

### Normal channel sessions

- On session creation, bind `session_key` to `baseline_decisional`.
- These sessions keep the current full-access behavior by default.

### Restricted sessions

- When restricted fixer or agent work starts, create or attach a scoped credential slot.
- Bind `work_context_id` to that scoped slot.
- Exec within that work context resolves the scoped token first, even if the enclosing session also has a baseline binding.

This gives normal channel sessions full access by default while forcing restricted work onto scoped credentials.

## Runtime Flow

### Startup

1. Load `baseline_decisional` from the startup credential source.
2. Register the slot in the credential manager.
3. Do not inject it directly into exec environments.

### Channel session creation

1. Resolve or create the session.
2. If the session is a normal channel session, bind `session_key -> baseline_decisional`.
3. Reuse the existing binding on later turns.

### Restricted work creation

1. Receive or mint a scoped Decisional token for the work.
2. Create a scoped slot for that token.
3. Bind `work_context_id -> scoped slot`.
4. Reuse that binding for follow-up fixer or agent turns in the same work context.

### Exec

1. Gather the active `work_context_id` and `session_key`.
2. Resolve bindings in the required order.
3. Materialize the chosen slot into the child exec env.
4. If nothing resolves, inject no Decisional token.

## Migration Path From `hiddenEnv`

The current hidden-env transport can remain as the final handoff into exec until the manager lands.

Suggested migration:

1. Keep `hiddenEnv` as the last-mile transport.
2. Replace direct token threading with slot resolution before exec.
3. Populate `hiddenEnv.DECISIONAL_TOKEN` from the resolved slot only at the final boundary.
4. Remove plaintext token copies from session and work binding records.

This keeps the external exec behavior stable while moving credential ownership into the manager.

## Storage Notes

- Slot records should store encrypted or otherwise protected token material using the repo's existing secret-storage conventions.
- Binding records should store only identifiers and metadata.
- Deleting a slot should invalidate all bindings that reference it.
- Rotation should update the slot material in place when possible so bindings remain stable.

## Acceptance Criteria

1. `baseline_decisional` loads at startup and is available for binding.
2. Normal channel sessions get full access through `session_key -> baseline_decisional`.
3. Restricted fixer or agent work gets scoped access through `work_context_id` bindings.
4. Exec resolves credentials in this exact order: work context, then session, else no token.
5. Binding stores never persist plaintext token copies.
6. The manager can continue using `hiddenEnv` as the last-mile exec transport during rollout.
