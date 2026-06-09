# ToClaw WebChat 🐺

小头虾的私有 WebChat 套壳，基于 OpenClaw Gateway。

## 功能

- 🔒 Caddy 反向代理 + Basic Auth 保护
- 💬 WebSocket 实时对话
- 📥 对话导出（JSON + Markdown）
- 📱 移动端适配
- 🔄 自动重连

## 安全

- Gateway token 只在服务端，前端不可见
- Basic Auth 保护所有访问
- WebSocket 通过反向代理转发

## 部署

详见 `deploy.sh` 和 `Caddyfile`。
# test
