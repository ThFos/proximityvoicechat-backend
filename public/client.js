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

const SPEAKING_THRESHOLD = 15;

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
let isDeafened = false;

let micMode = localStorage.getItem('vc_micMode') || 'open'; // 'open' | 'ptt'
let pttKeyDown = false;

let muteKey = localStorage.getItem('vc_muteKey') || 'm';
let pttKey = localStorage.getItem('vc_pttKey') || 'v';
let listeningForKey = null; // null | 'mute' | 'ptt'

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
const deafenToggleBtn = document.getElementById('deafenToggleBtn');
const masterVolumeSlider = document.getElementById('masterVolumeSlider');
const volumeValueDisplay = document.getElementById('volumeValueDisplay');
const modeOpenBtn = document.getElementById('modeOpenBtn');
const modePttBtn = document.getElementById('modePttBtn');
const pttHint = document.getElementById('pttHint');
const micStatusEl = document.getElementById('micStatus');
const muteKeyBtn = document.getElementById('muteKeyBtn');
const pttKeyBtn = document.getElementById('pttKeyBtn');

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
    if (masterGainNode && !isDeafened) {
        masterGainNode.gain.value = value;
    }
}

// ============================================
// Web Audio API Context
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

        setMicMode(micMode);
        updateKeyButtonLabels();

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
        const analyser = ctx.createAnalyser();
        const gainNode = ctx.createGain();
        const pannerNode = ctx.createStereoPanner();

        compressor.threshold.setValueAtTime(-50, ctx.currentTime);
        compressor.knee.setValueAtTime(40, ctx.currentTime);
        compressor.ratio.setValueAtTime(12, ctx.currentTime);
        compressor.attack.setValueAtTime(0, ctx.currentTime);
        compressor.release.setValueAtTime(0.25, ctx.currentTime);

        analyser.fftSize = 512;

        source.connect(compressor);
        compressor.connect(analyser);
        compressor.connect(gainNode);
        gainNode.connect(pannerNode);
        pannerNode.connect(masterGainNode);

        const peerData = peers.get(targetUuid);
        if (peerData) {
            peerData.audioElement = audioEl;
            peerData.sourceNode = source;
            peerData.compressorNode = compressor;
            peerData.analyserNode = analyser;
            peerData.dataArray = new Uint8Array(analyser.frequencyBinCount);
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
        analyserNode: null,
        dataArray: null,
        gainNode: null,
        pannerNode: null,
        name: targetName,
        distance: 0,
        angle: 0,
        speaking: false,
        quality: 'good'
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
        if (peerData.analyserNode) peerData.analyserNode.disconnect();
        if (peerData.gainNode) peerData.gainNode.disconnect();
        if (peerData.pannerNode) peerData.pannerNode.disconnect();
        if (peerData.audioElement) peerData.audioElement.remove();

        peers.delete(uuid);
    }
}

// ============================================
// Audio Enable Fallback Button
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
// Speaking Detection Loop
// ============================================
function updateSpeakingIndicators() {
    peers.forEach((peerData, uuid) => {
        if (!peerData.analyserNode || !peerData.dataArray) return;

        peerData.analyserNode.getByteFrequencyData(peerData.dataArray);

        let sum = 0;
        for (let i = 0; i < peerData.dataArray.length; i++) {
            sum += peerData.dataArray[i];
        }
        const avg = sum / peerData.dataArray.length;
        const speaking = avg > SPEAKING_THRESHOLD;

        if (speaking !== peerData.speaking) {
            peerData.speaking = speaking;

            const item = document.querySelector(`.player-item[data-uuid="${uuid}"]`);
            if (item) {
                item.classList.toggle('speaking', speaking);
                const dot = item.querySelector('.speaking-dot');
                if (dot) dot.classList.toggle('active', speaking);
            }
        }
    });
}
setInterval(updateSpeakingIndicators, 100);

