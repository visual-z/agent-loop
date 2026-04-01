# MonkeyTest Route Report Format

Per-route report path:
- `monkey-test-reports/{route_slug}.json`

## Required Fields
```json
{
  "route": "/path",
  "tested_at": "ISO-8601",
  "status": "pass|partial|fail",
  "page_info": {
    "title": "string",
    "has_table": true,
    "row_count": 0,
    "column_headers": [],
    "tabs": []
  },
  "action_tree": {
    "toolbar": [],
    "row_actions": [],
    "detail_header_actions": [],
    "detail_tabs": []
  },
  "bugs": [],
  "console_errors": [],
  "summary": "string"
}
```

## Status Semantics
- `pass`: no bugs found
- `partial`: testing finished and issues were found
- `fail`: route could not be meaningfully tested

## Correlation Rule
Every action-tree entry should reference its evidence screenshot filename.
