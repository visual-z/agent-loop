# MonkeyTest State Schema

`.monkey-test-state.json` is the MonkeyTest progress mirror.

## Invariants
- every route appears in exactly one of `pending`, `completed`, `failed`
- counters match array lengths
- `total_routes == pending + completed + failed`
- completed routes should have a route report path
- review counters should match completed route review states
