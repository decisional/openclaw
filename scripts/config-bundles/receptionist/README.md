# Receptionist Config Bundle

This bundle codifies the OpenClaw policy required for Slack receptionist workflows:

- keeps `coding` tool profile
- explicitly enables messaging tools via `tools.alsoAllow: ["group:messaging", "agents_list"]`
- keeps session tools usable across this agent via `tools.sessions.visibility: "agent"`
- sets higher default reasoning effort (`agents.defaults.thinkingDefault: "high"`)
- forces Slack channel/group replies into threads (`channels.slack.replyToMode: "all"`)
- enables thread context handoff from channel root (`channels.slack.thread.inheritParent: true`)

## Files

- `openclaw.json5`: root config using `$include`
- `config/base.public.json5`: tracked non-secret policy
- `config/secrets.example.json5`: secret shape template
- `config/secrets.local.json5`: real secrets (not tracked)
- `systemd/openclaw-gateway.override.conf`: service env override example

## Deploy

1. Copy this directory to the gateway host (example: `/opt/openclaw-config`).
2. Create `config/secrets.local.json5` from `config/secrets.example.json5`.
3. Set service env vars so gateway uses this config path.
4. Validate and restart:

```bash
OPENCLAW_CONFIG_PATH=/opt/openclaw-config/openclaw.json5 \
OPENCLAW_STATE_DIR=/home/ubuntu/.openclaw \
openclaw config validate

openclaw gateway restart
```

## DM target format

For Slack DMs, use `user:<SLACK_USER_ID>` (for example `user:U06HZG3ADK2`).
