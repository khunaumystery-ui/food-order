// Buffet & À la Carte Restaurant Demo Server (Pure Node.js)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'store.json');

// In-memory state with persistence
let sseClients = [];

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Load or initialize store
function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading store:', e);
  }
  return null;
}

function saveStore(store) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving store:', e);
  }
}

// Default store generator
function getDefaultStore() {
  const tables = {};
  for (let i = 1; i <= 20; i++) {
    const tableId = `T${i.toString().padStart(2, '0')}`;
    tables[tableId] = {
      id: tableId,
      number: i,
      status: i <= 3 ? 'occupied' : 'available', // sample active tables
      buffetType: i <= 3 ? 'Standard Buffet 399฿' : null,
      guests: i <= 3 ? (i === 1 ? 4 : (i === 2 ? 2 : 3)) : 0,
      startTime: i <= 3 ? Date.now() - (i * 20 * 60 * 1000) : null,
      timeLimitMinutes: 90,
      orders: []
    };
  }

  // Pre-seed a sample active order for Table 1 and Table 2 to show live KDS immediately
  const sampleOrders = [
    {
      id: 'ORD-101',
      tableId: 'T01',
      tableNumber: 1,
      createdAt: Date.now() - (8 * 60 * 1000),
      status: 'cooking', // pending, cooking, served
      items: [
        { id: 'm1', nameTh: 'เนื้อวากิวออสเตรเลียสไลซ์', nameEn: 'Aussie Wagyu Slice', qty: 3, type: 'buffet', price: 0 },
        { id: 'm6', nameTh: 'กุ้งแม่น้ำสดไซส์ใหญ่', nameEn: 'Giant River Prawns', qty: 2, type: 'buffet', price: 0 },
        { id: 'm11', nameTh: 'ซุปหม่าล่าเสฉวน', nameEn: 'Sichuan Mala Soup', qty: 1, type: 'buffet', price: 0, note: 'เผ็ดมาก' },
        { id: 'm5', nameTh: 'เนื้อริบอายวากิว A5 ลายหินอ่อน', nameEn: 'A5 Wagyu Ribeye Cut', qty: 1, type: 'alacarte', price: 490 }
      ],
      totalAlacarte: 490,
      totalItems: 7
    },
    {
      id: 'ORD-102',
      tableId: 'T02',
      tableNumber: 2,
      createdAt: Date.now() - (2 * 60 * 1000),
      status: 'pending',
      items: [
        { id: 'm2', nameTh: 'สันคอหมูคุโรบูตะ', nameEn: 'Kurobuta Pork Collar', qty: 2, type: 'buffet', price: 0 },
        { id: 'm7', nameTh: 'หอยแมลงภู่นิวซีแลนด์', nameEn: 'NZ Green Mussels', qty: 2, type: 'buffet', price: 0 },
        { id: 'm10', nameTh: 'ซาชิมิแซลมอนนอร์เวย์พรีเมียม', nameEn: 'Norway Salmon Sashimi', qty: 1, type: 'alacarte', price: 320 }
      ],
      totalAlacarte: 320,
      totalItems: 5
    }
  ];

  tables['T01'].orders.push('ORD-101');
  tables['T02'].orders.push('ORD-102');

  return {
    tables,
    orders: sampleOrders,
    menu: null // will be populated from client defaults or preserved
  };
}

let store = loadStore() || getDefaultStore();

