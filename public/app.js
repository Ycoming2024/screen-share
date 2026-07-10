// 版本号
const APP_VERSION = '1.4.2';
const ROOM_WS_PATH = '/ws';
const PEER_PATH = '/p';
const BLACK_FRAME_TIMEOUT_MS = 8000;
const RECONNECT_REQUEST_COOLDOWN_MS = 10000;
const VIDEO_MAX_BITRATE = 1200 * 1000;
const VIDEO_MAX_FRAMERATE = 20;
const CAPTURE_CONSTRAINTS = {
  video: {
    cursor: 'always',
    width: { ideal: 1280, max: 1920 },
    height: { ideal: 720, max: 1080 },
    frameRate: { ideal: 15, max: VIDEO_MAX_FRAMERATE }
  },
  audio: false
};
const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:openrelay.metered.ca:80' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.nextcloud.com:443' },
  { urls: 'stun:stun.sipgate.net:3478' },
  { urls: 'stun:stun.12connect.com:3478' }
];
const TURN_SERVERS = [
  {
    urls: 'turn:172.245.47.251:3478?transport=udp',
    username: 'turnuser',
    credential: 'r20X6AncpXA4p3f7SL'
  },
  {
    urls: 'turn:172.245.47.251:3478?transport=tcp',
    username: 'turnuser',
    credential: 'r20X6AncpXA4p3f7SL'
  },
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
];
const DEFAULT_STUN_SERVERS = STUN_SERVERS.slice(0, 4);
const ICE_SERVERS = [...DEFAULT_STUN_SERVERS, ...TURN_SERVERS];

// DOM元素
const startShareBtn = document.getElementById('start-share-btn');
const stopShareBtn = document.getElementById('stop-share-btn');
const shareInfo = document.getElementById('share-info');
const shareCodeDisplay = document.getElementById('share-code');
const sharerStatus = document.getElementById('sharer-status');
const joinBtn = document.getElementById('join-btn');
const shareCodeInput = document.getElementById('share-code-input');
const viewerStatus = document.getElementById('viewer-status');
const videoContainer = document.getElementById('video-container');
const remoteVideo = document.getElementById('remote-video');
const videoStatus = document.getElementById('video-status');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const pipBtn = document.getElementById('pip-btn');

// 状态变量
let ws = null;
let peer = null;
let localStream = null;
let currentCall = null;
let isSharer = false;
let currentShareCode = null;
let heartbeatTimer = null;
let blackFrameTimer = null;
let lastReconnectRequestAt = 0;
let optimizedIceServers = ICE_SERVERS;

function candidateType(candidate) {
  return candidate.type || (candidate.candidate.match(/ typ ([a-z0-9]+)/i) || [])[1] || 'unknown';
}

async function probeStunServer(server, timeoutMs = 2500) {
  const startedAt = performance.now();
  const pc = new RTCPeerConnection({ iceServers: [server] });
  let ok = false;

  pc.createDataChannel('stun-probe');
  pc.onicecandidate = (event) => {
    if (event.candidate && candidateType(event.candidate) === 'srflx') {
      ok = true;
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      pc.onicegatheringstatechange = () => {
        if (ok || pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          resolve();
        }
      };
    });
  } catch (err) {
    console.warn('STUN probe failed:', server.urls, err);
  } finally {
    pc.close();
  }

  return {
    server,
    ok,
    elapsed: Math.round(performance.now() - startedAt)
  };
}

async function optimizeIceServers() {
  const results = await Promise.all(STUN_SERVERS.map(server => probeStunServer(server)));
  const goodStunServers = results
    .filter(result => result.ok)
    .sort((a, b) => a.elapsed - b.elapsed)
    .map(result => result.server);
  const selectedStunServers = goodStunServers.length
    ? goodStunServers.slice(0, 4)
    : DEFAULT_STUN_SERVERS;

  optimizedIceServers = [
    ...selectedStunServers,
    ...TURN_SERVERS
  ];

  console.log('Optimized ICE servers:', results);
}

function getIceServers() {
  return optimizedIceServers;
}

