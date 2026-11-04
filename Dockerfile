FROM node:22-slim

WORKDIR /app

# openssl：Prisma schema-engine 运行所需（npm install 的 postinstall 会自动 prisma generate）
# ca-certificates：确保 npm 下载依赖时 HTTPS 正常
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# 拷贝源码（node_modules / dist / data / .env 等由 .dockerignore 排除）
COPY . .

# 安装全部依赖（含 dev，用于构建前端）
RUN npm install

# 构建前端产物 dist/（server.js 生产环境托管 dist）
RUN npm run build

ENV NODE_ENV=production

# Koyeb 会注入 PORT 环境变量，server.js 自动读取；此处仅作文档说明
EXPOSE 3000

CMD ["node", "server.js"]
