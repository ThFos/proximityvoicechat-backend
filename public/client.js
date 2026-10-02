// ============================================
// CONFIGURATION
// ============================================
const BACKEND_URL = 'wss://voice.pgglegacy.gr/voice';
const MAX_DISTANCE = 20; // Πρέπει να ταιριάζει με το PROXIMITY_RANGE του backend

const ICE_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// ============================================
// STATE
// ============================================
let ws = null;
let myUuid = null;
let myName = null;
let localStream = null;
let micEnabled = true;

const peers = new Map();

// ============================================
// DOM ELEMENTS
// ============================================
const linkScreen = document.getElementById('linkScreen');
const connectedScreen = document.getElementById('connectedScreen');
const codeInput = document.getElementById('codeInput');
const linkButton = document.getElementById('linkButton');
const errorMsg = document.getElementById('errorMsg');
const playerNameEl = document.getElementById('playerName');
const nearbyPlayersEl = document.getElementById('nearbyPlayers');
const micToggleBtn = document.getElementById('micToggleBtn');

codeInput.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
});

codeInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') submitLinkCode();
});

// ============================================
// WebSocket Connection
// ============================================
function connectWebSocket() {
    ws = new WebSocket(BACKEND_URL);

    ws.onopen = () => {
        console.log('✓ Connected to backend');
    };

    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        handleServerMessage(message);
    };

    ws.onclose = () => {
        console.log('✗ Disconnected from backend');
        showError('Η σύνδεση με τον server χάθηκε. Κάνε refresh τη σελίδα.');
    };

    ws.onerror = (err) => {
        console.error('WebSocket error:', err);
    };
}

// ============================================
// Link Code Submission
// ============================================
function submitLinkCode() {
    const code = codeInput.value.trim();

    if (code.length !== 6) {
        showError('Ο κωδικός πρέπει να έχει 6 χαρακτήρες');
        return;
    }

    linkButton.disabled = true;
    linkButton.textContent = 'Σύνδεση...';
    errorMsg.textContent = '';

    if (!ws || ws.readyState !== WebSocket.OPEN) {
        connectWebSocket();
        setTimeout(() => sendLinkCode(code), 500);
    } else {
        sendLinkCode(code);
    }
}

function sendLinkCode(code) {
    ws.send(JSON.stringify({
        type: 'link_code',
        code: code
    }));
}

function showError(message) {
    errorMsg.textContent = message;
    linkButton.disabled = false;
    linkButton.textContent = 'Σύνδεση';
}

// ============================================
// Server Message Handler
// ============================================
async function handleServerMessage(message) {
    switch (message.type) {
        case 'link_success':
            onLinkSuccess(message);
            break;

        case 'link_error':
            showError(message.message);
            break;

        case 'proximity_update':
            handleProximityUpdate(message.nearbyPlayers);
            break;

        case 'webrtc_offer':
            await handleOffer(message);
            break;

        case 'webrtc_answer':
            await handleAnswer(message);
            break;

        case 'webrtc_ice_candidate':
            await handleIceCandidate(message);
            break;
    }
}

// ============================================
// Link Success -> Request Microphone
// ============================================
async function onLinkSuccess(message) {
    myUuid = message.uuid;
    myName = message.name;

    console.log(`✓ Linked as ${myName} (${myUuid})`);

    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            },
            video: false
        });

        linkScreen.style.display = 'none';
        connectedScreen.style.display = 'block';
        playerNameEl.textContent = myName;

    } catch (err) {
        console.error('Microphone access denied:', err);
        showError('Χρειάζεται πρόσβαση στο μικρόφωνο για να λειτουργήσει το voice chat!');
    }
}

// ============================================
// Proximity Update
// ============================================
function handleProximityUpdate(nearbyPlayers) {
    const nearbyUuids = new Set(nearbyPlayers.map(p => p.uuid));

    for (const [uuid] of peers.entries()) {
        if (!nearbyUuids.has(uuid)) {
            closePeerConnection(uuid);
        }
    }

    nearbyPlayers.forEach(player => {
        if (!peers.has(player.uuid)) {
            initiateConnection(player.uuid, player.name);
        }
        updatePeerDistance(player.uuid, player.distance);
    });

    renderNearbyPlayersList(nearbyPlayers);
}

// ============================================
// WebRTC Connection Logic
// ============================================
function initiateConnection(targetUuid, targetName) {
    const pc = createPeerConnection(targetUuid, targetName);
    const shouldInitiate = myUuid < targetUuid;

    if (shouldInitiate) {
        createAndSendOffer(targetUuid, pc);
    }
}

