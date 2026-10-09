import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Order, Quantities, Workspace } from '../shared/types';
import { money } from '../shared/types';
import './style.css';
class RequestError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
async function api<T>(path: string, body?: unknown, method = 'GET'): Promise<T> {
  const response = await fetch('/api' + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new RequestError(data.code, data.error || 'The request failed.');
  return data;
}
const quantityKey = (q: Quantities) =>
  JSON.stringify(Object.entries(q).sort(([a], [b]) => a.localeCompare(b)));
function quantitiesFor(w: Workspace): Quantities {
  return Object.fromEntries(
    w.catalog.map((p) => [p.sku, w.order?.lines.find((l) => l.sku === p.sku)?.quantity || 0]),
  );
}
function ProductArt({ sku }: { sku: string }) {
  return (
    <div className={'product-art art-' + sku.toLowerCase()} aria-hidden="true">
      <span />
    </div>
  );
}
function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('buyer.ca@demo.invalid');
  const [password, setPassword] = useState('orderdesk-demo');
  const [quantities, setQuantities] = useState<Quantities>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RequestError | null>(null);
  const [notice, setNotice] = useState('');
  const [priceSku, setPriceSku] = useState('RIDGE');
  const [price, setPrice] = useState('24.00');
  const orderRef = useRef<Order | null>(null);
  const savedKey = useRef('');
  const alive = useRef(true);
  function fail(err: RequestError) {
    if (err.code === 'unauthorized') {
      setWorkspace(null);
      orderRef.current = null;
      setQuantities({});
      savedKey.current = '';
      setNotice('');
    }
    setError(err);
  }
  const currentKey = quantityKey(quantities);
  const invalid =
    workspace?.catalog.some((p) => {
      const q = quantities[p.sku] || 0;
      return !Number.isInteger(q) || q < 0 || q > 10000 || q % p.packSize !== 0;
    }) || false;
  const dirty = currentKey !== savedKey.current;
  function update(next: Workspace, replace = true) {
    orderRef.current = next.order;
    setWorkspace(next);
    if (next.user.role === 'operations' && replace) {
      const selected = next.catalog.find((p) => p.sku === priceSku);
      if (selected) setPrice((selected.cents / 100).toFixed(2));
    }
    if (replace) {
      const q = quantitiesFor(next);
      savedKey.current = quantityKey(q);
      setQuantities(q);
    }
  }
  useEffect(() => {
    alive.current = true;
    api<Workspace>('/workspace')
      .then((w) => {
        if (alive.current) update(w);
      })
      .catch((e) => {
        if (e.code !== 'unauthorized' && alive.current) setError(e);
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
    };
  }, []);
  async function save() {
    const order = orderRef.current;
    if (!order || busy || invalid) return;
    const snapshot = { ...quantities };
    const key = quantityKey(snapshot);
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      const next = await api<Workspace>(
        '/orders/' + order.id,
        {
          version: order.version,
          lines: Object.entries(snapshot)
            .filter(([, q]) => q > 0)
            .map(([sku, quantity]) => ({ sku, quantity })),
        },
        'PUT',
      );
      savedKey.current = key;
      update(next, false);
      setNotice('Draft saved');
    } catch (e) {
      fail(e as RequestError);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (
      !dirty ||
      busy ||
      error ||
      invalid ||
      !workspace?.campaignOpen ||
      workspace.order?.status !== 'draft'
    )
      return;
    const timeout = setTimeout(() => {
      void save();
    }, 700);
    return () => clearTimeout(timeout);
  }, [currentKey, busy, error, invalid, workspace?.campaignOpen, workspace?.order?.status]);
  async function login(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/login', { email, password }, 'POST');
      update(await api<Workspace>('/workspace'));
    } catch (e) {
      fail(e as RequestError);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    try {
      await api('/logout', {}, 'POST');
      setWorkspace(null);
      orderRef.current = null;
      setQuantities({});
      savedKey.current = '';
      setError(null);
      setNotice('');
    } catch (e) {
      fail(e as RequestError);
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    setBusy(true);
    try {
      update(await api<Workspace>('/workspace'));
      setError(null);
      setNotice('Latest draft loaded');
    } catch (e) {
      fail(e as RequestError);
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    const order = orderRef.current;
    if (!order) return;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      update(
        await api<Workspace>('/orders/' + order.id + '/submit', { version: order.version }, 'POST'),
      );
      setNotice('Order submitted. Its prices are now retained in the order history.');
    } catch (e) {
      const err = e as RequestError;
      setError(err);
      if (err.code === 'price_changed') {
        try {
          update(await api<Workspace>('/workspace'), false);
        } catch {}
      }
    } finally {
      setBusy(false);
    }
  }
  async function campaign() {
    if (!workspace) return;
    setBusy(true);
    setError(null);
    try {
      update(await api<Workspace>('/campaign', { open: !workspace.campaignOpen }, 'PUT'));
      setNotice(workspace.campaignOpen ? 'Ordering window closed' : 'Ordering window reopened');
    } catch (e) {
      fail(e as RequestError);
    } finally {
      setBusy(false);
    }
  }
  async function updatePrice(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      update(
        await api<Workspace>(
          '/prices',
          { sku: priceSku, region: 'CA', cents: Math.round(Number(price) * 100) },
          'PUT',
        ),
      );
      setNotice('Canadian catalog price updated. Submitted orders keep their original prices.');
    } catch (e) {
      fail(e as RequestError);
    } finally {
      setBusy(false);
    }
  }
  if (loading)
    return (
      <main className="loading">
        <span className="logo">O</span>
        <p>Opening Orderdesk...</p>
      </main>
    );
  if (!workspace)
    return (
      <main className="login-shell">
        <section className="login-story">
          <a href="https://github.com/nsdmalik/commerce-orderdesk" className="wordmark">
            <span className="logo">O</span>Orderdesk
          </a>
          <div>
            <p className="eyebrow">REGIONAL ORDERING, CONSIDERED</p>
            <h1>
              The order.
              <br />
              The rules.
              <br />
              <em>One workspace.</em>
            </h1>
            <p>Regional prices, saved drafts, and clear handoffs from buyer to operations.</p>
            <div className="login-preview">
              <span>STUDIO COLLECTION</span>
              <div>
                <ProductArt sku="RIDGE" />
                <ProductArt sku="ORBIT" />
                <ProductArt sku="FRAME" />
              </div>
              <p>A small catalog. A complete ordering workflow.</p>
            </div>
          </div>
          <footer>
            Independent engineering example by <a href="https://nsdmalik.dev">Nauman Masood</a>
          </footer>
        </section>
        <section className="login-form">
          <p className="eyebrow">EXPLORE THE WORKSPACE</p>
          <h2>Welcome to Orderdesk.</h2>
          <p>
            Try a buyer account or the operations view. All accounts and products are fictional.
          </p>
          <div className="demo-options" aria-label="Demo accounts">
            {[
              ['Canadian buyer', 'buyer.ca@demo.invalid'],
              ['US buyer', 'buyer.us@demo.invalid'],
              ['Operations', 'operations@demo.invalid'],
            ].map(([label, value]) => (
              <button
                type="button"
                key={value}
                className={email === value ? 'selected' : ''}
                onClick={() => {
                  setEmail(value);
                  setPassword('orderdesk-demo');
                  setError(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <form onSubmit={login}>
            <label>
              Email
              <input
                autoComplete="username"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label>
              Password
              <input
                autoComplete="current-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            {error && (
              <p className="error-inline" role="alert">
                {error.message}
              </p>
            )}
            <button className="primary full" disabled={busy}>
              {busy ? 'Signing in...' : 'Sign in to workspace'}
              <span aria-hidden="true">↗</span>
            </button>
          </form>
          <p className="demo-note">
            Demo password: <code>orderdesk-demo</code>
            <br />
            Sessions and account permissions are checked by the server.
          </p>
          <a className="source-link" href="https://github.com/nsdmalik/commerce-orderdesk">
            Source and engineering decisions ↗
          </a>
        </section>
      </main>
    );
  const buyer = workspace.user.role === 'buyer';
  const order = workspace.order;
  const currency = workspace.user.currency || 'CAD';
  const catalog =
    order?.status === 'submitted'
      ? workspace.catalog.map((p) => ({
          ...p,
          cents: order.lines.find((l) => l.sku === p.sku)?.cents ?? p.cents,
        }))
      : workspace.catalog;
  const total = catalog.reduce((sum, p) => sum + (quantities[p.sku] || 0) * p.cents, 0);
  const count = Object.values(quantities).filter((q) => q > 0).length;
  const readOnly = !workspace.campaignOpen || order?.status === 'submitted';
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="wordmark" href="#workspace">
          <span className="logo">O</span>Orderdesk
        </a>
        <p className="side-caption">WORKSPACE</p>
        <a className="nav-item active" href="#workspace">
          <span aria-hidden="true">▦</span>
          {buyer ? 'Your order' : 'Operations'}
        </a>
        <a className="nav-item" href="#activity">
          <span aria-hidden="true">↻</span>Recent activity
        </a>
        <div className="sidebar-bottom">
          <span className="demo-chip">FICTIONAL DEMO</span>
          <p>
            Built with React, TypeScript,
            <br />
            Node.js and PostgreSQL.
          </p>
          <a href="https://github.com/nsdmalik/commerce-orderdesk">View the source ↗</a>
        </div>
      </aside>
      <main className="workspace" id="workspace">
        <header className="topbar">
          <p>
            Studio collection <span>/ Autumn 2026</span>
          </p>
          <div>
            <span className="avatar">
              {workspace.user.name
                .split(' ')
                .map((n) => n[0])
                .join('')}
            </span>
            <span>
              {workspace.user.name}
              <small>{buyer ? workspace.user.accountName : 'Operations'}</small>
            </span>
            <button className="quiet" onClick={logout} disabled={busy}>
              Sign out
            </button>
          </div>
        </header>
        <div className="page-heading">
          <div>
            <p className="eyebrow">{buyer ? 'BUYER WORKSPACE' : 'OPERATIONS WORKSPACE'}</p>
            <h1>{buyer ? 'A good order starts here.' : 'A clear view of every order.'}</h1>
            <p>
              {buyer
                ? 'Choose products, save your draft, and submit when it is ready.'
                : 'Review account orders and manage the ordering window.'}
            </p>
          </div>
          <span className={'status-pill ' + (workspace.campaignOpen ? 'open' : 'closed')}>
            <span />
            {workspace.campaignOpen ? 'Ordering open' : 'Ordering closed'}
          </span>
        </div>
        {error && (
          <div className="feedback error" role="alert">
            <div>
              <strong>
                {error.code === 'stale_version'
                  ? 'A newer draft exists'
                  : error.code === 'price_changed'
                    ? 'Review updated prices'
                    : 'The change could not be completed'}
              </strong>
              <p>{error.message}</p>
              {error.code === 'stale_version' && (
                <p>
                  Your current quantities are still visible. Reloading replaces them with the saved
                  draft.
                </p>
              )}
            </div>
            {buyer && (
              <button onClick={error.code === 'price_changed' ? save : reload} disabled={busy}>
                {error.code === 'price_changed' ? 'Save current prices' : 'Reload latest draft'}
              </button>
            )}
          </div>
        )}
        {notice && (
          <p className="feedback success" role="status">
            {notice}
          </p>
        )}
        {buyer && order?.status === 'submitted' && (
          <div className="feedback success">
            <strong>Order submitted</strong>
            <p>This order is read-only. Its saved total is {money(order.total, order.currency)}.</p>
          </div>
        )}
        {buyer ? (
          <div className="buyer-layout">
            <section className="catalog-panel">
              <div className="panel-heading">
                <div>
                  <h2>Studio essentials</h2>
                  <p>
                    {workspace.user.accountName} · {currency} pricing
                  </p>
                </div>
                <span>{workspace.catalog.length} products</span>
              </div>
              <div className="product-list">
                {catalog.map((product) => {
                  const q = quantities[product.sku] || 0;
                  const bad =
                    q % product.packSize !== 0 || q < 0 || q > 10000 || !Number.isInteger(q);
                  return (
                    <article className="product" key={product.sku}>
                      <ProductArt sku={product.sku} />
                      <div className="product-copy">
                        <span className="sku">{product.sku}</span>
                        <h3>{product.name}</h3>
                        <p>{product.description}</p>
                        <strong>
                          {money(product.cents, currency)}
                          <span> / unit</span>
                        </strong>
                        <small>Pack of {product.packSize}</small>
                      </div>
                      <div className="quantity">
                        <label htmlFor={'qty-' + product.sku}>Units</label>
                        <input
                          id={'qty-' + product.sku}
                          aria-describedby={'help-' + product.sku}
                          aria-invalid={bad}
                          type="number"
                          min="0"
                          max="10000"
                          step={product.packSize}
                          value={q}
                          disabled={readOnly || (busy && order?.status === 'submitted')}
                          onChange={(e) => {
                            setQuantities((prev) => ({
                              ...prev,
                              [product.sku]: Number(e.target.value),
                            }));
                            setNotice('');
                          }}
                        />
                        <span id={'help-' + product.sku} className={bad ? 'invalid' : ''}>
                          {bad ? 'Use pack multiples' : 'Multiples of ' + product.packSize}
                        </span>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
            <aside className="order-summary">
              <p className="eyebrow">YOUR ORDER</p>
              <h2>{order?.status === 'submitted' ? 'Submitted order' : 'Order summary'}</h2>
              <div className="summary-lines">
                {catalog
                  .filter((p) => (quantities[p.sku] || 0) > 0)
                  .map((p) => (
                    <div key={p.sku}>
                      <span>
                        {p.name}
                        <small>{quantities[p.sku]} units</small>
                      </span>
                      <strong>{money(quantities[p.sku] * p.cents, currency)}</strong>
                    </div>
                  ))}
                {count === 0 && <p className="empty-summary">Add products to start your order.</p>}
              </div>
              <div className="summary-total">
                <span>{order?.status === 'submitted' ? 'Saved total' : 'Product total'}</span>
                <strong>
                  {money(order?.status === 'submitted' ? order.total : total, currency)}
                </strong>
              </div>
              <p className="total-note">
                {currency} · Product totals only. No tax or shipping calculation.
              </p>
              <div className="save-state" aria-live="polite">
                <span className={busy ? 'saving' : dirty ? 'pending' : 'saved'} />
                {order?.status === 'submitted'
                  ? 'Submitted and retained'
                  : busy
                    ? 'Saving changes...'
                    : invalid
                      ? 'Check pack quantities'
                      : error
                        ? 'Save needs attention'
                        : dirty
                          ? 'Unsaved changes'
                          : 'Draft up to date'}
                {order && <small>Version {order.version}</small>}
              </div>
              <button
                className="secondary full"
                type="button"
                onClick={save}
                disabled={busy || invalid || readOnly}
              >
                Save draft
              </button>
              <button
                className="primary full"
                type="button"
                onClick={submit}
                disabled={busy || dirty || invalid || !!error || readOnly || count === 0}
              >
                Submit order <span aria-hidden="true">↗</span>
              </button>
              <p className="summary-help">
                {order?.status === 'submitted'
                  ? 'This order is locked. Its accepted prices remain in the order history.'
                  : 'Drafts save automatically. Submitting locks the order and retains its accepted prices.'}
              </p>
            </aside>
          </div>
        ) : (
          <>
            <div className="ops-metrics">
              <div>
                <span>Accounts</span>
                <strong>{workspace.orders.length}</strong>
              </div>
              <div>
                <span>Submitted</span>
                <strong>{workspace.orders.filter((o) => o.status === 'submitted').length}</strong>
              </div>
              <div>
                <span>Drafts</span>
                <strong>{workspace.orders.filter((o) => o.status === 'draft').length}</strong>
              </div>
            </div>
            <section className="catalog-panel ops-table">
              <div className="panel-heading">
                <div>
                  <h2>Account orders</h2>
                  <p>Totals stay in their original currency.</p>
                </div>
                <button className="secondary" onClick={reload} disabled={busy}>
                  Refresh
                </button>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Status</th>
                      <th>Products</th>
                      <th>Total</th>
                      <th>Version</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workspace.orders.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <strong>{o.accountName}</strong>
                          <small>{o.currency}</small>
                        </td>
                        <td>
                          <span className={'order-status ' + o.status}>{o.status}</span>
                        </td>
                        <td>{o.lines.length}</td>
                        <td>{money(o.total, o.currency)}</td>
                        <td>{o.version}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <div className="ops-controls">
              <section className="control-card">
                <p className="eyebrow">ORDERING WINDOW</p>
                <h2>{workspace.campaignOpen ? 'Ready for orders.' : 'Ordering is paused.'}</h2>
                <p>
                  Closing the window stops draft changes and submissions. Saved orders and history
                  remain.
                </p>
                <button className="secondary" onClick={campaign} disabled={busy}>
                  {workspace.campaignOpen ? 'Close ordering window' : 'Reopen ordering window'}
                </button>
              </section>
              <section className="control-card">
                <p className="eyebrow">CANADIAN CATALOG</p>
                <h2>Update a regional price.</h2>
                <p>
                  Submitted orders keep their original prices. Drafts must acknowledge updated
                  prices before submission.
                </p>
                <form className="price-form" onSubmit={updatePrice}>
                  <label>
                    Product
                    <select
                      value={priceSku}
                      onChange={(e) => {
                        setPriceSku(e.target.value);
                        setPrice(
                          (
                            (workspace.catalog.find((p) => p.sku === e.target.value)?.cents || 0) /
                            100
                          ).toFixed(2),
                        );
                      }}
                    >
                      {workspace.catalog.map((p) => (
                        <option key={p.sku} value={p.sku}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Unit price (CAD)
                    <input
                      type="number"
                      min="0.01"
                      max="10000"
                      step="0.01"
                      value={price}
                      onChange={(e) => setPrice(e.target.value)}
                      required
                    />
                  </label>
                  <button className="secondary" disabled={busy}>
                    Update price
                  </button>
                </form>
              </section>
            </div>
          </>
        )}
        <section className="activity-panel" id="activity">
          <div>
            <p className="eyebrow">WORKSPACE HISTORY</p>
            <h2>Recent activity</h2>
          </div>
          {workspace.events.length ? (
            <ol>
              {workspace.events.map((event) => (
                <li key={event.id}>
                  <span className="event-dot" />
                  <div>
                    <strong>
                      {{
                        'draft.saved': 'Draft saved',
                        'order.submitted': 'Order submitted',
                        'campaign.closed': 'Ordering window closed',
                        'campaign.opened': 'Ordering window opened',
                        'price.updated': 'Regional price updated',
                      }[event.kind] || event.kind}
                    </strong>
                    <span>{event.actor}</span>
                  </div>
                  <time dateTime={event.createdAt}>
                    {new Intl.DateTimeFormat('en-CA', {
                      hour: 'numeric',
                      minute: '2-digit',
                    }).format(new Date(event.createdAt))}
                  </time>
                </li>
              ))}
            </ol>
          ) : (
            <p className="empty-activity">Your saved changes will appear here.</p>
          )}
        </section>
        <footer className="workspace-footer">
          Independent public implementation · Fictional products and accounts ·{' '}
          <a href="https://nsdmalik.dev">Nauman Masood</a>
        </footer>
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
