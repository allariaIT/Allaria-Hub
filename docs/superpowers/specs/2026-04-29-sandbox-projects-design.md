# Sandbox Projects - Design Spec

**Fecha:** 2026-04-29
**Estado:** Aprobado

## Goal

Permitir a los usuarios de Allaria Hub crear proyectos web desde el chat. La IA codea, buildea y deploya en containers aislados, dando una preview en vivo. Los cambios se pushean a GitLab.

## Architecture

```
Frontend (Chat.jsx)
  |
  v
Allaria Hub Backend (172.26.20.90:3098)
  |-- DB PostgreSQL (Project model)
  |-- GitLab API (gitlab.allaria.xyz)
  |-- Tool calling via LiteLLM
  |
  v (HTTP requests)
Sandbox Agent (172.30.200.101:3100)
  |-- Filesystem: /projects/{user-slug}/{project-name}/
  |-- Docker: build + run containers (ports 4001-4100)
  |-- Nginx: reverse proxy on :3099
```

**Preview URL:** `proyectos-sandbox.allaria.xyz:3099/{user-slug}/{project-name}/`

**ELB:** `proyectos-sandbox.allaria.xyz` → 172.30.200.101:3099

## Sandbox Agent

Servicio Express liviano corriendo en 172.30.200.101:3100. No tiene DB propia — usa el filesystem como source of truth para estado local.

