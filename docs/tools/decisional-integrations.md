---
summary: "Use Decisional integration toolkits from OpenClaw and hand users connect URLs for missing credentials"
read_when:
  - Adding or modifying Decisional integration discovery
  - Teaching agents to connect missing Decisional toolkits
  - Debugging Decisional CLI toolkit discovery from OpenClaw
title: "Decisional Integrations"
---

# Decisional Integrations

OpenClaw ships a bundled `decisional-integrations` skill for Decisional's
integration catalog. The skill teaches agents to discover likely business-system
toolkits, check connected credentials, and prompt the user with a direct connect
URL when a required toolkit exists but is not connected.

## Commands

Use Decisional CLI `0.1.14` or newer.

```bash
decisional tools list-connected-toolkits --output json
decisional tools list-connected-tools gmail --output json
decisional tools list gmail --output json
decisional tools inspect GMAIL_SEND_EMAIL --toolkit gmail --output json
decisional connect url gmail --url-only
```

`decisional tools list-connected-toolkits` lists connected toolkits in the
active workspace. It does not list every not-connected catalog toolkit.

For a specific toolkit, `decisional connect url <toolkit>` resolves the catalog
entry and prints a Decisional web URL that opens the integration catalog with
that toolkit selected. Without `--url-only`, it also reports connection context
such as `already_connected` and active credential count.

Agent-scoped connection checks are separate:

```bash
decisional connect status <agent-id> --output json
```

That command reports `needs_connection` for toolkits attached to the specified
Decisional agent's live version.

## Agent Behavior

When a user asks for a workflow like "send an email to Attio":

1. The agent reads `skills/decisional-integrations/common-use-cases.md` if the
   toolkit is ambiguous.
2. It checks the matching toolkit and connected credentials with `decisional
tools`.
3. If the toolkit exists but is not connected, it replies with:

```text
I found the Gmail integration, but it is not connected yet. Connect it here:
<url>

Reply when it is connected and I can continue.
```

For chat sessions, agents should use `--url-only` and send the URL back to the
requester rather than opening a browser on the host.

## Setup

Authenticate the Decisional CLI before using these commands:

```bash
decisional auth login
```

The bundled skill can still be overridden by placing a replacement
`decisional-integrations` skill in a higher-precedence skills directory. See
[Skills](/tools/skills) for precedence and gating rules.
