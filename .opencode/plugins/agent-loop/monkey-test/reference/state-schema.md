# MonkeyTest State Schema

` .monkey-test-state.json ` is the MonkeyTest progress mirror.

## Invariants
- every route appears in exactly one of `pending`, `completed`, `failed`
- counters match array lengths
- `total_routes == pending + completed + failed`
- completed routes should have a route report path
- review counters should match completed route review states

## Completed Entry
Each completed route should track:
- `route`
- `tested_at`
- `status`
- `screenshots_dir`
- `report_file`
- `summary`
- `review_status`
- `bug_report_file`

## Failed Entry
Each failed route should track:
- `route`
- `failed_at`
- `error`
- `retry_count`
- `last_error`
