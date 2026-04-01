# MonkeyTest Bug Report Format

Per-route bug report path:
- `monkey-test-reports/{route_slug}-bugs.md`

## Structure
- summary
- critical bugs
- major bugs
- minor bugs
- console errors
- notes

Each bug should include:
- bug id
- severity
- location
- screenshot filename
- description
- expected
- actual
- source

## Severity
- Critical: crash, blank screen, unrecoverable flow, security-grade issue
- Major: important interaction broken or clearly wrong
- Minor: cosmetic or low-impact UX issue

## Final Summary
Final report path:
- `monkey-test-reports/FINAL-REPORT.md`

It should aggregate:
- route coverage
- bug counts by severity
- route health summary
- critical issues first
- recommendations
