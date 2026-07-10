const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');
const { ExpressPeerServer } = require('peer');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PEER_PATH = '/p';
const ROOM_WS_PATH = '/ws';

const app = express();
const server = http.createServer(app);

function createPathScopedWebSocketServer(options) {
  const socketServer = new WebSocket.Server({ noServer: true });
  const peerWsPath = options.path.replace(/\/$/, '');

  options.server.on('upgrade', (req, socket, head) => {
    const urlPath = req.url.split('?')[0].replace(/\/$/, '');

    if (urlPath !== peerWsPath) {
      return;
    }

    socketServer.handleUpgrade(req, socket, head, (ws) => {
      socketServer.emit('connection', ws, req);
    });
  });

  return socketServer;
}

// PeerJS 挂载到主服务器同一端口
const peerServer = ExpressPeerServer(server, {
  path: PEER_PATH,
  allow_discovery: false,
  proxied: true,
  createWebSocketServer: createPathScopedWebSocketServer
});

app.use(peerServer);

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    peerPath: PEER_PATH,
    websocketPath: ROOM_WS_PATH
  });
});

app.use(express.static(PUBLIC_DIR));

app.use((req, res) => {
  res.status(404).send('File not found');
});

console.log(`PeerJS running on ${PEER_PATH}`);

const wss = new WebSocket.Server({ noServer: true });
const rooms = new Map();

server.on('upgrade', (req, socket, head) => {
  const urlPath = req.url.split('?')[0];

  if (urlPath === ROOM_WS_PATH || urlPath === '/') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
    return;
  }

  if (urlPath === PEER_PATH || urlPath.startsWith(`${PEER_PATH}/`)) {
    return;
  }

  socket.destroy();
});

function generateShareCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms.has(code));
  return code;
}

function safeSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(data));
      return true;
    } catch (e) {}
  }
  return false;
}

wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentViewerId = null;
  let isSharer = false;
  let heartbeatTimer = null;
  
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  
  heartbeatTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 25000);
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      
      if (message.type === 'heartbeat') {
        safeSend(ws, { type: 'heartbeat-ack' });
        return;
      }
      
      switch (message.type) {
        case 'create-room':
          const shareCode = generateShareCode();
          rooms.set(shareCode, {
            sharer: ws,
            sharerPeerId: message.peerId,
            viewers: new Map()
          });
          currentRoom = shareCode;
          isSharer = true;
          safeSend(ws, { type: 'room-created', shareCode });
          console.log(`房间已创建: ${shareCode}, PeerID: ${message.peerId}`);
          break;
          
        case 'join-room':
          const room = rooms.get(message.shareCode);
          if (!room) {
            safeSend(ws, { type: 'error', message: '共享码无效或房间不存在' });
            return;
          }
          
          if (room.sharer.readyState !== WebSocket.OPEN) {
            safeSend(ws, { type: 'error', message: '共享者已断开' });
            return;
          }
          
          const viewerId = Math.random().toString(36).substr(2, 9);
          room.viewers.set(viewerId, { ws, peerId: message.peerId });
          currentRoom = message.shareCode;
          currentViewerId = viewerId;
          isSharer = false;
          
          safeSend(ws, {
            type: 'joined-room',
            viewerId,
            peerId: room.sharerPeerId
          });
          
          safeSend(room.sharer, {
            type: 'viewer-joined',
            viewerId,
            peerId: message.peerId
          });
          
          console.log(`观看者 ${viewerId} 加入房间 ${message.shareCode}`);
          break;

        case 'request-call':
          if (!currentRoom || isSharer) return;

          const reconnectRoom = rooms.get(currentRoom);
          if (!reconnectRoom || reconnectRoom.sharer.readyState !== WebSocket.OPEN) return;

          const reconnectViewer = reconnectRoom.viewers.get(currentViewerId);
          if (!reconnectViewer) return;

          safeSend(reconnectRoom.sharer, {
            type: 'request-call',
            viewerId: currentViewerId,
            peerId: reconnectViewer.peerId
          });
          break;
      }
    } catch (e) {
      console.error('消息处理错误:', e);
    }
  });
  
  ws.on('close', () => {
    clearInterval(heartbeatTimer);
    
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        if (isSharer) {
          for (const [vid, viewer] of room.viewers) {
            safeSend(viewer.ws, { type: 'sharer-left' });
          }
          rooms.delete(currentRoom);
          console.log(`房间 ${currentRoom} 已关闭`);
        } else {
          room.viewers.delete(currentViewerId);
        }
      }
    }
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket错误:', err.message);
  });
});

setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.sharer.readyState !== WebSocket.OPEN) {
      for (const [vid, viewer] of room.viewers) {
        safeSend(viewer.ws, { type: 'sharer-left' });
      }
      rooms.delete(code);
    }
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});
