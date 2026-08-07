FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY instagram-bot.js ./
ENV IG_HEADLESS=1 IG_AUTO_START=1 IG_DATA_DIR=/data
VOLUME ["/data"]
CMD ["node", "instagram-bot.js", "--headless", "--auto"]
