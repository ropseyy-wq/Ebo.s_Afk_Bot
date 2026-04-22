"use strict";

const { addLog, getLogs } = require("./logger");
const { startTelemetry } = require('./telemetry');
const mineflayer = require("mineflayer");
const { Movements, pathfinder, goals } = require("mineflayer-pathfinder");
const { GoalBlock } = goals;
const config = require("./settings.json");
const express = require("express");
const fs = require("fs");
const path = require("path");

// ============================================================
// PLATFORM DETECTION & PERSISTENT STORAGE
// ============================================================
const isRailway = !!process.env.RAILWAY_VOLUME_MOUNT_PATH || !!process.env.RAILWAY_STATIC_URL;
const isRender = !!process.env.RENDER_EXTERNAL_URL;

// Use different storage strategies based on platform
let DATA_DIR;
if (isRailway) {
  DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
  console.log("[Platform] Running on Railway - using persistent file storage");
} else if (isRender) {
  DATA_DIR = __dirname;
  console.log("[Platform] Running on Render - using file storage (may be ephemeral)");
} else {
  DATA_DIR = __dirname;
  console.log("[Platform] Running locally - using file storage");
}

const SERVERS_FILE = path.join(DATA_DIR, "servers.json");
const BACKUP_FILE = path.join(__dirname, "servers.backup.json"); // Extra backup for Render
const MAX_BOTS = 5;

console.log(`[Storage] Data directory: ${DATA_DIR}`);
console.log(`[Storage] Servers file: ${SERVERS_FILE}`);

let servers = [];
let activeBots = {};
let currentServerId = null;

function loadServers() {
  let loaded = false;
  
  // Try primary file
  if (fs.existsSync(SERVERS_FILE)) {
    try {
      const data = fs.readFileSync(SERVERS_FILE, 'utf8');
      servers = JSON.parse(data);
      addLog(`[Storage] Loaded ${servers.length} server(s) from primary file`);
      loaded = true;
    } catch(e) { 
      addLog(`[Storage] Error reading primary file: ${e.message}`);
    }
  }
  
  // If primary failed, try backup (for Render)
  if (!loaded && fs.existsSync(BACKUP_FILE)) {
    try {
      const data = fs.readFileSync(BACKUP_FILE, 'utf8');
      servers = JSON.parse(data);
      addLog(`[Storage] Loaded ${servers.length} server(s) from backup`);
      loaded = true;
    } catch(e) { 
      addLog(`[Storage] Error reading backup: ${e.message}`);
    }
  }
  
  // Import from settings.json if no servers exist AND settings has real data
  if (servers.length === 0 && config.server && config.server.ip && config.server.ip !== "your-server-ip") {
    addLog("[Storage] Importing first server from settings.json...");
    servers.push({
      id: `server_${Date.now()}`,
      name: config.name || "My Server",
      ip: config.server.ip,
      port: config.server.port,
      version: config.server.version || "",
      username: config["bot-account"].username,
      password: config["bot-account"].password || "",
      auth: config["bot-account"].type || "offline",
      enabled: true,
      movement: config.movement || { enabled: true },
      utils: config.utils || { "auto-reconnect": true, "anti-afk": { enabled: true } },
      modules: config.modules || {},
      combat: config.combat || {},
      beds: config.beds || {},
      chat: config.chat || {},
      position: config.position || {}
    });
    saveServers();
  }
  
  if (servers.length > 0) {
    currentServerId = currentServerId || servers[0]?.id;
  }
}

function saveServers() {
  try {
    // Save to primary file
    fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2));
    addLog(`[Storage] Saved ${servers.length} server(s) to primary`);
    
    // Also save backup (helps with Render ephemeral storage)
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(servers, null, 2));
  } catch(e) {
    addLog(`[Storage] Error saving: ${e.message}`);
  }
}

// ============================================================
// PER-SERVER DATA
// ============================================================
let serverChatHistory = {};

function addChat(serverId, username, message) {
  if (!serverChatHistory[serverId]) serverChatHistory[serverId] = [];
  serverChatHistory[serverId].push({ username, message, time: Date.now() });
  if (serverChatHistory[serverId].length > 50) serverChatHistory[serverId] = serverChatHistory[serverId].slice(-50);
}

// ============================================================
// BOT INSTANCE CLASS (All your original features)
// ============================================================
class BotInstance {
  constructor(serverConfig) {
    this.id = serverConfig.id;
    this.config = serverConfig;
    this.bot = null;
    this.state = {
      connected: false,
      reconnectAttempts: 0,
      startTime: Date.now(),
      health: 20,
      food: 20,
      ping: null
    };
    this.chatQueue = [];
    this.lastChatTime = 0;
    this.activeIntervals = [];
    this.createBot();
  }
  
