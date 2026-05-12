# sandbox-agent/Dockerfile
FROM node:20-alpine

RUN apk add --no-cache git docker-cli nginx && \
    git config --global --add safe.directory '*' && \
    git config --global user.email "sandbox@allaria.xyz" && \
    git config --global user.name "Allaria Sandbox"

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY src/ ./src/

EXPOSE 3100

CMD ["node", "src/index.js"]
