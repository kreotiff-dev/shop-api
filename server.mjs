import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const port = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) || process.env.PORT || 4010);
const buggy = process.argv.includes('--buggy');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const products = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Чехол для телефона', price: 1990, status: 'active' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Зарядка 20W', price: 2490, status: 'active' },
  { id: '33333333-3333-4333-8333-333333333333', name: 'Кабель USB-C', price: 790, status: 'hidden' },
];
const orders = new Map();

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const err = (res, code, errCode, message) => send(res, code, { code: errCode, message });
const asContract = (p) => (buggy && p.id.startsWith('11111111') ? { ...p, price: String(p.price) } : p); // BUG 1: price as string

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(302, { location: '/docs' });
    return res.end();
  }
  const assets = {
    '/docs': ['public/docs.html', 'text/html; charset=utf-8'],
    '/docs/': ['public/docs.html', 'text/html; charset=utf-8'],
    '/docs/scalar.js': ['node_modules/@scalar/api-reference/dist/browser/standalone.js', 'text/javascript; charset=utf-8'],
    '/openapi.yaml': ['openapi.yaml', 'application/yaml; charset=utf-8'],
  };
  if (req.method === 'GET' && assets[url.pathname]) {
    const [file, contentType] = assets[url.pathname];
    try {
      let body = await readFile(new URL(file, import.meta.url));
      if (url.pathname === '/openapi.yaml') {
        body = body.toString().replace('http://127.0.0.1:4010/api/v1', `http://127.0.0.1:${server.address().port}/api/v1`);
      }
      res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
      return res.end(body);
    } catch {
      return err(res, 500, 'DOCS_UNAVAILABLE', 'Run npm ci before starting the project.');
    }
  }
  const path = url.pathname.replace(/^\/api\/v1(?=\/)/, ''); // servers.url of the spec ends with /api/v1
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try {
      if (req.method === 'GET' && path === '/products') {
        const limitRaw = url.searchParams.get('limit');
        const limit = limitRaw === null ? 20 : Number(limitRaw);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) return err(res, 400, 'BAD_LIMIT', 'limit must be 1..100');
        const items = products.slice(0, limit).map(asContract);
        return send(res, 200, { items, total: products.length });
      }
      let m = path.match(/^\/products\/([^/]+)$/);
      if (req.method === 'GET' && m) {
        if (!UUID_RE.test(m[1])) return err(res, 404, 'PRODUCT_NOT_FOUND', 'no such product');
        const p = products.find((x) => x.id === m[1]);
        return p ? send(res, 200, asContract(p)) : err(res, 404, 'PRODUCT_NOT_FOUND', 'no such product');
      }
      if (req.method === 'POST' && path === '/orders') {
        let body;
        try { body = JSON.parse(raw); } catch { return err(res, 400, 'BAD_JSON', 'body is not JSON'); }
        const items = body && body.items;
        if (!Array.isArray(items) || items.length < 1) return err(res, 400, 'BAD_ITEMS', 'items must be a non-empty array');
        if (buggy && items.length > 3) throw new Error('too many items'); // BUG 2: crashes with 500
        for (const it of items) {
          if (!it || !UUID_RE.test(String(it.productId)) || !Number.isInteger(it.quantity) || it.quantity < 1 || it.quantity > 50) return err(res, 400, 'BAD_ITEM', 'invalid item');
        }
        const known = items.every((it) => products.some((p) => p.id === it.productId));
        if (!known) return err(res, 422, 'UNKNOWN_PRODUCT', 'product does not exist');
        const total = items.reduce((s, it) => s + products.find((p) => p.id === it.productId).price * it.quantity, 0);
        const order = { id: randomUUID(), status: 'new', items, total };
        orders.set(order.id, order);
        return send(res, 201, order);
      }
      m = path.match(/^\/orders\/([^/]+)$/);
      if (req.method === 'GET' && m) {
        if (!UUID_RE.test(m[1])) return err(res, buggy ? 400 : 404, 'ORDER_NOT_FOUND', 'no such order'); // BUG 3: undocumented 400
        const o = orders.get(m[1]);
        return o ? send(res, 200, o) : err(res, 404, 'ORDER_NOT_FOUND', 'no such order');
      }
      const known = ['/products', '/orders'].includes(path) || /^\/(products|orders)\/[^/]+$/.test(path);
      if (known) return err(res, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
      return err(res, 404, 'NOT_FOUND', 'no such route');
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });
});
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') console.error(`Port ${port} is busy. Stop the previous server with Ctrl+C or use npm start -- 4011.`);
  else console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Shop API: http://127.0.0.1:${server.address().port}/api/v1${buggy ? ' (buggy)' : ''}`);
  console.log(`Scalar:   http://127.0.0.1:${server.address().port}/docs`);
});