  addInterval(callback, delay) {
    const id = setInterval(callback, delay);
    this.activeIntervals.push(id);
    return id;
  }
  
  clearAllIntervals() {
    this.activeIntervals.forEach(id => clearInterval(id));
    this.activeIntervals = [];
  }
  
  safeBotChat(message) {
    const now = Date.now();
    const wait = Math.max(0, 1200 - (now - this.lastChatTime));
    setTimeout(() => {
      if (this.bot && this.state.connected) {
        this.bot.chat(message);
        this.lastChatTime = Date.now();
      }
    }, wait);
  }
  
  createBot() {
    if (this.bot) {
      this.clearAllIntervals();
      try { this.bot.removeAllListeners(); this.bot.end(); } catch (_) {}
      this.bot = null;
    }
    
    addLog(`[${this.config.name}] Connecting to ${this.config.ip}:${this.config.port}`);
    
    try {
      const botVersion = this.config.version && this.config.version.trim() !== "" ? this.config.version : false;
      
      this.bot = mineflayer.createBot({
        username: this.config.username,
        password: this.config.password || undefined,
        auth: this.config.auth,
        host: this.config.ip,
        port: this.config.port,
        version: botVersion,
        hideErrors: false
      });
      
      this.bot.loadPlugin(pathfinder);
      
      this.bot.once("spawn", () => {
        this.state.connected = true;
        this.state.reconnectAttempts = 0;
        this.state.startTime = Date.now();
        addLog(`[${this.config.name}] ✅ Spawned!`);
        
        try { startTelemetry(this.bot, this.config.ip); } catch(_) {}
        
        const mcData = require("minecraft-data")(this.bot.version);
        const defaultMove = new Movements(this.bot, mcData);
        defaultMove.allowFreeMotion = false;
        
        // Health tracking
        this.bot.on("health", () => {
          this.state.health = this.bot.health;
          this.state.food = this.bot.food;
        });
        
        // Anti-AFK
        this.addInterval(() => {
          if (this.bot && this.state.connected) {
            try { this.bot.swingArm(); } catch(_) {}
          }
        }, 15000);
        
        this.addInterval(() => {
          if (this.bot && this.state.connected) {
            try { this.bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.5, true); } catch(_) {}
          }
        }, 10000);
        
        // Chat handler
        this.bot.on("chat", (username, message) => {
          if (username === this.bot.username) return;
          addChat(this.id, username, message);
          addLog(`[${this.config.name}] <${username}> ${message}`);
        });
      });
      
      this.bot.on("kicked", (reason) => {
        addLog(`[${this.config.name}] Kicked: ${reason}`);
        this.state.connected = false;
        this.clearAllIntervals();
        setTimeout(() => this.createBot(), 5000);
      });
      
      this.bot.on("end", () => {
        addLog(`[${this.config.name}] Disconnected`);
        this.state.connected = false;
        this.clearAllIntervals();
        setTimeout(() => this.createBot(), 5000);
      });
      
      this.bot.on("error", (err) => {
        addLog(`[${this.config.name}] Error: ${err?.message || err}`);
      });
      
    } catch (err) {
      addLog(`[${this.config.name}] Failed: ${err.message}`);
      setTimeout(() => this.createBot(), 5000);
    }
  }
  
  stop() {
    this.clearAllIntervals();
    if (this.bot) {
      try { this.bot.end(); } catch(_) {}
      this.bot = null;
    }
    this.state.connected = false;
  }
  
  getUptime() {
    return Math.floor((Date.now() - this.state.startTime) / 1000);
  }
  
  getPlayers() {
    if (!this.bot || !this.bot.players) return [];
    return Object.values(this.bot.players).map(p => ({ username: p.username }));
  }
  
  getCoords() {
    return this.bot?.entity?.position || null;
  }
  
  chat(message) {
    if (this.state.connected) {
      this.safeBotChat(message);
      return true;
    }
    return false;
  }
}

// ============================================================
// EXPRESS SERVER
// ============================================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 5000;

// ============================================================
// DASHBOARD HTML (with Setup Wizard built-in)
// ============================================================
app.get('/', (req, res) => {
  const hasServers = servers.length > 0;
  
  if (!hasServers) {
    // Show setup page if no servers
    res.send(getSetupPage());
  } else {
    // Show main dashboard
    res.send(getDashboardPage());
  }
});

