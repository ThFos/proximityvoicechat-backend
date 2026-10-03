import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';

const app = express();
const server = http.createServer(app);

app.use(express.static('public'));

const minecraftWSS = new WebSocketServer({ noServer: true });
const webClientWSS = new WebSocketServer({ noServer: true });

let minecraftConnection = null;
let playerLocations = new Map();
let linkCodes = new Map();
let webClients = new Map();
let uuidToWs = new Map();
let occludedPairsSet = new Set();

let PROXIMITY_RANGE = 20;
let VOLUME_CURVE = 'linear';
let ENABLE_3D_AUDIO = true;

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
                    handleLocationUpdate(message.players, message.occludedPairs);
                    break;

                case 'generate_link':
                    handleGenerateLink(message);
                    break;

                case 'config':
                    handleConfigUpdate(message);
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

function handleConfigUpdate(message) {
    if (typeof message.proximityRange === 'number') {
        PROXIMITY_RANGE = message.proximityRange;
    }
    if (typeof message.volumeCurve === 'string') {
        VOLUME_CURVE = message.volumeCurve;
    }
    if (typeof message.enable3dAudio === 'boolean') {
        ENABLE_3D_AUDIO = message.enable3dAudio;
    }
    console.log(`⚙️  Config updated: range=${PROXIMITY_RANGE}, curve=${VOLUME_CURVE}, 3d=${ENABLE_3D_AUDIO}`);

    for (const ws of uuidToWs.values()) {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
                type: 'config_update',
                proximityRange: PROXIMITY_RANGE,
                volumeCurve: VOLUME_CURVE,
                enable3dAudio: ENABLE_3D_AUDIO
            }));
        }
    }
}

function handleLocationUpdate(players, occludedPairs) {
    playerLocations.clear();

    players.forEach(player => {
        playerLocations.set(player.uuid, {
            name: player.name,
            x: player.x,
            y: player.y,
            z: player.z,
            yaw: player.yaw,
            world: player.world
        });
    });

    occludedPairsSet = new Set();
    if (Array.isArray(occludedPairs)) {
        occludedPairs.forEach(pair => {
            const key = [pair[0], pair[1]].sort().join('|');
            occludedPairsSet.add(key);
        });
    }

    calculateProximityAndNotify();
}

function isOccluded(uuid1, uuid2) {
    const key = [uuid1, uuid2].sort().join('|');
    return occludedPairsSet.has(key);
}

function handleGenerateLink(message) {
    linkCodes.set(message.code, {
        uuid: message.uuid,
        name: message.name,
        timestamp: Date.now()
    });

    console.log(`📋 Link code generated: ${message.code} for ${message.name}`);

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

                case 'speaking_status':
                    handleSpeakingStatus(ws, message.speaking);
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

            // ✅ ΝΕΟ: Όταν αποσυνδέεται ένας παίκτης, ξαναϋπολόγισε proximity
            // ώστε οι υπόλοιποι να μάθουν άμεσα ότι αυτός έφυγε
            calculateProximityAndNotify();
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

    webClients.set(ws, { uuid: linkData.uuid, name: linkData.name });
    uuidToWs.set(linkData.uuid, ws);
    linkCodes.delete(code);

    ws.send(JSON.stringify({
        type: 'link_success',
        uuid: linkData.uuid,
        name: linkData.name,
        proximityRange: PROXIMITY_RANGE,
        volumeCurve: VOLUME_CURVE,
        enable3dAudio: ENABLE_3D_AUDIO
    }));

    if (minecraftConnection) {
        minecraftConnection.send(JSON.stringify({
            type: 'link_confirmed',
            uuid: linkData.uuid
        }));
    }

    console.log(`✓ Linked: ${linkData.name}`);

    // ✅ ΝΕΟ: Μόλις συνδεθεί κάποιος, ξαναϋπολόγισε proximity για όλους
    // ώστε όποιος ήταν ήδη κοντά του να ενημερωθεί άμεσα (fix για race condition)
    calculateProximityAndNotify();
}

