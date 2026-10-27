'use strict';
// ระบบสั่งอาหารผ่าน QR ประจำโต๊ะ — ไม่ต้องติดตั้งแพ็กเกจเสริม (ใช้ Node.js 18+ อย่างเดียว)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''; // ว่าง = ไม่ต้องใส่รหัสผ่านที่หน้า /admin
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_TABLES = 20;
const STATUSES = ['new', 'preparing', 'served', 'cancelled'];
const MAX_ORDERS_KEPT = 5000;

const rid = (n = 6) => crypto.randomBytes(n).toString('hex');

/* ---------- ข้อมูล / การจัดเก็บ ---------- */
function seed() {
  const categories = [
    { id: 'c1', name: 'น้ำซุป' },
    { id: 'c2', name: 'เนื้อสัตว์' },
    { id: 'c3', name: 'ผัก' },
    { id: 'c4', name: 'ลูกชิ้น & ของทะเล' },
    { id: 'c5', name: 'ของทานเล่น & ของหวาน' },
    { id: 'c6', name: 'เครื่องดื่ม (คิดเงินเพิ่ม)' },
  ];
  const mk = (cat, name, price, desc = '') => ({ id: 'i' + rid(4), categoryId: cat, name, price, desc, available: true });
  const items = [
    mk('c1', 'น้ำซุปใส', 0, 'หวานธรรมชาติจากกระดูกหมูและผักกาดขาว'),
    mk('c1', 'น้ำซุปต้มยำ', 0, 'เปรี้ยวเผ็ดหอมตะไคร้ ใบมะกรูด'),
    mk('c1', 'น้ำซุปหม่าล่า', 0, 'เผ็ดชาแบบเสฉวน'),
    mk('c2', 'เนื้อโคสไลซ์', 0, 'เนื้อนุ่ม หั่นบาง'),
    mk('c2', 'สันในหมูสไลซ์', 0),
    mk('c2', 'สามชั้นหมูสไลซ์', 0),
    mk('c2', 'อกไก่สไลซ์', 0),
    mk('c2', 'เนื้อวากิวสไลซ์', 120, 'พรีเมียม สั่งเพิ่มคิดเงินแยก'),
    mk('c3', 'ผักกาดขาว', 0),
    mk('c3', 'ผักบุ้งจีน', 0),
    mk('c3', 'เห็ดรวม', 0, 'เอริงกิ ชิตาเกะ เห็ดนางฟ้า'),
    mk('c3', 'ข้าวโพดอ่อน', 0),
    mk('c3', 'เต้าหู้ไข่', 0),
    mk('c4', 'ลูกชิ้นปลา', 0),
    mk('c4', 'ลูกชิ้นหมู', 0),
    mk('c4', 'กุ้งสด', 0),
    mk('c4', 'ปลาหมึกกรอบ', 0),
    mk('c5', 'เส้นบะหมี่', 0),
    mk('c5', 'ข้าวสวย', 0),
    mk('c5', 'ไอศกรีมวานิลลา', 0),
    mk('c6', 'น้ำเปล่า', 10),
    mk('c6', 'น้ำอัดลม', 25),
    mk('c6', 'ชาเขียวเย็น', 35),
    mk('c6', 'เบียร์สิงห์ (ขวด)', 90),
  ];
  return {
    settings: { shopName: 'ร้านชาบูบุฟเฟ่ต์', tableCount: 10, buffetPrice: 299, baseUrl: '' },
    categories,
    items,
    tables: {},
    orders: [],
  };
}

function ensureTables(s) {
  for (let n = 1; n <= MAX_TABLES; n++) {
    if (!s.tables[n]) s.tables[n] = { key: rid(8), sessionId: rid(6), guests: 0 };
  }
}

function load() {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    s = seed();
  }
  ensureTables(s);
  return s;
}

let state = load();

function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
save();

/* ---------- ตัวช่วย ---------- */
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const num = (v) => (typeof v === 'number' ? v : parseFloat(v));
const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

class HttpError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}
const bad = (msg, code = 400) => { throw new HttpError(code, msg); };

function currentOrders(n) {
  const sid = state.tables[n].sessionId;
  return state.orders.filter((o) => o.table === n && o.sessionId === sid);
}

