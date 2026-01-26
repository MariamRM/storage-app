// server.js (UPDATED)
const express = require("express");
const cors = require("cors");
const fs = require("fs").promises;
const path = require("path");

const app = express();
const PORT = process.env.PORT || 4000;

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const MAIN_STORAGE_BRANCH_ID = process.env.MAIN_STORAGE_BRANCH_ID || "B001"; // change if needed

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // serve frontend

// ---------- Helpers ----------
async function loadData() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw);

    // Ensure new fields exist
    parsed.branches ||= [];
    parsed.users ||= [];
    parsed.items ||= [];
    parsed.movements ||= [];
    parsed.budgets ||= [];
    parsed.requests ||= [];
    parsed.trips ||= [];
    parsed.vehicles ||= [];
    parsed.vehicleReminders ||= [];

    // ✅ NEW (for car handover + maintenance)
    parsed.carAssignments ||= [];     // { id, vehicleId, driverUserId, assignedByUserId, assignedAt, note? }
    parsed.carMaintenances ||= [];    // { id, vehicleId, driverUserId, maintenanceDate, nextMaintenanceDate, price, invoiceNo, place?, storeName?, note?, createdAt }

    return parsed;
  } catch (e) {
    const initial = {
      branches: [],
      users: [],
      items: [],
      movements: [],
      budgets: [],
      requests: [],
      trips: [],
      vehicles: [],
      vehicleReminders: [],
      carAssignments: [],
      carMaintenances: []
    };
    await saveData(initial);
    return initial;
  }
}

async function saveData(data) {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
}

function findUserById(data, userId) {
  return data.users.find((u) => u.id === userId);
}

function findUserByName(data, name) {
  return data.users.find(
    (u) => (u.name || "").toLowerCase() === String(name || "").toLowerCase()
  );
}

function requireRole(user, roles) {
  return user && roles.includes(user.role);
}

