const express = require("express");
const cors = require("cors");
const fs = require("fs").promises;
const path = require("path");

const app = express();
const PORT = process.env.PORT || 4000;
const DATA_FILE = path.join(__dirname, "data.json");

// IMPORTANT: set this to your MAIN STORAGE branch id in data.json
const MAIN_STORAGE_BRANCH_ID = "B001";

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // serve frontend

// ---------- Helpers ----------
async function loadData() {
  const raw = await fs.readFile(DATA_FILE, "utf-8");
  return JSON.parse(raw);
}

async function saveData(data) {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
}

function findUserById(data, userId) {
  return (data.users || []).find((u) => u.id === userId);
}

function findUserByName(data, name) {
  return (data.users || []).find(
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
    res.json({
      id: user.id,
      name: user.name,
      role: user.role,
      branchId: user.branchId || null
    });
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

// ---------- USERS (Admin create) ----------
app.post("/api/users", async (req, res) => {
  try {
    const { name, role, password, adminUserId, branchId } = req.body;
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
      password,
      branchId: branchId || null
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

// ---------- USERS (Admin edit/update) ----------
app.patch("/api/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { adminUserId, name, role, password, branchId } = req.body;

    const data = await loadData();
    const admin = findUserById(data, adminUserId);
    if (!admin || admin.role !== "admin") {
      return res.status(403).json({ error: "Only admin can edit users" });
    }

    const user = (data.users || []).find((u) => u.id === id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (name) user.name = name;
    if (role) user.role = role;
    if (typeof branchId !== "undefined") user.branchId = branchId;
    if (password) user.password = password;

    await saveData(data);
    const { password: pw, ...safeUser } = user;
    res.json(safeUser);
  } catch (err) {
    console.error("Update user error", err);
    res.status(500).json({ error: "Failed to update user" });
  }
});

// ---------- USERS (Admin delete) ----------
app.delete("/api/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { adminUserId } = req.body;

    const data = await loadData();
    const admin = findUserById(data, adminUserId);
    if (!admin || admin.role !== "admin") {
      return res.status(403).json({ error: "Only admin can delete users" });
    }

    if (admin.id === id) {
      return res
        .status(400)
        .json({ error: "Admin cannot delete their own account" });
    }

    const idx = (data.users || []).findIndex((u) => u.id === id);
    if (idx === -1) return res.status(404).json({ error: "User not found" });

    data.users.splice(idx, 1);
    await saveData(data);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete user error", err);
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// ---------- ITEMS (Admin & Manager create item types) ----------
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

    if ((data.items || []).find((x) => x.id === id && x.branchId === branchId)) {
      return res
        .status(400)
        .json({ error: "Item ID already exists in this branch" });
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

// ---------- MOVEMENTS (Admin & Manager only, adjust stock) ----------
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
    if (user.role !== "admin" && user.role !== "manager") {
      return res
        .status(403)
        .json({ error: "Only admin/manager can record movements" });
    }

    const item = (data.items || []).find((it) => it.id === itemId);
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

    // adjust stock
    if (movement.type === "IN") {
      item.baseQty += movement.qty;
    } else if (movement.type === "OUT") {
      item.baseQty = Math.max(0, item.baseQty - movement.qty);
    }

    data.movements.push(movement);
    await saveData(data);
    res.status(201).json(movement);
  } catch (err) {
    console.error("Movement error", err);
    res.status(500).json({ error: "Failed to save movement" });
  }
});

// ---------- REQUESTS (staff/manager/admin; Main Storage → user branch) ----------
app.post("/api/requests", async (req, res) => {
  try {
    const { itemId, qty, userId, note } = req.body;
    if (!itemId || !qty || !userId) {
      return res
        .status(400)
        .json({ error: "itemId, qty, userId are required" });
    }

    const data = await loadData();
    const user = findUserById(data, userId);
    if (!user) return res.status(400).json({ error: "User not found" });
    if (user.role === "driver") {
      return res.status(403).json({ error: "Drivers cannot create requests" });
    }
    if (!user.branchId) {
      return res
        .status(400)
        .json({ error: "User is not assigned to a branch" });
    }

    const storageItem = (data.items || []).find(
      (it) => it.id === itemId && it.branchId === MAIN_STORAGE_BRANCH_ID
    );
    if (!storageItem) {
      return res
        .status(400)
        .json({ error: "Item not found in Main Storage" });
    }

    const request = {
      id: "REQ-" + Date.now(),
      itemId,
      qty: Number(qty),
      fromBranchId: MAIN_STORAGE_BRANCH_ID,
      toBranchId: user.branchId,
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

// ---------- DRIVER DELIVER (OUT storage, IN branch, move stock) ----------
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

    const request = (data.requests || []).find((r) => r.id === id);
    if (!request) return res.status(404).json({ error: "Request not found" });
    if (request.status === "delivered") {
      return res.status(400).json({ error: "Request already delivered" });
    }

    const storageItem = (data.items || []).find(
      (it) => it.id === request.itemId && it.branchId === request.fromBranchId
    );
    if (!storageItem) {
      return res
        .status(400)
        .json({ error: "Item not found in storage branch" });
    }

    const qty = Number(request.qty);
    if (storageItem.baseQty < qty) {
      return res
        .status(400)
        .json({ error: "Not enough stock in storage to deliver" });
    }

    // OUT movement from storage
    const outMovement = {
      id: "MOV-" + Date.now(),
      itemId: request.itemId,
      type: "OUT",
      qty,
      userId: driverUserId,
      branchId: request.fromBranchId,
      note: `Delivery OUT for request ${request.id}`,
      createdAt: new Date().toISOString()
    };
    storageItem.baseQty -= qty;

    // IN movement to destination branch
    let destItem = (data.items || []).find(
      (it) => it.id === request.itemId && it.branchId === request.toBranchId
    );
    if (!destItem) {
      destItem = {
        id: storageItem.id,
        name: storageItem.name,
        branchId: request.toBranchId,
        minQty: 0,
        baseQty: 0,
        unitCost: storageItem.unitCost
      };
      data.items.push(destItem);
    }
    destItem.baseQty += qty;

    const inMovement = {
      id: "MOV-" + (Date.now() + 1),
      itemId: request.itemId,
      type: "IN",
      qty,
      userId: driverUserId,
      branchId: request.toBranchId,
      note: `Delivery IN for request ${request.id}`,
      createdAt: new Date().toISOString()
    };

    data.movements.push(outMovement, inMovement);
    request.status = "delivered";
    request.driverUserId = driverUserId;

    await saveData(data);

    res.status(201).json({ request, movements: [outMovement, inMovement] });
  } catch (err) {
    console.error("Deliver error", err);
    res.status(500).json({ error: "Failed to deliver request" });
  }
});

// ---------- BUDGET (manual endpoint, optional) ----------
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

    let budget = (data.budgets || []).find(
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