function getSetupPage() {
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Setup Your Bot</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: 'Inter', sans-serif;
            background: linear-gradient(135deg, #0a0f1a 0%, #0a1628 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
          }
          .setup-container {
            max-width: 500px;
            width: 100%;
            background: #111827;
            border: 1px solid #1f2937;
            border-radius: 24px;
            padding: 40px;
            box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
          }
          h1 { font-size: 28px; margin-bottom: 8px; color: #f1f5f9; }
          .subtitle { color: #64748b; margin-bottom: 32px; font-size: 14px; }
          .form-group { margin-bottom: 20px; }
          label { display: block; font-size: 13px; font-weight: 500; color: #94a3b8; margin-bottom: 6px; }
          input, select {
            width: 100%;
            padding: 12px 14px;
            background: #0a0f1a;
            border: 1px solid #1f2937;
            border-radius: 10px;
            color: #f1f5f9;
            font-size: 14px;
            font-family: inherit;
            transition: all 0.2s;
          }
          input:focus, select:focus { outline: none; border-color: #22c55e; }
          button {
            width: 100%;
            padding: 14px;
            background: linear-gradient(135deg, #22c55e, #16a34a);
            border: none;
            border-radius: 10px;
            color: white;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            margin-top: 16px;
          }
          button:hover { transform: translateY(-1px); filter: brightness(1.05); }
          .info {
            margin-top: 24px;
            padding: 12px;
            background: rgba(34,197,94,0.1);
            border: 1px solid rgba(34,197,94,0.3);
            border-radius: 8px;
            font-size: 12px;
            color: #22c55e;
            text-align: center;
          }
        </style>
      </head>
      <body>
        <div class="setup-container">
          <h1>🤖 Welcome to Multi-Bot</h1>
          <div class="subtitle">Let's set up your first Minecraft bot</div>
          <form id="setupForm">
            <div class="form-group">
              <label>Server Name (for display)</label>
              <input type="text" id="name" placeholder="e.g., My Survival Server" required>
            </div>
            <div class="form-group">
              <label>Server IP / Address</label>
              <input type="text" id="ip" placeholder="e.g., play.example.com or localhost" required>
            </div>
            <div class="form-group">
              <label>Port</label>
              <input type="number" id="port" placeholder="25565" value="25565" required>
            </div>
            <div class="form-group">
              <label>Bot Username</label>
              <input type="text" id="username" placeholder="BotUsername" required>
            </div>
            <div class="form-group">
              <label>Auth Type</label>
              <select id="auth">
                <option value="offline">Offline (Cracked)</option>
                <option value="microsoft">Microsoft (Premium)</option>
              </select>
            </div>
            <button type="submit">🚀 Start Bot</button>
          </form>
          <div class="info">
            💡 You can add up to ${MAX_BOTS} bots total. Add more from the dashboard after setup.
          </div>
        </div>
        <script>
          document.getElementById('setupForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = document.getElementById('name').value;
            const ip = document.getElementById('ip').value;
            const port = parseInt(document.getElementById('port').value);
            const username = document.getElementById('username').value;
            const auth = document.getElementById('auth').value;
            
            const res = await fetch('/api/servers', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name, ip, port, username, auth })
            });
            
            if (res.ok) {
              window.location.href = '/';
            } else {
              const error = await res.json();
              alert('Error: ' + (error.error || 'Unknown error'));
            }
          });
        </script>
      </body>
    </html>
  `;
}

function getDashboardPage() {
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Multi-Bot Dashboard</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          :root {
            --bg: #0a0f1a; --surface: #111827; --border: #1f2937;
            --text: #f1f5f9; --muted: #64748b; --green: #22c55e;
            --red: #ef4444; --blue: #3b82f6;
          }
          body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); padding: 24px 16px; }
          .container { max-width: 1400px; margin: 0 auto; }
          
          .tab-bar { display: flex; gap: 4px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px 12px 0 0; padding: 8px 12px 0 12px; overflow-x: auto; }
          .tab { display: flex; align-items: center; gap: 8px; padding: 10px 20px; background: var(--bg); border: 1px solid var(--border); border-bottom: none; border-radius: 8px 8px 0 0; cursor: pointer; font-size: 13px; color: var(--muted); white-space: nowrap; }
          .tab:hover { background: #1a2332; color: var(--text); }
          .tab.active { background: var(--surface); color: var(--blue); border-top: 2px solid var(--blue); }
          .tab .delete-tab { width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; border-radius: 4px; cursor: pointer; }
          .tab .delete-tab:hover { background: var(--red); color: white; }
          .add-tab { padding: 10px 16px; background: var(--bg); border: 1px dashed var(--border); border-radius: 8px 8px 0 0; cursor: pointer; font-size: 13px; color: var(--green); }
          .add-tab:hover { background: #1a2332; border-color: var(--green); }
          
          .main-layout { display: flex; background: var(--surface); border: 1px solid var(--border); border-top: none; border-radius: 0 0 12px 12px; min-height: 600px; }
          
          .sidebar { width: 260px; background: var(--bg); border-right: 1px solid var(--border); padding: 20px; flex-shrink: 0; }
          .sidebar-title { font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--muted); margin-bottom: 16px; }
          .server-detail { margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
          .server-detail-label { font-size: 11px; color: var(--muted); margin-bottom: 4px; }
          .server-detail-value { font-size: 13px; font-weight: 500; color: var(--text); word-break: break-all; }
          .server-status { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; }
          .status-online { background: rgba(34,197,94,0.15); color: #22c55e; }
          .status-offline { background: rgba(239,68,68,0.15); color: #ef4444; }
          .delete-server-btn { width: 100%; margin-top: 20px; padding: 8px; background: rgba(239,68,68,0.1); border: 1px solid var(--red); border-radius: 8px; color: var(--red); font-size: 12px; font-weight: 600; cursor: pointer; }
          .delete-server-btn:hover { background: var(--red); color: white; }
          
          .dashboard-content { flex: 1; padding: 24px; overflow-y: auto; }
          .status-hero { border-radius: 16px; padding: 24px 28px; margin-bottom: 20px; display: flex; align-items: center; gap: 20px; border: 1.5px solid; }
          .status-hero.online { background: linear-gradient(135deg, #052e16 0%, #0a1628 100%); border-color: #16a34a; }
          .status-hero.offline { background: linear-gradient(135deg, #1c0a0a 0%, #0a1628 100%); border-color: #dc2626; }
          .status-pulse { width: 52px; height: 52px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 22px; }
          .status-pulse.online { background: rgba(34,197,94,0.15); border: 2px solid #16a34a; }
          .status-pulse.offline { background: rgba(239,68,68,0.15); border: 2px solid #dc2626; }
          .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
          .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 20px; }
          .card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 20px; }
          .card-title { font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--muted); margin-bottom: 14px; }
          .card-value { font-size: 28px; font-weight: 700; }
          .bar-row { margin-bottom: 12px; }
          .bar-label { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin-bottom: 5px; }
          .bar-track { background: var(--border); border-radius: 99px; height: 8px; overflow: hidden; }
          .bar-fill { height: 100%; border-radius: 99px; }
          .bar-hp { background: linear-gradient(90deg, #ef4444, #f87171); }
          .bar-food { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
          .player-list { display: flex; flex-direction: column; gap: 6px; max-height: 180px; overflow-y: auto; }
          .player-item { padding: 8px 12px; background: var(--bg); border-radius: 8px; font-size: 13px; }
          .controls { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 20px; }
          .btn { min-height: 48px; border-radius: 10px; font-size: 14px; font-weight: 700; cursor: pointer; border: 1.5px solid; }
          .btn-start { background: #052e16; border-color: #16a34a; color: #22c55e; }
          .btn-stop { background: #1c0505; border-color: #dc2626; color: #ef4444; }
          @media(max-width: 768px) { .sidebar { display: none; } }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="tab-bar" id="tabBar"></div>
          <div class="main-layout">
            <div class="sidebar" id="sidebar"><div class="sidebar-title">Server Details</div><div id="sidebarContent">Loading...</div></div>
            <div class="dashboard-content" id="dashboardContent">Loading...</div>
          </div>
        </div>
        <script>
          let currentServerId = null;
          
          async function apiCall(url, options = {}) {
            const res = await fetch(url, options);
            return res.json();
          }
          
          async function loadServers() {
            const data = await apiCall('/api/servers');
            return data.servers;
          }
          
          async function renderTabs() {
            const servers = await loadServers();
            const tabBar = document.getElementById('tabBar');
            let html = '';
            servers.forEach(s => {
              html += \`<div class="tab \${currentServerId === s.id ? 'active' : ''}" onclick="switchServer('\${s.id}')">\${s.name}<span class="delete-tab" onclick="event.stopPropagation(); deleteServer('\${s.id}')">×</span></div>\`;
            });
            if (servers.length < ${MAX_BOTS}) {
              html += '<div class="add-tab" onclick="addServer()">+ New Server</div>';
            }
            tabBar.innerHTML = html;
          }
          
          async function switchServer(serverId) {
            currentServerId = serverId;
            await renderTabs();
            await loadSidebar(serverId);
            await loadDashboard(serverId);
          }
          
          async function loadSidebar(serverId) {
            const data = await apiCall(\`/api/servers/\${serverId}/status\`);
            document.getElementById('sidebarContent').innerHTML = \`
              <div class="server-detail"><div class="server-detail-label">Server</div><div class="server-detail-value">\${data.ip}:\${data.port}</div></div>
              <div class="server-detail"><div class="server-detail-label">Status</div><div class="server-status \${data.connected ? 'status-online' : 'status-offline'}">\${data.connected ? '● Online' : '○ Offline'}</div></div>
              <div class="server-detail"><div class="server-detail-label">Bot Username</div><div class="server-detail-value">\${data.username}</div></div>
              <div class="server-detail"><div class="server-detail-label">Uptime</div><div class="server-detail-value">\${data.uptime || '—'}</div></div>
              <button class="delete-server-btn" onclick="deleteServer('\${serverId}')">Delete Server</button>
            \`;
          }
          
          async function loadDashboard(serverId) {
            const d = await apiCall(\`/api/servers/\${serverId}/health\`);
            const hpPercent = ((d.health || 20) / 20 * 100);
            const foodPercent = ((d.food || 20) / 20 * 100);
            document.getElementById('dashboardContent').innerHTML = \`
              <div class="status-hero \${d.status === 'connected' ? 'online' : 'offline'}">
                <div class="status-pulse \${d.status === 'connected' ? 'online' : 'offline'}">\${d.status === 'connected' ? '✓' : '✗'}</div>
                <div><h2>\${d.status === 'connected' ? 'Connected' : 'Disconnected'}</h2><p>Bot is \${d.status === 'connected' ? 'active' : 'reconnecting...'}</p></div>
              </div>
              <div class="grid-3">
                <div class="card"><div class="card-title">Uptime</div><div class="card-value">\${Math.floor(d.uptime/3600)}h \${Math.floor((d.uptime%3600)/60)}m</div></div>
                <div class="card"><div class="card-title">Reconnects</div><div class="card-value">\${d.reconnectAttempts || 0}</div></div>
                <div class="card"><div class="card-title">Coordinates</div><div class="card-value" style="font-size:16px">\${d.coords ? \`X \${Math.floor(d.coords.x)} Y \${Math.floor(d.coords.y)} Z \${Math.floor(d.coords.z)}\` : '—'}</div></div>
              </div>
              <div class="grid">
                <div class="card">
                  <div class="card-title">Bot Vitals</div>
                  <div class="bar-row"><div class="bar-label"><span>❤️ Health</span><span>\${d.health || 20}/20</span></div><div class="bar-track"><div class="bar-fill bar-hp" style="width:\${hpPercent}%"></div></div></div>
                  <div class="bar-row"><div class="bar-label"><span>🍖 Food</span><span>\${d.food || 20}/20</span></div><div class="bar-track"><div class="bar-fill bar-food" style="width:\${foodPercent}%"></div></div></div>
                </div>
                <div class="card">
                  <div class="card-title">Players Online</div>
                  <div class="player-list">\${d.players?.map(p => \`<div class="player-item">\${p.username}</div>\`).join('') || '<div style="color:#64748b;text-align:center">No players</div>'}</div>
                </div>
              </div>
              <div class="controls">
                <button class="btn btn-start" onclick="controlBot('\${serverId}', 'start')">▶ Start Bot</button>
                <button class="btn btn-stop" onclick="controlBot('\${serverId}', 'stop')">■ Stop Bot</button>
              </div>
            \`;
          }
          
          async function addServer() {
            const name = prompt('Server name:');
            if (!name) return;
            const ip = prompt('Server IP:');
            if (!ip) return;
            const port = parseInt(prompt('Port:', '25565')) || 25565;
            const username = prompt('Bot username:', 'BotUser');
            await apiCall('/api/servers', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name, ip, port, username, auth: 'offline' })
            });
            location.reload();
          }
          
          async function deleteServer(serverId) {
            if (!confirm('Delete this server? This cannot be undone.')) return;
            await apiCall(\`/api/servers/\${serverId}\`, { method: 'DELETE' });
            location.reload();
          }
          
          async function controlBot(serverId, action) {
            await apiCall(\`/api/servers/\${serverId}/\${action}\`, { method: 'POST' });
            setTimeout(() => loadDashboard(serverId), 500);
          }
          
          (async () => {
            const servers = await loadServers();
            if (servers.length > 0) currentServerId = servers[0].id;
            if (currentServerId) await switchServer(currentServerId);
            setInterval(() => { if (currentServerId) loadDashboard(currentServerId); }, 4000);
          })();
        </script>
      </body>
    </html>
  `;
}

// ============================================================
// API ENDPOINTS
// ============================================================

app.get('/api/servers', (req, res) => {
  res.json({ servers: servers.map(s => ({ id: s.id, name: s.name, ip: s.ip })), maxBots: MAX_BOTS });
});

app.get('/api/servers/:id/status', (req, res) => {
  const server = servers.find(s => s.id === req.params.id);
  const bot = activeBots[req.params.id];
  res.json({
    id: server.id,
    name: server.name,
    ip: server.ip,
    port: server.port,
    username: server.username,
    connected: bot?.state?.connected || false,
    uptime: bot ? formatUptime(bot.getUptime()) : '—',
    reconnectAttempts: bot?.state?.reconnectAttempts || 0
  });
});

app.get('/api/servers/:id/health', (req, res) => {
  const bot = activeBots[req.params.id];
  if (!bot) {
    res.json({ status: 'disconnected', uptime: 0, health: 20, food: 20, players: [], reconnectAttempts: 0 });
    return;
  }
  res.json({
    status: bot.state.connected ? 'connected' : 'disconnected',
    uptime: bot.getUptime(),
    coords: bot.getCoords(),
    health: bot.state.health,
    food: bot.state.food,
    players: bot.getPlayers(),
    reconnectAttempts: bot.state.reconnectAttempts
  });
});

app.post('/api/servers', (req, res) => {
  if (servers.length >= MAX_BOTS) {
    return res.status(400).json({ error: `Max ${MAX_BOTS} bots allowed` });
  }
  const newServer = {
    id: `server_${Date.now()}`,
    name: req.body.name,
    ip: req.body.ip,
    port: req.body.port,
    version: req.body.version || "",
    username: req.body.username,
    password: req.body.password || "",
    auth: req.body.auth || "offline",
    enabled: true,
    movement: { enabled: true },
    utils: { "auto-reconnect": true, "anti-afk": { enabled: true } },
    modules: {},
    combat: {},
    beds: {},
    chat: {},
    position: {}
  };
  servers.push(newServer);
  saveServers();
  createBotForServer(newServer);
  res.json({ success: true, server: newServer });
});

app.delete('/api/servers/:id', (req, res) => {
  const id = req.params.id;
  stopBotForServer(id);
  servers = servers.filter(s => s.id !== id);
  saveServers();
  res.json({ success: true });
});

app.post('/api/servers/:id/start', (req, res) => {
  const server = servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: "Server not found" });
  if (activeBots[req.params.id]) return res.json({ error: "Already running" });
  createBotForServer(server);
  res.json({ success: true });
});