// ✅ UPDATED: supports ITEM-001 and ITM-001 (but will generate ITEM-###)
function parseItemNumberAny(id) {
  const s = String(id || "").trim();
  let m = /^ITEM-(\d+)$/i.exec(s);
  if (!m) m = /^ITM-(\d+)$/i.exec(s);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function getNextItemId(data) {
  let max = 0;
  for (const it of data.items || []) {
    const n = parseItemNumberAny(it.id);
    if (n && n > max) max = n;
  }
  const next = max + 1;
  return "ITEM-" + String(next).padStart(3, "0");
}

function getNextBranchId(data) {
  let max = 0;
  for (const b of data.branches || []) {
    const m = /^B(\d+)$/i.exec(String(b.id || "").trim());
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  const next = max + 1;
  return "B" + String(next).padStart(3, "0");
}

function genId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

function mustBe(user, roles, res) {
  if (!user) {
    res.status(400).json({ error: "User not found" });
    return false;
  }
  if (!requireRole(user, roles)) {
    res.status(403).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// Helper for item multilingual names
function normalizeItemNames({ name, nameEn, nameAr }) {
  const n = String(name || "").trim();
  const en = String(nameEn || n || "").trim();
  const ar = String(nameAr || "").trim();
  return { name: n || en || ar || "", nameEn: en || n || "", nameAr: ar || "" };
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

// ---------- NEXT ITEM ID ----------
app.get("/api/next-item-id", async (req, res) => {
  try {
    const data = await loadData();
    res.json({ nextId: getNextItemId(data) });
  } catch (e) {
    res.status(500).json({ error: "Failed to generate next id" });
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
      trips: data.trips || [],
      vehicles: data.vehicles || [],
      vehicleReminders: data.vehicleReminders || [],

      // ✅ NEW
      carAssignments: data.carAssignments || [],
      carMaintenances: data.carMaintenances || []
    });
  } catch (err) {
    console.error("State error", err);
    res.status(500).json({ error: "Failed to load data" });
  }
});

// ---------- BRANCHES (Admin create) ----------
app.post("/api/branches", async (req, res) => {
  try {
    const { name, id, adminUserId } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    const data = await loadData();
    const admin = findUserById(data, adminUserId);
    if (!requireRole(admin, ["admin"])) {
      return res.status(403).json({ error: "Only admin can create branches" });
    }

    const branchName = String(name).trim();
    if ((data.branches || []).some((b) => String(b.name || "").toLowerCase() === branchName.toLowerCase())) {
      return res.status(400).json({ error: "Branch name already exists" });
    }

    let branchId = id ? String(id).trim() : "";
    if (!branchId) {
      branchId = getNextBranchId(data);
    }
    if ((data.branches || []).some((b) => String(b.id || "").toLowerCase() === branchId.toLowerCase())) {
      return res.status(400).json({ error: "Branch ID already exists" });
    }

    const newBranch = { id: branchId, name: branchName };
    data.branches.push(newBranch);
    await saveData(data);
    res.status(201).json(newBranch);
  } catch (err) {
    console.error("Create branch error", err);
    res.status(500).json({ error: "Failed to create branch" });
  }
});

// ---------- FULL STATE EXPORT (admin-only, temporary) ----------
app.get("/api/state-full", async (req, res) => {
  try {
    const key = process.env.ADMIN_EXPORT_KEY;
    if (!key || req.query.key !== key) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    res.setHeader("Content-Type", "application/json");
    res.send(raw);
  } catch (err) {
    console.error("State-full error", err);
    res.status(500).json({ error: "Failed to load full data" });
  }
});

// ---------- USERS (Admin create) ----------
app.post("/api/users", async (req, res) => {
  try {
    const { name, role, password, adminUserId, branchId } = req.body;
    if (!name || !role || !password) {
      return res.status(400).json({ error: "name, role, password are required" });
    }

    const data = await loadData();
    const admin = findUserById(data, adminUserId);
    if (!requireRole(admin, ["admin"])) {
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
    if (!requireRole(admin, ["admin"])) {
      return res.status(403).json({ error: "Only admin can edit users" });
    }

    const user = data.users.find((u) => u.id === id);
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
    if (!requireRole(admin, ["admin"])) {
      return res.status(403).json({ error: "Only admin can delete users" });
    }
    if (admin.id === id) {
      return res.status(400).json({ error: "Admin cannot delete their own account" });
    }

    const idx = data.users.findIndex((u) => u.id === id);
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
    let { id, name, nameEn, nameAr, branchId, minQty, baseQty, unitCost, managerUserId } = req.body;

    if (!branchId) {
      return res.status(400).json({ error: "branchId required" });
    }

    const data = await loadData();
    const user = findUserById(data, managerUserId);
    if (!requireRole(user, ["admin", "manager"])) {
      return res.status(403).json({ error: "Only manager or admin can create items" });
    }

    if (!id || !String(id).trim()) {
      id = getNextItemId(data);
    }

    const names = normalizeItemNames({ name, nameEn, nameAr });
    if (!names.name && !names.nameEn && !names.nameAr) {
      return res.status(400).json({ error: "name (or nameEn/nameAr) required" });
    }

    if (data.items.find((x) => x.id === String(id).trim() && x.branchId === branchId)) {
      return res.status(400).json({ error: "Item ID already exists in this branch" });
    }

    const newItem = {
      id: String(id).trim(),
      ...names,
      branchId: String(branchId).trim(),
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

// ---------- ITEMS UPDATE (Admin & Manager can edit items) ----------
app.patch("/api/items/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, branchId, name, nameEn, nameAr, minQty, baseQty, unitCost } = req.body;

    const data = await loadData();
    const user = findUserById(data, userId);
    if (!requireRole(user, ["admin", "manager"])) {
      return res.status(403).json({ error: "Only admin/manager can update items" });
    }

    if (!branchId) {
      return res.status(400).json({ error: "branchId is required to update item" });
    }

    const item = data.items.find(
      (it) => it.id === String(id).trim() && it.branchId === String(branchId).trim()
    );

    if (!item) {
      return res.status(404).json({ error: "Item not found for this branch" });
    }

    if (typeof name !== "undefined") item.name = String(name).trim();
    if (typeof nameEn !== "undefined") item.nameEn = String(nameEn || "").trim();
    if (typeof nameAr !== "undefined") item.nameAr = String(nameAr || "").trim();
    if (typeof minQty !== "undefined") item.minQty = Number(minQty) || 0;
    if (typeof baseQty !== "undefined") item.baseQty = Number(baseQty) || 0;
    if (typeof unitCost !== "undefined") item.unitCost = Number(unitCost) || 0;

    // keep fallback names consistent
    const names = normalizeItemNames({ name: item.name, nameEn: item.nameEn, nameAr: item.nameAr });
    item.name = names.name;
    item.nameEn = names.nameEn;
    item.nameAr = names.nameAr;

    await saveData(data);
    res.json(item);
  } catch (err) {
    console.error("Update item error", err);
    res.status(500).json({ error: "Failed to update item" });
  }
});

// ---------- MOVEMENTS (Admin & Manager only, adjust stock) ----------
app.post("/api/movements", async (req, res) => {
  try {
    const { itemId, type, qty, userId, note } = req.body;
    if (!itemId || !type || !qty || !userId) {
      return res.status(400).json({ error: "itemId, type, qty, userId are required" });
    }

    const data = await loadData();
    const user = findUserById(data, userId);
    if (!user) return res.status(400).json({ error: "User not found" });
    if (!requireRole(user, ["admin", "manager"])) {
      return res.status(403).json({ error: "Only admin/manager can record movements" });
    }

    const item = data.items.find((it) => it.id === itemId);
    if (!item) return res.status(400).json({ error: "Item not found" });

    const movement = {
      id: "MOV-" + Date.now(),
      itemId,
      type,
      qty: Number(qty),
      userId,
      branchId: item.branchId,
      note: note || "",
      createdAt: new Date().toISOString()
    };

    if (movement.type === "IN") item.baseQty += movement.qty;
    else if (movement.type === "OUT") item.baseQty = Math.max(0, item.baseQty - movement.qty);

    data.movements.push(movement);
    await saveData(data);
    res.status(201).json(movement);
  } catch (err) {
    console.error("Movement error", err);
    res.status(500).json({ error: "Failed to save movement" });
  }
});

// ---------- REQUESTS (staff/manager/admin/supervisor; Storage → user branch) ----------
app.post("/api/requests", async (req, res) => {
  try {
    const { itemId, qty, userId, note, priority, urgentNote, imageData } = req.body;
    if (!itemId || !qty || !userId) {
      return res.status(400).json({ error: "itemId, qty, userId are required" });
    }

    const data = await loadData();
    const user = findUserById(data, userId);
    if (!user) return res.status(400).json({ error: "User not found" });
    if (user.role === "driver") return res.status(403).json({ error: "Drivers cannot create requests" });
    if (!user.branchId) return res.status(400).json({ error: "User is not assigned to a branch" });

    const storageItem = data.items.find(
      (it) => it.id === itemId && it.branchId === MAIN_STORAGE_BRANCH_ID
    );
    if (!storageItem) return res.status(400).json({ error: "Item not found in Main Storage" });

    const request = {
      id: "REQ-" + Date.now(),
      itemId,
      qty: Number(qty),
      fromBranchId: MAIN_STORAGE_BRANCH_ID,
      toBranchId: user.branchId,
      createdByUserId: userId,
      note: note || "",
      priority: priority === "urgent" ? "urgent" : "normal",
      urgentNote: urgentNote || "",
      imageData: imageData || "",
      status: "pending",
      driverUserId: null,
      assignedAt: null,
      assignedByUserId: null,
      deliveryEta: null,
      deliveryEtaLabel: "",
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

// ✅ pending requests for admin/manager/driver across ALL branches
app.get("/api/requests/pending", async (req, res) => {
  try {
    const { userId } = req.query;
    const data = await loadData();
    const user = findUserById(data, userId);
    if (!mustBe(user, ["admin", "manager", "driver"], res)) return;

    const pending = (data.requests || []).filter((r) => r.status === "pending");
    res.json(pending);
  } catch (err) {
    console.error("Pending requests error", err);
    res.status(500).json({ error: "Failed to load pending requests" });
  }
});

// ---------- ASSIGN REQUEST TO DRIVER (admin/manager) ----------
app.post("/api/requests/:id/assign", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, driverUserId, deliveryEta, deliveryEtaLabel } = req.body || {};

    const data = await loadData();
    const actor = findUserById(data, userId);
    if (!mustBe(actor, ["admin", "manager"], res)) return;

    const request = (data.requests || []).find((r) => r.id === id);
    if (!request) return res.status(404).json({ error: "Request not found" });
    if (request.status === "delivered") return res.status(400).json({ error: "Request already delivered" });

    const driver = findUserById(data, driverUserId);
    if (!driver || driver.role !== "driver") {
      return res.status(400).json({ error: "driverUserId must be a valid driver" });
    }

    request.driverUserId = driverUserId;
    request.assignedAt = new Date().toISOString();
    request.assignedByUserId = actor.id;
    request.status = "assigned";

    if (typeof deliveryEta !== "undefined") request.deliveryEta = deliveryEta || null;
    if (typeof deliveryEtaLabel !== "undefined") request.deliveryEtaLabel = deliveryEtaLabel || "";

    await saveData(data);
    res.json(request);
  } catch (err) {
    console.error("Assign request error", err);
    res.status(500).json({ error: "Failed to assign request" });
  }
});

// ---------- CLAIM REQUEST (driver can take unassigned) ----------
app.post("/api/requests/:id/claim", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, deliveryEta, deliveryEtaLabel } = req.body || {};

    const data = await loadData();
    const driver = findUserById(data, userId);
    if (!mustBe(driver, ["driver"], res)) return;

    const request = (data.requests || []).find((r) => r.id === id);
    if (!request) return res.status(404).json({ error: "Request not found" });
    if (request.status === "delivered") return res.status(400).json({ error: "Request already delivered" });

    if (request.driverUserId && request.driverUserId !== driver.id) {
      return res.status(403).json({ error: "Request already assigned to another driver" });
    }

    request.driverUserId = driver.id;
    request.assignedAt = new Date().toISOString();
    request.assignedByUserId = driver.id;
    request.status = "assigned";

    if (typeof deliveryEta !== "undefined") request.deliveryEta = deliveryEta || null;
    if (typeof deliveryEtaLabel !== "undefined") request.deliveryEtaLabel = deliveryEtaLabel || "";

    await saveData(data);
    res.json(request);
  } catch (err) {
    console.error("Claim request error", err);
    res.status(500).json({ error: "Failed to claim request" });
  }
});

// ---------- UPDATE ETA (driver/admin/manager) ----------
app.post("/api/requests/:id/eta", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, deliveryEta, deliveryEtaLabel } = req.body || {};

    const data = await loadData();
    const actor = findUserById(data, userId);
    if (!mustBe(actor, ["admin", "manager", "driver"], res)) return;

    const request = (data.requests || []).find((r) => r.id === id);
    if (!request) return res.status(404).json({ error: "Request not found" });
    if (request.status === "delivered") return res.status(400).json({ error: "Request already delivered" });

    if (actor.role === "driver" && request.driverUserId && request.driverUserId !== actor.id) {
      return res.status(403).json({ error: "Drivers can only update ETA for their own request" });
    }

    if (actor.role === "driver" && !request.driverUserId) {
      request.driverUserId = actor.id;
      request.assignedAt = new Date().toISOString();
      request.assignedByUserId = actor.id;
      request.status = "assigned";
    }

    request.deliveryEta = deliveryEta || null;
    request.deliveryEtaLabel = deliveryEtaLabel || "";

    await saveData(data);
    res.json(request);
  } catch (err) {
    console.error("ETA update error", err);
    res.status(500).json({ error: "Failed to update ETA" });
  }
});

// ---------- CONFIRM RECEIVE (Staff/Admin/Manager) ----------
app.post("/api/requests/:id/deliver", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, driverUserId } = req.body;
    const actorUserId = userId || driverUserId; // backward-compatible
    if (!actorUserId) return res.status(400).json({ error: "userId required" });

    const data = await loadData();
    const actor = findUserById(data, actorUserId);
    if (!actor) return res.status(400).json({ error: "User not found" });
    if (!requireRole(actor, ["staff", "supervisor", "admin", "manager"])) {
      return res.status(403).json({ error: "Only staff/supervisor/admin/manager can confirm receipt" });
    }

    const request = data.requests.find((r) => r.id === id);
    if (!request) return res.status(404).json({ error: "Request not found" });
    if (request.status === "delivered") return res.status(400).json({ error: "Request already delivered" });
    if (["staff", "supervisor"].includes(actor.role) && actor.branchId !== request.toBranchId) {
      return res.status(403).json({ error: "Only staff from the destination branch can confirm receipt" });
    }

    const storageItem = data.items.find(
      (it) => it.id === request.itemId && it.branchId === request.fromBranchId
    );
    if (!storageItem) return res.status(400).json({ error: "Item not found in storage branch" });

    const qty = Number(request.qty);
    if (storageItem.baseQty < qty) return res.status(400).json({ error: "Not enough stock in storage to deliver" });

    const outMovement = {
      id: "MOV-" + Date.now(),
      itemId: request.itemId,
      type: "OUT",
      qty,
      userId: actorUserId,
      branchId: request.fromBranchId,
      note: `Delivery OUT for request ${request.id}`,
      createdAt: new Date().toISOString()
    };
    storageItem.baseQty -= qty;

    let destItem = data.items.find(
      (it) => it.id === request.itemId && it.branchId === request.toBranchId
    );
    if (!destItem) {
      destItem = {
        id: storageItem.id,
        name: storageItem.name,
        nameEn: storageItem.nameEn || storageItem.name,
        nameAr: storageItem.nameAr || "",
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
      userId: actorUserId,
      branchId: request.toBranchId,
      note: `Delivery IN for request ${request.id}`,
      createdAt: new Date().toISOString()
    };

    data.movements.push(outMovement, inMovement);
    request.status = "delivered";
    request.receivedByUserId = actorUserId;
    request.deliveredAt = new Date().toISOString();

    await saveData(data);
    res.status(201).json({ request, movements: [outMovement, inMovement] });
  } catch (err) {
    console.error("Deliver error", err);
    res.status(500).json({ error: "Failed to deliver request" });
  }
});