function billFor(n) {
  const t = state.tables[n];
  const orders = currentOrders(n).filter((o) => o.status !== 'cancelled');
  const lines = {};
  for (const o of orders) {
    for (const it of o.items) {
      if (it.price > 0) {
        const k = it.name + '|' + it.price;
        lines[k] = lines[k] || { name: it.name, price: it.price, qty: 0 };
        lines[k].qty += it.qty;
      }
    }
  }
  const extraLines = Object.values(lines);
  const extras = extraLines.reduce((s, l) => s + l.price * l.qty, 0);
  const buffet = t.guests * state.settings.buffetPrice;
  return { guests: t.guests, buffetPrice: state.settings.buffetPrice, buffet, extras, extraLines, total: buffet + extras };
}

function baseUrl(req) {
  if (state.settings.baseUrl) return state.settings.baseUrl;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${String(proto).split(',')[0]}://${req.headers.host}`;
}
const tableUrl = (req, n) => `${baseUrl(req)}/?t=${n}&k=${state.tables[n].key}`;

/* ---------- ตัวจัดเส้นทาง ---------- */
const routes = [];
function route(method, pattern, handler, isAdmin = false) {
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
  routes.push({ method, re, handler, isAdmin });
}

function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}

const sessions = new Map();
const attempts = new Map();
const isAdminReq = (req) => {
  if (!ADMIN_PASSWORD) return true;
  const exp = sessions.get(cookies(req).sid);
  return !!exp && exp > Date.now();
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100 * 1024) { reject(new HttpError(413, 'ข้อมูลใหญ่เกินไป')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) || {}); } catch (e) { reject(new HttpError(400, 'รูปแบบข้อมูลไม่ถูกต้อง')); }
    });
    req.on('error', reject);
  });
}

