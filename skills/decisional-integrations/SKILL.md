---
name: decisional-integrations
description: Use Decisional integration toolkits from OpenClaw. Use when a user asks to act through external SaaS or business systems such as email, CRM, Slack, Attio, HubSpot, Salesforce, Linear, GitHub, Jira, Google Sheets, Google Drive, calendar, Stripe, Shopify, Airtable, Notion, or databases; especially when you need to discover whether a toolkit exists, whether it is connected, list available toolkit tools, execute a connected tool, or prompt the user with a Decisional connect URL for a missing credential.
metadata:
  {
    "openclaw":
      {
        "emoji": "D",
        "install":
          [
            {
              "id": "npm",
              "kind": "node",
              "package": "@decisional/cli",
              "bins": ["decisional"],
              "label": "Install Decisional CLI"
            }
          ]
      }
  }
---

# Decisional Integrations

Use the `decisional` CLI when the user asks OpenClaw to work with an external
business system through Decisional integrations.

## Discovery Files

Read `{baseDir}/common-use-cases.md` when the user describes an external-system
or business-data workflow without naming the exact toolkit. Use it as a hint
file, then verify exact toolkit and tool availability with the CLI.

Do not default to generic browser or web tools when a Decisional toolkit is a
better fit and the task needs the user's live business data or write access.

## CLI Availability

Check the CLI before relying on it:

```bash
decisional --version
decisional connect url --help
decisional tools --help
```

`decisional connect url` requires Decisional CLI `0.1.14` or newer. If the
command is unavailable, tell the user the Decisional CLI needs updating before
you can generate toolkit connect links.

If authentication is missing, ask the user to authenticate Decisional first:

```bash
decisional auth login
```

## Workflow

1. Identify likely toolkit candidates.
   - If the user named one, use that name directly.
   - If the user described a generic workflow, read `common-use-cases.md`.
   - If multiple likely toolkits remain, ask one focused question.

2. Check connected credentials and tools.
   - Connected toolkits:
     ```bash
     decisional tools list-connected-toolkits --output json
     ```
   - Connected tools for a likely toolkit:
     ```bash
     decisional tools list-connected-tools <toolkit> --output json
     ```
   - All available tools for a toolkit, connected or not:
     ```bash
     decisional tools list <toolkit> --output json
     ```

3. If the toolkit exists but is not connected, generate a connect URL:

   ```bash
   decisional connect url <toolkit> --url-only
   ```

   Reply to the user with a concise prompt such as:

   ```text
   I found the Gmail integration, but it is not connected yet. Connect it here:
   <url>

   Reply when it is connected and I can continue.
   ```

   In chat/channel sessions, prefer `--url-only`; do not use `--open`.

4. Execute only after a connected credential is available.
   - Inspect tool schema when parameters are unclear:
     ```bash
     decisional tools inspect <tool-slug> --toolkit <toolkit> --output json
     ```
   - Execute with parameters from a file for non-trivial payloads:
     ```bash
     decisional tools execute <tool-slug> --params-file payload.json --output json
     ```

## Connection Status Notes

- `decisional tools list-connected-toolkits` lists connected toolkits in the
  active workspace. It does not list every not-connected catalog toolkit.
- `decisional connect url <toolkit>` resolves a catalog toolkit and reports
  whether it already has active credentials when not using `--url-only`.
- `decisional connect status <agent-id>` is agent-scoped; it shows
  `needs_connection` only for toolkits attached to that Decisional agent's live
  version.

## Fallback Policy

- If a toolkit exists but is not connected and the task requires that system,
  stop and ask the user to connect it with the generated URL.
- If the toolkit is optional, briefly offer it and continue with a safe fallback
  only when the user asked for progress without that system.
- If the toolkit does not exist, say that Decisional does not currently expose
  that toolkit and offer the closest connected alternative.
- Never invent credential ids, toolkit ids, tool slugs, or connection status.