// Delete pending request (admin/manager)
app.delete("/api/requests/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body || {};

    const data = await loadData();
    const user = findUserById(data, userId);
    if (!requireRole(user, ["admin", "manager"])) {
      return res.status(403).json({ error: "Only admin/manager can delete requests" });
    }

    const idx = (data.requests || []).findIndex((r) => r.id === id);
    if (idx === -1) return res.status(404).json({ error: "Request not found" });

    if (data.requests[idx].status !== "pending") {
      return res.status(400).json({ error: "Only pending requests can be deleted" });
    }

    data.requests.splice(idx, 1);
    await saveData(data);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete request error", err);
    res.status(500).json({ error: "Failed to delete request" });
  }
});

// ---------- BUDGET ----------
app.post("/api/budgets", async (req, res) => {
  try {
    const { branchId, month, planned, adminUserId } = req.body;
    if (!branchId || !month) return res.status(400).json({ error: "branchId and month are required" });

    const data = await loadData();
    const admin = findUserById(data, adminUserId);
    if (!requireRole(admin, ["admin"])) return res.status(403).json({ error: "Only admin can set budgets" });

    let budget = data.budgets.find((b) => b.branchId === branchId && b.month === month);
    if (!budget) {
      budget = { id: `BUD-${month}-${branchId}`, branchId, month, planned: Number(planned) || 0 };
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

/* =========================
   VEHICLES + REMINDERS
========================= */

// Vehicles list (read)
app.get("/api/vehicles", async (req, res) => {
  try {
    const data = await loadData();
    res.json(data.vehicles || []);
  } catch {
    res.status(500).json({ error: "Failed to load vehicles" });
  }
});

// Create vehicle (admin/manager)
app.post("/api/vehicles", async (req, res) => {
  try {
    const { userId, name, plate } = req.body;
    const data = await loadData();
    const user = findUserById(data, userId);
    if (!requireRole(user, ["admin", "manager"])) {
      return res.status(403).json({ error: "Only admin/manager can create vehicles" });
    }
    if (!name) return res.status(400).json({ error: "name required" });

    const vehicle = {
      id: "CAR-" + Date.now(),
      name: String(name).trim(),
      plate: String(plate || "").trim()
    };
    data.vehicles.push(vehicle);
    await saveData(data);
    res.status(201).json(vehicle);
  } catch {
    res.status(500).json({ error: "Failed to create vehicle" });
  }
});

// Update vehicle (admin/manager)
app.patch("/api/vehicles/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, name, plate } = req.body || {};
    const data = await loadData();
    const user = findUserById(data, userId);
    if (!requireRole(user, ["admin", "manager"])) {
      return res.status(403).json({ error: "Only admin/manager can update vehicles" });
    }

    const vehicle = (data.vehicles || []).find((v) => v.id === id);
    if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });

    if (typeof name !== "undefined") {
      const trimmed = String(name || "").trim();
      if (!trimmed) return res.status(400).json({ error: "Vehicle name required" });
      vehicle.name = trimmed;
    }
    if (typeof plate !== "undefined") {
      vehicle.plate = String(plate || "").trim();
    }

    await saveData(data);
    res.json(vehicle);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update vehicle" });
  }
});

