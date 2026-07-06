// WebRTC配置
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.miwifi.com:3478' },
    { urls: 'stun:stun.qq.com:3478' },
    // 公共TURN服务器（免费但不太稳定）
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
  ],
  iceCandidatePoolSize: 10,
  iceTransportPolicy: 'all'
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
let peerConnections = new Map();
let isSharer = false;
let currentShareCode = null;
let viewerId = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// WebSocket连接
function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}`);
  
  ws.onopen = () => {
    console.log('已连接到服务器');
    reconnectAttempts = 0;
    startHeartbeat();
    
    // 如果之前有共享码，尝试重连
    if (currentShareCode && !isSharer && viewerId) {
      ws.send(JSON.stringify({
        type: 'join-room',
        shareCode: currentShareCode
      }));
    }
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
    console.log('与服务器断开连接');
    stopHeartbeat();
    
    if (isSharer) {
      showStatus('sharer-status', '连接断开，正在重连...', 'error');
    } else if (currentShareCode) {
      showStatus('viewer-status', '连接断开，正在重连...', 'error');
    }
    
    attemptReconnect();
  };
  
  ws.onerror = (error) => {
    console.error('WebSocket错误:', error);
  };
}

// 心跳机制
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

// 重连逻辑
function attemptReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    showStatus('sharer-status', '重连失败，请刷新页面', 'error');
    showStatus('viewer-status', '重连失败，请刷新页面', 'error');
    return;
  }
  
  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), 10000);
  
  console.log(`尝试重连 (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
  
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    connectWebSocket();
  }, delay);
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
      handleViewerJoined(message.viewerId);
      break;
      
    case 'viewer-left':
      handleViewerLeft(message.viewerId);
      break;
      
    case 'viewer-reconnect':
      // 观看者重连，重新发送offer
      handleViewerJoined(message.viewerId);
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
      closeAllPeerConnections();
      videoContainer.classList.add('hidden');
      currentShareCode = null;
      viewerId = null;
      break;
      
    case 'error':
      showStatus('viewer-status', message.message, 'error');
      break;
  }
}

// 共享者：处理观看者加入
async function handleViewerJoined(newViewerId) {
  console.log('观看者加入:', newViewerId);
  
  try {
    // 如果已有连接，先关闭
    if (peerConnections.has(newViewerId)) {
      peerConnections.get(newViewerId).close();
    }
    
    const pc = createPeerConnection(newViewerId);
    peerConnections.set(newViewerId, pc);
    
    // 添加本地流
    if (localStream) {
      localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });
    }
    
    // 创建offer
    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true
    });
    await pc.setLocalDescription(offer);
    
    // 发送offer
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

// 处理观看者离开
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
  
  // ICE候选处理
  pc.onicecandidate = (event) => {
    if (event.candidate && ws.readyState === WebSocket.OPEN) {
      console.log('发送ICE候选:', event.candidate.type);
      ws.send(JSON.stringify({
        type: 'ice-candidate',
        candidate: event.candidate,
        viewerId: isSharer ? peerId : currentShareCode,
        shareCode: currentShareCode
      }));
    } else if (!event.candidate) {
      console.log('ICE候选收集完成');
    }
  };
  
  // ICE收集状态
  pc.onicegatheringstatechange = () => {
    console.log('ICE收集状态:', pc.iceGatheringState);
  };
  
  if (!isSharer) {
    pc.ontrack = (event) => {
      console.log('收到远程流');
      if (event.streams && event.streams[0]) {
        remoteVideo.srcObject = event.streams[0];
        videoContainer.classList.remove('hidden');
        videoStatus.textContent = '正在观看共享屏幕';
      }
    };
  }
  
  // 连接状态监控
  pc.onconnectionstatechange = () => {
    console.log('连接状态:', pc.connectionState);
    
    switch (pc.connectionState) {
      case 'connected':
        if (!isSharer) {
          videoStatus.textContent = '正在观看共享屏幕';
        }
        break;
      case 'disconnected':
        if (!isSharer) {
          videoStatus.textContent = '连接中断，尝试恢复中...';
          // 尝试恢复
          setTimeout(() => {
            if (pc.connectionState === 'disconnected') {
              pc.restartIce();
            }
          }, 2000);
        }
        break;
      case 'failed':
        if (!isSharer) {
          videoStatus.textContent = '连接失败，请刷新重试';
        }
        // 关闭失败的连接
        pc.close();
        peerConnections.delete(peerId);
        updateViewerCount();
        break;
    }
  };
  
  pc.oniceconnectionstatechange = () => {
    console.log('ICE状态:', pc.iceConnectionState);
    
    if (pc.iceConnectionState === 'failed') {
      pc.restartIce();
    }
  };
  
  return pc;
}

