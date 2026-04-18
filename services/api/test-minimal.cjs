const express = require('express');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(rateLimit({ windowMs: 60_000, max: 600 }));
app.get('/', (req, res) => res.json({ ok: true }));

const server = app.listen(4399, '0.0.0.0', () => {
  console.log('Test server listening on 4399');
});
setTimeout(() => {
  server.close();
  process.exit(0);
}, 5000);