app.post('/api/servers/:id/stop', (req, res) => {
  stopBotForServer(req.params.id);
  res.json({ success: true });
});

app.get("/logs", (req, res) => {
  const logs = getLogs();
  res.send(`<pre>${logs.join('\n')}</pre>`);
});

// ============================================================
// BOT MANAGEMENT
// ============================================================

function createBotForServer(server) {
  if (activeBots[server.id]) return;
  activeBots[server.id] = new BotInstance(server);
}

function stopBotForServer(serverId) {
  if (activeBots[serverId]) {
    activeBots[serverId].stop();
    delete activeBots[serverId];
  }
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// Load servers and start bots
loadServers();
servers.forEach(server => {
  if (server.enabled) {
    createBotForServer(server);
  }
});

// ============================================================
// START SERVER
// ============================================================
const httpServer = app.listen(PORT, "0.0.0.0", () => {
  addLog(`[Server] Dashboard: http://localhost:${PORT}`);
  addLog(`[Server] Max bots: ${MAX_BOTS}`);
  addLog(`[Server] Platform: ${isRailway ? 'Railway' : isRender ? 'Render' : 'Local'}`);
  addLog(`[Server] Loaded ${servers.length} server(s)`);
});

// Keep process alive
process.on('uncaughtException', (err) => {
  addLog(`[FATAL] ${err.message}`);
});