// 处理offer
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

// 处理answer
async function handleAnswer(answer, fromViewerId) {
  try {
    const pc = peerConnections.get(fromViewerId);
    if (pc && pc.signalingState === 'have-local-offer') {
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
    if (pc && pc.remoteDescription) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  } catch (error) {
    console.error('处理ICE候选错误:', error);
  }
}

// 开始共享
async function startShare() {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: 'always',
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 }
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    
    // 监听轨道结束（用户停止共享）
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
  
  closeAllPeerConnections();
  
  isSharer = false;
  currentShareCode = null;
  
  shareInfo.classList.add('hidden');
  startShareBtn.classList.remove('hidden');
  sharerStatus.textContent = '';
  
  // 移除观看者数量显示
  const countDisplay = document.getElementById('viewer-count');
  if (countDisplay) countDisplay.remove();
}

// 加入共享
function joinShare() {
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

// 关闭所有PeerConnection
function closeAllPeerConnections() {
  peerConnections.forEach(pc => {
    try { pc.close(); } catch (e) {}
  });
  peerConnections.clear();
}

// 显示状态
function showStatus(elementId, message, type) {
  const element = document.getElementById(elementId);
  if (element) {
    element.textContent = message;
    element.className = `status ${type}`;
  }
}

// 更新观看者数量
function updateViewerCount() {
  const count = peerConnections.size;
  let countDisplay = document.getElementById('viewer-count');
  
  if (count > 0) {
    if (!countDisplay) {
      countDisplay = document.createElement('span');
      countDisplay.id = 'viewer-count';
      countDisplay.className = 'viewer-count';
      sharerStatus.parentNode.insertBefore(countDisplay, sharerStatus.nextSibling);
    }
    countDisplay.textContent = `${count} 人正在观看`;
  } else if (countDisplay) {
    countDisplay.remove();
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
  closeAllPeerConnections();
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
  }
});

// 诊断功能
async function runDiagnosis() {
  const resultDiv = document.getElementById('diagnosis-result');
  resultDiv.classList.remove('hidden');
  resultDiv.innerHTML = '<p>正在诊断...</p>';
  
  const results = [];
  
  // 1. 检查WebSocket连接
  results.push(`<strong>1. WebSocket连接:</strong> ${ws.readyState === WebSocket.OPEN ? '✅ 已连接' : '❌ 未连接'}`);
  
  // 2. 检查WebRTC支持
  const rtcSupported = !!(window.RTCPeerConnection && navigator.mediaDevices);
  results.push(`<strong>2. WebRTC支持:</strong> ${rtcSupported ? '✅ 支持' : '❌ 不支持'}`);
  
  // 3. 检查屏幕共享支持
  const screenSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  results.push(`<strong>3. 屏幕共享支持:</strong> ${screenSupported ? '✅ 支持' : '❌ 不支持'}`);
  
  // 4. 测试ICE服务器
  try {
    const pc = new RTCPeerConnection(rtcConfig);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    // 等待ICE候选收集
    await new Promise((resolve) => {
      const candidates = [];
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          candidates.push(e.candidate);
        } else {
          resolve(candidates);
        }
      };
      setTimeout(() => resolve(candidates), 5000);
    });
    
    const iceState = pc.iceConnectionState;
    results.push(`<strong>4. ICE服务器:</strong> ${iceState === 'failed' ? '❌ 连接失败' : '✅ 可用'}`);
    
    // 检查是否有relay候选（TURN服务器）
    const hasRelay = pc.localDescription.sdp.includes('typ relay');
    results.push(`<strong>5. TURN中继:</strong> ${hasRelay ? '✅ 可用' : '⚠️ 不可用（可能无法穿透NAT）'}`);
    
    pc.close();
  } catch (error) {
    results.push(`<strong>4. ICE服务器:</strong> ❌ 错误: ${error.message}`);
  }
  
  // 6. 网络信息
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (connection) {
    results.push(`<strong>6. 网络类型:</strong> ${connection.effectiveType || '未知'}`);
  }
  
  // 显示结果
  resultDiv.innerHTML = results.join('<br>');
  
  // 添加建议
  let suggestions = '<br><strong>建议:</strong><br>';
  if (!rtcSupported) {
    suggestions += '- 请使用最新版 Chrome/Edge/Firefox 浏览器<br>';
  }
  if (ws.readyState !== WebSocket.OPEN) {
    suggestions += '- 请检查服务器是否正常运行<br>';
  }
  suggestions += '- 如果跨网络连接失败，可能需要配置 TURN 服务器<br>';
  suggestions += '- 确保防火墙允许 WebRTC 通信（UDP端口）<br>';
  
  resultDiv.innerHTML += suggestions;
}

// 初始化
connectWebSocket();
