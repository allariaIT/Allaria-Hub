FROM node:20-alpine

# Variables por defecto (el compose las sobreescribe)
ENV REPO_NAME="allaria-project"
ENV APP_PORT=8080

WORKDIR /app

# Creamos un server básico en una sola línea para evitar archivos externos
CMD node -e "const http = require('http'); \
    const server = http.createServer((req, res) => { \
      res.writeHead(200, {'Content-Type': 'text/html'}); \
      res.end('<h1>🚀 Project: ' + process.env.REPO_NAME + ' is ONLINE</h1>'); \
    }); \
    server.listen(process.env.APP_PORT, () => { \
      console.log('[' + new Date().toISOString() + '] ' + process.env.REPO_NAME + ' started on port ' + process.env.APP_PORT); \
    });"
