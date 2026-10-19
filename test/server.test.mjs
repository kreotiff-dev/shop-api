import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function start(buggy = false) {
  const child = spawn(process.execPath, ['server.mjs', '0', ...(buggy ? ['--buggy'] : [])], {
    cwd: new URL('../', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Server did not start')); }, 10000);
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/Shop API: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
  });
  return { base, async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill(); await exited;
  } };
}

test('learner route: docs, specification, requests, order, reset', async () => {
  const server = await start();
  try {
    const root = await fetch(server.base, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/docs');
    const docs = await fetch(`${server.base}/docs`);
    assert.equal(docs.status, 200);
    assert.match(await docs.text(), /Scalar.createApiReference/);
    const script = await fetch(`${server.base}/docs/scalar.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
    assert.ok((await script.text()).length > 10000);
    const spec = await fetch(`${server.base}/openapi.yaml`);
    assert.match(await spec.text(), new RegExp(`${server.base}/api/v1`));
    const good = await fetch(`${server.base}/api/v1/products?limit=1`);
    assert.equal(good.status, 200);
    const page = await good.json();
    assert.equal(page.items.length, 1);
    assert.equal(page.total, 3);
    assert.equal(typeof page.items[0].price, 'number');
    const bad = await fetch(`${server.base}/api/v1/products?limit=0`);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, 'BAD_LIMIT');
    const created = await fetch(`${server.base}/api/v1/orders`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ productId: page.items[0].id, quantity: 2 }] }),
    });
    assert.equal(created.status, 201);
    const order = await created.json();
    assert.equal(order.total, 3980);
    const saved = await fetch(`${server.base}/api/v1/orders/${order.id}`);
    assert.equal(saved.status, 200);
    await server.stop();
    const restarted = await start();
    try { assert.equal((await fetch(`${restarted.base}/api/v1/orders/${order.id}`)).status, 404); }
    finally { await restarted.stop(); }
  } finally { if (server) await server.stop().catch(() => {}); }
});

test('buggy mode exposes the intended price mismatch', async () => {
  const server = await start(true);
  try {
    const response = await fetch(`${server.base}/api/v1/products/11111111-1111-4111-8111-111111111111`);
    assert.equal(response.status, 200);
    assert.equal(typeof (await response.json()).price, 'string');
  } finally { await server.stop(); }
});