// Delete vehicle (admin/manager)
app.delete("/api/vehicles/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body || {};
    const data = await loadData();
    const user = findUserById(data, userId);
    if (!requireRole(user, ["admin", "manager"])) {
      return res.status(403).json({ error: "Only admin/manager can delete vehicles" });
    }

    const vehicles = data.vehicles || [];
    const idx = vehicles.findIndex((v) => v.id === id);
    if (idx === -1) return res.status(404).json({ error: "Vehicle not found" });

    const vehicleId = vehicles[idx].id;
    vehicles.splice(idx, 1);

    data.carAssignments = (data.carAssignments || []).filter((a) => a.vehicleId !== vehicleId);
    data.vehicleReminders = (data.vehicleReminders || []).filter((r) => r.vehicleId !== vehicleId);
    data.carMaintenances = (data.carMaintenances || []).filter((m) => m.vehicleId !== vehicleId);

    await saveData(data);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete vehicle" });
  }
});

// Reminders list (read)
app.get("/api/vehicle-reminders", async (req, res) => {
  try {
    const data = await loadData();
    res.json(data.vehicleReminders || []);
  } catch {
    res.status(500).json({ error: "Failed to load reminders" });
  }
});

// Create reminder (admin/manager)
app.post("/api/vehicle-reminders", async (req, res) => {
  try {
    const { userId, vehicleId, type, dueDate, dueOdometer, note } = req.body;
    const data = await loadData();
    const user = findUserById(data, userId);
    if (!requireRole(user, ["admin", "manager"])) {
      return res.status(403).json({ error: "Only admin/manager can create reminders" });
    }
    if (!vehicleId || !type) return res.status(400).json({ error: "vehicleId and type required" });

    const r = {
      id: "REM-" + Date.now(),
      vehicleId,
      type,
      dueDate: dueDate || null,
      dueOdometer: typeof dueOdometer === "undefined" ? null : Number(dueOdometer),
      note: note || "",
      status: "open",
      createdAt: new Date().toISOString(),
      doneAt: null
    };

    data.vehicleReminders.push(r);
    await saveData(data);
    res.status(201).json(r);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create reminder" });
  }
});