function createPeerConnection(targetUuid, targetName) {
    const pc = new RTCPeerConnection(ICE_SERVERS);

    localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
    });

    pc.ontrack = (event) => {
        const audioEl = document.createElement('audio');
        audioEl.srcObject = event.streams[0];
        audioEl.autoplay = true;
        document.body.appendChild(audioEl);

        const peerData = peers.get(targetUuid);
        if (peerData) {
            peerData.audioElement = audioEl;
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            ws.send(JSON.stringify({
                type: 'webrtc_ice_candidate',
                targetUuid: targetUuid,
                fromUuid: myUuid,
                candidate: event.candidate
            }));
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`Connection with ${targetName}: ${pc.connectionState}`);
    };

    peers.set(targetUuid, {
        peerConnection: pc,
        audioElement: null,
        name: targetName,
        distance: 0
    });

    return pc;
}

async function createAndSendOffer(targetUuid, pc) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    ws.send(JSON.stringify({
        type: 'webrtc_offer',
        targetUuid: targetUuid,
        fromUuid: myUuid,
        fromName: myName,
        offer: offer
    }));
}

async function handleOffer(message) {
    const { fromUuid, fromName, offer } = message;

    let peerData = peers.get(fromUuid);
    let pc;

    if (!peerData) {
        pc = createPeerConnection(fromUuid, fromName);
    } else {
        pc = peerData.peerConnection;
    }

    await pc.setRemoteDescription(new RTCSessionDescription(offer));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    ws.send(JSON.stringify({
        type: 'webrtc_answer',
        targetUuid: fromUuid,
        fromUuid: myUuid,
        answer: answer
    }));
}

async function handleAnswer(message) {
    const { fromUuid, answer } = message;
    const peerData = peers.get(fromUuid);

    if (peerData) {
        await peerData.peerConnection.setRemoteDescription(
            new RTCSessionDescription(answer)
        );
    }
}

async function handleIceCandidate(message) {
    const { fromUuid, candidate } = message;
    const peerData = peers.get(fromUuid);

    if (peerData) {
        try {
            await peerData.peerConnection.addIceCandidate(
                new RTCIceCandidate(candidate)
            );
        } catch (err) {
            console.error('Error adding ICE candidate:', err);
        }
    }
}

function closePeerConnection(uuid) {
    const peerData = peers.get(uuid);
    if (peerData) {
        peerData.peerConnection.close();
        if (peerData.audioElement) {
            peerData.audioElement.remove();
        }
        peers.delete(uuid);
    }
}

// ============================================
// Dynamic Volume
// ============================================
function updatePeerDistance(uuid, distance) {
    const peerData = peers.get(uuid);
    if (!peerData) return;

    peerData.distance = distance;

    if (peerData.audioElement) {
        const volume = Math.max(0, 1 - (distance / MAX_DISTANCE));
        peerData.audioElement.volume = volume;
    }
}

// ============================================
// UI Rendering
// ============================================
function renderNearbyPlayersList(nearbyPlayers) {
    if (nearbyPlayers.length === 0) {
        nearbyPlayersEl.innerHTML = '<div class="no-players">Κανένας παίκτης κοντά σου</div>';
        return;
    }

    nearbyPlayersEl.innerHTML = nearbyPlayers.map(player => {
        const volumePercent = Math.round(Math.max(0, 1 - (player.distance / MAX_DISTANCE)) * 100);
        return `
            <div class="player-item">
                <div class="player-info">
                    <div class="player-name">${player.name}</div>
                    <div class="player-distance">${player.distance.toFixed(1)}m</div>
                </div>
                <div class="volume-bar">
                    <div class="volume-fill" style="width: ${volumePercent}%"></div>
                </div>
            </div>
        `;
    }).join('');
}

// ============================================
// Mic Toggle
// ============================================
function toggleMic() {
    micEnabled = !micEnabled;

    if (localStream) {
        localStream.getAudioTracks().forEach(track => {
            track.enabled = micEnabled;
        });
    }

    if (micEnabled) {
        micToggleBtn.textContent = '🔇 Σίγαση Μικροφώνου';
        micToggleBtn.classList.remove('muted');
        document.getElementById('micStatus').textContent = '🎤 Μικρόφωνο: Ενεργό';
    } else {
        micToggleBtn.textContent = '🎤 Ενεργοποίηση Μικροφώνου';
        micToggleBtn.classList.add('muted');
        document.getElementById('micStatus').textContent = '🔇 Μικρόφωνο: Σίγαση';
    }
}

// ============================================
// INIT
// ============================================
connectWebSocket();