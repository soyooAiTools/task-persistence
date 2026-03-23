# task-persistence

OpenClaw plugin — survives gateway restarts.

## Features

### Layer 1: Pending Reply Recovery
- Writes `pending-reply.json` when a user message arrives (`before_agent_start`)
- Deletes it when the agent finishes responding (`agent_end`)
- If the gateway crashes mid-response, `HEARTBEAT.md` detects the leftover file and recovers

### Layer 2: Active Task Checkpoints
- Reads `active-task.json` on every agent start
- Injects task progress (completed/remaining steps) into the agent context
- Agent can resume multi-step tasks after restarts without losing track

## Install

Copy to `~/.openclaw/extensions/task-persistence/`, then add to `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["task-persistence"],
    "entries": {
      "task-persistence": { "enabled": true }
    }
  }
}
```

Restart the gateway.

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `dataDir` | workspace root | Directory for `pending-reply.json` and `active-task.json` |

## active-task.json Format

```json
{
  "taskId": "deploy-v2",
  "description": "Deploy blueprint v2 to production",
  "steps": [
    { "step": 1, "label": "Build frontend", "status": "done" },
    { "step": 2, "label": "Upload to ECS", "status": "pending" },
    { "step": 3, "label": "Restart PM2", "status": "pending" }
  ],
  "currentStep": 2,
  "startedAt": "2026-03-23T10:00:00Z",
  "updatedAt": "2026-03-23T10:05:00Z"
}
```

## License

MIT
