# MonkeyTest Screenshot Protocol

Every executed action must produce screenshot evidence.

## Decision-Point Snapshots
Use DOM-heavy snapshots only when they are needed to decide the next action:
- after login
- after entering a route
- after opening dialog / dropdown / wizard / submenu
- after backtracking when DOM may have changed
- after navigation to a new page
- when investigating an error state

## Non-Decision Points
Screenshot only, no heavy snapshot, for:
- `no_response`
- `toast_notification`
- disabled elements
- cancel / close / escape clicks

## Minimum Evidence Set
Each route should include at least:
- `00-login-success.png`
- `01-route-entry.png`
- one screenshot for each action result
- dedicated `*-error.png` evidence when failures occur
- `07-final-state.png`

## Naming
Pattern:
- `monkey-test-screenshots/{route_slug}/{phase}-{action}.png`

Phase prefixes:
- `00` login
- `01` route landing
- `02` toolbar actions
- `03` row actions
- `04` detail page load
- `05` detail header actions
- `06` detail tabs
- `07` route final state
- `08` nested interactions

## Correlation Rule
Every screenshot filename should appear in the route report action tree.