// WebSocket连接
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}${ROOM_WS_PATH}`);
  
  ws.onopen = () => {
    console.log('WebSocket已连接');
    startHeartbeat();
  };
  
  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      handleMessage(message);
    } catch (e) {
      console.error('解析消息错误:', e);
    }
  };
  
  ws.onclose = () => {
    console.log('WebSocket断开');
    stopHeartbeat();
    setTimeout(connectWebSocket, 3000);
  };
  
  ws.onerror = (error) => {
    console.error('WebSocket错误:', error);
  };
}

function sendWsMessage(message, statusElementId) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    return true;
  }

  if (statusElementId) {
    showStatus(statusElementId, 'WebSocket not connected, please try again later', 'error');
  }
  return false;
}

// 心跳
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'heartbeat' }));
    }
  }, 20000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// 初始化PeerJS
function initPeer() {
  if (peer && !peer.destroyed) {
    peer.destroy();
  }

  // PeerJS 和主服务器同一端口，通过 Nginx/Cloudflare 代理
  peer = new Peer({
    host: window.location.hostname,
    port: window.location.port || (window.location.protocol === 'https:' ? 443 : 80),
    path: PEER_PATH,
    secure: window.location.protocol === 'https:',
    debug: 2,
    config: {
      iceServers: getIceServers(),
      iceCandidatePoolSize: 10
    }
  });
  
  peer.on('open', (id) => {
    console.log('PeerJS ID:', id);
  });
  
  peer.on('call', (call) => {
    console.log('收到呼叫');
    // 创建一个空流用于应答
    const emptyStream = new MediaStream();
    call.answer(emptyStream);
    handleCall(call);
  });
  
  peer.on('error', (err) => {
    showStatus(isSharer ? 'sharer-status' : 'viewer-status', `PeerJS connection failed: ${err.type || err.message || err}`, 'error');
    console.error('PeerJS错误:', err);
  });
}

// 处理呼叫
function playRemoteVideo() {
  remoteVideo.autoplay = true;
  remoteVideo.muted = true;
  remoteVideo.playsInline = true;

  const playPromise = remoteVideo.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch((err) => {
      console.warn('Remote video autoplay blocked:', err);
      videoStatus.textContent = '视频已连接，点击黑色画面播放';
    });
  }
}

function describeRemoteStream(remoteStream) {
  const videoTracks = remoteStream.getVideoTracks();
  const audioTracks = remoteStream.getAudioTracks();
  const videoTrack = videoTracks[0];

  if (videoTrack) {
    videoTrack.onmute = () => {
      videoStatus.textContent = '视频轨道暂时无画面，可能正在切换窗口或被系统保护';
    };
    videoTrack.onunmute = () => {
      videoStatus.textContent = '正在观看共享屏幕';
      playRemoteVideo();
      scheduleBlackFrameCheck(remoteStream);
    };
    videoTrack.onended = () => {
      videoStatus.textContent = '共享视频轨道已结束';
    };
  }

  console.log('Remote stream tracks:', {
    video: videoTracks.length,
    audio: audioTracks.length,
    videoState: videoTrack ? videoTrack.readyState : 'none',
    videoMuted: videoTrack ? videoTrack.muted : null
  });
}

function tuneOutgoingVideo(call) {
  const pc = call && call.peerConnection;
  if (!pc || !localStream) return;

  const applyLimits = () => {
    for (const sender of pc.getSenders()) {
      if (!sender.track || sender.track.kind !== 'video') continue;

      const params = sender.getParameters();
      params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = VIDEO_MAX_BITRATE;
      params.encodings[0].maxFramerate = VIDEO_MAX_FRAMERATE;
      sender.setParameters(params).catch((err) => {
        console.warn('Failed to tune video sender:', err);
      });
    }
  };

  applyLimits();
  setTimeout(applyLimits, 1000);
  setTimeout(applyLimits, 3000);
}

function monitorPeerConnection(call) {
  const pc = call && call.peerConnection;
  if (!pc) return;

  const updateState = () => {
    const state = pc.connectionState || pc.iceConnectionState;
    console.log('WebRTC connection state:', state);

    if (!isSharer && ['disconnected', 'failed'].includes(state)) {
      requestReconnectCall('connection-state');
    }
  };

  pc.onconnectionstatechange = updateState;
  pc.oniceconnectionstatechange = updateState;
}

function requestReconnectCall(reason) {
  if (isSharer || !currentShareCode) return;

  const now = Date.now();
  if (now - lastReconnectRequestAt < RECONNECT_REQUEST_COOLDOWN_MS) return;
  lastReconnectRequestAt = now;

  console.warn('Requesting a fresh media call:', reason);
  videoStatus.textContent = '画面未恢复，正在重新连接...';

  if (currentCall) {
    currentCall.close();
    currentCall = null;
  }

  sendWsMessage({
    type: 'request-call',
    shareCode: currentShareCode
  }, 'viewer-status');
}

function scheduleBlackFrameCheck(remoteStream) {
  if (blackFrameTimer) clearTimeout(blackFrameTimer);

  blackFrameTimer = setTimeout(() => {
    const hasVideoTrack = remoteStream.getVideoTracks().some(track => track.readyState === 'live');
    const hasFrame = remoteVideo.videoWidth > 0 && remoteVideo.videoHeight > 0 && remoteVideo.readyState >= 2;

    if (hasVideoTrack && !hasFrame) {
      requestReconnectCall('black-frame');
    }
  }, BLACK_FRAME_TIMEOUT_MS);
}

function handleCall(call) {
  currentCall = call;
  tuneOutgoingVideo(call);
  monitorPeerConnection(call);
  
  call.on('stream', (remoteStream) => {
    console.log('收到远程流，轨道数:', remoteStream.getTracks().length);
    if (remoteStream.getTracks().length > 0) {
      describeRemoteStream(remoteStream);
      remoteVideo.srcObject = remoteStream;
      remoteVideo.onloadedmetadata = () => {
        videoStatus.textContent = `正在观看共享屏幕 ${remoteVideo.videoWidth || 0}x${remoteVideo.videoHeight || 0}`;
        playRemoteVideo();
      };
      videoContainer.classList.remove('hidden');
      scheduleBlackFrameCheck(remoteStream);
      playRemoteVideo();
      videoStatus.textContent = '正在观看共享屏幕';
    }
  });
  
  call.on('close', () => {
    if (blackFrameTimer) {
      clearTimeout(blackFrameTimer);
      blackFrameTimer = null;
    }
    console.log('呼叫关闭');
    videoStatus.textContent = '连接已关闭';
  });
  
  call.on('error', (err) => {
    console.error('呼叫错误:', err);
    videoStatus.textContent = '连接错误: ' + err.message;
  });
}

// 处理消息
function handleMessage(message) {
  switch (message.type) {
    case 'heartbeat-ack':
      break;
      
    case 'room-created':
      currentShareCode = message.shareCode;
      shareCodeDisplay.textContent = message.shareCode;
      shareInfo.classList.remove('hidden');
      startShareBtn.classList.add('hidden');
      showStatus('sharer-status', '共享已开始，等待观看者加入...', 'success');
      break;
      
    case 'viewer-joined':
      handleViewerJoined(message.peerId);
      break;

    case 'request-call':
      handleViewerJoined(message.peerId);
      break;
      
    case 'joined-room':
      showStatus('viewer-status', '已加入房间，正在连接...', 'info');
      // 观看者不需要主动呼叫，等待共享者呼叫
      break;
      
    case 'sharer-peer-id':
      // 观看者收到共享者的PeerID，发起呼叫
      if (peer && localStream) {
        const call = peer.call(message.peerId, localStream);
        handleCall(call);
      }
      break;
      
    case 'sharer-left':
      showStatus('viewer-status', '共享者已停止共享', 'error');
      videoContainer.classList.add('hidden');
      if (currentCall) {
        currentCall.close();
        currentCall = null;
      }
      break;
      
    case 'error':
      showStatus('viewer-status', message.message, 'error');
      break;
  }
}

// 共享者：处理观看者加入
function handleViewerJoined(viewerPeerId) {
  console.log('观看者加入，PeerID:', viewerPeerId);
  console.log('本地流状态:', localStream ? '有' : '无', '轨道数:', localStream ? localStream.getTracks().length : 0);
  
  if (peer && localStream && viewerPeerId) {
    console.log('正在呼叫观看者...');
    const call = peer.call(viewerPeerId, localStream);
    if (call) {
      handleCall(call);
      console.log('呼叫已发起');
    } else {
      console.error('呼叫失败');
    }
  } else {
    console.error('无法呼叫：', { peer: !!peer, localStream: !!localStream, viewerPeerId });
  }
  
  updateViewerCount();
}

// 开始共享
async function startShare() {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia(CAPTURE_CONSTRAINTS);
    
    localStream.getVideoTracks()[0].onended = () => {
      stopShare();
    };
    
    isSharer = true;
    initPeer();
    
    peer.on('open', (id) => {
      console.log('共享者PeerID:', id);
      sendWsMessage({
        type: 'create-room',
        peerId: id
      }, 'sharer-status');
    });
    
  } catch (error) {
    console.error('获取屏幕流错误:', error);
    showStatus('sharer-status', '无法获取屏幕共享权限', 'error');
  }
}

// 停止共享
function stopShare() {
  if (blackFrameTimer) {
    clearTimeout(blackFrameTimer);
    blackFrameTimer = null;
  }

  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  
  if (currentCall) {
    currentCall.close();
    currentCall = null;
  }
  
  if (peer) {
    peer.destroy();
    peer = null;
  }
  
  isSharer = false;
  currentShareCode = null;
  
  shareInfo.classList.add('hidden');
  startShareBtn.classList.remove('hidden');
  sharerStatus.textContent = '';
  
  const countDisplay = document.getElementById('viewer-count');
  if (countDisplay) countDisplay.remove();
}

// 加入共享
async function joinShare() {
  const code = shareCodeInput.value.trim().toUpperCase();
  
  if (code.length !== 5) {
    showStatus('viewer-status', '请输入5位共享码', 'error');
    return;
  }
  
  // 观看者不需要本地流
  localStream = null;
  isSharer = false;
  currentShareCode = code;
  
  initPeer();
  
  peer.on('open', (id) => {
    console.log('观看者PeerID:', id);
    sendWsMessage({
      type: 'join-room',
      shareCode: code,
      peerId: id
    }, 'viewer-status');
  });
}

// 更新观看者数量
function updateViewerCount() {
  let countDisplay = document.getElementById('viewer-count');
  if (!countDisplay) {
    countDisplay = document.createElement('span');
    countDisplay.id = 'viewer-count';
    countDisplay.className = 'viewer-count';
    sharerStatus.parentNode.insertBefore(countDisplay, sharerStatus.nextSibling);
  }
  countDisplay.textContent = '有观看者已连接';
}

// 显示状态
function showStatus(elementId, message, type) {
  const element = document.getElementById(elementId);
  if (element) {
    element.textContent = message;
    element.className = `status ${type}`;
  }
}

// 全屏
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    videoContainer.requestFullscreen().catch(() => {
      createVideoOverlay();
    });
  } else {
    document.exitFullscreen();
  }
}

// 视频放大
function createVideoOverlay() {
  const existing = document.querySelector('.video-overlay');
  if (existing) {
    existing.remove();
    return;
  }
  
  const overlay = document.createElement('div');
  overlay.className = 'video-overlay';
  
  const video = remoteVideo.cloneNode(true);
  video.srcObject = remoteVideo.srcObject;
  
  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-btn';
  closeBtn.textContent = '✕';
  closeBtn.onclick = () => overlay.remove();
  
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };
  
  overlay.appendChild(video);
  overlay.appendChild(closeBtn);
  document.body.appendChild(overlay);
}

// 画中画
async function togglePictureInPicture() {
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (remoteVideo.srcObject) {
      await remoteVideo.requestPictureInPicture();
    }
  } catch (error) {
    console.error('画中画错误:', error);
  }
}

// 事件监听
startShareBtn.addEventListener('click', startShare);
stopShareBtn.addEventListener('click', stopShare);
joinBtn.addEventListener('click', joinShare);
fullscreenBtn.addEventListener('click', toggleFullscreen);
pipBtn.addEventListener('click', togglePictureInPicture);
remoteVideo.addEventListener('click', createVideoOverlay);

shareCodeInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') joinShare();
});

shareCodeInput.addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase();
});

// 页面关闭时清理
window.addEventListener('beforeunload', () => {
  if (currentCall) currentCall.close();
  if (peer) peer.destroy();
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
  }
});

// 初始化
connectWebSocket();
optimizeIceServers().catch((err) => {
  console.warn('ICE optimization failed:', err);
});
