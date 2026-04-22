// NEXUSBOT - Stable Bot with Anti-Kick (from Multi-Bot)
const mineflayer = require("mineflayer");
const { pathfinder, Movements } = require("mineflayer-pathfinder");
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

// Configuration
let config = {
    username: process.env.BOT_NAME || 'NexusBot',
    serverIp: process.env.SERVER_IP || 'localhost',
    serverPort: parseInt(process.env.SERVER_PORT) || 25565,
    auth: 'offline',
    version: process.env.MC_VERSION || false,  // false = auto-detect
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

function addLog(message, type = 'info') {
    const logEntry = { timestamp: new Date().toISOString(), message, type };
    botStats.logs.push(logEntry);
    if (botStats.logs.length > 200) botStats.logs.shift();
    console.log(`[${type.toUpperCase()}] ${message}`);
}

function clearIntervals() {
    activeIntervals.forEach(id => clearInterval(id));
    activeIntervals = [];
}

function addInterval(callback, delay) {
    const id = setInterval(callback, delay);
    activeIntervals.push(id);
    return id;
}

// API Server
const app = express();
app.use(cors());
app.use(express.json());

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

app.get('/logs', (req, res) => {
    res.json(botStats.logs.slice(-150));
});

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
    if (bot && botStats.connected) restartFeatures();
    res.json({ success: true });
});

app.post('/api/chat', (req, res) => {
    const { responses } = req.body;
    if (responses) {
        config.chatResponses = { ...config.chatResponses, ...responses };
        addLog(`Chat responses updated`, 'success');
    }
    res.json({ success: true });
});

app.post('/command', (req, res) => {
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'No command' });
    addLog(`[Command] ${command}`, 'control');
    if (command === 'start') {
        if (!botStats.connected) createBot();
        res.json({ success: true });
    } else if (command === 'stop') {
        if (bot) { clearIntervals(); bot.end(); bot = null; botStats.connected = false; }
        res.json({ success: true });
    } else if (command === 'restart') {
        if (bot) { clearIntervals(); bot.end(); bot = null; }
        botStats.connected = false;
        botStats.reconnectAttempts = 0;
        setTimeout(() => createBot(), 3000);
        res.json({ success: true });
    } else {
        if (bot && botStats.connected) {
            const now = Date.now();
            const wait = Math.max(0, 1200 - (now - lastChatTime));
            setTimeout(() => { bot.chat(command); lastChatTime = Date.now(); }, wait);
            res.json({ success: true });
        } else {
            res.status(503).json({ error: 'Bot not connected' });
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    addLog(`[API] Server running on port ${PORT}`);
});

// Bot Features
function restartFeatures() {
    clearIntervals();
    if (config.antiAFK) startAntiAFK();
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
    }, 15000);
    addInterval(() => {
        if (bot && botStats.connected && config.antiAFK) {
            try { bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.5, true); } catch(e) {}
        }
    }, 10000);
}

function startFarming() {
    addInterval(() => {
        if (!bot || !bot.entity || !botStats.connected || !config.autoFarm) return;
        const crop = bot.findBlock({
            matching: (block) => ['wheat', 'carrots', 'potatoes', 'beetroots'].includes(block.name),
            maxDistance: 5
        });
        if (crop) {
            bot.dig(crop, (err) => {
                if (!err) { botStats.blocksMined++; addLog(`Farmed ${crop.name}`, 'success'); }
            });
        }
    }, 8000);
}