// Update reminder
app.patch("/api/vehicle-reminders/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, status, dueDate, dueOdometer, note, type, vehicleId } = req.body;

    const data = await loadData();
    const user = findUserById(data, userId);
    if (!requireRole(user, ["admin", "manager", "driver"])) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const r = data.vehicleReminders.find((x) => x.id === id);
    if (!r) return res.status(404).json({ error: "Reminder not found" });

    const isEditor = requireRole(user, ["admin", "manager"]);
    if (!isEditor) {
      if (typeof status === "undefined") {
        return res.status(403).json({ error: "Drivers can only change status" });
      }
    }

    if (isEditor) {
      if (typeof vehicleId !== "undefined") r.vehicleId = vehicleId;
      if (typeof type !== "undefined") r.type = type;
      if (typeof dueDate !== "undefined") r.dueDate = dueDate || null;
      if (typeof dueOdometer !== "undefined") r.dueOdometer = dueOdometer === null ? null : Number(dueOdometer);
      if (typeof note !== "undefined") r.note = note || "";
    }

    if (typeof status !== "undefined") {
      r.status = status === "done" ? "done" : "open";
      r.doneAt = r.status === "done" ? new Date().toISOString() : null;
    }

    await saveData(data);
    res.json(r);
  } catch {
    res.status(500).json({ error: "Failed to update reminder" });
  }
});