function send(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

/* ----- ฝั่งลูกค้า ----- */
route('GET', '/api/menu', () => {
  const { shopName, buffetPrice } = state.settings;
  return { settings: { shopName, buffetPrice }, categories: state.categories, items: state.items };
});

function getTable(ctx) {
  const n = parseInt(ctx.params.n, 10);
  if (!(n >= 1 && n <= state.settings.tableCount)) bad('ไม่พบโต๊ะนี้', 404);
  if (!safeEq(ctx.query.get('k') || '', state.tables[n].key)) bad('QR Code ไม่ถูกต้องหรือหมดอายุ กรุณาเรียกพนักงาน', 403);
  return n;
}

route('GET', '/api/table/:n', (ctx) => {
  const n = getTable(ctx);
  return {
    table: n,
    guests: state.tables[n].guests,
    orders: currentOrders(n).map(({ id, items, note, status, createdAt }) => ({ id, items, note, status, createdAt })),
  };
});

route('POST', '/api/table/:n/orders', (ctx) => {
  const n = getTable(ctx);
  const lines = Array.isArray(ctx.body.items) ? ctx.body.items : [];
  if (!lines.length || lines.length > 40) bad('กรุณาเลือกรายการอาหาร');
  const mine = currentOrders(n);
  const last = mine[mine.length - 1];
  if (last && Date.now() - last.createdAt < 2000) bad('ส่งออเดอร์เร็วเกินไป กรุณารอสักครู่', 429);

  const items = [];
  for (const l of lines) {
    const it = state.items.find((x) => x.id === l.id);
    const qty = parseInt(l.qty, 10);
    if (!it) bad('มีเมนูที่ไม่พบในระบบ กรุณารีเฟรชหน้า');
    if (!it.available) bad(`"${it.name}" หมดชั่วคราว`);
    if (!(qty >= 1 && qty <= 20)) bad('จำนวนต่อรายการต้องอยู่ระหว่าง 1-20');
    items.push({ id: it.id, name: it.name, price: it.price, qty });
  }
  const order = {
    id: 'o' + rid(5),
    table: n,
    sessionId: state.tables[n].sessionId,
    items,
    note: str(ctx.body.note, 200),
    status: 'new',
    createdAt: Date.now(),
  };
  state.orders.push(order);
  if (state.orders.length > MAX_ORDERS_KEPT) state.orders = state.orders.slice(-MAX_ORDERS_KEPT);
  save();
  return { ok: true, id: order.id };
});

/* ----- ผู้ดูแล ----- */
route('POST', '/api/admin/login', (ctx) => {
  if (!ADMIN_PASSWORD) return { ok: true };
  const ip = ctx.req.socket.remoteAddress + '|' + (ctx.req.headers['x-forwarded-for'] || '');
  const a = attempts.get(ip) || { count: 0, reset: Date.now() + 10 * 60 * 1000 };
  if (Date.now() > a.reset) { a.count = 0; a.reset = Date.now() + 10 * 60 * 1000; }
  if (a.count >= 10) bad('ลองผิดหลายครั้งเกินไป กรุณารอ 10 นาที', 429);
  if (!safeEq(String(ctx.body.password || ''), ADMIN_PASSWORD)) {
    a.count++;
    attempts.set(ip, a);
    bad('รหัสผ่านไม่ถูกต้อง', 403);
  }
  attempts.delete(ip);
  const sid = rid(24);
  sessions.set(sid, Date.now() + 12 * 3600 * 1000);
  const secure = String(ctx.req.headers['x-forwarded-proto'] || '').startsWith('https') ? '; Secure' : '';
  return { body: { ok: true }, headers: { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}` } };
});
route('POST', '/api/admin/logout', (ctx) => {
  sessions.delete(cookies(ctx.req).sid);
  return { body: { ok: true }, headers: { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' } };
});

route('GET', '/api/admin/me', () => ({ ok: true, maxTables: MAX_TABLES }), true);

route('GET', '/api/admin/settings', () => ({ ...state.settings, maxTables: MAX_TABLES }), true);
route('PUT', '/api/admin/settings', (ctx) => {
  const b = ctx.body;
  const tc = parseInt(b.tableCount, 10);
  const bp = num(b.buffetPrice);
  if (!(tc >= 1 && tc <= MAX_TABLES)) bad(`จำนวนโต๊ะต้องอยู่ระหว่าง 1-${MAX_TABLES}`);
  if (!(bp >= 0 && bp <= 100000)) bad('ราคาบุฟเฟ่ต์ไม่ถูกต้อง');
  const base = str(b.baseUrl, 200).replace(/\/+$/, '');
  if (base && !/^https?:\/\/[^\s]+$/i.test(base)) bad('ที่อยู่เว็บไซต์ต้องขึ้นต้นด้วย http:// หรือ https://');
  const name = str(b.shopName, 80);
  if (!name) bad('กรุณากรอกชื่อร้าน');
  state.settings = { shopName: name, tableCount: tc, buffetPrice: bp, baseUrl: base };
  save();
  return state.settings;
}, true);

route('GET', '/api/admin/menu', () => ({ categories: state.categories, items: state.items }), true);

route('POST', '/api/admin/categories', (ctx) => {
  const name = str(ctx.body.name, 60);
  if (!name) bad('กรุณากรอกชื่อหมวด');
  const c = { id: 'c' + rid(4), name };
  state.categories.push(c);
  save();
  return c;
}, true);
route('PUT', '/api/admin/categories/:id', (ctx) => {
  const c = state.categories.find((x) => x.id === ctx.params.id);
  if (!c) bad('ไม่พบหมวด', 404);
  const name = str(ctx.body.name, 60);
  if (!name) bad('กรุณากรอกชื่อหมวด');
  c.name = name;
  save();
  return c;
}, true);
route('DELETE', '/api/admin/categories/:id', (ctx) => {
  if (state.items.some((i) => i.categoryId === ctx.params.id)) bad('กรุณาลบหรือย้ายเมนูในหมวดนี้ก่อน');
  state.categories = state.categories.filter((c) => c.id !== ctx.params.id);
  save();
  return { ok: true };
}, true);

function readItem(b, partial) {
  const out = {};
  if (!partial || 'name' in b) {
    out.name = str(b.name, 80);
    if (!out.name) bad('กรุณากรอกชื่อเมนู');
  }
  if (!partial || 'price' in b) {
    out.price = num(b.price);
    if (!(out.price >= 0 && out.price <= 100000)) bad('ราคาไม่ถูกต้อง');
  }
  if (!partial || 'desc' in b) out.desc = str(b.desc, 200);
  if (!partial || 'available' in b) out.available = b.available !== false;
  if (!partial || 'categoryId' in b) {
    if (!state.categories.some((c) => c.id === b.categoryId)) bad('ไม่พบหมวดหมู่');
    out.categoryId = b.categoryId;
  }
  return out;
}
route('POST', '/api/admin/items', (ctx) => {
  const it = { id: 'i' + rid(4), ...readItem(ctx.body, false) };
  state.items.push(it);
  save();
  return it;
}, true);
route('PUT', '/api/admin/items/:id', (ctx) => {
  const it = state.items.find((x) => x.id === ctx.params.id);
  if (!it) bad('ไม่พบเมนู', 404);
  Object.assign(it, readItem(ctx.body, true));
  save();
  return it;
}, true);
route('DELETE', '/api/admin/items/:id', (ctx) => {
  state.items = state.items.filter((x) => x.id !== ctx.params.id);
  save();
  return { ok: true };
}, true);

route('GET', '/api/admin/orders', () => {
  const active = [];
  for (let n = 1; n <= state.settings.tableCount; n++) active.push(...currentOrders(n));
  active.sort((a, b) => a.createdAt - b.createdAt);
  return { orders: active };
}, true);
route('PUT', '/api/admin/orders/:id/status', (ctx) => {
  const o = state.orders.find((x) => x.id === ctx.params.id);
  if (!o) bad('ไม่พบออเดอร์', 404);
  if (!STATUSES.includes(ctx.body.status)) bad('สถานะไม่ถูกต้อง');
  o.status = ctx.body.status;
  save();
  return o;
}, true);

route('GET', '/api/admin/tables', (ctx) => {
  const list = [];
  for (let n = 1; n <= state.settings.tableCount; n++) {
    const orders = currentOrders(n);
    list.push({
      table: n,
      guests: state.tables[n].guests,
      orderCount: orders.filter((o) => o.status !== 'cancelled').length,
      pending: orders.filter((o) => o.status === 'new' || o.status === 'preparing').length,
      bill: billFor(n),
      url: tableUrl(ctx.req, n),
    });
  }
  return { base: baseUrl(ctx.req), tables: list };
}, true);

function adminTable(ctx) {
  const n = parseInt(ctx.params.n, 10);
  if (!(n >= 1 && n <= state.settings.tableCount)) bad('ไม่พบโต๊ะ', 404);
  return n;
}
route('PUT', '/api/admin/tables/:n', (ctx) => {
  const n = adminTable(ctx);
  const g = parseInt(ctx.body.guests, 10);
  if (!(g >= 0 && g <= 50)) bad('จำนวนลูกค้าต้องอยู่ระหว่าง 0-50');
  state.tables[n].guests = g;
  save();
  return { ok: true, bill: billFor(n) };
}, true);
route('POST', '/api/admin/tables/:n/close', (ctx) => {
  const n = adminTable(ctx);
  state.tables[n].sessionId = rid(6);
  state.tables[n].guests = 0;
  save();
  return { ok: true };
}, true);
route('POST', '/api/admin/tables/:n/regen-key', (ctx) => {
  const n = adminTable(ctx);
  state.tables[n].key = rid(8);
  save();
  return { ok: true };
}, true);

/* ---------- ไฟล์หน้าเว็บ ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
function serveStatic(req, res, pathname) {
  if (pathname === '/admin') pathname = '/admin.html';
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'ไม่พบหน้านี้' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
      return serveStatic(req, res, pathname);
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.isAdmin && !isAdminReq(req)) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      const out = await r.handler({ req, res, params: m.groups || {}, query: url.searchParams, body });
      if (out && out.body) return send(res, 200, out.body, out.headers);
      return send(res, 200, out);
    }
    throw new HttpError(404, 'ไม่พบ API นี้');
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.code, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'เซิร์ฟเวอร์ขัดข้อง' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`เปิดใช้งานที่ http://localhost:${PORT}  (หลังบ้าน: /admin)`);
    if (!ADMIN_PASSWORD) console.log('⚠ หน้า /admin เปิดโดยไม่ต้องใส่รหัสผ่าน — ใครรู้ลิงก์ก็แก้เมนูและราคาได้ (ตั้ง ADMIN_PASSWORD หากต้องการล็อก)');
  });
}
module.exports = server;
