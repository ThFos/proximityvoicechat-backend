// ============================================
// CONFIGURATION (dynamic - ενημερώνεται από τον server)
// ============================================
const BACKEND_URL = 'wss://voice.pgglegacy.gr/voice';

let MAX_DISTANCE = 20;
let VOLUME_CURVE = 'linear';
let ENABLE_3D_AUDIO = true;

const ICE_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
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
let audioCtx = null;
let masterGainNode = null;

let masterVolume = parseFloat(localStorage.getItem('vc_masterVolume'));
if (isNaN(masterVolume)) masterVolume = 1.0;

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
const masterVolumeSlider = document.getElementById('masterVolumeSlider');
const volumeValueDisplay = document.getElementById('volumeValueDisplay');

codeInput.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
});

codeInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') submitLinkCode();
});

// ============================================
// Master Volume Slider Wiring
// ============================================
if (masterVolumeSlider) {
    masterVolumeSlider.value = Math.round(masterVolume * 100);
    if (volumeValueDisplay) {
        volumeValueDisplay.textContent = `${Math.round(masterVolume * 100)}%`;
    }

    masterVolumeSlider.addEventListener('input', (e) => {
        const val = e.target.value / 100;
        setMasterVolume(val);
        if (volumeValueDisplay) {
            volumeValueDisplay.textContent = `${e.target.value}%`;
        }
    });
}

function setMasterVolume(value) {
    masterVolume = value;
    localStorage.setItem('vc_masterVolume', value);
    if (masterGainNode) {
        masterGainNode.gain.value = value;
    }
}

// ============================================
// Web Audio API Context (lazy init, μέσα σε user gesture)
// ============================================
function getAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        masterGainNode = audioCtx.createGain();
        masterGainNode.gain.value = masterVolume;
        masterGainNode.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    return audioCtx;
}

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

    getAudioContext();

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
            syncConfig(message);
            handleProximityUpdate(message.nearbyPlayers);
            break;

        case 'config_update':
            syncConfig(message);
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

function syncConfig(message) {
    if (typeof message.proximityRange === 'number') {
        MAX_DISTANCE = message.proximityRange;
    }
    if (typeof message.volumeCurve === 'string') {
        VOLUME_CURVE = message.volumeCurve;
    }
    if (typeof message.enable3dAudio === 'boolean') {
        ENABLE_3D_AUDIO = message.enable3dAudio;
    }
}

// ============================================
// Link Success -> Request Microphone
// ============================================
async function onLinkSuccess(message) {
    myUuid = message.uuid;
    myName = message.name;
    syncConfig(message);

    console.log(`✓ Linked as ${myName} (${myUuid}) | range=${MAX_DISTANCE} curve=${VOLUME_CURVE} 3d=${ENABLE_3D_AUDIO}`);

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
        console.error('Microphone access denied:', err.name, err.message);
        showError('Χρειάζεται πρόσβαση στο μικρόφωνο! Error: ' + err.name);
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
        updatePeerAudio(player.uuid, player.distance, player.angle);
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
        const remoteStream = event.streams[0];

        const audioEl = document.createElement('audio');
        audioEl.srcObject = remoteStream;
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        audioEl.muted = true;
        document.body.appendChild(audioEl);

        const playPromise = audioEl.play();
        if (playPromise !== undefined) {
            playPromise.catch(err => {
                console.error('Hidden audio element blocked:', err);
                showEnableAudioButton();
            });
        }

        const ctx = getAudioContext();
        const source = ctx.createMediaStreamSource(remoteStream);
        const compressor = ctx.createDynamicsCompressor();
        const gainNode = ctx.createGain();
        const pannerNode = ctx.createStereoPanner();

        compressor.threshold.setValueAtTime(-50, ctx.currentTime);
        compressor.knee.setValueAtTime(40, ctx.currentTime);
        compressor.ratio.setValueAtTime(12, ctx.currentTime);
        compressor.attack.setValueAtTime(0, ctx.currentTime);
        compressor.release.setValueAtTime(0.25, ctx.currentTime);

        source.connect(compressor);
        compressor.connect(gainNode);
        gainNode.connect(pannerNode);
        pannerNode.connect(masterGainNode);

        const peerData = peers.get(targetUuid);
        if (peerData) {
            peerData.audioElement = audioEl;
            peerData.sourceNode = source;
            peerData.compressorNode = compressor;
            peerData.gainNode = gainNode;
            peerData.pannerNode = pannerNode;
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
        sourceNode: null,
        compressorNode: null,
        gainNode: null,
        pannerNode: null,
        name: targetName,
        distance: 0,
        angle: 0
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

        if (peerData.sourceNode) peerData.sourceNode.disconnect();
        if (peerData.compressorNode) peerData.compressorNode.disconnect();
        if (peerData.gainNode) peerData.gainNode.disconnect();
        if (peerData.pannerNode) peerData.pannerNode.disconnect();
        if (peerData.audioElement) peerData.audioElement.remove();

        peers.delete(uuid);
    }
}

// ============================================
// Audio Enable Fallback Button (autoplay block)
// ============================================
function showEnableAudioButton() {
    if (document.getElementById('enableAudioBtn')) return;

    const btn = document.createElement('button');
    btn.id = 'enableAudioBtn';
    btn.textContent = '🔊 Πάτα εδώ για να ενεργοποιηθεί ο ήχος';
    btn.style.cssText = `
        position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
        background: #6b2dd8; color: white; border: 1px solid #521eb8; padding: 12px 20px;
        border-radius: 0.75rem; font-family: 'Space Grotesk', sans-serif;
        font-size: 14px; z-index: 9999; cursor: pointer; width: auto;
    `;
    btn.onclick = () => {
        getAudioContext();
        peers.forEach(peerData => {
            if (peerData.audioElement) {
                peerData.audioElement.play().catch(e => console.error('Still blocked:', e));
            }
        });
        btn.remove();
    };
    document.body.appendChild(btn);
}

// ============================================
// Dynamic Volume & Panning
// ============================================
function calculateVolume(distance) {
    const ratio = Math.max(0, 1 - (distance / MAX_DISTANCE));

    if (VOLUME_CURVE === 'exponential') {
        return Math.pow(ratio, 2);
    }

    return ratio;
}

function updatePeerAudio(uuid, distance, angle) {
    const peerData = peers.get(uuid);
    if (!peerData) return;

    peerData.distance = distance;
    peerData.angle = angle;

    if (peerData.gainNode) {
        peerData.gainNode.gain.value = calculateVolume(distance);
    }

    if (peerData.pannerNode) {
        if (ENABLE_3D_AUDIO && typeof angle === 'number') {
            const panValue = Math.sin(angle * Math.PI / 180);
            peerData.pannerNode.pan.value = panValue;
        } else {
            peerData.pannerNode.pan.value = 0;
        }
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
        const volumePercent = Math.round(calculateVolume(player.distance) * 100);
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