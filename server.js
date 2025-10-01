const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const storage = require("node-persist");
const cors = require("cors");

// Simple word lists for more memorable IDs
const ADJECTIVES = ["alpha", "beta", "gamma", "delta", "zeta", "nova", "comet", "solar", "lunar", "star"];
const NOUNS = ["fox", "wolf", "hawk", "lion", "tiger", "bear", "crane", "iris", "rose", "maple"];

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});
// --- START: Syrja ID Directory Service (v2) ---

app.use(express.json()); // Middleware to parse JSON bodies
app.use(cors());       // CORS Middleware

// Initialize node-persist storage
(async () => {
    await storage.init({ dir: 'syrja_id_store' });
    console.log("✅ Syrja ID storage initialized.");
})();

// Endpoint to claim a new Syrja ID
app.post("/claim-id", async (req, res) => {
    const { customId, fullInviteCode, persistence, pubKey } = req.body;

    if (!customId || !fullInviteCode || !persistence || !pubKey) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    // NEW RULE: Check if this public key already owns a DIFFERENT ID
    const allKeys = await storage.keys();
    for (const key of allKeys) {
        const item = await storage.getItem(key);
        if (item && item.pubKey === pubKey && key !== customId) {
            return res.status(409).json({ error: "You already own a different ID. Please delete it before claiming a new one." });
        }
    }

    // OLD RULE: Check if the requested ID is taken by someone else
    const existingItem = await storage.getItem(customId);
    if (existingItem && existingItem.pubKey !== pubKey) {
        return res.status(409).json({ error: "ID already taken" });
    }

    // If all checks pass, proceed to store/update the ID
    const value = {
        code: fullInviteCode,
        pubKey: pubKey,
        permanent: persistence === 'permanent'
    };
    
    const ttl = (persistence === 'temporary') ? 24 * 60 * 60 * 1000 : false;
    await storage.setItem(customId, value, { ttl });

    console.log(`✅ ID Claimed/Updated: ${customId} (Permanent: ${value.permanent})`);
    res.json({ success: true, id: customId });
});

// Endpoint to get an invite code from a Syrja ID (for adding contacts)
app.get("/get-invite/:id", async (req, res) => {
    // The full ID including "syrja/" is passed in the URL
    const fullId = `syrja/${req.params.id}`; 
    const item = await storage.getItem(fullId);
    if (item && item.code) {
        console.log(`➡️ Resolved Syrja ID: ${fullId}`);
        res.json({ fullInviteCode: item.code });
    } else {
        console.log(`❓ Failed to resolve Syrja ID: ${fullId}`);
        res.status(404).json({ error: "ID not found or has expired" });
    }
});

// Endpoint to find a user's current ID by their public key
app.get("/get-id-by-pubkey/:pubkey", async (req, res) => {
    const pubkey = req.params.pubkey;
    const allKeys = await storage.keys();

    for (const key of allKeys) {
        const item = await storage.getItem(key);
        if (item && item.pubKey === pubkey) {
            // Found a match!
            console.log(`🔎 Found ID for pubkey ${pubkey.slice(0,12)}... -> ${key}`);
            return res.json({ id: key, permanent: item.permanent });
        }
    }

    // If the loop finishes without finding a match
    console.log(`🔎 No ID found for pubkey ${pubkey.slice(0,12)}...`);
    res.status(404).json({ error: "No ID found for this public key" });
});

// Endpoint to delete an ID, authenticated by public key
app.post("/delete-id", async (req, res) => {
    const { pubKey } = req.body;
    if (!pubKey) return res.status(400).json({ error: "Public key is required" });

    const allItems = await storage.data();
    const keyToDelete = allItems.find(item => item.value.pubKey === pubKey)?.key;

    if (keyToDelete) {
        await storage.removeItem(keyToDelete);
        console.log(`🗑️ Deleted Syrja ID for pubKey: ${pubKey.slice(0,12)}...`);
        res.json({ success: true });
    } else {
        // It's not an error if they didn't have an ID to begin with
        res.json({ success: true, message: "No ID found to delete" });
    }
});
// --- END: Syrja ID Directory Service (v2) ---
// --- START: Simple Rate Limiting ---
const rateLimit = new Map();
const LIMIT = 20; // Max 20 requests
const TIME_FRAME = 60 * 1000; // per 60 seconds (1 minute)

