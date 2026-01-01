const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const bodyParser = require("body-parser");
const generatePayload = require("promptpay-qr");
const qrcode = require("qrcode");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ตั้งค่า PromptPay ID (เบอร์โทร หรือ เลข ปชช)
const SHOP_PROMPTPAY_ID = "0812345678";

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// Database Setup
const db = new sqlite3.Database("./icecream_shop.db", (err) => {
  if (err) console.error(err.message);
  console.log("Connected to Database");
});

db.serialize(() => {
  // 1. Orders
  db.run(
    `CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, table_no TEXT, items TEXT, total REAL, status TEXT, created_at TEXT, date TEXT)`
  );
  // 2. Stock
  db.run(
    `CREATE TABLE IF NOT EXISTS stock (item_id TEXT PRIMARY KEY, is_available INTEGER)`
  );
  // 3. Users
  db.run(
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, role TEXT)`
  );

  // 4. Menu Tables
  db.run(
    `CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price INTEGER, max_scoops INTEGER, img_url TEXT, is_available INTEGER DEFAULT 1)`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS flavors (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, color TEXT, is_available INTEGER DEFAULT 1)`
  );
  // 🔥 แก้ไขบรรทัดนี้: เพิ่ม img_url ในตาราง toppings
  db.run(
    `CREATE TABLE IF NOT EXISTS toppings (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price INTEGER, img_url TEXT, is_available INTEGER DEFAULT 1)`
  );

  // Seed Users
  db.get("SELECT count(*) as count FROM users", (err, row) => {
    if (row.count === 0) {
      db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", [
        "admin",
        "1234",
        "admin",
      ]);
      db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", [
        "staff",
        "1111",
        "staff",
      ]);
    }
  });

  // Seed Menu (ข้อมูลตัวอย่าง)
  db.get("SELECT count(*) as count FROM categories", (err, row) => {
    if (row.count === 0) {
      console.log("Seeding menu data...");
      // Flavors
      const f = db.prepare("INSERT INTO flavors (name, color) VALUES (?, ?)");
      [
        ["Vanilla", "#F3E5AB"],
        ["Chocolate", "#5D4037"],
        ["Strawberry", "#FFB7B2"],
        ["Matcha", "#C1E1C1"],
        ["Cookie", "#E0E0E0"],
        ["Mint", "#AAF0D1"],
      ].forEach((i) => f.run(i));
      f.finalize();

      // Toppings (ตัวอย่างแบบมีรูปและไม่มีรูป)
      const t = db.prepare(
        "INSERT INTO toppings (name, price, img_url) VALUES (?, ?, ?)"
      );
      [
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
      ].forEach((i) => t.run(i));
      t.finalize();

      // Categories
      const c = db.prepare(
        "INSERT INTO categories (name, price, max_scoops, img_url) VALUES (?, ?, ?, ?)"
      );
      const initCats = [
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
      initCats.forEach((i) => c.run(i));
      c.finalize();
    }
  });
});

function getTodayDate() {
  return new Date().toISOString().split("T")[0];
}

// --- API Endpoints ---

// Login
app.post("/api/login", (req, res) => {
  db.get(
    "SELECT * FROM users WHERE username = ? AND password = ?",
    [req.body.username, req.body.password],
    (err, user) => {
      if (user)
        res.json({
          status: "success",
          role: user.role,
          username: user.username,
        });
      else res.json({ status: "error", message: "Invalid credentials" });
    }
  );
});

// Menu Data
app.get("/api/menu", (req, res) => {
  const menu = {};
  db.all("SELECT * FROM categories WHERE is_available=1", [], (err, c) => {
    menu.categories = c;
    db.all("SELECT * FROM flavors WHERE is_available=1", [], (err, f) => {
      menu.flavors = f;
      db.all("SELECT * FROM toppings WHERE is_available=1", [], (err, t) => {
        menu.toppings = t;
        res.json(menu);
      });
    });
  });
});

// QR Gen
app.post("/api/generate-qr", (req, res) => {
  const amount = parseFloat(req.body.amount);
  if (!amount || amount <= 0) return res.json({ status: "error" });
  const payload = generatePayload(SHOP_PROMPTPAY_ID, { amount });
  qrcode.toDataURL(payload, (err, url) => {
    if (err) return res.status(500).json({ status: "error" });
    res.json({ status: "success", qrImage: url });
  });
});

// Admin Helper: Emit 'menu_updated' ทุกครั้งที่มีการเปลี่ยนแปลง
const adminRun = (sql, params, res) =>
  db.run(sql, params, (err) => {
    if (err)
      return res.json({ status: "error", message: err ? err.message : "" });
    res.json({ status: "success" });
    io.emit("menu_updated"); // 🔥 แจ้งเตือนทุกเครื่องให้โหลดเมนูใหม่
  });

// Flavors
app.post("/api/admin/flavor/add", (req, res) =>
  adminRun(
    "INSERT INTO flavors (name, color) VALUES (?, ?)",
    [req.body.name, req.body.color],
    res
  )
);
app.post("/api/admin/flavor/delete", (req, res) =>
  adminRun(
    "UPDATE flavors SET is_available = 0 WHERE id = ?",
    [req.body.id],
    res
  )
);

