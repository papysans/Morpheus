# Morpheus 服务器部署指南（Docker）

本文用于单机服务器部署（你已有服务器 + 域名）。

## 1. 前置条件

- 服务器已安装 Docker 和 Docker Compose
- 域名已解析到服务器公网 IP
- 服务器安全组已放行 `80`（以及你需要的 `443`）

## 2. 准备配置

```bash
cd /path/to/Morpheus
cp backend/.env.example backend/.env
```

编辑 `backend/.env`，至少完成：

- `LLM_PROVIDER`
- 对应 API Key（`MINIMAX_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`）
- `CORS_ALLOW_ORIGINS`：填你的域名，如 `https://your-domain.com`
- `TRUSTED_HOSTS`：填你的域名，如 `your-domain.com,www.your-domain.com`

## 3. 部署前检查

```bash
./scripts/predeploy_check.sh
```

## 4. 启动服务

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

## 5. 验证

```bash
# 查看容器状态
docker compose -f docker-compose.prod.yml ps

# 查看后端健康检查
curl http://127.0.0.1/api/health
```

浏览器访问：

- `http://你的域名`

## 6. 日常运维

```bash
# 查看日志
docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml logs -f frontend

# 重启
docker compose -f docker-compose.prod.yml restart

# 停止
docker compose -f docker-compose.prod.yml down

# 更新后重建
# (先 git pull)
docker compose -f docker-compose.prod.yml up -d --build
```

## 7. 数据说明

- 项目数据通过 `./data:/app/data` 挂载持久化
- 备份时至少保留：`data/projects` 与 `data/logs`

## 8. HTTPS 建议

当前编排默认暴露 HTTP (`80`)。
生产建议：

- 在服务器前加 Nginx/Caddy 做 TLS 终止，或
- 使用云厂商负载均衡 + 证书托管

完成 TLS 后，将 `CORS_ALLOW_ORIGINS` 改为 `https://你的域名`。
