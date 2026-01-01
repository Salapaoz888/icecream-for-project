// server.js (เวอร์ชั่น PostgreSQL)
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
// const sqlite3 = require('sqlite3').verbose(); // ❌ เลิกใช้ SQLite
const { Pool } = require("pg"); // ✅ ใช้ PostgreSQL แทน
const bodyParser = require("body-parser");
const generatePayload = require("promptpay-qr");
const qrcode = require("qrcode");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ----------------------------------------------------
const SHOP_PROMPTPAY_ID = "0812345678";
// ----------------------------------------------------

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// Database Connection (ใช้ Environment Variable จาก Render)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // ถ้า run บน localhost เครื่องตัวเอง ต้องใส่ค่า connectionString เอง หรือใช้ .env
  // ssl: { rejectUnauthorized: false } // บาง Cloud ต้องเปิดตัวนี้
});

console.log("Connecting to PostgreSQL...");

// Initialize Tables & Seed Data (แปลงเป็น Async/Await เพื่อความชัวร์)
async function initDatabase() {
  try {
    const client = await pool.connect();

    // 1. Create Tables (เปลี่ยน syntax เป็น PostgreSQL)
    await client.query(`CREATE TABLE IF NOT EXISTS orders (
            id SERIAL PRIMARY KEY, 
            table_no TEXT, 
            items TEXT, 
            total REAL, 
            status TEXT, 
            created_at TEXT, 
            date TEXT
        )`);

    await client.query(`CREATE TABLE IF NOT EXISTS stock (
            item_id TEXT PRIMARY KEY, 
            is_available INTEGER
        )`);

    await client.query(`CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY, 
            username TEXT UNIQUE, 
            password TEXT, 
            role TEXT
        )`);

    await client.query(`CREATE TABLE IF NOT EXISTS categories (
            id SERIAL PRIMARY KEY, 
            name TEXT, 
            price INTEGER, 
            max_scoops INTEGER, 
            img_url TEXT, 
            is_available INTEGER DEFAULT 1
        )`);

    await client.query(`CREATE TABLE IF NOT EXISTS flavors (
            id SERIAL PRIMARY KEY, 
            name TEXT, 
            color TEXT, 
            is_available INTEGER DEFAULT 1
        )`);

    await client.query(`CREATE TABLE IF NOT EXISTS toppings (
            id SERIAL PRIMARY KEY, 
            name TEXT, 
            price INTEGER, 
            img_url TEXT, 
            is_available INTEGER DEFAULT 1
        )`);

    // Seed Users
    const userCheck = await client.query("SELECT count(*) FROM users");
    if (parseInt(userCheck.rows[0].count) === 0) {
      await client.query(
        "INSERT INTO users (username, password, role) VALUES ($1, $2, $3)",
        ["admin", "1234", "admin"]
      );
      await client.query(
        "INSERT INTO users (username, password, role) VALUES ($1, $2, $3)",
        ["staff", "1111", "staff"]
      );
    }

    // Seed Menu
    const catCheck = await client.query("SELECT count(*) FROM categories");
    if (parseInt(catCheck.rows[0].count) === 0) {
      console.log("Seeding menu data...");

      // Flavors
      const flavors = [
        ["Vanilla", "#F3E5AB"],
        ["Chocolate", "#5D4037"],
        ["Strawberry", "#FFB7B2"],
        ["Matcha", "#C1E1C1"],
        ["Cookie", "#E0E0E0"],
        ["Mint", "#AAF0D1"],
      ];
      for (const f of flavors)
        await client.query(
          "INSERT INTO flavors (name, color) VALUES ($1, $2)",
          f
        );

      // Toppings
      const toppings = [
        [
          "Cherry",
          10,
          "https://images.unsplash.com/photo-1563286161-9c128d61292d?auto=format&fit=crop&w=100&q=60",
        ],
        ["WhipCream", 10, ""],
        [
          "Oreo",
          10,
          "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?auto=format&fit=crop&w=100&q=60",
        ],
      ];
      for (const t of toppings)
        await client.query(
          "INSERT INTO toppings (name, price, img_url) VALUES ($1, $2, $3)",
          t
        );

      // Categories
      const cats = [
        [
          "Single Scoop",
          59,
          1,
          "https://images.unsplash.com/photo-1563805042-7684c019e1cb?auto=format&fit=crop&w=500&q=60",
        ],
        [
          "Double Scoop",
          99,
          2,
          "https://images.unsplash.com/photo-1570197788417-0e82375c9371?auto=format&fit=crop&w=500&q=60",
        ],
        [
          "Waffle Cone",
          69,
          1,
          "https://images.unsplash.com/photo-1551024709-8f23befc6f87?auto=format&fit=crop&w=500&q=60",
        ],
        [
          "Waffle Bowl",
          129,
          3,
          "https://images.unsplash.com/photo-1560801619-01d71da0f70c?auto=format&fit=crop&w=500&q=60",
        ],
      ];
      for (const c of cats)
        await client.query(
          "INSERT INTO categories (name, price, max_scoops, img_url) VALUES ($1, $2, $3, $4)",
          c
        );
    }

    client.release();
    console.log("Database initialized successfully");
  } catch (err) {
    console.error("Database Init Error:", err);
  }
}
initDatabase();