function isRateLimited(socket) {
  const ip = socket.handshake.address;
  const now = Date.now();
  const record = rateLimit.get(ip);

  if (!record) {
    rateLimit.set(ip, { count: 1, startTime: now });
    return false;
  }

  // If time window has passed, reset
  if (now - record.startTime > TIME_FRAME) {
    rateLimit.set(ip, { count: 1, startTime: now });
    return false;
  }

  // If count exceeds limit, block the request
  if (record.count >= LIMIT) {
    return true;
  }

  // Otherwise, increment count and allow
  record.count++;
  return false;
}
// --- END: Simple Rate Limiting ---

// just to confirm server is alive
app.get("/", (req, res) => {
  res.send("✅ Signaling server is running");
});

// Map a user's permanent pubKey to their temporary socket.id
const userSockets = {};

// Helper to normalize keys
function normKey(k){ return (typeof k === 'string') ? k.replace(/\s+/g,'') : k; }

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // Handle client registration
  socket.on("register", (pubKey) => {
    if (isRateLimited(socket)) {
      console.log(`⚠️ Rate limit exceeded for registration by ${socket.handshake.address}`);
      return;
    }
    if (!pubKey) return;
    const key = normKey(pubKey);
    userSockets[key] = socket.id;
    socket.data.pubKey = key; // Store key on socket for later cleanup
    console.log(`🔑 Registered: ${key.slice(0,12)}... -> ${socket.id}`);
  });

  // Handle direct connection requests
  socket.on("request-connection", ({ to, from }) => {
    if (isRateLimited(socket)) {
      console.log(`⚠️ Rate limit exceeded for request-connection by ${socket.handshake.address}`);
      return;
    }
    const targetId = userSockets[normKey(to)];
    if (targetId) {
      io.to(targetId).emit("incoming-request", { from: normKey(from) });
      console.log(`📨 Connection request: ${from.slice(0, 12)}... → ${to.slice(0, 12)}...`);
    } else {
      console.log(`⚠️ Could not deliver request to ${to.slice(0,12)} (not registered/online)`);
    }
  });

  // Handle connection acceptance
  socket.on("accept-connection", ({ to, from }) => {
    const targetId = userSockets[normKey(to)];
    if (targetId) {
      io.to(targetId).emit("connection-accepted", { from: normKey(from) });
      console.log(`✅ Connection accepted: ${from.slice(0, 12)}... → ${to.slice(0, 12)}...`);
    } else {
      console.log(`⚠️ Could not deliver acceptance to ${to.slice(0,12)} (not registered/online)`);
    }
  });

  // server.js - New Code
// -- Video/Voice Call Signaling --
socket.on("call-request", ({ to, from, callType }) => {
    const targetId = userSockets[normKey(to)];
    if (targetId) {
        io.to(targetId).emit("incoming-call", { from: normKey(from), callType });
        console.log(`📞 Call request (${callType}): ${from.slice(0,12)}... → ${to.slice(0,12)}...`);
    }
});

socket.on("call-accepted", ({ to, from }) => {
    const targetId = userSockets[normKey(to)];
    if (targetId) {
        io.to(targetId).emit("call-accepted", { from: normKey(from) });
        console.log(`✔️ Call accepted: ${from.slice(0,12)}... → ${to.slice(0,12)}...`);
    }
});

socket.on("call-rejected", ({ to, from }) => {
    const targetId = userSockets[normKey(to)];
    if (targetId) {
        io.to(targetId).emit("call-rejected", { from: normKey(from) });
        console.log(`❌ Call rejected: ${from.slice(0,12)}... → ${to.slice(0,12)}...`);
    }
});

socket.on("call-ended", ({ to, from }) => {
    const targetId = userSockets[normKey(to)];
    if (targetId) {
        io.to(targetId).emit("call-ended", { from: normKey(from) });
        console.log(`👋 Call ended: ${from.slice(0,12)}... & ${to.slice(0,12)}...`);
    }
});
// ---------------------------------


  // Room and signaling logic remains the same
  socket.on("join", (room) => {
    socket.join(room);
    console.log(`Client ${socket.id} joined ${room}`);
  });

  socket.on("signal", ({ room, payload }) => {
    socket.to(room).emit("signal", payload);
  });

  socket.on("auth", ({ room, payload }) => {
    socket.to(room).emit("auth", payload);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    // Clean up the user mapping on disconnect
    if (socket.data.pubKey) {
      delete userSockets[socket.data.pubKey];
      console.log(`🗑️ Unregistered: ${socket.data.pubKey.slice(0, 12)}...`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
