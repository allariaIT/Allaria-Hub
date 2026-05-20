FROM node:23-alpine

RUN apk add --no-cache git openssh-client

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

ENV PORT=3200
ENV WORKSPACE_DIR=/workspace

RUN mkdir -p /workspace && chown node:node /workspace

EXPOSE 3200
USER node
CMD ["node", "src/index.js"]