function getTodayDate() {
  return new Date().toISOString().split("T")[0];
}

// --- API Endpoints ---

// Login
app.post("/api/login", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE username = $1 AND password = $2",
      [req.body.username, req.body.password]
    );
    if (result.rows.length > 0) {
      res.json({
        status: "success",
        role: result.rows[0].role,
        username: result.rows[0].username,
      });
    } else {
      res.json({ status: "error", message: "Invalid credentials" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Menu Data
app.get("/api/menu", async (req, res) => {
  try {
    const cats = await pool.query(
      "SELECT * FROM categories WHERE is_available=1 ORDER BY id"
    );
    const flavs = await pool.query(
      "SELECT * FROM flavors WHERE is_available=1 ORDER BY id"
    );
    const tops = await pool.query(
      "SELECT * FROM toppings WHERE is_available=1 ORDER BY id"
    );
    res.json({
      categories: cats.rows,
      flavors: flavs.rows,
      toppings: tops.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// QR Gen (ไม่ยุ่งกับ DB)
app.post("/api/generate-qr", (req, res) => {
  const amount = parseFloat(req.body.amount);
  if (!amount || amount <= 0) return res.json({ status: "error" });
  const payload = generatePayload(SHOP_PROMPTPAY_ID, { amount });
  qrcode.toDataURL(payload, (err, url) => {
    if (err) return res.status(500).json({ status: "error" });
    res.json({ status: "success", qrImage: url });
  });
});

// --- Admin APIs ---

const adminRun = async (sql, params, res) => {
  try {
    await pool.query(sql, params);
    res.json({ status: "success" });
    io.emit("menu_updated");
  } catch (err) {
    res.json({ status: "error", message: err.message });
  }
};

app.post("/api/admin/flavor/add", (req, res) =>
  adminRun(
    "INSERT INTO flavors (name, color) VALUES ($1, $2)",
    [req.body.name, req.body.color],
    res
  )
);
app.post("/api/admin/flavor/delete", (req, res) =>
  adminRun(
    "UPDATE flavors SET is_available = 0 WHERE id = $1",
    [req.body.id],
    res
  )
);

app.post("/api/admin/topping/add", (req, res) =>
  adminRun(
    "INSERT INTO toppings (name, price, img_url) VALUES ($1, $2, $3)",
    [req.body.name, req.body.price, req.body.img_url],
    res
  )
);
app.post("/api/admin/topping/update", (req, res) => {
  const { id, name, price, img_url } = req.body;
  adminRun(
    "UPDATE toppings SET name = $1, price = $2, img_url = $3 WHERE id = $4",
    [name, price, img_url, id],
    res
  );
});
app.post("/api/admin/topping/delete", (req, res) =>
  adminRun(
    "UPDATE toppings SET is_available = 0 WHERE id = $1",
    [req.body.id],
    res
  )
);

app.post("/api/admin/category/add", (req, res) => {
  const { name, price, max_scoops, img_url } = req.body;
  adminRun(
    "INSERT INTO categories (name, price, max_scoops, img_url) VALUES ($1, $2, $3, $4)",
    [name, price, max_scoops, img_url],
    res
  );
});
app.post("/api/admin/category/update", (req, res) => {
  const { id, name, price, max_scoops, img_url } = req.body;
  adminRun(
    "UPDATE categories SET name = $1, price = $2, max_scoops = $3, img_url = $4 WHERE id = $5",
    [name, price, max_scoops, img_url, id],
    res
  );
});
app.post("/api/admin/category/delete", (req, res) =>
  adminRun(
    "UPDATE categories SET is_available = 0 WHERE id = $1",
    [req.body.id],
    res
  )
);

// --- Socket.io ---

function broadcastUpdate() {
  io.emit("force_refresh_staff");
  io.emit("order_status_changed_global");
}

io.on("connection", async (socket) => {
  // Send Stock
  try {
    const stockRes = await pool.query("SELECT * FROM stock");
    const stockMap = {};
    stockRes.rows.forEach((r) => (stockMap[r.item_id] = r.is_available === 1));
    socket.emit("stock_update", stockMap);
  } catch (e) {
    console.error(e);
  }

  socket.on("request_pending_orders", async () => {
    try {
      const rows = await pool.query(
        "SELECT * FROM orders WHERE status = 'pending' ORDER BY id ASC"
      );
      socket.emit(
        "load_current_orders",
        rows.rows.map((r) => ({ ...r, items: JSON.parse(r.items) }))
      );
    } catch (e) {
      console.error(e);
    }
  });

  socket.on("place_order", async (orderData, callback) => {
    const time = new Date().toLocaleTimeString("th-TH");
    const itemsString = JSON.stringify(orderData.items);
    try {
      // Postgres ใช้ RETURNING id เพื่อเอา ID ล่าสุดกลับมา
      const res = await pool.query(
        `INSERT INTO orders (table_no, items, total, status, created_at, date) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          orderData.table,
          itemsString,
          orderData.totalPrice,
          "pending",
          time,
          getTodayDate(),
        ]
      );
      const newId = res.rows[0].id;

      io.emit("new_order_notification", {
        id: newId,
        ...orderData,
        timestamp: time,
        status: "pending",
      });
      broadcastUpdate();
      if (callback) callback({ status: "success", orderId: newId });
    } catch (e) {
      console.error(e);
      if (callback) callback({ status: "error" });
    }
  });

  socket.on("complete_order", (id) => updateStatus(id, "completed"));
  socket.on("undo_order", (id) => updateStatus(id, "pending"));

  socket.on("delete_order", async (id) => {
    try {
      await pool.query("DELETE FROM orders WHERE id = $1", [id]);
      broadcastUpdate();
    } catch (e) {}
  });

  socket.on("edit_order_info", async (data) => {
    try {
      await pool.query("UPDATE orders SET table_no = $1 WHERE id = $2", [
        data.table,
        data.id,
      ]);
      broadcastUpdate();
    } catch (e) {}
  });

  async function updateStatus(id, status) {
    try {
      await pool.query("UPDATE orders SET status = $1 WHERE id = $2", [
        status,
        id,
      ]);
      broadcastUpdate();
      io.emit("order_status_changed", { orderId: id, status: status });
    } catch (e) {}
  }

  socket.on("toggle_stock", async (data) => {
    const s = data.available ? 1 : 0;
    try {
      await pool.query(
        `INSERT INTO stock (item_id, is_available) VALUES ($1, $2) ON CONFLICT(item_id) DO UPDATE SET is_available = $3`,
        [data.itemId, s, s]
      );
      const stockRes = await pool.query("SELECT * FROM stock");
      const map = {};
      stockRes.rows.forEach((r) => (map[r.item_id] = r.is_available === 1));
      io.emit("stock_update", map);
    } catch (e) {}
  });

  socket.on("request_admin_data", async () => {
    try {
      const h = await pool.query(
        "SELECT * FROM orders WHERE status = 'completed' ORDER BY id DESC LIMIT 50"
      );
      const t = await pool.query(
        "SELECT SUM(total) as t FROM orders WHERE status = 'completed' AND date = $1",
        [getTodayDate()]
      );

      const history = h.rows.map((r) => ({ ...r, items: JSON.parse(r.items) }));
      const total = t.rows[0].t || 0;

      socket.emit("admin_data_response", { history, totalToday: total });
    } catch (e) {}
  });
});

server.listen(3000, () => console.log("Server running on port 3000"));