// Delete reminder
app.delete("/api/vehicle-reminders/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

    const data = await loadData();
    const user = findUserById(data, userId);
    if (!requireRole(user, ["admin", "manager"])) {
      return res.status(403).json({ error: "Only admin/manager can delete reminders" });
    }

    const idx = data.vehicleReminders.findIndex((x) => x.id === id);
    if (idx === -1) return res.status(404).json({ error: "Reminder not found" });

    data.vehicleReminders.splice(idx, 1);
    await saveData(data);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to delete reminder" });
  }
});

/* =========================
   ✅ CAR HANDOVER (ASSIGNMENTS)
========================= */

// List assignments
app.get("/api/car-assignments", async (req, res) => {
  try {
    const { userId } = req.query;
    const data = await loadData();
    const user = findUserById(data, userId);
    if (!mustBe(user, ["admin", "manager", "driver"], res)) return;

    if (user.role === "driver") {
      return res.json((data.carAssignments || []).filter(a => a.driverUserId === user.id));
    }
    res.json(data.carAssignments || []);
  } catch (e) {
    res.status(500).json({ error: "Failed to load car assignments" });
  }
});

// Create/replace assignment (admin/manager)
app.post("/api/car-assignments", async (req, res) => {
  try {
    const { userId, vehicleId, driverUserId, note } = req.body;
    const data = await loadData();
    const actor = findUserById(data, userId);
    if (!mustBe(actor, ["admin", "manager", "driver"], res)) return;

    const driver = findUserById(data, driverUserId);
    if (!driver || driver.role !== "driver") {
      return res.status(400).json({ error: "driverUserId must be a valid driver" });
    }

    if (actor.role === "driver" && driverUserId === actor.id) {
      return res.status(400).json({ error: "Drivers must select another driver" });
    }

    const vehicle = (data.vehicles || []).find(v => v.id === vehicleId);
    if (!vehicle) return res.status(400).json({ error: "vehicleId not found" });

    const assignments = data.carAssignments || [];
    const currentAssignment = assignments.find(a => a.vehicleId === vehicleId);
    if (actor.role === "driver") {
      if (!currentAssignment || currentAssignment.driverUserId !== actor.id) {
        return res.status(403).json({ error: "Drivers can only hand over vehicles assigned to them" });
      }
    }

    data.carAssignments = assignments.filter(a => a.vehicleId !== vehicleId);
    data.carAssignments = data.carAssignments.filter(a => a.driverUserId !== driverUserId);

    const assignment = {
      id: genId("ASSIGN"),
      vehicleId,
      driverUserId,
      assignedByUserId: actor.id,
      note: note || "",
      assignedAt: new Date().toISOString()
    };

    data.carAssignments.push(assignment);
    await saveData(data);
    res.status(201).json(assignment);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create assignment" });
  }
});

