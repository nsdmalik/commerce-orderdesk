# Orderdesk

[![Verify application](https://github.com/nsdmalik/commerce-orderdesk/actions/workflows/verify.yml/badge.svg)](https://github.com/nsdmalik/commerce-orderdesk/actions/workflows/verify.yml)

**A full-stack ordering workspace built with React, TypeScript, Node.js, and PostgreSQL.**

Buyers see prices for their region, draft an order in valid case quantities, and submit it with its accepted prices retained. Operations can review account orders, change Canadian catalog prices, and close the ordering window. Two people editing the same draft cannot silently overwrite each other.

![Orderdesk buyer workspace](docs/buyer-workspace.jpg)

This is an independent public implementation with fictional accounts and products. It is separate from employer applications and contains no employer code, data, or integrations.

## Try it locally

Requires Node.js 22.12 or later and PostgreSQL 16. Docker is an optional way to run the database.

```sh
npm ci
cp .env.example .env
# If using Docker:
docker compose up -d --wait
npm run seed
npm run dev
```

In a second terminal:

```sh
npm run web
```

Open http://127.0.0.1:5177. The API runs on http://127.0.0.1:8084. For an existing PostgreSQL installation, create a separate empty database, update `DATABASE_URL` in `.env`, and skip the Docker command. The seed inserts missing fictional records without resetting existing edits. Do not seed a real business database.

| Demo account | Email | View |
| --- | --- | --- |
| Canadian buyer | buyer.ca@demo.invalid | North Studio Supply, CAD prices and its own order |
| US buyer | buyer.us@demo.invalid | West Studio Supply, USD prices and its own order |
| Operations | operations@demo.invalid | Both accounts, campaign controls and Canadian catalog price editing |

All demo accounts use `orderdesk-demo`. The login uses salted password hashes and opaque, expiring session cookies. Account scope and roles come from the database rather than a browser-supplied actor ID.

## Walk through the important behavior

1. Sign in as the Canadian buyer. Add six Ridge desk mats. The draft autosaves at CAD 144.00.
2. Open a second tab, then change the quantity in the first. Editing the older draft in the second tab produces a visible conflict. Your local quantities remain visible until you choose to reload the latest draft.
3. Sign out and use the US buyer. The same product has a USD 18.00 unit price; Canadian orders and their activity are inaccessible.
4. As Operations, change the Canadian Ridge price. An already saved draft cannot be submitted at a stale price: the buyer reviews and saves the updated prices first.
5. Submit an order. Later catalog changes do not change its accepted line prices or saved total. Submitted orders are read-only.
6. Close the ordering window. Draft writes and submissions are rejected at the API boundary, even from an already open buyer tab.

## Engineering decisions

| Concern | Decision |
| --- | --- |
| Prices | The server resolves region and reads PostgreSQL prices. Requests contain SKUs and quantities, never authoritative prices. |
| Money | Integer cents and explicit currencies. Account totals are not combined across currencies. |
| Concurrent edits | Row locking plus expected versions allows only one write using a given version. A stale write returns HTTP 409. |
| Catalog changes | Draft submission compares saved prices with the current catalog. Repricing requires a deliberate draft save. |
| Historical terms | Submitted lines retain their accepted prices and cannot be edited. |
| Atomicity | The order update and its activity event commit in the same PostgreSQL transaction. If either fails, both roll back. |
| Campaign closure | Order writes take a shared campaign lock; changing campaign state serializes with those writes. |
| Identity | Salted scrypt hashes, opaque tokens stored as hashes, HttpOnly/SameSite cookies, expiry and logout revocation. |
| Account boundaries | Session identity resolves account scope on every request. Buyers cannot read another account or use operations controls. |
| UI continuity | Autosaving preserves newer local input when an earlier save completes. Conflicts and network errors have visible recovery actions. |

```mermaid
flowchart LR
  UI[React + TypeScript] --> API[Express API]
  API --> Identity[Session identity + account scope]
  Identity --> Rules[Validation + order rules]
  Rules --> Transaction[Versioned PostgreSQL transaction]
  Transaction --> Orders[Orders + retained line prices]
  Transaction --> Events[Workspace history]
```

[HTTP and identity boundary](server/app.ts) · [Order rules and transactions](server/orders.ts) · [React workspace](web/main.tsx) · [Architecture and tradeoffs](docs/architecture.md)

## Verification

The integration suite uses a real PostgreSQL database. It checks regional/account isolation, manipulated prices, invalid pack quantities, simultaneous writes, rollback when event recording fails, campaign state, changed-price acknowledgement, immutable submitted terms, session expiry, logout and cross-origin request rejection.

Tests require a **separate database named `orderdesk_test`**. The runner refuses other database names, and each test resets only this dedicated database.

```sh
# Create this separate database using your PostgreSQL administrator tools first.
TEST_DATABASE_URL=postgresql://orderdesk:orderdesk@127.0.0.1:5544/orderdesk_test npm test
npm run build
npm run format:check
```

GitHub Actions provisions an isolated PostgreSQL service and runs the build and integration suite. Browser checks cover autosaving, two-tab conflict recovery, submitted orders, and desktop/mobile layouts.

`npm run build` type-checks the whole project and bundles the frontend. To inspect the built frontend locally, run `npm run dev` with `APP_ORIGIN=http://127.0.0.1:8084` and open port 8084; no separate Vite process is needed.

## Scope

This is a runnable engineering example, not an internet-ready commerce service. It has a deliberately small catalog, one campaign and one order per account. Seeded passwords are public demo credentials. It has no payment, tax, shipping calculation, inventory reservation, email delivery, password recovery or scheduled campaign expiry. The activity trail is application-maintained, not tamper-proof storage.

Before any real deployment, replace demo identities, define account provisioning and recovery, use HTTPS and secure cookies, implement operational monitoring and backups, adopt versioned migrations, and review retention and access requirements. The in-memory sign-in limiter is local to one server process. Performance and distributed-throughput claims are intentionally absent.

[MIT license](LICENSE) · [Nauman Masood](https://nsdmalik.dev)