// ============================================
// Connection Quality Monitoring
// ============================================
async function updateConnectionQuality() {
    for (const [uuid, peerData] of peers.entries()) {
        const pc = peerData.peerConnection;
        if (!pc || pc.connectionState !== 'connected') continue;

        try {
            const stats = await pc.getStats();
            let packetsLost = 0;
            let packetsReceived = 0;

            stats.forEach(report => {
                if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                    packetsLost = report.packetsLost || 0;
                    packetsReceived = report.packetsReceived || 0;
                }
            });

            const total = packetsLost + packetsReceived;
            const lossRatio = total > 0 ? packetsLost / total : 0;

            let quality = 'good';
            if (lossRatio > 0.1) quality = 'poor';
            else if (lossRatio > 0.03) quality = 'medium';

            peerData.quality = quality;

            const icon = document.querySelector(`.player-item[data-uuid="${uuid}"] .quality-icon`);
            if (icon) {
                icon.className = 'quality-icon quality-' + quality;
            }
        } catch (err) {
            // αγνόησε σιωπηλά
        }
    }
}
setInterval(updateConnectionQuality, 4000);

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
        const angle = typeof player.angle === 'number' ? player.angle : 0;

        return `
            <div class="player-item" data-uuid="${player.uuid}">
                <div class="player-info">
                    <div class="player-name-row">
                        <span class="speaking-dot"></span>
                        <span class="player-name">${player.name}</span>
                        <span class="direction-arrow" style="transform: rotate(${angle}deg)">↑</span>
                        <span class="quality-icon quality-good">📶</span>
                    </div>
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
// Mic Toggle (Open Mic mode)
// ============================================
function toggleMic() {
    if (micMode === 'ptt') return;
    if (isDeafened) return;

    micEnabled = !micEnabled;

    if (localStream) {
        localStream.getAudioTracks().forEach(track => {
            track.enabled = micEnabled;
        });
    }

    updateMicStatusDisplay(micEnabled);

    if (micEnabled) {
        micToggleBtn.textContent = '🔇 Σίγαση Μικροφώνου';
        micToggleBtn.classList.remove('muted');
    } else {
        micToggleBtn.textContent = '🎤 Ενεργοποίηση Μικροφώνου';
        micToggleBtn.classList.add('muted');
    }
}

// ============================================
// Mic Mode (Open / Push-to-Talk)
// ============================================
function setMicMode(mode) {
    micMode = mode;
    localStorage.setItem('vc_micMode', mode);

    if (modeOpenBtn) modeOpenBtn.classList.toggle('active', mode === 'open');
    if (modePttBtn) modePttBtn.classList.toggle('active', mode === 'ptt');
    if (pttHint) {
        pttHint.style.display = mode === 'ptt' ? 'block' : 'none';
        pttHint.innerHTML = `Κράτα πατημένο το <strong>${formatKeyLabel(pttKey)}</strong> για να μιλήσεις`;
    }
    if (micToggleBtn) micToggleBtn.style.display = mode === 'open' ? 'block' : 'none';

    if (localStream && !isDeafened) {
        if (mode === 'ptt') {
            localStream.getAudioTracks().forEach(t => t.enabled = false);
            updateMicStatusDisplay(false);
        } else {
            localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
            updateMicStatusDisplay(micEnabled);
        }
    }
}

function setMicTrackEnabled(enabled) {
    if (!localStream || isDeafened) return;
    localStream.getAudioTracks().forEach(track => track.enabled = enabled);
    updateMicStatusDisplay(enabled);
}

function updateMicStatusDisplay(enabled) {
    if (!micStatusEl) return;

    if (isDeafened) {
        micStatusEl.textContent = '🔇 Deafened';
        return;
    }

    if (micMode === 'ptt') {
        micStatusEl.textContent = enabled ? '🎤 Μιλάς...' : `⌨️ Κράτα το ${formatKeyLabel(pttKey)} για να μιλήσεις`;
        return;
    }

    micStatusEl.textContent = enabled ? '🎤 Μικρόφωνο: Ενεργό' : '🔇 Μικρόφωνο: Σίγαση';
}

// ============================================
// Deafen Toggle
// ============================================
function toggleDeafen() {
    isDeafened = !isDeafened;

    if (isDeafened) {
        if (masterGainNode) masterGainNode.gain.value = 0;
        if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = false);

        deafenToggleBtn.textContent = '🔇 Ενεργοποίηση Ήχου';
        deafenToggleBtn.classList.add('active');
        updateMicStatusDisplay(false);
    } else {
        if (masterGainNode) masterGainNode.gain.value = masterVolume;

        if (localStream) {
            if (micMode === 'open') {
                localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
            }
        }

        deafenToggleBtn.textContent = '🙉 Κλείσιμο Ήχου (Deafen)';
        deafenToggleBtn.classList.remove('active');
        updateMicStatusDisplay(micMode === 'open' ? micEnabled : false);
    }
}

// ============================================
// Customizable Keyboard Shortcuts
// ============================================
function formatKeyLabel(key) {
    if (key === ' ') return 'SPACE';
    return key.toUpperCase();
}

function updateKeyButtonLabels() {
    if (muteKeyBtn && listeningForKey !== 'mute') muteKeyBtn.textContent = `Mute: ${formatKeyLabel(muteKey)}`;
    if (pttKeyBtn && listeningForKey !== 'ptt') pttKeyBtn.textContent = `PTT: ${formatKeyLabel(pttKey)}`;
}

function startListeningForKey(type) {
    listeningForKey = type;

    if (type === 'mute' && muteKeyBtn) {
        muteKeyBtn.textContent = 'Πάτα ένα πλήκτρο...';
        muteKeyBtn.classList.add('listening');
    }
    if (type === 'ptt' && pttKeyBtn) {
        pttKeyBtn.textContent = 'Πάτα ένα πλήκτρο...';
        pttKeyBtn.classList.add('listening');
    }
}

function cancelListening() {
    listeningForKey = null;
    if (muteKeyBtn) muteKeyBtn.classList.remove('listening');
    if (pttKeyBtn) pttKeyBtn.classList.remove('listening');
    updateKeyButtonLabels();
}

function showShortcutError(message) {
    let el = document.getElementById('shortcutError');
    if (!el) {
        el = document.createElement('div');
        el.id = 'shortcutError';
        el.style.cssText = 'color:#ff4d4d;font-size:0.78rem;margin-top:0.4rem;';
        const container = document.querySelector('.shortcuts-section');
        if (container) container.appendChild(el);
    }
    el.textContent = message;
    setTimeout(() => { if (el) el.textContent = ''; }, 2000);
}

document.addEventListener('keydown', (e) => {
    // --- Λειτουργία "καταγραφής" νέου shortcut ---
    if (listeningForKey) {
        e.preventDefault();

        const newKey = e.key.toLowerCase();

        if (newKey === 'escape') {
            cancelListening();
            return;
        }

        const otherKey = listeningForKey === 'mute' ? pttKey : muteKey;
        if (newKey === otherKey) {
            showShortcutError('Αυτό το πλήκτρο χρησιμοποιείται ήδη!');
            return;
        }

        if (listeningForKey === 'mute') {
            muteKey = newKey;
            localStorage.setItem('vc_muteKey', newKey);
        } else if (listeningForKey === 'ptt') {
            pttKey = newKey;
            localStorage.setItem('vc_pttKey', newKey);
            if (pttHint) {
                pttHint.innerHTML = `Κράτα πατημένο το <strong>${formatKeyLabel(pttKey)}</strong> για να μιλήσεις`;
            }
        }

        cancelListening();
        return;
    }

    // --- Κανονική λειτουργία shortcuts ---
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (connectedScreen.style.display !== 'block') return;

    const key = e.key.toLowerCase();

    if (micMode === 'ptt' && key === pttKey && !e.repeat) {
        pttKeyDown = true;
        setMicTrackEnabled(true);
        return;
    }

    if (micMode === 'open' && key === muteKey && !e.repeat) {
        toggleMic();
    }
});

document.addEventListener('keyup', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    const key = e.key.toLowerCase();

    if (micMode === 'ptt' && key === pttKey) {
        pttKeyDown = false;
        setMicTrackEnabled(false);
    }
});

if (muteKeyBtn) {
    muteKeyBtn.addEventListener('click', () => startListeningForKey('mute'));
}
if (pttKeyBtn) {
    pttKeyBtn.addEventListener('click', () => startListeningForKey('ptt'));
}

updateKeyButtonLabels();

// ============================================
// INIT
// ============================================
connectWebSocket();