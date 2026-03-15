cat > index.js << 'ENDOFFILE'
const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || "SebaGhor";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const SESSIONS_DIR = path.join(__dirname, "sessions");

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const app = express();
app.use(express.json());
const logger = pino({ level: "warn" });
const sessions = new Map();

function auth(req, res, next) {
  if (req.path === "/health") return next();
  const key = req.headers["apikey"] || req.headers["authorization"]?.replace("Bearer ", "");
  if (key !== API_KEY) return res.status(401).json({ error: "Invalid API key" });
  next();
}
app.use(auth);

async function sendWebhook(event, instance, data) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, instance, data }),
    });
  } catch (e) { console.error("Webhook failed:", e.message); }
}

async function createSession(instanceName) {
  if (sessions.has(instanceName)) {
    const s = sessions.get(instanceName);
    if (s.socket) { try { s.socket.end(); } catch {} }
  }
  const sessionDir = path.join(SESSIONS_DIR, instanceName);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const socket = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    printQRInTerminal: false,
    browser: ["Whabot", "Chrome", "1.0.0"],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  const session = { socket, qrCode: "", status: "connecting", profileName: "", phoneNumber: "", retryCount: 0 };
  sessions.set(instanceName, session);

  socket.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      const base64 = await QRCode.toDataURL(qr);
      session.qrCode = base64;
      session.status = "scanning";
      console.log("[" + instanceName + "] QR generated");
      sendWebhook("QRCODE_UPDATED", instanceName, { qrcode: { base64 } });
    }
    if (connection === "open") {
      session.status = "connected";
      session.qrCode = "";
      session.retryCount = 0;
      const me = socket.user;
      session.phoneNumber = me?.id?.split(":")[0] || me?.id?.split("@")[0] || "";
      session.profileName = me?.name || "";
      console.log("[" + instanceName + "] Connected as " + session.phoneNumber);
      sendWebhook("CONNECTION_UPDATE", instanceName, { state: "open", pushName: session.profileName, ownerJid: me?.id || "" });
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log("[" + instanceName + "] Disconnected code:" + code);
      if (code === DisconnectReason.loggedOut) {
        session.status = "disconnected"; session.qrCode = "";
        if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
        sendWebhook("CONNECTION_UPDATE", instanceName, { state: "close" });
      } else if (shouldReconnect && session.retryCount < 5) {
        session.retryCount++; session.status = "connecting";
        sendWebhook("CONNECTION_UPDATE", instanceName, { state: "connecting" });
        setTimeout(() => createSession(instanceName), 3000);
      } else {
        session.status = "disconnected";
        sendWebhook("CONNECTION_UPDATE", instanceName, { state: "close" });
      }
    }
  });

  socket.ev.on("creds.update", saveCreds);

  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.remoteJid === "status@broadcast") continue;
      console.log("[" + instanceName + "] Msg " + (msg.key.fromMe ? "out" : "in") + ": " + msg.key.remoteJid);
      sendWebhook("MESSAGES_UPSERT", instanceName, { key: msg.key, message: msg.message, messageTimestamp: msg.messageTimestamp, pushName: msg.pushName, status: msg.status });
    }
  });

  socket.ev.on("messages.update", (updates) => { sendWebhook("MESSAGES_UPDATE", instanceName, updates); });

  return session;
}

