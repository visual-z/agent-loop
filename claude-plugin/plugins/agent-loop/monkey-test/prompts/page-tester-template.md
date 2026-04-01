# MonkeyTest Page Tester Template

Use this structure when dispatching `monkey-test-page-tester`:

- Route: `{ROUTE}`
- Route slug: `{ROUTE_SLUG}`
- Base URL: `{BASE_URL}`
- Credentials: `{USERNAME}` / `{PASSWORD}`
- Screenshots dir: `{SCREENSHOTS_DIR}`
- Reports dir: `{REPORTS_DIR}`
- Safe to mutate: `{SAFE_TO_MUTATE}`

Requirements:
- test exactly one route
- use isolated browser session
- follow DFS click-all traversal
- capture minimum screenshot evidence set
- return a structured JSON report
