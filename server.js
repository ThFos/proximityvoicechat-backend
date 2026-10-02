import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';

const app = express();
const server = http.createServer(app);

app.use(express.static('public'));

// Δύο ξεχωριστά WebSocket servers
const minecraftWSS = new WebSocketServer({ noServer: true });
const webClientWSS = new WebSocketServer({ noServer: true });

// Data structures
let minecraftConnection = null;
let playerLocations = new Map(); // uuid -> {x, y, z, world, name}
let linkCodes = new Map(); // code -> {uuid, name, timestamp}
let webClients = new Map(); // ws -> {uuid, name}
let uuidToWs = new Map(); // uuid -> ws

const PROXIMITY_RANGE = 20; // blocks

// Handle upgrade requests (για να ξεχωρίζουμε /minecraft από /voice)
server.on('upgrade', (request, socket, head) => {
    const pathname = request.url;

    if (pathname === '/minecraft') {
        minecraftWSS.handleUpgrade(request, socket, head, (ws) => {
            minecraftWSS.emit('connection', ws, request);
        });
    } else if (pathname === '/voice') {
        webClientWSS.handleUpgrade(request, socket, head, (ws) => {
            webClientWSS.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

// ============ MINECRAFT PLUGIN CONNECTION ============
minecraftWSS.on('connection', (ws) => {
    console.log('✓ Minecraft server connected');
    minecraftConnection = ws;

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());

            switch (message.type) {
                case 'location_update':
                    handleLocationUpdate(message.players);
                    break;

                case 'generate_link':
                    handleGenerateLink(message);
                    break;
            }
        } catch (err) {
            console.error('Error parsing minecraft message:', err);
        }
    });

    ws.on('close', () => {
        console.log('✗ Minecraft server disconnected');
        minecraftConnection = null;
        playerLocations.clear();
    });

    ws.on('error', (err) => {
        console.error('Minecraft WebSocket error:', err);
    });
});

function handleLocationUpdate(players) {
    players.forEach(player => {
        playerLocations.set(player.uuid, {
            name: player.name,
            x: player.x,
            y: player.y,
            z: player.z,
            world: player.world
        });
    });

    calculateProximityAndNotify();
}

function handleGenerateLink(message) {
    linkCodes.set(message.code, {
        uuid: message.uuid,
        name: message.name,
        timestamp: Date.now()
    });

    console.log(`📋 Link code generated: ${message.code} for ${message.name}`);

    // Clean up old codes after 5 minutes
    setTimeout(() => {
        linkCodes.delete(message.code);
    }, 5 * 60 * 1000);
}

// ============ WEB CLIENT CONNECTION ============
webClientWSS.on('connection', (ws) => {
    console.log('🌐 New web client connected');

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());

            switch (message.type) {
                case 'link_code':
                    handleLinkCode(ws, message.code);
                    break;

                case 'webrtc_offer':
                case 'webrtc_answer':
                case 'webrtc_ice_candidate':
                    relayWebRTCMessage(message);
                    break;
            }
        } catch (err) {
            console.error('Error parsing web client message:', err);
        }
    });

    ws.on('close', () => {
        const clientData = webClients.get(ws);
        if (clientData) {
            uuidToWs.delete(clientData.uuid);
            webClients.delete(ws);
            console.log(`Client disconnected: ${clientData.name}`);
        }
    });

    ws.on('error', (err) => {
        console.error('Web client WebSocket error:', err);
    });
});

function handleLinkCode(ws, code) {
    const linkData = linkCodes.get(code);

    if (!linkData) {
        ws.send(JSON.stringify({
            type: 'link_error',
            message: 'Invalid or expired code'
        }));
        return;
    }

    // Link successful
    webClients.set(ws, { uuid: linkData.uuid, name: linkData.name });
    uuidToWs.set(linkData.uuid, ws);
    linkCodes.delete(code);

    ws.send(JSON.stringify({
        type: 'link_success',
        uuid: linkData.uuid,
        name: linkData.name
    }));

    // Notify Minecraft plugin
    if (minecraftConnection) {
        minecraftConnection.send(JSON.stringify({
            type: 'link_confirmed',
            uuid: linkData.uuid
        }));
    }

    console.log(`✓ Linked: ${linkData.name}`);
}

function relayWebRTCMessage(message) {
    const targetWs = uuidToWs.get(message.targetUuid);
    if (targetWs) {
        targetWs.send(JSON.stringify(message));
    }
}

// ============ PROXIMITY CALCULATION ============
function calculateProximityAndNotify() {
    const players = Array.from(playerLocations.entries());

    for (let i = 0; i < players.length; i++) {
        const [uuid1, loc1] = players[i];
        const nearbyPlayers = [];

        for (let j = 0; j < players.length; j++) {
            if (i === j) continue;

            const [uuid2, loc2] = players[j];

            if (loc1.world !== loc2.world) continue;

            const distance = calculateDistance(loc1, loc2);

            if (distance <= PROXIMITY_RANGE) {
                nearbyPlayers.push({
                    uuid: uuid2,
                    name: loc2.name,
                    distance: distance
                });
            }
        }

        // Notify this player's web client about nearby players
        const ws = uuidToWs.get(uuid1);
        if (ws && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
                type: 'proximity_update',
                nearbyPlayers: nearbyPlayers
            }));
        }
    }
}

function calculateDistance(loc1, loc2) {
    const dx = loc1.x - loc2.x;
    const dy = loc1.y - loc2.y;
    const dz = loc1.z - loc2.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ============ BASIC ROUTE ============
app.get('/', (req, res) => {
    res.send('VoiceChat Backend is running! 🎤');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on 0.0.0.0:${PORT}`);
});
