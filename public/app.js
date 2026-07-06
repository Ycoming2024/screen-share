// WebRTC配置
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

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
let localStream = null;
let peerConnections = new Map(); // Map<viewerId, RTCPeerConnection>
let isSharer = false;
let currentShareCode = null;
let viewerId = null;

// 连接WebSocket服务器
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}`);
  
  ws.onopen = () => {
    console.log('已连接到服务器');
  };
  
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    handleMessage(message);
  };
  
  ws.onclose = () => {
    console.log('与服务器断开连接');
    showStatus('sharer-status', '与服务器断开连接', 'error');
    showStatus('viewer-status', '与服务器断开连接', 'error');
  };
  
  ws.onerror = (error) => {
    console.error('WebSocket错误:', error);
    showStatus('sharer-status', '连接错误', 'error');
    showStatus('viewer-status', '连接错误', 'error');
  };
}

// 处理接收到的消息
function handleMessage(message) {
  switch (message.type) {
    case 'room-created':
      currentShareCode = message.shareCode;
      shareCodeDisplay.textContent = message.shareCode;
      shareInfo.classList.remove('hidden');
      startShareBtn.classList.add('hidden');
      showStatus('sharer-status', '共享已开始，等待观看者加入...', 'success');
      break;
      
    case 'viewer-joined':
      handleViewerJoined(message.viewerId);
      break;
      
    case 'viewer-left':
      handleViewerLeft(message.viewerId);
      break;
      
    case 'joined-room':
      viewerId = message.viewerId;
      showStatus('viewer-status', '已加入房间，正在连接...', 'info');
      break;
      
    case 'offer':
      handleOffer(message.offer, message.shareCode);
      break;
      
    case 'answer':
      handleAnswer(message.answer, message.viewerId);
      break;
      
    case 'ice-candidate':
      handleIceCandidate(message.candidate, message.viewerId || message.shareCode);
      break;
      
    case 'sharer-left':
      showStatus('viewer-status', '共享者已停止共享', 'error');
      closePeerConnection();
      videoContainer.classList.add('hidden');
      break;
      
    case 'error':
      showStatus('viewer-status', message.message, 'error');
      break;
  }
}

// 共享者：处理新观看者加入
async function handleViewerJoined(newViewerId) {
  console.log('观看者加入:', newViewerId);
  
  try {
    const pc = createPeerConnection(newViewerId);
    peerConnections.set(newViewerId, pc);
    
    // 添加本地流到连接
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
    
    // 创建并发送offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    ws.send(JSON.stringify({
      type: 'offer',
      offer: offer,
      viewerId: newViewerId,
      shareCode: currentShareCode
    }));
    
    updateViewerCount();
  } catch (error) {
    console.error('处理观看者加入错误:', error);
  }
}

// 共享者：处理观看者离开
function handleViewerLeft(leavingViewerId) {
  console.log('观看者离开:', leavingViewerId);
  
  const pc = peerConnections.get(leavingViewerId);
  if (pc) {
    pc.close();
    peerConnections.delete(leavingViewerId);
  }
  
  updateViewerCount();
}

// 创建PeerConnection
function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection(rtcConfig);
  
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({
        type: 'ice-candidate',
        candidate: event.candidate,
        viewerId: isSharer ? peerId : currentShareCode,
        shareCode: currentShareCode
      }));
    }
  };
  
  if (!isSharer) {
    pc.ontrack = (event) => {
      console.log('收到远程流');
      remoteVideo.srcObject = event.streams[0];
      videoContainer.classList.remove('hidden');
      videoStatus.textContent = '正在观看共享屏幕';
    };
  }
  
  pc.onconnectionstatechange = () => {
    console.log('连接状态:', pc.connectionState);
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      if (!isSharer) {
        videoStatus.textContent = '连接断开';
      }
    }
  };
  
  return pc;
}

// 观看者：处理offer
async function handleOffer(offer, shareCode) {
  try {
    const pc = createPeerConnection(shareCode);
    peerConnections.set(shareCode, pc);
    
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    ws.send(JSON.stringify({
      type: 'answer',
      answer: answer,
      viewerId: viewerId,
      shareCode: shareCode
    }));
  } catch (error) {
    console.error('处理offer错误:', error);
  }
}

// 共享者：处理answer
async function handleAnswer(answer, fromViewerId) {
  try {
    const pc = peerConnections.get(fromViewerId);
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
  } catch (error) {
    console.error('处理answer错误:', error);
  }
}

// 处理ICE候选
async function handleIceCandidate(candidate, peerId) {
  try {
    const pc = peerConnections.get(peerId);
    if (pc) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  } catch (error) {
    console.error('处理ICE候选错误:', error);
  }
}

// 开始共享屏幕
async function startShare() {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: 'always'
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true
      }
    });
    
    localStream.getVideoTracks()[0].onended = () => {
      stopShare();
    };
    
    isSharer = true;
    ws.send(JSON.stringify({ type: 'create-room' }));
    
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
  
  peerConnections.forEach(pc => pc.close());
  peerConnections.clear();
  
  isSharer = false;
  currentShareCode = null;
  
  shareInfo.classList.add('hidden');
  startShareBtn.classList.remove('hidden');
  sharerStatus.textContent = '';
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
    connectWebSocket();
  }
}

// 加入共享
async function joinShare() {
  const code = shareCodeInput.value.trim().toUpperCase();
  
  if (code.length !== 5) {
    showStatus('viewer-status', '请输入5位共享码', 'error');
    return;
  }
  
  currentShareCode = code;
  isSharer = false;
  
  ws.send(JSON.stringify({
    type: 'join-room',
    shareCode: code
  }));
}

// 关闭PeerConnection
function closePeerConnection() {
  peerConnections.forEach(pc => pc.close());
  peerConnections.clear();
}

// 显示状态信息
function showStatus(elementId, message, type) {
  const element = document.getElementById(elementId);
  element.textContent = message;
  element.className = `status ${type}`;
}

// 更新观看者数量显示
function updateViewerCount() {
  const count = peerConnections.size;
  const countDisplay = document.getElementById('viewer-count');
  
  if (count > 0) {
    if (!countDisplay) {
      const span = document.createElement('span');
      span.id = 'viewer-count';
      span.className = 'viewer-count';
      sharerStatus.parentNode.insertBefore(span, sharerStatus.nextSibling);
    }
    document.getElementById('viewer-count').textContent = `${count} 人正在观看`;
  } else if (countDisplay) {
    countDisplay.remove();
  }
}

// 全屏功能
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    videoContainer.requestFullscreen().catch(err => {
      console.error('全屏错误:', err);
      // 降级：创建放大遮罩
      createVideoOverlay();
    });
  } else {
    document.exitFullscreen();
  }
}

// 创建视频放大遮罩
function createVideoOverlay() {
  // 移除已存在的遮罩
  const existingOverlay = document.querySelector('.video-overlay');
  if (existingOverlay) {
    existingOverlay.remove();
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
    if (e.target === overlay) {
      overlay.remove();
    }
  };
  
  overlay.appendChild(video);
  overlay.appendChild(closeBtn);
  document.body.appendChild(overlay);
}

// 画中画功能
async function togglePictureInPicture() {
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (remoteVideo.srcObject) {
      await remoteVideo.requestPictureInPicture();
    }
  } catch (error) {
    console.error('画中画错误:', error);
    showStatus('video-status', '画中画不可用', 'error');
  }
}

// 视频点击放大
remoteVideo.addEventListener('click', createVideoOverlay);

// 事件监听
startShareBtn.addEventListener('click', startShare);
stopShareBtn.addEventListener('click', stopShare);
joinBtn.addEventListener('click', joinShare);
fullscreenBtn.addEventListener('click', toggleFullscreen);
pipBtn.addEventListener('click', togglePictureInPicture);

shareCodeInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    joinShare();
  }
});

shareCodeInput.addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase();
});

// 初始化
connectWebSocket();
