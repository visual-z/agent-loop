# MonkeyTest Route Discovery

Discover every navigable route and sub-route in a web application while minimizing source-code exposure.

## Strategy Order
1. Code-based discovery from route definition files.
2. Browser-based discovery if route files are not available.
3. User-provided route map if already available.

## Code-Based Discovery
Read only route definition files when possible.

Search patterns:
- `**/*route*.*`
- `**/router.*`
- `app/**/page.*`
- `pages/**/*.*`

Framework hints:
- React Router: `path:`
- Vue Router: route objects with `path`
- Angular: route arrays with `path`
- Next.js: `app/**/page.*`, `pages/**`
- Nuxt: `pages/**/*.vue`

Extract:
- route path
- parent/child structure
- likely page type
- top-level category

Do not read component internals unless route discovery is blocked.

## Browser-Based Discovery
Use browser exploration only when needed.

Flow:
1. open base URL
2. log in if required
3. inspect navigation, sidebar, tabs, and expandable menus
4. record all reachable internal routes

## Page Type Hints
- `list`: tables, grids, pagination
- `list+detail`: list page with drill-in records
- `detail`: one record, tabs, header actions
- `create`: form or wizard
- `dashboard`: overview metrics/charts
- `settings`: configuration pages
- `tool`: specialized operational surface

## Exclude By Default
- auth pages
- error pages
- redirect stubs
- setup wizards not part of steady-state product usage
- remote shells / embedded external tools
- obvious external iframe shells

## Required Output
Write `ROUTE_MAP.md` with:
- route registry
- excluded routes with reasons
- route categories for user selection
