const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

// 获取项目根目录
const ROOT_DIR = process.cwd();

const server = http.createServer((req, res) => {
  // 移除查询参数
  const urlPath = req.url.split('?')[0];
  let filePath = path.join(ROOT_DIR, 'public', urlPath === '/' ? 'index.html' : urlPath);
  
  console.log('请求路径:', req.url);
  console.log('文件路径:', filePath);
  console.log('文件存在:', fs.existsSync(filePath));
  
  const extname = path.extname(filePath);
  let contentType = 'text/html';
  
  switch (extname) {
    case '.js': contentType = 'text/javascript'; break;
    case '.css': contentType = 'text/css'; break;
  }
  
  fs.readFile(filePath, (err, content) => {
    if (err) {
      console.log('文件读取错误:', err.message);
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('文件未找到: ' + urlPath);
      } else {
        res.writeHead(500);
        res.end('服务器错误');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();

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
          isSharer = false;
          
          // 通知观看者加入成功，并发送共享者的PeerID
          safeSend(ws, {
            type: 'joined-room',
            viewerId,
            peerId: room.sharerPeerId
          });
          
          // 通知共享者有新观看者，发送观看者的PeerID
          safeSend(room.sharer, {
            type: 'viewer-joined',
            viewerId,
            peerId: message.peerId
          });
          
          console.log(`观看者 ${viewerId} 加入房间 ${message.shareCode}`);
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
          room.viewers.delete(currentRoom);
        }
      }
    }
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket错误:', err.message);
  });
});

// 定期清理无效房间
setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.sharer.readyState !== WebSocket.OPEN) {
      for (const [vid, viewer] of room.viewers) {
        safeSend(viewer.ws, { type: 'sharer-left' });
      }
      rooms.delete(code);
      console.log(`清理无效房间: ${code}`);
    }
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});
