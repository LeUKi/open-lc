# Agent API

All Agent requests use:

```http
Authorization: Bearer <agent_token>
```

Error responses should use JSON with at least:

```json
{
  "code": "ERROR_CODE",
  "message": "Human readable message"
}
```

Polling responses should include `next_poll_after` in seconds. Terminal states may return `next_poll_after: null`.

Broker notification preferences are split by domain. User notification settings cover user-facing events such as Agent runtime changes, feedback status updates, and summary notifications. Admin backend notification settings are separate per-admin settings for backend events such as `feedback_created_admin`. Admins may configure both domains independently because an admin account is also a normal user account. Admin backend notifications may still create rows in the normal notification list for that admin, but their delivery switches and Webhook URL come from the admin notification domain. By default only in-app delivery is enabled; browser push, Webhook, and email delivery must be explicitly enabled by users or admins. Real external delivery also requires the Broker-level `NOTIFICATION_EXTERNAL_DELIVERY_ENABLED=true`; when it is not enabled, in-app notifications still work and external attempts are logged as skipped.

## Heartbeat

```http
POST /api/lc/agent/heartbeat
```

Request:

```json
{
  "available": true,
  "capabilities": {
    "schemaVersion": 1,
    "providers": ["baidu"],
    "features": ["link_proxy:v2"],
    "providerCapabilities": {
      "baidu": {
        "features": ["link_proxy:v2"],
        "resultLinkTtlSeconds": 3600
      }
    }
  },
  "client_version": "agent-v0.0.0",
  "client_info": {
    "name": "lc-agent",
    "version": "0.0.0",
    "runtime": "desktop",
    "platform": "darwin",
    "arch": "arm64"
  }
}
```

`client_info` is an optional top-level diagnostics/display field, parallel to `client_version`. It is not part of `capabilities`, does not have its own schema version, and must not be used for task matching, scheduling, billing, or authorization. Missing `client_info` values are treated as legacy Agent heartbeats.

Response:

```json
{
  "status": "ok",
  "next_poll_after": 30
}
```

If the Agent polls too early:

```json
{
  "status": "too_early",
  "next_poll_after": 3
}
```

## Poll Task Summaries

```http
GET /api/lc/agent/tasks?limit=20
```

Rules:

- Return only tasks that are open for participation.
- Do not return share URL, password, directory, file name, or other real task payload.
- `capabilities.providers` may be used to match provider support.
- `capabilities.providerCapabilities[provider].features` is preferred for provider-specific matching. `capabilities.features` remains a compatibility summary. Current link-proxy tags are `link_proxy:v1` and `link_proxy:v2`.
- `capabilities.providerCapabilities[provider].resultLinkTtlSeconds` reports the Agent's committed result-link lifetime in seconds for that provider. Missing legacy values are treated as `3600`.
- A task may require `link_proxy_requirement=no_link_proxy`.
- `no_link_proxy` only matches Agents that explicitly report a provider-level or top-level `features` array and do not include `link_proxy:v1` or `link_proxy:v2`.
- Old Agents that omit `features` are treated as unknown and do not match `no_link_proxy`.
- This is a requester-side direct-link requirement, not proof of the final result URL state.
- A task may require `min_result_link_ttl_seconds`. The Agent sees the task only when its provider-specific `resultLinkTtlSeconds` is greater than or equal to the task requirement.

Response:

```json
{
  "status": "ok",
  "next_poll_after": 5,
  "tasks": [
    {
      "task_id": "uuid",
      "provider": "baidu",
      "file_size": 5368709120,
      "base_price": 100,
      "base_price_cents": 100,
      "price": 100,
      "desired_result_count": 1,
      "primary_reward": 40,
      "secondary_pool": 10,
      "platform_budget": 50,
      "max_candidates": 3,
      "link_proxy_requirement": "any",
      "min_result_link_ttl_seconds": 3600,
      "apply_deadline": "2026-05-13T12:00:00Z",
      "blocking_timeout_seconds": 10,
      "parse_timeout_seconds": 30
    }
  ]
}
```

## Participate In Task

```http
POST /api/lc/agent/tasks/:task_id/participations
```

Request body may be an empty JSON object.

Rules:

- The task must be in `APPLYING`.
- The apply window must still be open.
- The task participation limit must not be full.
- The same Agent can have only one Participation per task.
- New Participations should satisfy the same provider, link-proxy, and `min_result_link_ttl_seconds` capability requirements used by task summary polling.
- Repeated calls should return the existing Participation.

Response:

```json
{
  "participation_id": "uuid",
  "task_id": "uuid",
  "status": "APPLIED",
  "next_poll_after": 5
}
```

## Poll Participation

```http
GET /api/lc/agent/participations/:participation_id
```

The Participation must belong to the authenticated Agent.

Waiting response:

```json
{
  "status": "APPLIED",
  "next_poll_after": 5
}
```

Not selected response:

```json
{
  "status": "NOT_SELECTED",
  "next_poll_after": null
}
```

Active response:

```json
{
  "status": "ACTIVE",
  "next_poll_after": 10,
  "task_payload": {
    "provider": "baidu",
    "share_url": "https://example.invalid/share",
    "password": "",
    "dir": "/",
    "file_id": "file-id",
    "file_name": "demo.bin",
    "file_size": 5368709120,
    "file_size_bytes": 5368709120
  },
  "activated_at": "2026-05-13T12:01:00Z",
  "blocking_deadline": "2026-05-13T12:01:30Z",
  "parse_deadline": "2026-05-13T12:03:00Z"
}
```

If a primary result already exists but this Participation is still active and before its parse deadline:

```json
{
  "status": "ACTIVE",
  "task_status": "PRIMARY_COMPLETED",
  "allow_secondary_submit": true,
  "next_poll_after": 10,
  "task_payload": {
    "provider": "baidu",
    "share_url": "https://example.invalid/share",
    "password": "",
    "dir": "/",
    "file_id": "file-id",
    "file_name": "demo.bin",
    "file_size": 5368709120,
    "file_size_bytes": 5368709120
  },
  "parse_deadline": "2026-05-13T12:03:00Z"
}
```

`base_price` / `base_price_cents` is the Task base price (任务基准积分). `price` is the total Task price (任务总积分), computed as `base_price * desired_result_count`.

## Submit Result

```http
POST /api/lc/agent/participations/:participation_id/submit
```

Success request:

```json
{
  "type": "success",
  "result_url": "https://example.invalid/download",
  "expires_at": "2026-05-13T12:30:00Z",
  "headers": {
    "User-Agent": "..."
  },
  "note": ""
}
```

Failure request:

```json
{
  "type": "failure",
  "failure_code": "INVALID_SHARE_LINK",
  "note": "share expired"
}
```

Rules:

- The Participation must belong to the authenticated Agent.
- The Participation must be `ACTIVE`.
- The submission must arrive before `parse_deadline`.
- A Participation can submit only once.
- Success may become `primary` or `secondary` for compatibility.
- Success additionally returns `reward_role`: `main_contributor` for the first `desired_result_count` successful submissions, otherwise `secondary`.
- Failure receives `reward_role: "none"` and no reward.

Accepted responses:

```json
{
  "status": "accepted",
  "submission_role": "primary",
  "reward_role": "main_contributor"
}
```

```json
{
  "status": "accepted",
  "submission_role": "secondary",
  "reward_role": "main_contributor"
}
```

```json
{
  "status": "accepted",
  "submission_role": "secondary",
  "reward_role": "secondary"
}
```

```json
{
  "status": "accepted",
  "submission_role": "none",
  "reward_role": "none"
}
```
