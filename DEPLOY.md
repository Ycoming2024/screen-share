# 屏幕共享 - 服务器部署指南

## 一、本地准备（Git）

```bash
# 1. 初始化 Git 仓库
git init

# 2. 创建 .gitignore
echo "node_modules/" > .gitignore

# 3. 添加文件并提交
git add .
git commit -m "初始提交：屏幕共享应用"

# 4. 在 GitHub/Gitee 创建仓库后，关联远程仓库
git remote add origin https://github.com/你的用户名/screen-share.git
git push -u origin main
```

## 二、服务器部署

### 1. 登录服务器
```bash
ssh root@你的服务器IP
```

### 2. 安装 Node.js
```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# CentOS/RHEL
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

# 验证安装
node -v
npm -v
```

### 3. 克隆项目
```bash
cd /var/www
git clone https://github.com/你的用户名/screen-share.git
cd screen-share
```

### 4. 安装依赖
```bash
npm install
```

### 5. 测试运行
```bash
node server.js
# 访问 http://服务器IP:8080 测试
# Ctrl+C 停止
```

### 6. 使用 PM2 进程管理（推荐）
```bash
# 安装 PM2
npm install -g pm2

# 启动应用
pm2 start server.js --name screen-share

# 常用命令
pm2 list              # 查看进程
pm2 logs screen-share # 查看日志
pm2 restart screen-share # 重启
pm2 stop screen-share    # 停止

# 开机自启
pm2 startup
pm2 save
```

### 7. 配置 Nginx 反向代理（可选，用于域名和SSL）
```bash
# 安装 Nginx
sudo apt install nginx  # Ubuntu
sudo yum install nginx  # CentOS

# 创建配置文件
sudo nano /etc/nginx/sites-available/screen-share
```

Nginx 配置内容：
```nginx
server {
    listen 80;
    server_name 你的域名.com;  # 或服务器IP

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

```bash
# 启用配置
sudo ln -s /etc/nginx/sites-available/screen-share /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### 8. 配置 SSL 证书（HTTPS，WebRTC 必需）

```bash
# 安装 Certbot
sudo apt install certbot python3-certbot-nginx  # Ubuntu
sudo yum install certbot python3-certbot-nginx  # CentOS

# 申请证书
sudo certbot --nginx -d 你的域名.com

# 自动续期
sudo certbot renew --dry-run
```

## 三、防火墙配置

```bash
# Ubuntu (UFW)
sudo ufw allow 80
sudo ufw allow 443
sudo ufw allow 8080  # 如果不用Nginx

# CentOS (firewalld)
sudo firewall-cmd --permanent --add-port=80/tcp
sudo firewall-cmd --permanent --add-port=443/tcp
sudo firewall-cmd --reload
```

## 四、访问地址

- 无 Nginx：`http://服务器IP:8080`
- 有 Nginx：`http://你的域名.com`
- 有 SSL：`https://你的域名.com`（推荐，WebRTC 完整功能）

## 五、注意事项

1. **HTTPS 必需**：WebRTC 的屏幕共享功能在非 localhost 环境下需要 HTTPS
2. **域名**：如果没有域名，可以使用服务器 IP，但无法申请 SSL 证书
3. **带宽**：多人观看时，共享者的上行带宽会成倍消耗
4. **端口**：确保服务器防火墙开放了相应端口
