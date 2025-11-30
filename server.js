const express = require("express");
const cors = require("cors");
const fs = require("fs").promises;
const path = require("path");

const app = express();
const PORT = process.env.PORT || 4000; // Render will set PORT env var
const DATA_FILE = path.join(__dirname, "data.json");

app.use(cors());
app.use(express.json());

// Serve frontend from /public
app.use(express.static(path.join(__dirname, "public")));

// ---------- Helpers ----------
async function loadData() {
  const raw = await fs.readFile(DATA_FILE, "utf-8");
  return JSON.parse(raw);
}

async function saveData(data) {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
}

function findUserById(data, userId) {
  return data.users.find((u) => u.id === userId);
}

function findUserByName(data, name) {
  return data.users.find(
    (u) => u.name.toLowerCase() === String(name).toLowerCase()
  );
}

// ---------- AUTH ----------
app.post("/api/login", async (req, res) => {
  try {
    const { name, password } = req.body;
    if (!name || !password) {
      return res.status(400).json({ error: "name and password required" });
    }
    const data = await loadData();
    const user = findUserByName(data, name);
    if (!user || user.password !== password) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    res.json({ id: user.id, name: user.name, role: user.role });
  } catch (err) {
    console.error("Login error", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// ---------- STATE ----------
app.get("/api/state", async (req, res) => {
  try {
    const data = await loadData();
    res.json({
      branches: data.branches || [],
      users: (data.users || []).map(({ password, ...u }) => u),
      items: data.items || [],
      movements: data.movements || [],
      budgets: data.budgets || [],
      requests: data.requests || [],
      trips: data.trips || []
    });
  } catch (err) {
    console.error("State error", err);
    res.status(500).json({ error: "Failed to load data" });
  }
});

// ---------- USERS (admin only create) ----------
app.post("/api/users", async (req, res) => {
  try {
    const { name, role, password, adminUserId } = req.body;
    if (!name || !role || !password) {
      return res
        .status(400)
        .json({ error: "name, role, password are required" });
    }

    const data = await loadData();
    const admin = findUserById(data, adminUserId);
    if (!admin || admin.role !== "admin") {
      return res.status(403).json({ error: "Only admin can create users" });
    }

    if (findUserByName(data, name)) {
      return res.status(400).json({ error: "Username already exists" });
    }

    const newUser = {
      id: "u_" + Date.now(),
      name,
      role,
      password
    };
    data.users.push(newUser);
    await saveData(data);

    const { password: pw, ...safeUser } = newUser;
    res.status(201).json(safeUser);
  } catch (err) {
    console.error("Create user error", err);
    res.status(500).json({ error: "Failed to create user" });
  }
});

// ---------- ITEMS (admin & manager create item types) ----------
app.post("/api/items", async (req, res) => {
  try {
    const {
      id,
      name,
      branchId,
      minQty,
      baseQty,
      unitCost,
      managerUserId
    } = req.body;

    if (!id || !name || !branchId) {
      return res.status(400).json({ error: "id, name, branchId required" });
    }

    const data = await loadData();
    const user = findUserById(data, managerUserId);
    if (!user || (user.role !== "manager" && user.role !== "admin")) {
      return res
        .status(403)
        .json({ error: "Only manager or admin can create items" });
    }

    if (data.items.find((x) => x.id === id)) {
      return res.status(400).json({ error: "Item ID already exists" });
    }

    const newItem = {
      id,
      name,
      branchId,
      minQty: Number(minQty) || 0,
      baseQty: Number(baseQty) || 0,
      unitCost: Number(unitCost) || 0
    };

    data.items.push(newItem);
    await saveData(data);
    res.status(201).json(newItem);
  } catch (err) {
    console.error("Create item error", err);
    res.status(500).json({ error: "Failed to create item" });
  }
});

// ---------- MOVEMENTS ----------
app.post("/api/movements", async (req, res) => {
  try {
    const { itemId, type, qty, userId, note } = req.body;
    if (!itemId || !type || !qty || !userId) {
      return res
        .status(400)
        .json({ error: "itemId, type, qty, userId are required" });
    }

    const data = await loadData();
    const user = findUserById(data, userId);
    if (!user) return res.status(400).json({ error: "User not found" });

    const item = data.items.find((it) => it.id === itemId);
    if (!item) return res.status(400).json({ error: "Item not found" });

    const movement = {
      id: "MOV-" + Date.now(),
      itemId,
      type, // "IN" or "OUT"
      qty: Number(qty),
      userId,
      branchId: item.branchId,
      note: note || "",
      createdAt: new Date().toISOString()
    };

    data.movements.push(movement);
    await saveData(data);
    res.status(201).json(movement);
  } catch (err) {
    console.error("Movement error", err);
    res.status(500).json({ error: "Failed to save movement" });
  }
});

// ---------- REQUESTS (all EXCEPT drivers can create) ----------
app.post("/api/requests", async (req, res) => {
  try {
    const { itemId, qty, userId, branchId, note } = req.body;
    if (!itemId || !qty || !userId || !branchId) {
      return res
        .status(400)
        .json({ error: "itemId, qty, userId, branchId required" });
    }

    const data = await loadData();
    const user = findUserById(data, userId);
    if (!user) return res.status(400).json({ error: "User not found" });
    if (user.role === "driver") {
      return res.status(403).json({ error: "Drivers cannot create requests" });
    }

    const item = data.items.find(
      (it) => it.id === itemId && it.branchId === branchId
    );
    if (!item) {
      return res.status(400).json({ error: "Item not found in branch" });
    }

    const request = {
      id: "REQ-" + Date.now(),
      itemId,
      qty: Number(qty),
      branchId,
      createdByUserId: userId,
      note: note || "",
      status: "pending",
      driverUserId: null,
      createdAt: new Date().toISOString()
    };

    data.requests.push(request);
    await saveData(data);
    res.status(201).json(request);
  } catch (err) {
    console.error("Create request error", err);
    res.status(500).json({ error: "Failed to create request" });
  }
});

// ---------- DRIVER DELIVER ----------
app.post("/api/requests/:id/deliver", async (req, res) => {
  try {
    const { id } = req.params;
    const { driverUserId } = req.body;
    if (!driverUserId) {
      return res.status(400).json({ error: "driverUserId required" });
    }

    const data = await loadData();
    const driver = findUserById(data, driverUserId);
    if (!driver || driver.role !== "driver") {
      return res.status(403).json({ error: "Only drivers can deliver" });
    }

    const request = data.requests.find((r) => r.id === id);
    if (!request) return res.status(404).json({ error: "Request not found" });
    if (request.status === "delivered") {
      return res.status(400).json({ error: "Request already delivered" });
    }

    const item = data.items.find(
      (it) => it.id === request.itemId && it.branchId === request.branchId
    );
    if (!item) {
      return res
        .status(400)
        .json({ error: "Item not found for this request" });
    }

    const movement = {
      id: "MOV-" + Date.now(),
      itemId: request.itemId,
      type: "OUT",
      qty: Number(request.qty),
      userId: driverUserId,
      branchId: request.branchId,
      note: `Delivery for request ${request.id}`,
      createdAt: new Date().toISOString()
    };

    data.movements.push(movement);
    request.status = "delivered";
    request.driverUserId = driverUserId;

    await saveData(data);

    res.status(201).json({ request, movement });
  } catch (err) {
    console.error("Deliver error", err);
    res.status(500).json({ error: "Failed to deliver request" });
  }
});

// ---------- BUDGET (admin only) ----------
app.post("/api/budgets", async (req, res) => {
  try {
    const { branchId, month, planned, adminUserId } = req.body;
    if (!branchId || !month) {
      return res
        .status(400)
        .json({ error: "branchId and month are required" });
    }
    const data = await loadData();
    const admin = findUserById(data, adminUserId);
    if (!admin || admin.role !== "admin") {
      return res.status(403).json({ error: "Only admin can set budgets" });
    }

    let budget = data.budgets.find(
      (b) => b.branchId === branchId && b.month === month
    );
    if (!budget) {
      budget = {
        id: `BUD-${month}-${branchId}`,
        branchId,
        month,
        planned: Number(planned) || 0
      };
      data.budgets.push(budget);
    } else {
      budget.planned = Number(planned) || 0;
    }

    await saveData(data);
    res.status(201).json(budget);
  } catch (err) {
    console.error("Budget error", err);
    res.status(500).json({ error: "Failed to save budget" });
  }
});

// ---------- FRONTEND FALLBACK ----------
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`Storage backend running on http://localhost:${PORT}`);
});
