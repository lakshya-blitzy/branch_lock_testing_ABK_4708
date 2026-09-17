const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server');

let server;
let base;

before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => { await new Promise((resolve) => server.close(resolve)); });

test('GET / preserves the original Hello, World! contract', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/plain');
  assert.equal(await res.text(), 'Hello, World!\n');
});

test('GET /good-evening returns Good evening', async () => {
  const res = await fetch(`${base}/good-evening`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/plain');
  assert.equal(await res.text(), 'Good evening');
});

test('unmatched route yields 404', async () => {
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});
