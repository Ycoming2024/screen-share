const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

// 创建HTTP服务器提供静态文件
const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  
  const extname = path.extname(filePath);
  let contentType = 'text/html';
  
  switch (extname) {
    case '.js':
      contentType = 'text/javascript';
      break;
    case '.css':
      contentType = 'text/css';
      break;
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

// 创建WebSocket服务器
const wss = new WebSocket.Server({ server });

// 房间管理：Map<shareCode, {sharer: ws, viewers: Map<viewerId, ws>}>
const rooms = new Map();

// 生成5位共享码
function generateShareCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 排除易混淆字符
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms.has(code));
  return code;
}

// 广播消息给房间内的所有观看者
function broadcastToViewers(shareCode, message, excludeWs = null) {
  const room = rooms.get(shareCode);
  if (!room) return;
  
  const messageStr = JSON.stringify(message);
  room.viewers.forEach((viewerWs, viewerId) => {
    if (viewerWs !== excludeWs && viewerWs.readyState === WebSocket.OPEN) {
      viewerWs.send(messageStr);
    }
  });
}

// 处理WebSocket连接
wss.on('connection', (ws) => {
  let currentRoom = null;
  let viewerId = null;
  let isSharer = false;
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      
      switch (message.type) {
        case 'create-room':
          // 共享者创建房间
          const shareCode = generateShareCode();
          rooms.set(shareCode, {
            sharer: ws,
            viewers: new Map()
          });
          currentRoom = shareCode;
          isSharer = true;
          
          ws.send(JSON.stringify({
            type: 'room-created',
            shareCode: shareCode
          }));
          console.log(`房间已创建: ${shareCode}`);
          break;
          
        case 'join-room':
          // 观看者加入房间
          const room = rooms.get(message.shareCode);
          if (!room) {
            ws.send(JSON.stringify({
              type: 'error',
              message: '共享码无效或房间不存在'
            }));
            return;
          }
          
          viewerId = Math.random().toString(36).substr(2, 9);
          room.viewers.set(viewerId, ws);
          currentRoom = message.shareCode;
          isSharer = false;
          
          // 通知观看者加入成功
          ws.send(JSON.stringify({
            type: 'joined-room',
            viewerId: viewerId
          }));
          
          // 通知共享者有新观看者
          if (room.sharer.readyState === WebSocket.OPEN) {
            room.sharer.send(JSON.stringify({
              type: 'viewer-joined',
              viewerId: viewerId
            }));
          }
          console.log(`观看者 ${viewerId} 加入房间 ${message.shareCode}`);
          break;
          
        case 'offer':
          // 转发SDP提议（从共享者到观看者）
          const offerRoom = rooms.get(message.shareCode);
          if (offerRoom && offerRoom.viewers.has(message.viewerId)) {
            const viewerWs = offerRoom.viewers.get(message.viewerId);
            if (viewerWs.readyState === WebSocket.OPEN) {
              viewerWs.send(JSON.stringify({
                type: 'offer',
                offer: message.offer,
                shareCode: message.shareCode
              }));
            }
          }
          break;
          
        case 'answer':
          // 转发SDP应答（从观看者到共享者）
          const answerRoom = rooms.get(message.shareCode);
          if (answerRoom && answerRoom.sharer.readyState === WebSocket.OPEN) {
            answerRoom.sharer.send(JSON.stringify({
              type: 'answer',
              answer: message.answer,
              viewerId: message.viewerId
            }));
          }
          break;
          
        case 'ice-candidate':
          // 转发ICE候选
          const iceRoom = rooms.get(message.shareCode);
          if (!iceRoom) return;
          
          if (isSharer && message.viewerId) {
            // 从共享者转发到指定观看者
            const targetViewer = iceRoom.viewers.get(message.viewerId);
            if (targetViewer && targetViewer.readyState === WebSocket.OPEN) {
              targetViewer.send(JSON.stringify({
                type: 'ice-candidate',
                candidate: message.candidate,
                shareCode: message.shareCode
              }));
            }
          } else if (!isSharer) {
            // 从观看者转发到共享者
            if (iceRoom.sharer.readyState === WebSocket.OPEN) {
              iceRoom.sharer.send(JSON.stringify({
                type: 'ice-candidate',
                candidate: message.candidate,
                viewerId: viewerId
              }));
            }
          }
          break;
      }
    } catch (e) {
      console.error('消息处理错误:', e);
    }
  });
  
  ws.on('close', () => {
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        if (isSharer) {
          // 共享者断开，通知所有观看者并删除房间
          broadcastToViewers(currentRoom, { type: 'sharer-left' });
          rooms.delete(currentRoom);
          console.log(`房间 ${currentRoom} 已关闭`);
        } else if (viewerId) {
          // 观看者断开，从房间移除
          room.viewers.delete(viewerId);
          if (room.sharer.readyState === WebSocket.OPEN) {
            room.sharer.send(JSON.stringify({
              type: 'viewer-left',
              viewerId: viewerId
            }));
          }
          console.log(`观看者 ${viewerId} 离开房间 ${currentRoom}`);
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});
