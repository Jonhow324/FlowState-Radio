FROM node:22-alpine

# Install NeteaseCloudMusicApi Enhanced (community-maintained fork)
RUN npm install -g @neteasecloudmusicapienhanced/api

EXPOSE 3000

# Enhanced 版全局安装后命令为 `api`，默认监听 3000 端口
CMD ["api"]