/* =========================
   ✅ MAINTENANCE RECORDS
========================= */

app.get("/api/car-maintenances", async (req, res) => {
  try {
    const { userId } = req.query;
    const data = await loadData();
    const user = findUserById(data, userId);
    if (!mustBe(user, ["admin", "manager", "driver"], res)) return;

    if (user.role === "driver") {
      return res.json((data.carMaintenances || []).filter(m => m.driverUserId === user.id));
    }
    res.json(data.carMaintenances || []);
  } catch {
    res.status(500).json({ error: "Failed to load maintenances" });
  }
});

app.post("/api/car-maintenances", async (req, res) => {
  try {
    const {
      userId,
      vehicleId,
      maintenanceDate,
      nextMaintenanceDate,
      price,
      invoiceNo,
      place,
      storeName,
      note
    } = req.body;

    const data = await loadData();
    const user = findUserById(data, userId);
    if (!mustBe(user, ["driver", "admin", "manager"], res)) return;

    if (!vehicleId || !maintenanceDate || typeof price === "undefined" || !invoiceNo) {
      return res.status(400).json({
        error: "vehicleId, maintenanceDate, price, invoiceNo are required"
      });
    }

    if (user.role === "driver") {
      const assign = (data.carAssignments || []).find(a => a.driverUserId === user.id && a.vehicleId === vehicleId);
      if (!assign) return res.status(403).json({ error: "You are not assigned to this vehicle" });
    }

    const vehicle = (data.vehicles || []).find(v => v.id === vehicleId);
    if (!vehicle) return res.status(400).json({ error: "vehicleId not found" });

    const rec = {
      id: genId("MAINT"),
      vehicleId,
      driverUserId: user.role === "driver" ? user.id : (req.body.driverUserId || user.id),
      maintenanceDate,
      nextMaintenanceDate: nextMaintenanceDate || null,
      price: Number(price) || 0,
      invoiceNo: String(invoiceNo).trim(),
      place: place ? String(place).trim() : "",
      storeName: storeName ? String(storeName).trim() : "",
      note: note ? String(note) : "",
      createdAt: new Date().toISOString()
    };

    data.carMaintenances.push(rec);
    await saveData(data);
    res.status(201).json(rec);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to save maintenance" });
  }
});

