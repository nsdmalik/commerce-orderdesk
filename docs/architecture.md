# Architecture and tradeoffs

## Why this example

A small ordering application exposes useful full-stack concerns without requiring a cloud account: regional catalogs, account boundaries, drafts, simultaneous edits, historical prices and operational controls. PostgreSQL is part of the implementation and test setup, rather than replaced by an in-memory imitation.

## Write ordering

A draft change validates its JSON shape, resolves the signed-in buyer, locks that buyer's order, checks its expected version and status, then reads campaign state under a shared lock. Catalog price rows are also locked while server-owned line totals are calculated. The order update and history event share one transaction.

Operations can close the campaign or change prices. PostgreSQL row locks give those changes an ordering relative to an in-progress write. They do not establish a global throughput claim. The concurrent-write test exercises two HTTP requests against separate pooled database connections and verifies that only one changes the order.

## Prices and accepted terms

Draft saves use current regional prices. Submitting a draft verifies that its saved line prices still match the catalog. A change returns `price_changed`, so the user can review and explicitly save current prices. Submission then locks that order. Later catalog edits leave historical line prices and the saved total intact, including the prices shown in the submitted-order UI.

An extended system would need additional workflows for amendments, cancellation, taxes and fulfillment. This example does not pretend to solve those by mutating a submitted order.

## Client state

The browser holds editable quantities separately from the latest saved order/version. A completed save updates the version but does not overwrite input typed while that save was running. Changes debounce into a save, and failed saves pause autosaving until recovery. A stale-version conflict preserves local quantities; reloading is a deliberate replacement with the latest server draft.

The server remains authoritative. Browser calculations are previews, and disabled controls are conveniences rather than permissions. Invalid pack quantities have inline feedback; the API independently rejects them.

## Identity boundary

The browser receives an opaque token in an HttpOnly, SameSite cookie. PostgreSQL stores its hash and expiry. Every protected request resolves the user, role and account from the session. Logout deletes the session. Mutating requests require JSON and an allowed Origin. Demo credentials are public and are not an authorization system for real customers.

## Deliberate limits

The schema is idempotent bootstrap SQL, not a migration framework. The campaign is manually controlled. The service binds to loopback for local use. Logs, monitoring, recovery, multi-instance rate limiting, deployment and identity lifecycle would be separate production work.
