# MonkeyTest Testing Reference

## Result Classification
- `dialog_opened`: modal or overlay appeared
- `dropdown_opened`: floating action list appeared
- `wizard_opened`: multi-step flow appeared
- `confirmation_dialog`: confirm/cancel dialog appeared
- `page_navigated`: URL or page state changed materially
- `toast_notification`: transient toast/snackbar appeared
- `no_response`: nothing visible changed
- `error`: error page, error banner, or broken state
- `disabled`: element was not clickable
- `submenu_opened`: nested menu appeared

Decision-point results:
- `dialog_opened`
- `dropdown_opened`
- `wizard_opened`
- `submenu_opened`
- `page_navigated`
- `error`

Non-decision results:
- `no_response`
- `toast_notification`
- `disabled`
- `confirmation_dialog`

## Bug Triggers
Report bugs for:
- blank or white screens
- visible error pages or error banners
- missing expected table/list rendering
- button does nothing when it should act
- modal expected but nothing opens
- detail page fails to load
- redirect back to login unexpectedly
- broken layout, overlap, truncation
- action causes error toast
- unrecoverable state / cannot backtrack

## Backtracking
- dialog: close / cancel / escape
- dropdown: escape or click outside
- wizard: cancel / escape
- navigated page: browser back or re-open route
- confirmation dialog: screenshot, then cancel unless mutation is allowed
- submenu: escape to close
