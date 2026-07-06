const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

// 创建HTTP服务器
const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  
  const extname = path.extname(filePath);
  let contentType = 'text/html';
  
  switch (extname) {
    case '.js': contentType = 'text/javascript'; break;
    case '.css': contentType = 'text/css'; break;
  }
  
  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('文件未找到');
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

// 房间管理
const rooms = new Map();

// 生成5位共享码
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

// 安全发送消息
function safeSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(data));
      return true;
    } catch (e) {
      console.error('发送消息失败:', e);
    }
  }
  return false;
}

// 清理断开的连接
function cleanRoom(shareCode) {
  const room = rooms.get(shareCode);
  if (!room) return;
  
  // 清理断开的观看者
  for (const [vid, ws] of room.viewers) {
    if (ws.readyState !== WebSocket.OPEN) {
      room.viewers.delete(vid);
      console.log(`清理断开的观看者: ${vid}`);
    }
  }
}

wss.on('connection', (ws) => {
  let currentRoom = null;
  let viewerId = null;
  let isSharer = false;
  let heartbeatTimer = null;
  
  // 心跳检测
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  
  // 启动心跳
  heartbeatTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 25000);
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      
      // 心跳响应
      if (message.type === 'heartbeat') {
        safeSend(ws, { type: 'heartbeat-ack' });
        return;
      }
      
      switch (message.type) {
        case 'create-room':
          const shareCode = generateShareCode();
          rooms.set(shareCode, {
            sharer: ws,
            viewers: new Map(),
            createdAt: Date.now()
          });
          currentRoom = shareCode;
          isSharer = true;
          
          safeSend(ws, { type: 'room-created', shareCode });
          console.log(`房间已创建: ${shareCode}`);
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
          
          viewerId = Math.random().toString(36).substr(2, 9);
          room.viewers.set(viewerId, ws);
          currentRoom = message.shareCode;
          isSharer = false;
          
          safeSend(ws, { type: 'joined-room', viewerId });
          safeSend(room.sharer, { type: 'viewer-joined', viewerId });
          console.log(`观看者 ${viewerId} 加入房间 ${message.shareCode}`);
          break;
          
        case 'offer':
          const offerRoom = rooms.get(message.shareCode);
          if (offerRoom) {
            const viewer = offerRoom.viewers.get(message.viewerId);
            if (viewer) {
              safeSend(viewer, {
                type: 'offer',
                offer: message.offer,
                shareCode: message.shareCode
              });
            }
          }
          break;
          
        case 'answer':
          const answerRoom = rooms.get(message.shareCode);
          if (answerRoom) {
            safeSend(answerRoom.sharer, {
              type: 'answer',
              answer: message.answer,
              viewerId: message.viewerId
            });
          }
          break;
          
        case 'ice-candidate':
          const iceRoom = rooms.get(message.shareCode);
          if (!iceRoom) return;
          
          if (isSharer && message.viewerId) {
            const targetViewer = iceRoom.viewers.get(message.viewerId);
            safeSend(targetViewer, {
              type: 'ice-candidate',
              candidate: message.candidate,
              shareCode: message.shareCode
            });
          } else if (!isSharer) {
            safeSend(iceRoom.sharer, {
              type: 'ice-candidate',
              candidate: message.candidate,
              viewerId: viewerId
            });
          }
          break;
          
        case 'reconnect-request':
          // 观看者请求重新连接
          if (!isSharer && currentRoom) {
            const reRoom = rooms.get(currentRoom);
            if (reRoom && reRoom.sharer.readyState === WebSocket.OPEN) {
              safeSend(reRoom.sharer, {
                type: 'viewer-reconnect',
                viewerId: viewerId
              });
            }
          }
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
          // 通知所有观看者
          for (const [vid, viewerWs] of room.viewers) {
            safeSend(viewerWs, { type: 'sharer-left' });
          }
          rooms.delete(currentRoom);
          console.log(`房间 ${currentRoom} 已关闭`);
        } else if (viewerId) {
          room.viewers.delete(viewerId);
          safeSend(room.sharer, { type: 'viewer-left', viewerId });
          console.log(`观看者 ${viewerId} 离开房间 ${currentRoom}`);
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
      // 通知观看者
      for (const [vid, viewerWs] of room.viewers) {
        safeSend(viewerWs, { type: 'sharer-left' });
      }
      rooms.delete(code);
      console.log(`清理无效房间: ${code}`);
    } else {
      cleanRoom(code);
    }
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});