function startMining() {
    const ores = ['coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'emerald_ore', 'copper_ore'];
    addInterval(() => {
        if (!bot || !bot.entity || !botStats.connected || !config.autoMine) return;
        const ore = bot.findBlock({ matching: (block) => ores.includes(block.name), maxDistance: 5 });
        if (ore) {
            bot.dig(ore, (err) => {
                if (!err) { botStats.blocksMined++; addLog(`Mined ${ore.name}`, 'success'); }
            });
        }
    }, 6000);
}

function startParkour() {
    addInterval(() => {
        if (!bot || !bot.entity || !botStats.connected || !config.parkour) return;
        bot.setControlState('forward', true);
        setTimeout(() => bot.setControlState('forward', false), 800);
    }, 15000);
}

function startLiquidWalker() {
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

// Bot Connection (with Pathfinder from Multi-Bot)
function createBot() {
    if (!config.serverIp || config.serverIp === 'localhost' || config.serverIp === 'mc.example.com') {
        addLog(`Invalid SERVER_IP: "${config.serverIp}". Please set a valid Minecraft server IP.`, 'error');
        return;
    }
    
    addLog(`Connecting to ${config.serverIp}:${config.serverPort} as "${config.username}"...`, 'info');
    
    const cacheFolder = path.join(__dirname, `./auth_cache_${config.username.replace(/[^a-z0-9]/gi, '_')}`);
    if (!fs.existsSync(cacheFolder)) fs.mkdirSync(cacheFolder, { recursive: true });
    
    const botOptions = {
        host: config.serverIp,
        port: config.serverPort,
        username: config.username,
        auth: config.auth,
        profilesFolder: cacheFolder,
        viewDistance: 'normal',
        hideErrors: false
    };
    
    if (config.version) botOptions.version = config.version;
    
    try {
        bot = mineflayer.createBot(botOptions);
    } catch (err) {
        addLog(`Failed to create bot: ${err.message}`, 'error');
        scheduleReconnect();
        return;
    }
    
    // Load pathfinder plugin (anti-kick feature from Multi-Bot)
    bot.loadPlugin(pathfinder);
    
    bot.on('connect', () => {
        addLog(`Connected to ${config.serverIp}:${config.serverPort}`, 'success');
    });
    
    bot.once('spawn', () => {
        botStats.connected = true;
        botStats.startTime = Date.now();
        botStats.reconnectAttempts = 0;
        addLog(`Bot has joined the server!`, 'success');
        updatePlayerList();
        
        // Setup pathfinder with anti-kick settings (from Multi-Bot)
        const mcData = require('minecraft-data')(bot.version);
        const defaultMove = new Movements(bot, mcData);
        defaultMove.allowFreeMotion = false;  // KEY: Makes movement less detectable
        bot.pathfinder.setMovements(defaultMove);
        
        setTimeout(() => { restartFeatures(); }, 5000);
    });
    
    bot.on('health', () => {
        if (bot) { botStats.health = bot.health; botStats.food = bot.food; }
    });
    
    setInterval(() => {
        if (bot && bot.entity) {
            botStats.position = {
                x: Math.round(bot.entity.position.x * 10) / 10,
                y: Math.round(bot.entity.position.y * 10) / 10,
                z: Math.round(bot.entity.position.z * 10) / 10
            };
            botStats.ping = bot.player?.ping || 0;
        }
    }, 2000);
    
    bot.on('playerJoined', (player) => { updatePlayerList(); addLog(`Player joined: ${player.username}`, 'info'); });
    bot.on('playerLeft', (player) => { updatePlayerList(); addLog(`Player left: ${player.username}`, 'info'); });
    
    bot.on('chat', (username, message) => {
        if (username === bot.username) return;
        addLog(`<${username}> ${message}`, 'info');
        if (!config.autoResponder) return;
        const lowerMsg = message.toLowerCase();
        for (const [keyword, response] of Object.entries(config.chatResponses)) {
            if (lowerMsg.includes(keyword.toLowerCase())) {
                setTimeout(() => {
                    if (bot && botStats.connected) {
                        bot.chat(response);
                        addLog(`Auto-reply to ${username}: ${response}`, 'success');
                    }
                }, 1000);
                break;
            }
        }
    });
    
    bot.on('end', (reason) => {
        botStats.connected = false;
        addLog(`Disconnected: ${reason || 'Unknown'}`, 'error');
        clearIntervals();
        scheduleReconnect();
    });
    
    bot.on('error', (err) => {
        addLog(`Error: ${err.message}`, 'error');
    });
    
    bot.on('kicked', (reason) => {
        const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
        addLog(`Kicked: ${reasonStr}`, 'error');
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
        addLog(`Max reconnection attempts (10) reached. Bot stopped.`, 'error');
        return;
    }
    botStats.reconnectAttempts++;
    const delay = Math.min(5000 * botStats.reconnectAttempts, 30000);
    addLog(`Reconnecting in ${delay/1000} seconds... (Attempt ${botStats.reconnectAttempts}/10)`, 'warning');
    setTimeout(() => {
        if (bot) { try { bot.removeAllListeners(); } catch(e) {} bot = null; }
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

addLog(`Starting NexusBot...`, 'info');
addLog(`Target: ${config.serverIp}:${config.serverPort}`, 'info');
addLog(`Username: ${config.username}`, 'info');
createBot();