**Auth:** Shared secret en header `X-Sandbox-Key`. Solo acepta requests del backend de Allaria Hub.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/projects` | Crea carpeta, scaffold Vite+React, genera Dockerfile, git init |
| GET | `/projects` | Lista proyectos con estado (running/stopped/building) |
| GET | `/projects/:user/:name` | Info del proyecto (puerto, URL, status, archivos) |
| DELETE | `/projects/:user/:name` | Para container, borra carpeta |
| POST | `/projects/:user/:name/files` | Escribe/sobreescribe un archivo (body: {path, content}) |
| GET | `/projects/:user/:name/files/*path` | Lee un archivo |
| GET | `/projects/:user/:name/tree` | Lista estructura de archivos |
| POST | `/projects/:user/:name/build` | Docker build + run + actualiza nginx config |
| POST | `/projects/:user/:name/stop` | Para el container |
| POST | `/projects/:user/:name/push` | Git add + commit + push a GitLab |
| POST | `/projects/:user/:name/exec` | Ejecuta comando dentro del container |

### Filesystem Structure

```
/projects/
  juan-perez/
    dashboard-ventas/
      index.html
      package.json
      vite.config.js
      Dockerfile
      .dockerignore
      src/
        main.jsx
        App.jsx
        App.css
    landing-clientes/
      ...
  maria-gomez/
    portal-rrhh/
      ...
```

### Port Pool

Puertos 4001-4100 (max 100 proyectos concurrentes). El agente asigna el primer puerto libre escaneando containers activos.

### Nginx Config

El agente mantiene `/etc/nginx/conf.d/sandbox-projects.conf`:

```nginx
server {
    listen 3099;

    location /juan-perez/dashboard-ventas/ {
        proxy_pass http://localhost:4001/;
    }

    location /maria-gomez/portal-rrhh/ {
        proxy_pass http://localhost:4002/;
    }
}
```

Se regenera y recarga nginx cada vez que se crea, buildea o destruye un proyecto.

### Docker Container per Project

Cada proyecto corre en su propio container aislado:
- Container name: `sandbox-{user-slug}-{project-name}`
- Image tag: `sandbox-{user-slug}-{project-name}:latest`
- Port mapping: `{assigned-port}:80`
- Restart policy: `unless-stopped`

### Scaffold Template (Vite + React)

Al crear un proyecto se generan estos archivos:

**package.json:**
```json
{
  "name": "{project-name}",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.0.0",
    "vite": "^6.0.0"
  }
}
```

**vite.config.js:**
```javascript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/{user-slug}/{project-name}/',
})
```

**Dockerfile:**
```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
```

**src/App.jsx:** Landing page basica con el titulo del proyecto.

**src/main.jsx:** Entry point estandar de React.

**src/App.css:** Estilos basicos.

**index.html:** HTML base con root div.

**.dockerignore:** node_modules, dist, .git

## GitLab Integration

- **API:** gitlab.allaria.xyz con token `glpat-...`
- **Grupo:** `allaria-sandbox` (https://gitlab.allaria.xyz/allaria-sandbox)
- **Repo naming:** `{user-slug}-{project-name}` (ej: `juan-perez-dashboard-ventas`)
- **Repo URL:** `https://gitlab.allaria.xyz/allaria-sandbox/{user-slug}-{project-name}`

Al crear un proyecto:
1. Crear repo en GitLab via API
2. Git init en la carpeta local
3. Git remote add origin
4. Push inicial con scaffold

Al pushear cambios:
1. Git add -A
2. Git commit -m "{message}"
3. Git push

## Allaria Hub Backend — Conector "sandbox"

### Prisma Model

```prisma
model Project {
  id          String   @id @default(cuid())
  name        String            // "dashboard-ventas" (slug)
  title       String            // "Dashboard de Ventas"
  description String?
  userId      String
  user        User     @relation(fields: [userId], references: [id])
  gitlabId    Int?              // ID del repo en GitLab
  repoUrl     String?           // URL del repo
  port        Int?              // Puerto asignado
  status      String   @default("creating") // creating, running, stopped, error
  previewUrl  String?           // URL completa de preview
  template    String   @default("vite-react")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([userId, name])
  @@index([userId])
}
```

Agregar `projects Project[]` en el modelo User.

### Tool Definitions

| Tool | Args | Confirmable | Description |
|------|------|-------------|-------------|
| `sandbox_create_project` | name, title, description? | Yes | Crea repo GitLab + scaffold + build + deploy preview |
| `sandbox_write_file` | projectName, filePath, content | No | Escribe/modifica un archivo |
| `sandbox_read_file` | projectName, filePath | No | Lee contenido de un archivo |
| `sandbox_list_files` | projectName | No | Lista estructura de archivos |
| `sandbox_build` | projectName | No | Rebuild container + deploy |
| `sandbox_push` | projectName, message | Yes | Git commit + push a GitLab |
| `sandbox_status` | projectName | No | Estado del proyecto (running, URL, etc.) |

### Tool Flow

Las tools del backend no ejecutan nada directamente — hacen HTTP requests al Sandbox Agent.

**Crear proyecto:**
1. Derivar user slug del email: `juan.perez@allaria.com` → `juan-perez`
2. Crear repo en GitLab via API (POST /api/v4/projects)
3. Crear Project en DB (status: "creating")
4. POST al Sandbox Agent `/projects` con {userSlug, name, title, repoUrl}
5. Agente: scaffold + docker build + run + nginx config
6. Actualizar Project en DB con port, previewUrl, status: "running"
7. Devolver URL de preview al LLM

**Escribir archivo:**
1. POST al Sandbox Agent `/projects/:user/:name/files` con {path, content}
2. Agente escribe el archivo en disco

**Build:**
1. POST al Sandbox Agent `/projects/:user/:name/build`
2. Agente: docker build + run + nginx reload
3. Actualizar status en DB

**Push:**
1. POST al Sandbox Agent `/projects/:user/:name/push` con {message}
2. Agente: git add -A + commit + push

## Frontend

### Project Picker (en la pagina de Proyectos)

Lista los proyectos del usuario con:
- Nombre, titulo, status (badge)
- URL de preview (link)
- Link al repo en GitLab
- Boton para abrir en el chat

### Chat Integration

El conector "sandbox" aparece en el ConnectorPicker igual que Gmail, Calendar, etc. Al activarlo, el LLM tiene acceso a las tools de sandbox.

System prompt cuando sandbox esta activo:
"Tenes acceso al sandbox de proyectos. Podes crear proyectos web con Vite+React, escribir archivos, buildear y deployar previews. Cuando crees o modifiques archivos, hacelo directamente con las tools. Despues de modificar archivos, siempre llama sandbox_build para que el usuario vea los cambios."

## Environment Variables

### Allaria Hub Backend (.env)
```
SANDBOX_AGENT_URL=http://172.30.200.101:3100
SANDBOX_AGENT_KEY={shared-secret}
GITLAB_URL=https://gitlab.allaria.xyz
GITLAB_TOKEN=glpat-...
GITLAB_GROUP_ID=54
```

### Sandbox Agent (.env)
```
PORT=3100
SANDBOX_KEY={same-shared-secret}
PROJECTS_DIR=/projects
NGINX_CONFIG_PATH=/etc/nginx/conf.d/sandbox-projects.conf
PORT_RANGE_START=4001
PORT_RANGE_END=4100
```

## Security

- Sandbox Agent solo acepta requests con `X-Sandbox-Key` valido
- Cada proyecto corre en su propio container Docker (aislamiento)
- Los containers no tienen acceso a la red del host (network mode default)
- El agente no expone puertos de containers directamente — todo pasa por nginx :3099
- Los archivos de cada usuario estan separados por carpeta

## MVP Scope

1. Crear proyecto desde el chat (scaffold Vite+React + build + preview)
2. Modificar archivos desde el chat (write_file + build)
3. Ver preview en vivo (nginx reverse proxy)
4. Push a GitLab
5. Ver estado del proyecto
6. Un solo template: Vite + React

## Out of Scope (post-MVP)

- Mas templates (Next.js, Node API, Python)
- Branches y PRs
- Logs del container en el chat
- Terminal interactiva
- Colaboracion multi-usuario en un proyecto
- CI/CD pipeline de produccion (reusar el template docker-deployment existente)
- Subdominios por proyecto
- Automatizacion de Huawei Cloud API (DNS, ELB)
