// NEXUSBOT - Stable Single Bot (Converted from Multi-Bot)
const mineflayer = require("mineflayer");
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

// ============================================================
// CONFIGURATION (from Railway environment variables)
// ============================================================
const config = {
    username: process.env.BOT_NAME || 'NexusBot',
    serverIp: process.env.SERVER_IP || 'localhost',
    serverPort: parseInt(process.env.SERVER_PORT) || 25565,
    auth: 'offline',
    version: process.env.MC_VERSION || '1.20.4',
    // Features (can be toggled via API)
    autoReconnect: true,
    antiAFK: true,
    autoFarm: false,
    autoMine: false,
    parkour: false,
    liquidWalker: false,
    autoResponder: false,
    chatResponses: {
        'hello': 'Hi there!',
        'how are you': 'I am a bot!',
        'help': 'I am an AFK bot'
    }
};

let botStats = {
    connected: false,
    health: 20,
    food: 20,
    position: { x: 0, y: 0, z: 0 },
    ping: 0,
    players: [],
    logs: [],
    startTime: Date.now(),
    blocksMined: 0,
    reconnectAttempts: 0
};

let bot = null;
let activeIntervals = [];
let lastChatTime = 0;

// ============================================================
// LOGGING
// ============================================================
function addLog(message, type = 'info') {
    const logEntry = { 
        timestamp: new Date().toISOString(), 
        message: message, 
        type: type 
    };
    botStats.logs.push(logEntry);
    if (botStats.logs.length > 200) botStats.logs.shift();
    console.log(`[${type.toUpperCase()}] ${message}`);
}

// ============================================================
// INTERVAL MANAGEMENT
// ============================================================
function clearIntervals() {
    activeIntervals.forEach(id => clearInterval(id));
    activeIntervals = [];
}

function addInterval(callback, delay) {
    const id = setInterval(callback, delay);
    activeIntervals.push(id);
    return id;
}

// ============================================================
// EXPRESS API SERVER (for your website)
// ============================================================
const app = express();
app.use(cors());
app.use(express.json());

// Health endpoint - used by your website
app.get('/health', (req, res) => {
    res.json({
        status: botStats.connected ? 'connected' : 'disconnected',
        uptime: Math.floor((Date.now() - botStats.startTime) / 1000),
        health: botStats.health,
        food: botStats.food,
        position: botStats.position,
        ping: botStats.ping,
        players: botStats.players,
        blocksMined: botStats.blocksMined,
        reconnectAttempts: botStats.reconnectAttempts
    });
});

// Logs endpoint - used by your website
app.get('/logs', (req, res) => {
    res.json(botStats.logs.slice(-150));
});

// Get settings - used by your website
app.get('/api/settings', (req, res) => {
    res.json({
        autoReconnect: config.autoReconnect,
        antiAFK: config.antiAFK,
        autoFarm: config.autoFarm,
        autoMine: config.autoMine,
        parkour: config.parkour,
        liquidWalker: config.liquidWalker,
        autoResponder: config.autoResponder,
        chatResponses: config.chatResponses
    });
});

// Update settings - used by your website
app.post('/api/settings', (req, res) => {
    const { autoReconnect, antiAFK, autoFarm, autoMine, parkour, liquidWalker, autoResponder } = req.body;
    
    if (autoReconnect !== undefined) config.autoReconnect = autoReconnect;
    if (antiAFK !== undefined) config.antiAFK = antiAFK;
    if (autoFarm !== undefined) config.autoFarm = autoFarm;
    if (autoMine !== undefined) config.autoMine = autoMine;
    if (parkour !== undefined) config.parkour = parkour;
    if (liquidWalker !== undefined) config.liquidWalker = liquidWalker;
    if (autoResponder !== undefined) config.autoResponder = autoResponder;
    
    addLog(`Settings updated via API`, 'success');
    
    if (bot && botStats.connected) {
        restartFeatures();
    }
    
    res.json({ success: true });
});

// Update chat responses - used by your website
app.post('/api/chat', (req, res) => {
    const { responses } = req.body;
    if (responses) {
        config.chatResponses = { ...config.chatResponses, ...responses };
        addLog(`Chat responses updated: ${Object.keys(responses).length} rules`, 'success');
    }
    res.json({ success: true });
});

