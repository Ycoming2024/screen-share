// 版本号
const APP_VERSION = '1.2.0';

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

// WebSocket连接
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}`);
  
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
  peer = new Peer({
    config: {
      iceServers: [
        // 公共STUN服务器
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:stun.miwifi.com:3478' },
        { urls: 'stun:stun.qq.com:3478' },
        { urls: 'stun:stun.sipgate.net:3478' },
        { urls: 'stun:stun.antisip.com:3478' },
        { urls: 'stun:stun.counterpath.net:3478' },
        { urls: 'stun:stun.ekiga.net' },
        { urls: 'stun:stun.ideasip.com' },
        { urls: 'stun:stun.rixtelecom.se' },
        { urls: 'stun:stun.schlund.de' },
        // 自建TURN服务器（使用static-auth-secret）
        {
          urls: 'turn:172.245.47.251:3478',
          username: 'turnuser',
          credential: 'r20X6AncpXA4p3f7SL'
        },
        {
          urls: 'turn:172.245.47.251:3478?transport=tcp',
          username: 'turnuser',
          credential: 'r20X6AncpXA4p3f7SL'
        },
        // 免费TURN服务器（备用）
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
        },
        {
          urls: 'turn:openrelay.metered.ca:443?transport=udp',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        }
      ],
      iceCandidatePoolSize: 10,
      iceTransportPolicy: 'all' // 尝试所有连接方式
    }
  });
  
  peer.on('open', (id) => {
    console.log('PeerJS ID:', id);
  });
  
  peer.on('call', (call) => {
    console.log('收到呼叫');
    if (localStream) {
      call.answer(localStream);
      handleCall(call);
    }
  });
  
  peer.on('error', (err) => {
    console.error('PeerJS错误:', err);
  });
}

// 处理呼叫
function handleCall(call) {
  currentCall = call;
  
  call.on('stream', (remoteStream) => {
    console.log('收到远程流');
    remoteVideo.srcObject = remoteStream;
    videoContainer.classList.remove('hidden');
    videoStatus.textContent = '正在观看共享屏幕';
  });
  
  call.on('close', () => {
    console.log('呼叫关闭');
    videoStatus.textContent = '连接已关闭';
  });
  
  call.on('error', (err) => {
    console.error('呼叫错误:', err);
    videoStatus.textContent = '连接错误';
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
      
    case 'joined-room':
      showStatus('viewer-status', '已加入房间，正在连接...', 'info');
      // 观看者呼叫共享者
      if (message.peerId && localStream) {
        const call = peer.call(message.peerId, localStream);
        handleCall(call);
      }
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
  console.log('观看者加入:', viewerPeerId);
  
  if (peer && localStream && viewerPeerId) {
    const call = peer.call(viewerPeerId, localStream);
    handleCall(call);
  }
  
  updateViewerCount();
}

// 开始共享
async function startShare() {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: 'always',
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: true
    });
    
    localStream.getVideoTracks()[0].onended = () => {
      stopShare();
    };
    
    isSharer = true;
    initPeer();
    
    peer.on('open', (id) => {
      console.log('共享者PeerID:', id);
      ws.send(JSON.stringify({
        type: 'create-room',
        peerId: id
      }));
    });
    
  } catch (error) {
    console.error('获取屏幕流错误:', error);
    showStatus('sharer-status', '无法获取屏幕共享权限', 'error');
  }
}

// 停止共享
function stopShare() {
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
  
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: false,
      audio: true
    }).catch(() => null);
    
    // 如果没有获取到音频流，创建空流
    if (!localStream) {
      const ctx = new AudioContext();
      const oscillator = ctx.createOscillator();
      const dst = oscillator.connect(ctx.createMediaStreamDestination());
      oscillator.start();
      localStream = dst.stream;
    }
  } catch (e) {
    console.log('无音频流');
  }
  
  initPeer();
  
  peer.on('open', (id) => {
    console.log('观看者PeerID:', id);
    ws.send(JSON.stringify({
      type: 'join-room',
      shareCode: code,
      peerId: id
    }));
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
