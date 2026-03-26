const fs = require('fs');
const path = require('path');
const express = require('express');
const webPush = require('web-push');

const app = express();
const PORT = process.env.PORT || 8080;

const ROOT = __dirname;
const SUB_FILE = path.join(ROOT, 'xang-subscriptions.json');
const KEY_FILE = path.join(ROOT, 'xang-vapid-keys.json');

const SOURCE_URL = 'https://r.jina.ai/http://www.pvoil.com.vn/bang-gia-xang-dau';
const POLL_INTERVAL_MS = 10 * 60 * 1000;

app.use(express.json({ limit: '1mb' }));

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function getOrCreateVapidKeys() {
  const keys = readJsonSafe(KEY_FILE, null);
  if (keys && keys.publicKey && keys.privateKey) return keys;

  const generated = webPush.generateVAPIDKeys();
  writeJsonSafe(KEY_FILE, generated);
  return generated;
}

const vapidKeys = getOrCreateVapidKeys();
webPush.setVapidDetails('mailto:admin@example.com', vapidKeys.publicKey, vapidKeys.privateKey);

function getSubscriptions() {
  return readJsonSafe(SUB_FILE, []);
}

function saveSubscriptions(items) {
  writeJsonSafe(SUB_FILE, items);
}

function normalizeEndpoint(endpoint) {
  return String(endpoint || '').trim();
}

function parseVndPrice(token) {
  if (!token) return null;
  const cleaned = String(token).replace(/[^\d]/g, '');
  if (!cleaned) return null;
  const n = parseInt(cleaned, 10);
  return Number.isNaN(n) ? null : n;
}

function parseMarketRows(text) {
  const out = {};
  const lines = String(text).split('\n').map(l => l.trim()).filter(Boolean);

  for (const ln of lines) {
    if (/Xăng\s+RON\s*95-III/i.test(ln)) {
      const m = ln.match(/(\d{1,3}(?:\.\d{3})+)\s*đ/i);
      out.ron95 = parseVndPrice(m && m[1]);
    }

    if (/Giá điều chỉnh lúc/i.test(ln)) {
      const when = ln.match(/Giá điều chỉnh lúc\s*([^*]+?)\s*\(/i);
      if (when && when[1]) out.updatedAt = when[1].trim();
    }
  }

  return out;
}

async function fetchMarketPrice() {
  const res = await fetch(SOURCE_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const parsed = parseMarketRows(text);
  if (!parsed.ron95) throw new Error('Cannot parse RON 95-III');

  return {
    ron95: parsed.ron95,
    updatedAt: parsed.updatedAt || new Date().toLocaleString('vi-VN')
  };
}

async function sendPushToAll(payload) {
  const subs = getSubscriptions();
  if (!subs.length) return { sent: 0, removed: 0 };

  let sent = 0;
  const alive = [];

  for (const sub of subs) {
    try {
      await webPush.sendNotification(sub, JSON.stringify(payload));
      sent += 1;
      alive.push(sub);
    } catch (err) {
      const code = err && err.statusCode;
      if (code !== 404 && code !== 410) {
        alive.push(sub);
      }
    }
  }

  const removed = subs.length - alive.length;
  if (removed > 0) saveSubscriptions(alive);
  return { sent, removed };
}

let lastSeenPrice = null;

async function pollAndNotify() {
  try {
    const data = await fetchMarketPrice();

    if (lastSeenPrice === null) {
      lastSeenPrice = data.ron95;
      return;
    }

    if (data.ron95 !== lastSeenPrice) {
      const delta = data.ron95 - lastSeenPrice;
      const direction = delta > 0 ? 'TANG' : 'GIAM';
      const payload = {
        title: 'XangAlert: RON 95-III thay doi',
        body: `${direction} ${Math.abs(delta).toLocaleString('vi-VN')} d | Gia moi ${data.ron95.toLocaleString('vi-VN')} d/lit`,
        data: {
          type: 'price-change',
          price: data.ron95,
          previous: lastSeenPrice,
          delta,
          updatedAt: data.updatedAt
        }
      };

      const result = await sendPushToAll(payload);
      console.log(`[PUSH] Sent ${result.sent}, removed ${result.removed}. Price ${lastSeenPrice} -> ${data.ron95}`);
      lastSeenPrice = data.ron95;
      return;
    }

    lastSeenPrice = data.ron95;
  } catch (err) {
    console.error('[POLL ERROR]', err.message);
  }
}

app.get('/xang', (_, res) => {
  res.sendFile(path.join(ROOT, 'xang'));
});

app.get('/xang-sw.js', (_, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(ROOT, 'xang-sw.js'));
});

app.get('/xang-manifest.webmanifest', (_, res) => {
  res.type('application/manifest+json');
  res.sendFile(path.join(ROOT, 'xang-manifest.webmanifest'));
});

app.get('/api/public-key', (_, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  const endpoint = normalizeEndpoint(sub && sub.endpoint);
  if (!endpoint) {
    return res.status(400).json({ ok: false, error: 'Invalid subscription' });
  }

  const all = getSubscriptions();
  const exists = all.some(item => normalizeEndpoint(item.endpoint) === endpoint);
  if (!exists) {
    all.push(sub);
    saveSubscriptions(all);
  }

  return res.json({ ok: true, count: all.length });
});

app.post('/api/unsubscribe', (req, res) => {
  const endpoint = normalizeEndpoint(req.body && req.body.endpoint);
  const all = getSubscriptions();
  const next = all.filter(item => normalizeEndpoint(item.endpoint) !== endpoint);
  saveSubscriptions(next);
  res.json({ ok: true, count: next.length });
});

app.post('/api/test-push', async (req, res) => {
  const payload = {
    title: 'XangAlert Test',
    body: 'Thong bao thu tu server push.',
    data: { type: 'test', at: Date.now() }
  };
  const result = await sendPushToAll(payload);
  res.json({ ok: true, ...result });
});

app.listen(PORT, () => {
  console.log(`XangAlert server listening on http://0.0.0.0:${PORT}/xang`);
  pollAndNotify();
  setInterval(pollAndNotify, POLL_INTERVAL_MS);
});