// Toppings (Updated for Image URL)
// 🔥 แก้ไข API นี้ให้รับ img_url
// Toppings
app.post("/api/admin/topping/add", (req, res) =>
  adminRun(
    "INSERT INTO toppings (name, price, img_url) VALUES (?, ?, ?)",
    [req.body.name, req.body.price, req.body.img_url],
    res
  )
);
app.post("/api/admin/topping/delete", (req, res) =>
  adminRun(
    "UPDATE toppings SET is_available = 0 WHERE id = ?",
    [req.body.id],
    res
  )
);

// 🔥 เพิ่ม API นี้เข้าไปครับ: สำหรับอัปเดตข้อมูล Topping
app.post("/api/admin/topping/update", (req, res) => {
  const { id, name, price, img_url } = req.body;
  adminRun(
    "UPDATE toppings SET name = ?, price = ?, img_url = ? WHERE id = ?",
    [name, price, img_url, id],
    res
  );
});

// Categories
app.post("/api/admin/category/add", (req, res) => {
  const { name, price, max_scoops, img_url } = req.body;
  adminRun(
    "INSERT INTO categories (name, price, max_scoops, img_url) VALUES (?, ?, ?, ?)",
    [name, price, max_scoops, img_url],
    res
  );
});
app.post("/api/admin/category/update", (req, res) => {
  const { id, name, price, max_scoops, img_url } = req.body;
  adminRun(
    "UPDATE categories SET name = ?, price = ?, max_scoops = ?, img_url = ? WHERE id = ?",
    [name, price, max_scoops, img_url, id],
    res
  );
});
app.post("/api/admin/category/delete", (req, res) =>
  adminRun(
    "UPDATE categories SET is_available = 0 WHERE id = ?",
    [req.body.id],
    res
  )
);

// --- Socket.io ---
io.on("connection", (socket) => {
  // Send Stock
  db.all("SELECT * FROM stock", [], (err, rows) => {
    const stockMap = {};
    if (rows) rows.forEach((r) => (stockMap[r.item_id] = r.is_available === 1));
    socket.emit("stock_update", stockMap);
  });

  // Orders
  socket.on("request_pending_orders", () => {
    db.all("SELECT * FROM orders WHERE status = 'pending'", [], (err, rows) => {
      if (!err)
        socket.emit(
          "load_current_orders",
          rows.map((r) => ({ ...r, items: JSON.parse(r.items) }))
        );
    });
  });

  socket.on("place_order", (orderData, callback) => {
    const time = new Date().toLocaleTimeString("th-TH");
    const itemsString = JSON.stringify(orderData.items);
    db.run(
      `INSERT INTO orders (table_no, items, total, status, created_at, date) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        orderData.table,
        itemsString,
        orderData.totalPrice,
        "pending",
        time,
        getTodayDate(),
      ],
      function (err) {
        if (err) {
          if (callback) callback({ status: "error" });
          return;
        }
        io.emit("new_order_notification", {
          id: this.lastID,
          ...orderData,
          timestamp: time,
          status: "pending",
        });
        if (callback) callback({ status: "success", orderId: this.lastID });
      }
    );
  });

  socket.on("complete_order", (id) => updateStatus(id, "completed"));
  socket.on("undo_order", (id) => updateStatus(id, "pending"));

  function updateStatus(id, status) {
    db.run("UPDATE orders SET status = ? WHERE id = ?", [status, id], (err) => {
      if (!err) {
        db.all(
          "SELECT * FROM orders WHERE status = 'pending'",
          [],
          (err, rows) => {
            io.emit(
              "load_current_orders",
              rows.map((r) => ({ ...r, items: JSON.parse(r.items) }))
            );
          }
        );
        io.emit("order_status_changed", { orderId: id, status: status });
      }
    });
  }

  socket.on("toggle_stock", (data) => {
    const s = data.available ? 1 : 0;
    db.run(
      `INSERT INTO stock (item_id, is_available) VALUES (?, ?) ON CONFLICT(item_id) DO UPDATE SET is_available = ?`,
      [data.itemId, s, s],
      () => {
        db.all("SELECT * FROM stock", [], (err, rows) => {
          const map = {};
          rows.forEach((r) => (map[r.item_id] = r.is_available === 1));
          io.emit("stock_update", map);
        });
      }
    );
  });

  socket.on("request_admin_data", () => {
    db.all(
      "SELECT * FROM orders WHERE status = 'completed' ORDER BY id DESC LIMIT 50",
      [],
      (err, rows) => {
        const h = rows
          ? rows.map((r) => ({ ...r, items: JSON.parse(r.items) }))
          : [];
        db.get(
          "SELECT SUM(total) as t FROM orders WHERE status = 'completed' AND date = ?",
          [getTodayDate()],
          (err, res) => {
            socket.emit("admin_data_response", {
              history: h,
              totalToday: res ? res.t || 0 : 0,
            });
          }
        );
      }
    );
  });
});

server.listen(3000, () => console.log("Server running on port 3000"));
