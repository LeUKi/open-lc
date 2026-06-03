# State Machine

## Task Status

- `APPLYING`
- `SELECTING`
- `RUNNING`
- `PRIMARY_COMPLETED`
- `SETTLED`
- `FAILED`

There is no `CREATED` state in LC v0. A task enters `APPLYING` only after it is accepted by the Broker.

## Participation Status

- `APPLIED`
- `NOT_SELECTED`
- `CANDIDATE_WAITING`
- `ACTIVE`
- `SUBMITTED_SUCCESS`
- `SUBMITTED_FAILURE`
- `EXPIRED`

## Task Flow

`APPLYING` means Agents may participate before `apply_deadline`.

When the apply window closes, the Broker selects candidates:

- If no Participations exist, the task becomes `FAILED`.
- Otherwise, selected Participations become `CANDIDATE_WAITING`.
- Unselected Participations become `NOT_SELECTED`.
- The task becomes `RUNNING`.
- The first candidate becomes `ACTIVE`.

`RUNNING` means one or more candidates may be active or waiting. The first success submission exposes the primary result to the requester. The task becomes `PRIMARY_COMPLETED` after the desired main-contributor result count is reached, or after candidates are exhausted with at least one primary result.

`PRIMARY_COMPLETED` means the primary result exists and no new candidates should be activated, but active candidates may still submit before their own `parse_deadline`.

`SETTLED` and `FAILED` are terminal.

## Candidate Activation

When a Participation becomes `ACTIVE`, the Broker sets:

- `activated_at`
- `blocking_deadline = activated_at + blocking_timeout_seconds`
- `parse_deadline = activated_at + parse_timeout_seconds`

The Broker must not expose `task_payload` before the Participation is `ACTIVE`.

The Broker may keep activating candidates after primary success until `desired_result_count` main-contributor successes are collected or candidates are exhausted.

## Submission Rules

- Only `ACTIVE` Participations may submit.
- Submission after `parse_deadline` must be rejected.
- A Participation can submit only once.
- The first success is `primary`.
- Later success submissions may be `secondary`.
- The first `desired_result_count` successes have `reward_role: "main_contributor"`; later successes have `reward_role: "secondary"`.
- Failure submissions have `submission_role: "none"` and `reward_role: "none"`.

## Forbidden Behavior

- A terminal task must not transition again.
- A non-active Participation must not receive task payload.
- A non-active Participation must not submit.
- A Participation must not submit both success and failure.
- A `NOT_SELECTED` Participation must not become `ACTIVE`.