function relayWebRTCMessage(message) {
    const targetWs = uuidToWs.get(message.targetUuid);
    if (targetWs && targetWs.readyState === targetWs.OPEN) {
        targetWs.send(JSON.stringify(message));
    } else {
        console.warn(`⚠️  Could not relay ${message.type} to ${message.targetUuid} - not connected`);
    }
}

function handleSpeakingStatus(ws, speaking) {
    const clientData = webClients.get(ws);
    if (!clientData) return;

    if (minecraftConnection && minecraftConnection.readyState === minecraftConnection.OPEN) {
        minecraftConnection.send(JSON.stringify({
            type: 'speaking_status',
            uuid: clientData.uuid,
            speaking: speaking
        }));
    }
}

// ============ PROXIMITY CALCULATION ============
function calculateProximityAndNotify() {
    const players = Array.from(playerLocations.entries());

    for (let i = 0; i < players.length; i++) {
        const [uuid1, loc1] = players[i];

        // Αν ο uuid1 δεν έχει συνδέσει τον web client του, μη χάνεις χρόνο
        const ws1 = uuidToWs.get(uuid1);
        if (!ws1 || ws1.readyState !== ws1.OPEN) continue;

        const nearbyPlayers = [];

        for (let j = 0; j < players.length; j++) {
            if (i === j) continue;

            const [uuid2, loc2] = players[j];

            if (loc1.world !== loc2.world) continue;

            // ✅ ΝΕΟ / ΚΡΙΣΙΜΗ ΔΙΟΡΘΩΣΗ:
            // Μην συμπεριλαμβάνεις παίκτες που ΔΕΝ έχουν συνδέσει ακόμα τον web client τους.
            // Χωρίς αυτό, ο client Α προσπαθεί να στείλει WebRTC offer σε παίκτη Β που
            // δεν είναι ακόμα συνδεδεμένος στο /voice websocket, το offer χάνεται σιωπηλά,
            // και επειδή το peers.has(B) γίνεται ήδη true, ο Α ΔΕΝ ξαναπροσπαθεί ποτέ -
            // μέχρι ο Β να βγει εκτός εμβέλειας και να ξαναμπεί.
            const ws2 = uuidToWs.get(uuid2);
            if (!ws2 || ws2.readyState !== ws2.OPEN) continue;

            const distance = calculateDistance(loc1, loc2);

            if (distance <= PROXIMITY_RANGE) {
                const angle = calculateRelativeAngle(loc1, loc2);
                const occluded = isOccluded(uuid1, uuid2);

                nearbyPlayers.push({
                    uuid: uuid2,
                    name: loc2.name,
                    distance: distance,
                    angle: angle,
                    occluded: occluded
                });
            }
        }

        ws1.send(JSON.stringify({
            type: 'proximity_update',
            nearbyPlayers: nearbyPlayers,
            proximityRange: PROXIMITY_RANGE,
            volumeCurve: VOLUME_CURVE,
            enable3dAudio: ENABLE_3D_AUDIO
        }));
    }
}

function calculateDistance(loc1, loc2) {
    const dx = loc1.x - loc2.x;
    const dy = loc1.y - loc2.y;
    const dz = loc1.z - loc2.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function calculateRelativeAngle(listener, speaker) {
    const dx = speaker.x - listener.x;
    const dz = speaker.z - listener.z;

    const angleToSpeaker = (Math.atan2(-dx, dz) * 180 / Math.PI + 360) % 360;

    let relativeAngle = angleToSpeaker - listener.yaw;
    relativeAngle = ((relativeAngle + 180) % 360 + 360) % 360 - 180;

    return relativeAngle;
}

app.get('/', (req, res) => {
    res.send('VoiceChat Backend is running! 🎤');
});

app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on 0.0.0.0:${PORT}`);
});