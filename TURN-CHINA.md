# 国内网络 TURN 配置

国内网络中 WebRTC 直连经常失败，必须让 TURN 走 443/tcp 或 443/tls。客户端已经同时尝试 `turn:443`、`turns:443` 和 `turns:5349`，服务器端至少要保证其中一条能在 `/test.html` 里测出 `relay > 0`。

## coturn 推荐配置

在 TURN 服务器上安装 coturn 后，如果这台机器的 443 没有被 nginx/HTTPS 占用，优先把 443 用作 TLS TURN：

```conf
listening-port=3478
tls-listening-port=443
alt-tls-listening-port=5349
listening-ip=0.0.0.0
relay-ip=172.245.47.251
external-ip=172.245.47.251

fingerprint
lt-cred-mech
user=turnuser:r20X6AncpXA4p3f7SL
realm=turn.ycoming.top

no-multicast-peers
no-cli
stale-nonce

cert=/etc/letsencrypt/live/turn.ycoming.top/fullchain.pem
pkey=/etc/letsencrypt/live/turn.ycoming.top/privkey.pem
```

如果 443 已经被网站 HTTPS 占用，就把 `tls-listening-port` 改回 `5349`，并另开普通 TCP 443：

```conf
listening-port=3478
tls-listening-port=5349
alt-listening-port=443
```

## 必须开放的端口

```bash
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 443/tcp
sudo ufw allow 5349/tcp
sudo ufw allow 49152:65535/udp
```

云服务器安全组也要放行同样端口。`turn.ycoming.top` 必须是 DNS only，不能走 Cloudflare 橙云代理。

## 验证

部署后打开 `/test.html`：

- `turns:turn.ycoming.top:443?transport=tcp` 优先应该出现 `relay > 0`
- 如果 443 只能跑普通 TCP，`turn:172.245.47.251:443?transport=tcp` 应该出现 `relay > 0`
- 如果 TLS 只能跑 5349，`turns:turn.ycoming.top:5349?transport=tcp` 应该出现 `relay > 0`

如果这些仍然是 0，说明 TURN 443/TLS 没有真正通，国内用户仍可能需要 VPN。