// Command endpoint - used by your website (start/stop/restart)
app.post('/command', (req, res) => {
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'No command' });
    
    addLog(`[Command] ${command}`, 'control');
    
    if (command === 'start') {
        if (!botStats.connected) {
            createBot();
        }
        res.json({ success: true });
    } 
    else if (command === 'stop') {
        if (bot) {
            clearIntervals();
            bot.end();
            bot = null;
            botStats.connected = false;
        }
        res.json({ success: true });
    }
    else if (command === 'restart') {
        if (bot) {
            clearIntervals();
            bot.end();
            bot = null;
        }
        botStats.connected = false;
        botStats.reconnectAttempts = 0;
        setTimeout(() => createBot(), 3000);
        res.json({ success: true });
    }
    else {
        if (bot && botStats.connected) {
            safeBotChat(command);
            res.json({ success: true });
        } else {
            res.status(503).json({ error: 'Bot not connected' });
        }
    }
});

// Safe chat with rate limiting
function safeBotChat(message) {
    const now = Date.now();
    const wait = Math.max(0, 1200 - (now - lastChatTime));
    setTimeout(() => {
        if (bot && botStats.connected) {
            bot.chat(message);
            lastChatTime = Date.now();
        }
    }, wait);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    addLog(`[API] Server running on port ${PORT}`);
});

// ============================================================
// BOT FEATURES
// ============================================================
function restartFeatures() {
    clearIntervals();
    
    // Anti-AFK starts immediately
    if (config.antiAFK) startAntiAFK();
    
    // Movement features start with delays
    if (config.autoFarm) setTimeout(() => startFarming(), 5000);
    if (config.autoMine) setTimeout(() => startMining(), 8000);
    if (config.parkour) setTimeout(() => startParkour(), 10000);
    if (config.liquidWalker) setTimeout(() => startLiquidWalker(), 12000);
}

function startAntiAFK() {
    addInterval(() => {
        if (bot && botStats.connected && config.antiAFK) {
            try { bot.swingArm(); } catch(e) {}
        }
    }, 20000);
    
    addInterval(() => {
        if (bot && botStats.connected && config.antiAFK) {
            try { bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.3, true); } catch(e) {}
        }
    }, 30000);
}

function startFarming() {
    addLog(`🌾 Auto-Farm started`, 'info');
    addInterval(() => {
        if (!bot || !bot.entity || !botStats.connected || !config.autoFarm) return;
        const crop = bot.findBlock({
            matching: (block) => ['wheat', 'carrots', 'potatoes', 'beetroots'].includes(block.name),
            maxDistance: 4
        });
        if (crop) {
            bot.dig(crop, (err) => {
                if (!err) {
                    botStats.blocksMined++;
                    addLog(`🌾 Farmed ${crop.name}`, 'success');
                }
            });
        }
    }, 8000);
}