function broadcastEvent(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.res.write(payload);
    } catch (e) {
      // client disconnected
    }
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // SSE Stream endpoint
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write('data: {"type":"connected"}\n\n');
    const clientId = Date.now();
    sseClients.push({ id: clientId, res });

    req.on('close', () => {
      sseClients = sseClients.filter(c => c.id !== clientId);
    });
    return;
  }

  // REST API: GET /api/state
  if (pathname === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(store));
    return;
  }

  // REST API: POST /api/orders (New Order from Table)
  if (pathname === '/api/orders' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const orderData = JSON.parse(body);
        const orderId = 'ORD-' + Math.floor(100 + Math.random() * 900);
        const newOrder = {
          id: orderId,
          tableId: orderData.tableId,
          tableNumber: parseInt(orderData.tableNumber || orderData.tableId.replace(/\D/g, '')),
          createdAt: Date.now(),
          status: 'pending',
          items: orderData.items || [],
          totalAlacarte: orderData.totalAlacarte || 0,
          totalItems: (orderData.items || []).reduce((acc, it) => acc + (it.qty || 1), 0),
          note: orderData.note || ''
        };

        store.orders.unshift(newOrder);

        // Update table status to occupied if it was available
        if (store.tables[newOrder.tableId]) {
          const tbl = store.tables[newOrder.tableId];
          tbl.status = 'occupied';
          if (!tbl.startTime) tbl.startTime = Date.now();
          if (!tbl.orders) tbl.orders = [];
          tbl.orders.push(orderId);
        }

        saveStore(store);
        broadcastEvent('new_order', newOrder);
        broadcastEvent('state_updated', store);

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, order: newOrder }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // REST API: PATCH /api/orders/:id/status
  if (pathname.startsWith('/api/orders/') && req.method === 'PATCH') {
    const parts = pathname.split('/');
    const orderId = parts[3];
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const order = store.orders.find(o => o.id === orderId);
        if (order) {
          order.status = payload.status;
          saveStore(store);
          broadcastEvent('order_status', { id: orderId, status: payload.status });
          broadcastEvent('state_updated', store);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, order }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Order not found' }));
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // REST API: POST /api/tables/:id/action (open, checkout, reset)
  if (pathname.startsWith('/api/tables/') && req.method === 'POST') {
    const parts = pathname.split('/');
    const tableId = parts[3];
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const action = payload.action;
        const tbl = store.tables[tableId];
        if (tbl) {
          if (action === 'open') {
            tbl.status = 'occupied';
            tbl.guests = payload.guests || 2;
            tbl.buffetType = payload.buffetType || 'Standard Buffet 399฿';
            tbl.startTime = Date.now();
            tbl.orders = [];
          } else if (action === 'checkout') {
            tbl.status = 'available';
            tbl.guests = 0;
            tbl.buffetType = null;
            tbl.startTime = null;
            tbl.orders = [];
          } else if (action === 'add_time') {
            tbl.timeLimitMinutes = (tbl.timeLimitMinutes || 90) + 15;
          }
          saveStore(store);
          broadcastEvent('state_updated', store);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, table: tbl }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Table not found' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // REST API: POST /api/reset (Reset Demo Data)
  if (pathname === '/api/reset' && req.method === 'POST') {
    store = getDefaultStore();
    saveStore(store);
    broadcastEvent('state_updated', store);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Reset completed' }));
    return;
  }

  // Static File Serving
  let filePath = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.normalize(path.join(__dirname, filePath));

  if (!safePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for SPA routes
      const indexPath = path.join(__dirname, 'index.html');
      fs.readFile(indexPath, (err2, data) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('404 Not Found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(data);
        }
      });
      return;
    }

    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(safePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500);
        res.end('Server Error');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalIp();
  console.log('================================================================');
  console.log('🔥 SHABU & GRILL PALACE - BUFFET RESTAURANT DEMO SERVER');
  console.log('================================================================');
  console.log(`🌐 Local Web:    http://localhost:${PORT}`);
  console.log(`📱 Mobile/Wi-Fi: http://${localIp}:${PORT}`);
  console.log('----------------------------------------------------------------');
  console.log('💡 เคล็ดลับการนำเสนอลูกค้า:');
  console.log('   - เปิด http://localhost:' + PORT + ' บนคอมพิวเตอร์');
  console.log('   - ใช้มือถือที่ต่อ Wi-Fi เดียวกัน สแกน QR Code หน้าจอ เพื่อสั่งอาหารจริง');
  console.log('   - จอครัวจะแจ้งเตือนพร้อมเสียงกระดิ่ง "Ding-Dong!" ทันทีที่มีออเดอร์');
  console.log('================================================================');
});
