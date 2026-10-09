export type Role = 'buyer' | 'operations';
export type User = {
  id: string;
  name: string;
  role: Role;
  accountId: string | null;
  accountName: string | null;
  region: string | null;
  currency: string | null;
};
export type Product = {
  sku: string;
  name: string;
  description: string;
  packSize: number;
  cents: number;
};
export type Line = { sku: string; name: string; quantity: number; cents: number };
export type Order = {
  id: string;
  accountId: string;
  accountName: string;
  currency: string;
  version: number;
  status: 'draft' | 'submitted';
  total: number;
  lines: Line[];
  updatedAt: string;
};
export type Event = {
  id: number;
  actor: string;
  kind: string;
  createdAt: string;
  orderId: string | null;
};
export type Workspace = {
  user: User;
  catalog: Product[];
  order: Order | null;
  orders: Order[];
  events: Event[];
  campaignOpen: boolean;
};
export type Quantities = Record<string, number>;
export function money(cents: number, currency: string) {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(cents / 100);
}