function startMining() {
    const ores = ['coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'emerald_ore', 'copper_ore'];
    addLog(`⛏️ Auto-Mine started`, 'info');
    addInterval(() => {
        if (!bot || !bot.entity || !botStats.connected || !config.autoMine) return;
        const ore = bot.findBlock({ matching: (block) => ores.includes(block.name), maxDistance: 4 });
        if (ore) {
            bot.dig(ore, (err) => {
                if (!err) {
                    botStats.blocksMined++;
                    addLog(`⛏️ Mined ${ore.name}`, 'success');
                }
            });
        }
    }, 6000);
}

function startParkour() {
    addLog(`🏃 Parkour Mode started`, 'info');
    addInterval(() => {
        if (!bot || !bot.entity || !botStats.connected || !config.parkour) return;
        bot.setControlState('forward', true);
        setTimeout(() => bot.setControlState('forward', false), 800);
    }, 15000);
}

function startLiquidWalker() {
    addLog(`🪣 Liquid Walker started`, 'info');
    addInterval(() => {
        if (!bot || !bot.entity || !botStats.connected || !config.liquidWalker) return;
        const blockBelow = bot.blockAt(bot.entity.position.offset(0, -1, 0));
        if (blockBelow && (blockBelow.name === 'water' || blockBelow.name === 'lava')) {
            const cobble = bot.inventory.findInventoryItem(item => item.name === 'cobblestone');
            if (cobble) {
                bot.equip(cobble, 'hand');
                bot.placeBlock(blockBelow.position, () => {});
            }
        }
    }, 5000);
}

// ============================================================
// BOT CONNECTION (STABLE - from Multi-Bot)
// ============================================================
function createBot() {
    if (!config.serverIp || config.serverIp === 'localhost' || config.serverIp === 'mc.example.com') {
        addLog(`⚠️ Invalid SERVER_IP: "${config.serverIp}". Please set a valid Minecraft server IP.`, 'error');
        return;
    }
    
    addLog(`🤖 Bot connecting to ${config.serverIp}:${config.serverPort} as "${config.username}"...`, 'info');
    
    // Unique cache folder to prevent Microsoft auth conflicts
    const cacheFolder = path.join(__dirname, `./auth_cache_${config.username.replace(/[^a-z0-9]/gi, '_')}`);
    if (!fs.existsSync(cacheFolder)) fs.mkdirSync(cacheFolder, { recursive: true });
    
    try {
        bot = mineflayer.createBot({
            host: config.serverIp,
            port: config.serverPort,
            username: config.username,
            auth: config.auth,
            version: config.version,
            profilesFolder: cacheFolder,
            viewDistance: 'normal',
            hideErrors: false
        });
    } catch (err) {
        addLog(`❌ Failed to create bot: ${err.message}`, 'error');
        scheduleReconnect();
        return;
    }
    
    bot.on('connect', () => {
        addLog(`✅ Connected to ${config.serverIp}:${config.serverPort}`, 'success');
    });
    
    bot.once('spawn', () => {
        botStats.connected = true;
        botStats.startTime = Date.now();
        botStats.reconnectAttempts = 0;
        addLog(`✅ Bot has joined the server!`, 'success');
        updatePlayerList();
        
        // Wait 8 seconds then start features
        addLog(`⏳ Waiting 8 seconds before starting features...`, 'info');
        setTimeout(() => {
            restartFeatures();
        }, 8000);
    });
    
    bot.on('health', () => {
        if (bot) {
            botStats.health = bot.health;
            botStats.food = bot.food;
        }
    });
    
    // Position tracking
    setInterval(() => {
        if (bot && bot.entity) {
            botStats.position = {
                x: Math.round(bot.entity.position.x * 10) / 10,
                y: Math.round(bot.entity.position.y * 10) / 10,
                z: Math.round(bot.entity.position.z * 10) / 10
            };
            botStats.ping = bot.player?.ping || 0;
        }
    }, 3000);
    
    bot.on('playerJoined', (player) => {
        updatePlayerList();
        addLog(`👤 Player joined: ${player.username}`, 'info');
    });
    
    bot.on('playerLeft', (player) => {
        updatePlayerList();
        addLog(`👤 Player left: ${player.username}`, 'info');
    });
    
    // Chat handler for auto-responses
    bot.on('chat', (username, message) => {
        if (username === bot.username) return;
        addLog(`💬 <${username}> ${message}`, 'info');
        
        if (!config.autoResponder) return;
        
        const lowerMsg = message.toLowerCase();
        for (const [keyword, response] of Object.entries(config.chatResponses)) {
            if (lowerMsg.includes(keyword.toLowerCase())) {
                setTimeout(() => {
                    if (bot && botStats.connected) {
                        bot.chat(response);
                        addLog(`🤖 Auto-reply to ${username}: ${response}`, 'success');
                    }
                }, 1500);
                break;
            }
        }
    });
    
    bot.on('end', (reason) => {
        botStats.connected = false;
        addLog(`❌ Disconnected: ${reason || 'Unknown'}`, 'error');
        clearIntervals();
        scheduleReconnect();
    });
    
    bot.on('error', (err) => {
        addLog(`⚠️ Error: ${err.message}`, 'error');
    });
    
    bot.on('kicked', (reason) => {
        const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
        addLog(`👢 Kicked: ${reasonStr}`, 'error');
        botStats.connected = false;
        clearIntervals();
        scheduleReconnect();
    });
}

function scheduleReconnect() {
    if (!config.autoReconnect) {
        addLog(`Auto-reconnect is disabled. Bot will not reconnect.`, 'warning');
        return;
    }
    
    if (botStats.reconnectAttempts >= 10) {
        addLog(`❌ Max reconnection attempts (10) reached. Bot stopped.`, 'error');
        return;
    }
    
    botStats.reconnectAttempts++;
    const delay = Math.min(8000 * botStats.reconnectAttempts, 45000);
    addLog(`🔄 Reconnecting in ${delay/1000} seconds... (Attempt ${botStats.reconnectAttempts}/10)`, 'warning');
    
    setTimeout(() => {
        if (bot) {
            try { bot.removeAllListeners(); } catch(e) {}
            bot = null;
        }
        createBot();
    }, delay);
}

function updatePlayerList() {
    if (bot && bot.players) {
        botStats.players = Object.values(bot.players)
            .filter(p => p.username !== bot.username)
            .map(p => ({ username: p.username, ping: p.ping }));
    }
}

// ============================================================
// START BOT
// ============================================================
addLog(`🚀 Starting NexusBot (Stable Version)...`, 'info');
addLog(`📡 Target: ${config.serverIp}:${config.serverPort}`, 'info');
addLog(`🤖 Username: ${config.username}`, 'info');
addLog(`🔌 Auth: ${config.auth}`, 'info');
addLog(`📦 Version: ${config.version}`, 'info');

createBot();