app.post("/instance/create", async (req, res) => {
  try {
    const { instanceName } = req.body;
    if (!instanceName) return res.status(400).json({ error: "instanceName required" });
    const session = await createSession(instanceName);
    await new Promise((r) => setTimeout(r, 2000));
    res.json({ instance: { instanceName, status: session.status }, qrcode: session.qrCode ? { base64: session.qrCode } : undefined });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/instance/connect/:instanceName", async (req, res) => {
  try {
    const { instanceName } = req.params;
    let session = sessions.get(instanceName);
    if (!session) { session = await createSession(instanceName); await new Promise((r) => setTimeout(r, 3000)); }
    if (session.status === "connected") return res.json({ instance: { state: "open" } });
    res.json({ base64: session.qrCode || "", code: "" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/instance/connectionState/:instanceName", (req, res) => {
  const session = sessions.get(req.params.instanceName);
  if (!session) return res.json({ instance: { state: "close" } });
  const m = { connected: "open", scanning: "connecting", connecting: "connecting", disconnected: "close" };
  res.json({ instance: { state: m[session.status] || "close" } });
});

app.get("/instance/fetchInstances", (req, res) => {
  const { instanceName } = req.query;
  if (instanceName) {
    const s = sessions.get(instanceName);
    if (!s) return res.json([]);
    return res.json([{ instance: { instanceName, status: s.status === "connected" ? "open" : "close", owner: s.phoneNumber, profileName: s.profileName } }]);
  }
  const list = [];
  for (const [name, s] of sessions) list.push({ instance: { instanceName: name, status: s.status === "connected" ? "open" : "close", owner: s.phoneNumber, profileName: s.profileName } });
  res.json(list);
});

app.post("/message/sendText/:instanceName", async (req, res) => {
  try {
    const session = sessions.get(req.params.instanceName);
    if (!session?.socket) return res.status(404).json({ error: "Session not found" });
    if (session.status !== "connected") return res.status(400).json({ error: "Not connected" });
    const { number, text } = req.body;
    if (!number || !text) return res.status(400).json({ error: "number and text required" });
    const jid = number.includes("@") ? number : (number.replace(/[^0-9]/g, "") + "@s.whatsapp.net");
    const result = await session.socket.sendMessage(jid, { text });
    res.json({ key: result.key, status: "PENDING", message: { conversation: text } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/message/sendMedia/:instanceName", async (req, res) => {
  try {
    const session = sessions.get(req.params.instanceName);
    if (!session?.socket) return res.status(404).json({ error: "Session not found" });
    if (session.status !== "connected") return res.status(400).json({ error: "Not connected" });
    const { number, media, mediatype, caption } = req.body;
    const jid = number.includes("@") ? number : (number.replace(/[^0-9]/g, "") + "@s.whatsapp.net");
    let content = {};
    if (mediatype === "image") content = { image: { url: media }, caption: caption || "" };
    else if (mediatype === "video") content = { video: { url: media }, caption: caption || "" };
    else if (mediatype === "audio") content = { audio: { url: media }, mimetype: "audio/mp4" };
    else if (mediatype === "document") content = { document: { url: media }, caption: caption || "", fileName: caption || "file" };
    else content = { image: { url: media }, caption: caption || "" };
    const result = await session.socket.sendMessage(jid, content);
    res.json({ key: result.key, status: "PENDING" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/instance/logout/:instanceName", async (req, res) => {
  try {
    const session = sessions.get(req.params.instanceName);
    if (!session?.socket) return res.json({ status: "SUCCESS" });
    await session.socket.logout();
    session.status = "disconnected"; session.qrCode = "";
    const dir = path.join(SESSIONS_DIR, req.params.instanceName);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    sessions.delete(req.params.instanceName);
    res.json({ status: "SUCCESS" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/instance/delete/:instanceName", async (req, res) => {
  try {
    const session = sessions.get(req.params.instanceName);
    if (session?.socket) { try { session.socket.end(); } catch {} }
    const dir = path.join(SESSIONS_DIR, req.params.instanceName);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    sessions.delete(req.params.instanceName);
    res.json({ status: "SUCCESS" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/chat/findContacts/:instanceName", (req, res) => { res.json([]); });
app.post("/webhook/set/:instanceName", (req, res) => { res.json({ webhook: { enabled: true, url: WEBHOOK_URL } }); });
app.get("/health", (_, res) => res.json({ status: "ok", sessions: sessions.size }));

app.listen(PORT, "0.0.0.0", () => {
  console.log("Whabot Baileys Server running on port " + PORT);
  console.log("Webhook: " + (WEBHOOK_URL || "(not set)"));
  if (fs.existsSync(SESSIONS_DIR)) {
    const dirs = fs.readdirSync(SESSIONS_DIR).filter((d) => fs.statSync(path.join(SESSIONS_DIR, d)).isDirectory());
    for (const dir of dirs) { console.log("Restoring: " + dir); createSession(dir).catch((e) => console.error("Restore fail:", e.message)); }
  }
});
ENDOFFILE
