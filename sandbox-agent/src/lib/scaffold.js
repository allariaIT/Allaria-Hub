import fs from 'node:fs'
import path from 'node:path'

export function generateScaffold(projectDir, { name, title, userSlug }) {
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true })

  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
    name,
    private: true,
    version: '0.0.1',
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'vite build',
      preview: 'vite preview',
    },
    dependencies: {
      react: '^19.0.0',
      'react-dom': '^19.0.0',
    },
    devDependencies: {
      '@vitejs/plugin-react': '^4.0.0',
      vite: '^6.0.0',
    },
  }, null, 2))

  fs.writeFileSync(path.join(projectDir, 'vite.config.js'),
`import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/${userSlug}/${name}/',
})
`)

  fs.writeFileSync(path.join(projectDir, 'Dockerfile'),
`FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --package-lock-only
COPY . .
RUN npm ci
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
`)

  fs.writeFileSync(path.join(projectDir, 'nginx.conf'),
`server {
    listen 80;

    location /health {
        return 200 'ok';
        add_header Content-Type text/plain;
    }

    location / {
        root /usr/share/nginx/html;
        index index.html;
        try_files $uri $uri/ /index.html;
    }
}
`)

  fs.writeFileSync(path.join(projectDir, '.dockerignore'),
`node_modules
dist
.git
`)

  fs.writeFileSync(path.join(projectDir, 'index.html'),
`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.jsx"></script>
</body>
</html>
`)

  fs.writeFileSync(path.join(projectDir, 'src', 'main.jsx'),
`import { createRoot } from 'react-dom/client'
import App from './App'
import './App.css'

createRoot(document.getElementById('root')).render(<App />)
`)

  fs.writeFileSync(path.join(projectDir, 'src', 'App.jsx'),
`export default function App() {
  return (
    <div className="app">
      <h1>${title}</h1>
      <p>Proyecto creado con Allaria Hub Sandbox</p>
    </div>
  )
}
`)

  fs.writeFileSync(path.join(projectDir, 'src', 'App.css'),
`* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #fafafa; }
.app { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1rem; }
h1 { font-size: 2.5rem; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
p { color: #888; }
`)
}
