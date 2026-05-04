# sandbox-agent/Dockerfile
FROM node:20-alpine

RUN apk add --no-cache git docker-cli nginx

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY src/ ./src/

EXPOSE 3100

CMD ["node", "src/index.js"]