// Maintenance budget summary (admin/manager)
app.get("/api/maintenance-summary", async (req, res) => {
  try {
    const { userId, from, to, vehicleId } = req.query;
    const data = await loadData();
    const user = findUserById(data, userId);
    if (!mustBe(user, ["admin", "manager"], res)) return;

    const fromD = from ? new Date(from + "T00:00:00") : null;
    const toD = to ? new Date(to + "T23:59:59") : null;

    const list = (data.carMaintenances || []).filter(m => {
      if (vehicleId && m.vehicleId !== vehicleId) return false;
      const d = new Date((m.maintenanceDate || "") + "T00:00:00");
      if (fromD && d < fromD) return false;
      if (toD && d > toD) return false;
      return true;
    });

    const total = list.reduce((s, m) => s + Number(m.price || 0), 0);

    const byCar = {};
    for (const m of list) {
      byCar[m.vehicleId] = (byCar[m.vehicleId] || 0) + Number(m.price || 0);
    }

    res.json({
      total: Number(total.toFixed(3)),
      count: list.length,
      byCar
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to compute maintenance summary" });
  }
});

// ---------- FRONTEND FALLBACK ----------
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`Storage backend running on http://localhost:${PORT}`);
  console.log(`Main Storage Branch ID = ${MAIN_STORAGE_BRANCH_ID}`);
  console.log(`DATA_FILE = ${DATA_FILE}`);
});
