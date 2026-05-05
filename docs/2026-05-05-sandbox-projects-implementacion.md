# Sandbox Projects — Documentación Completa de Implementación

**Fecha:** 2026-05-05
**Sesión:** Implementación completa desde diseño hasta producción
**Estado:** En producción

---

## Índice

1. [Arquitectura general](#arquitectura-general)
2. [Infraestructura y servidores](#infraestructura-y-servidores)
3. [Sandbox Agent](#sandbox-agent)
4. [Allaria Hub Backend](#allaria-hub-backend)
5. [Frontend](#frontend)
6. [Deploy e infraestructura de red](#deploy-e-infraestructura-de-red)
7. [Problemas encontrados y soluciones](#problemas-encontrados-y-soluciones)
8. [Credenciales y variables de entorno](#credenciales-y-variables-de-entorno)
9. [Flujo completo de creación de un proyecto](#flujo-completo-de-creacion-de-un-proyecto)

---

## Arquitectura general

```
Browser (usuario)
  │
  ▼
ELB Huawei Cloud (23.227.176.14)
  │
  ├─► ia.allaria.xyz ──────────────────► 172.26.20.90:3097  (allaria-hub-front)
  │
  ├─► ia.allaria.xyz/api/* ────────────► 172.26.20.90:3098  (allaria-hub-back)
  │                                              │
  │                                              ├─► 172.26.20.32:5432  (PostgreSQL)
  │                                              ├─► gitlab.allaria.xyz (172.30.200.105)
  │                                              └─► 172.30.200.101:3100 (Sandbox Agent)
  │
  └─► proyectos-sandbox.allaria.xyz ──► 172.30.200.101:3099 (sandbox-nginx)
                                                 │
                                                 └─► localhost:4001-4100 (containers de proyectos)
```

**Dos servidores principales:**

| Servidor | IP | Rol |
|---|---|---|
| docker-srv-prd | 172.26.20.90 | App server: front (3097) + back (3098) |
| sandbox-srv | 172.30.200.101 | Sandbox: agent (3100) + nginx (3099) + containers proyectos (4001-4100) |

**Base de datos:** PostgreSQL en 172.26.20.32:5432 (allaria_hub)

**GitLab:** gitlab.allaria.xyz → 172.30.200.105

---

## Infraestructura y servidores

### App Server (172.26.20.90)

```
usuario: allaria
password: 25DeMayo
directorio: ~/Allaria-Hub
docker network: red-docker (10.100.0.0/24)
```

**Containers corriendo:**
- `allaria-hub-front` (puerto 3097)
- `allaria-hub-back` (puerto 3098)

**Deploy:** `cd ~/Allaria-Hub && git pull && docker compose up -d --build`

### Sandbox Server (172.30.200.101)

```
usuario: allaria
password: 25DeMayo
directorio: ~/Allaria-Hub/sandbox-agent
proyectos: /projects/{userSlug}/{projectName}/
docker network: red-docker (10.101.0.0/24) — red creada manualmente en este servidor
```

**Containers corriendo:**
- `sandbox-agent` (puerto 3100)
- `sandbox-nginx` (puerto 3099)
- `sandbox-{user}-{project}` (puertos 4001-4100, uno por proyecto)

**Deploy:** `cd ~/Allaria-Hub/sandbox-agent && git pull && docker compose up -d --build`

### Conectividad entre servidores

Las dos IPs están en subnets distintas de Huawei Cloud (172.26.20.0/24 y 172.30.200.96/27). Se configuró VPC peering con reglas de firewall en Huawei Cloud:

| Origen | Destino | Puerto | Para qué |
|---|---|---|---|
| 172.26.20.90 | 172.30.200.101 | 3100 | Sandbox Agent API |
| 172.26.20.90 | 172.30.200.101 | 3099 | Nginx preview |
| 172.26.20.90 | 172.30.200.105 | 443 | GitLab API |

---

## Sandbox Agent

### Qué es

Servicio Express independiente en `sandbox-agent/`. Corre en el servidor dedicado (172.30.200.101). El backend de Allaria Hub se comunica con él via HTTP. El agente maneja:
- Filesystem de proyectos (`/projects/`)
- Build y run de containers Docker
- Configuración dinámica de nginx
- Operaciones git

### Por qué es un servicio separado

Para aislar la ejecución de Docker del app server de producción. Los containers de los proyectos de usuarios corren en hardware separado y no interfieren con la app principal.

### Estructura de archivos

```
sandbox-agent/
├── src/
│   ├── index.js              # Entry point Express, auth middleware, rutas
│   ├── middleware/
│   │   └── auth.js           # createAuthMiddleware() — valida X-Sandbox-Key header
│   ├── routes/
│   │   └── projects.js       # Todos los endpoints CRUD + files + build + push
│   └── lib/
│       ├── scaffold.js       # Genera template Vite+React (8 archivos)
│       ├── docker.js         # Build/run/stop containers, port pool 4001-4100
│       ├── nginx.js          # Genera config nginx + reload via dockerode
│       └── git.js            # git init, commit, push a GitLab
├── tests/                    # Tests con node:test (TDD)
├── Dockerfile                # node:20-alpine + git + docker-cli
├── docker-compose.yml        # sandbox-agent + nginx-proxy, ambos en red-docker
└── .env                      # Variables de entorno (no en git)
```

### Endpoints

| Método | Path | Descripción |
|---|---|---|
| GET | `/health` | Health check (usado por ELB) |
| POST | `/projects` | Crea proyecto: scaffold + git init + docker build + nginx |
| GET | `/projects` | Lista todos los proyectos (lee .sandbox-meta.json) |
| GET | `/projects/:user/:name` | Info del proyecto + estado del container |
| DELETE | `/projects/:user/:name` | Para container + borra carpeta + nginx reload |
| POST | `/projects/:user/:name/files` | Escribe/crea un archivo (path traversal protegido) |
| GET | `/projects/:user/:name/files/*filePath` | Lee un archivo |
| GET | `/projects/:user/:name/tree` | Estructura de archivos (excluye node_modules, .git, dist) |
| POST | `/projects/:user/:name/build` | Docker build + run + nginx reload + **verifica /health** |
| POST | `/projects/:user/:name/stop` | Para el container |
| POST | `/projects/:user/:name/push` | Git commit + push a GitLab |
| POST | `/projects/:user/:name/exec` | Ejecuta comando dentro del container |

### Autenticación

Header `X-Sandbox-Key` con shared secret. Solo acepta requests del backend de Allaria Hub.

### Scaffold de proyectos (Vite + React)

Cuando se crea un proyecto, `scaffold.js` genera:
- `package.json` — React 19 + Vite 6
- `vite.config.js` — con `base: '/{userSlug}/{projectName}/'` para el path correcto en nginx
- `Dockerfile` — multi-stage: node:20-alpine build → nginx:alpine serve
- `nginx.conf` — incluye `location /health { return 200 'ok'; }` + SPA fallback
- `.dockerignore`
- `index.html`
- `src/App.jsx`, `src/main.jsx`, `src/App.css`

El `nginx.conf` dentro de cada proyecto es clave: habilita el endpoint `/health` que el agente usa para verificar que el container está listo tras un build.

### Port pool

Puertos 4001-4100 (máximo 100 proyectos concurrentes). El agente escanea containers activos cuyo nombre empieza con `sandbox-` y asigna el primer puerto libre.

### Nginx dinámico

`nginx.js` mantiene `/etc/nginx/conf.d/sandbox-projects.conf` en el host, montado como volumen en `sandbox-nginx`. Cuando se crea/destruye un proyecto, regenera la config y recarga nginx via dockerode:

```nginx
server {
    listen 3099;

    location = / {
        return 200 'ok';  /* health check para el ELB */
        add_header Content-Type text/plain;
    }

    location /ramiro-schulmeister/dashboard-dolar/ {
        proxy_pass http://host.docker.internal:4001/;
    }
}
```

**Por qué `host.docker.internal`:** El container de nginx no puede usar `localhost` para llegar a puertos del HOST — `localhost` dentro de un container es el propio container. `host.docker.internal` resuelve a la IP del host a través del `extra_hosts: host-gateway` en docker-compose.

### Verificación post-build

Antes de responder OK tras un build, el agente hace polling a `http://host.docker.internal:{port}/health` hasta 15 veces (30 segundos máximo). Recién cuando responde 200 le avisa al usuario. Si no responde, devuelve error.

### Variables de entorno (.env en el servidor)

```env
PORT=3100
SANDBOX_KEY=5f98396823e95b7ed633b2970d234c210e2fca50f927f68cc69ba62950929761
PROJECTS_DIR=/projects
NGINX_CONFIG_PATH=/etc/nginx/conf.d/sandbox-projects.conf
PORT_RANGE_START=4001
PORT_RANGE_END=4100
PROXY_HOST=host.docker.internal
```

---

## Allaria Hub Backend

### Prisma — Modelo Project

Se agregó al schema:

```prisma
model Project {
  id          String   @id @default(cuid())
  name        String            // slug: "dashboard-ventas"
  title       String            // "Dashboard de Ventas"
  description String?
  userId      String
  user        User     @relation(fields: [userId], references: [id])
  gitlabId    Int?
  repoUrl     String?           // URL web del repo en GitLab
  port        Int?              // Puerto del container en sandbox server
  status      String   @default("creating") // creating | running | stopped | error
  previewUrl  String?           // https://proyectos-sandbox.allaria.xyz/{user}/{project}/
  template    String   @default("vite-react")
  chatId      String?           // Chat dedicado del proyecto
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([userId, name])
  @@index([userId])
}
```

**chatId:** Cada proyecto tiene un chat dedicado en la tabla Chat. Se crea junto con el proyecto y se vincula. Los chats de proyectos se excluyen del listado del chat común (`GET /api/chats` filtra los chatIds que aparecen en proyectos).

### Nuevos archivos en back/src/lib/

#### gitlab.js
Cliente para la API de GitLab:
- `createGitlabRepo(userSlug, projectName)` — crea repo en el grupo `allaria-sandbox` (ID 54)
- `deleteGitlabRepo(gitlabId)` — elimina el repo

```
GitLab URL: https://gitlab.allaria.xyz
Token: glpat-TGuDOM4IxWdJBKE8gu4ILG86MQp1OjUH.01.0w101ew41
Grupo: allaria-sandbox (ID 54)
Repos: {userSlug}-{projectName} (ej: ramiro-schulmeister-dashboard-dolar)
```

#### sandbox-client.js
HTTP client para comunicarse con el Sandbox Agent (172.30.200.101:3100). Todas las funciones agregan el header `X-Sandbox-Key` automáticamente.

Funciones: `sandboxCreateProject`, `sandboxWriteFile`, `sandboxReadFile`, `sandboxListFiles`, `sandboxBuild`, `sandboxPush`, `sandboxStatus`, `sandboxDelete`, `sandboxStop`.

#### sandbox-tools.js
Tool definitions para LiteLLM + función `executeSandboxTool()`.

**Herramientas disponibles:**

| Tool | Confirmable | Descripción |
|---|---|---|
| `sandbox_create_project` | Sí | Crea GitLab repo + scaffold + docker + chat dedicado |
| `sandbox_write_file` | No | Escribe/modifica un archivo |
| `sandbox_read_file` | No | Lee un archivo |
| `sandbox_list_files` | No | Lista estructura de archivos |
| `sandbox_build` | No | Rebuild container + verifica health |
| `sandbox_push` | Sí | Git commit + push a GitLab |
| `sandbox_status` | No | Estado del proyecto |

**Función userSlugFromEmail:** `juan.perez@allaria.com` → `juan-perez`

### Rutas nuevas en back/src/routes/

#### projects.js
```
POST   /api/projects              Crear proyecto (directo, sin LLM)
GET    /api/projects/community    Todos los proyectos (hub) — con datos del usuario
GET    /api/projects              Proyectos del usuario autenticado
GET    /api/projects/:id          Detalle de un proyecto
GET    /api/projects/:id/chat     Get o crear chat dedicado del proyecto
PATCH  /api/projects/:id          Actualizar título/descripción
DELETE /api/projects/:id          Eliminar (sandbox + GitLab + DB)
POST   /api/projects/:id/stop     Detener container
```

**Flujo de POST /api/projects:**
1. Validar slug (solo `[a-z0-9-]+`)
2. Crear repo en GitLab (si falla, continúa sin repo)
3. Crear `Project` en DB (status: creating)
4. Crear `Chat` dedicado en DB
5. Llamar al Sandbox Agent (`POST /projects`)
6. Actualizar `Project` con port, previewUrl, chatId, status: running
7. Devolver el proyecto

#### Streaming SSE en proxy.js (`POST /api/chat/stream`)

Endpoint exclusivo para el chat de proyectos. Diferencias con `/completions`:
- Responde con `Content-Type: text/event-stream`
- Envía eventos: `thinking`, `tool_start`, `tool_done`, `done`, `error`
- Heartbeat cada 15 segundos (`: ping`) para prevenir timeouts
- **Detecta desconexión del cliente pero continúa procesando** — guarda la respuesta en DB aunque el browser se haya ido
- Ejecuta todas las tools sin pedir confirmación (flujo de proyecto)

#### stats en index.js (`GET /api/stats`)

```javascript
{
  activeProjects: número de proyectos con status 'running',
  totalUsers: total de usuarios,
  chatsThisMonth: chats creados desde el 1° del mes,
  totalMessages: total histórico de mensajes
}
```

### Variables de entorno del backend (.env en el servidor)

```env
DATABASE_URL=postgresql://root:02DeAbril@172.26.20.32:5432/allaria_hub
GOOGLE_CLIENT_ID=...
LITELLM_URL=https://litellm.allaria.xyz/v1/chat/completions
LITELLM_KEY=sk-eWkdUVfWsfB4YVYHi935aw
PORT=3098
CORS_ORIGIN=https://ia.allaria.xyz
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://ia.allaria.xyz/api/connectors/callback
FRONT_URL=https://ia.allaria.xyz
SANDBOX_AGENT_URL=http://172.30.200.101:3100
SANDBOX_AGENT_KEY=5f98396823e95b7ed633b2970d234c210e2fca50f927f68cc69ba62950929761
SANDBOX_PREVIEW_URL=https://proyectos-sandbox.allaria.xyz
GITLAB_URL=https://gitlab.allaria.xyz
GITLAB_TOKEN=glpat-TGuDOM4IxWdJBKE8gu4ILG86MQp1OjUH.01.0w101ew41
GITLAB_GROUP_ID=54
```

---

## Frontend

### Nuevas páginas y componentes

#### /proyectos — Hub de Proyectos (Projects.jsx)

Dos secciones:
1. **Mis Proyectos** — sandbox projects del usuario autenticado (DB). Cards clickeables que abren el workspace. Botón "+ Crear Proyecto" arriba a la derecha que abre modal de creación directa.
2. **Hub de Proyectos** — todos los proyectos de todos los usuarios (`GET /api/projects/community`). Búsqueda por texto. Click abre la preview URL.

**Modal de creación:** Formulario con título (genera slug automáticamente), nombre slug (validación `/[a-z0-9-]+/`) y descripción opcional. Llama directo a `POST /api/projects`.

#### /proyectos/:id — ProjectWorkspace.jsx

Layout en tres partes:
1. **Topbar** — título editable (PATCH al click), status badge, links a Preview y GitLab, badge "Claude Sonnet" fijo
2. **Sidebar** — descripción editable, detalles (slug, template, puerto, fecha), preview URL
3. **Chat** — chat aislado del proyecto con streaming SSE en tiempo real

**Características del chat del workspace:**
- Usa `POST /api/chat/stream` (SSE) en lugar de `/completions`
- Modelo forzado: **claude-sonnet-4-5** (no seleccionable)
- Conector sandbox siempre activo, no hay ConnectorPicker
- Muestra progreso en tiempo real:
  ```
  ⟳ ✍️ Escribiendo src/App.jsx
  ✓ ✍️ Escribiendo src/App.jsx
  ⟳ 🔨 Buildeando proyecto...
  ✓ 🔨 Buildeando proyecto...
  ```
- Input bloqueado mientras el bot responde
- **Background processing:** si el usuario navega a otra sección mientras el bot responde, el backend continúa procesando y guarda en DB. Al volver, aparece un spinner "Procesando en segundo plano..." y hace polling cada 3s hasta que aparezca la respuesta.

**System prompt del workspace:**
Instruye a Claude a:
1. Leer `CHANGELOG.md` cuando le pregunten "¿en qué estábamos?" — NO leer todos los archivos
2. Actualizar `CHANGELOG.md` después de cada cambio
3. Siempre buildear después de modificar archivos
4. Pushear a GitLab solo cuando el usuario lo pide

#### ConnectorPicker.jsx

Se **eliminó** la entrada de Sandbox del ConnectorPicker del chat común. El sandbox solo está disponible en el workspace de proyectos.

#### Home.jsx

Stats reales del DB en lugar de valores mock:
- Proyectos activos (running)
- Total usuarios
- Chats este mes
- Mensajes totales

---

## Deploy e infraestructura de red

### Problema de red encontrado

El app server (172.26.20.90) y el sandbox server (172.30.200.101) están en VPCs distintas en Huawei Cloud. Inicialmente no había conectividad.

**Solución:** VPC peering + reglas de firewall en Huawei Cloud (configuradas manualmente por el equipo de infraestructura).

### Problema: sandbox agent en red equivocada

Al levantar el sandbox agent en 172.26.20.90 como workaround, creó su propia red Docker (`172.27.x.x`) que rompió conexiones existentes.

**Solución:** Agregar `networks: red-docker` (external: true) al docker-compose del sandbox agent. Crear la red `red-docker` también en el sandbox server:
```bash
docker network create red-docker --subnet 10.101.0.0/24
```

### Problema: nginx no recarga correctamente

El sandbox agent llamaba `execSync('nginx -s reload')` que intentaba recargar nginx en el HOST, pero nginx corre dentro del container `sandbox-nginx`.

**Solución:** Usar dockerode para ejecutar el reload dentro del container:
```javascript
const container = docker.getContainer('sandbox-nginx')
const exec = await container.exec({ Cmd: ['nginx', '-s', 'reload'], ... })
```

### Problema: proxy_pass localhost no funciona desde container

`proxy_pass http://localhost:4001/` dentro del container de nginx no llega al puerto 4001 del HOST (localhost = el propio container).

**Solución:** `proxy_pass http://host.docker.internal:4001/` + agregar `extra_hosts: ["host.docker.internal:host-gateway"]` al container de nginx en docker-compose.

### ELB — proyectos-sandbox.allaria.xyz

El ELB (23.227.176.14) tiene una regla que mapea `proyectos-sandbox.allaria.xyz` → `172.30.200.101:3099`. SSL termination en el ELB. El nginx escucha en HTTP port 3099.

La ruta `location = /` en nginx devuelve 200 para que el health check del ELB no marque el backend como unhealthy.

---

## Problemas encontrados y soluciones

### 1. fetch failed — GitLab y sandbox agent

**Problema:** El backend no podía alcanzar `172.30.200.101` ni `gitlab.allaria.xyz`.
**Causa:** Subnets distintas sin routing entre ellas en Huawei Cloud.
**Solución:** VPC peering + reglas de firewall (3 reglas: puertos 3100, 3099, 443).

### 2. 502 tras sandbox_build

**Problema:** `waitForContainer` usaba `http://localhost:{port}/` pero desde dentro del container del agente, localhost no llega a los puertos del host.
**Solución:** Cambiar a `http://host.docker.internal:{port}/health` + agregar `extra_hosts` al docker-compose del agente.

### 3. Error `The "paths[1]" argument must be of type string. Received an instance of Array`

**Problema:** En Express 5, el wildcard `*filePath` en rutas devuelve un Array.
**Solución:**
```javascript
const filePath = Array.isArray(req.params.filePath)
  ? req.params.filePath.join('/')
  : req.params.filePath
```

### 4. Proyecto stuck en status "creating"

**Problema:** El sandbox agent procesó correctamente pero la actualización del DB falló silenciosamente.
**Solución manual:**
```sql
UPDATE "Project"
SET status='running', port=4002,
    "previewUrl"='https://proyectos-sandbox.allaria.xyz/ramiro-schulmeister/buscador-de-noticias/'
WHERE name='buscador-de-noticias';
```

### 5. Network error en el chat del workspace

**Problema:** Requests SSE largas (Claude + docker build) se cortaban por timeout de nginx/browser.
**Solución:**
- Heartbeat cada 15s: `res.write(': ping\n\n')`
- El backend detecta desconexión del cliente (`req.on('close', ...)`) pero **continúa procesando** y guarda en DB
- Frontend hace polling cada 3s al volver al workspace

### 6. El bot leía todos los archivos al preguntar "¿en qué estábamos?"

**Problema:** Sin instrucciones específicas, Claude recorría toda la estructura del proyecto innecesariamente.
**Solución:** System prompt actualizado con instrucción explícita de leer `CHANGELOG.md` primero. Los proyectos mantienen un CHANGELOG.md actualizado automáticamente.

### 7. Prisma migrate en servidor sin npm

**Problema:** El servidor no tiene npm instalado (solo Docker).
**Solución:** Usar `prisma db push` dentro del container:
```bash
docker compose exec back npx prisma db push
```

### 8. Preview URL con puerto en el path

**Problema:** Las URLs generadas incluían `:3099` (ej: `https://proyectos-sandbox.allaria.xyz:3099/...`).
**Causa:** Valor hardcodeado en `SANDBOX_PREVIEW_URL` con el puerto.
**Solución:** Actualizar `.env` y defaults en código: `https://proyectos-sandbox.allaria.xyz` (sin puerto, el ELB lo maneja).

---

## Credenciales y variables de entorno

### Sandbox Agent Key (shared secret)
```
5f98396823e95b7ed633b2970d234c210e2fca50f927f68cc69ba62950929761
```
Debe ser igual en:
- Sandbox server: `~/Allaria-Hub/sandbox-agent/.env` → `SANDBOX_KEY=...`
- App server: `~/Allaria-Hub/back/.env` → `SANDBOX_AGENT_KEY=...`

### GitLab Token
```
glpat-TGuDOM4IxWdJBKE8gu4ILG86MQp1OjUH.01.0w101ew41
```
Permisos: API access. Grupo target: `allaria-sandbox` (ID 54).

### PostgreSQL
```
Host: 172.26.20.32:5432
DB: allaria_hub
User: root
Password: 02DeAbril
```

### Acceso a servidores
```
App server:     172.26.20.90   — usuario: allaria / password: 25DeMayo
Sandbox server: 172.30.200.101 — usuario: allaria / password: 25DeMayo
```

---

## Flujo completo de creación de un proyecto

```
Usuario hace click en "+ Crear Proyecto"
  │
  ▼
Modal: título, nombre (slug), descripción opcional
  │
  ▼
POST /api/projects  (back)
  ├─ Valida slug [a-z0-9-]+
  ├─ Deriva userSlug del email: juan.perez@allaria.com → juan-perez
  ├─ POST gitlab.allaria.xyz/api/v4/projects → crea repo juan-perez-dashboard-dolar
  ├─ Crea Project en DB (status: creating)
  ├─ Crea Chat dedicado en DB (title: "🚧 {título}")
  ├─ POST 172.30.200.101:3100/projects
  │    ├─ generateScaffold() → 8 archivos en /projects/juan-perez/dashboard-dolar/
  │    ├─ git init + remote add origin {repoUrl}
  │    ├─ findFreePort() → puerto libre en 4001-4100
  │    ├─ Guarda .sandbox-meta.json
  │    ├─ docker build -t sandbox-juan-perez-dashboard-dolar:latest .
  │    ├─ docker run -p 4001:80 ...
  │    ├─ generateNginxConfig() + reload nginx
  │    ├─ git push (push inicial del scaffold)
  │    └─ waitForContainer() → polling a host.docker.internal:4001/health hasta 200
  ├─ Actualiza Project en DB: port=4001, previewUrl=..., chatId=..., status=running
  └─ Devuelve proyecto completo
  │
  ▼
Frontend navega a /proyectos/{id}
  │
  ▼
ProjectWorkspace carga proyecto + chat dedicado desde DB
```

---

## Flujo de edición de un proyecto via chat

```
Usuario escribe en el chat del workspace
  │
  ▼
POST /api/chat/stream  (SSE)
  ├─ Guarda mensaje del usuario en DB
  ├─ Llama a Claude claude-sonnet-4-5 con system prompt + herramientas sandbox
  │
  Claude decide llamar tools:
  │
  ├─ sandbox_read_file "CHANGELOG.md"
  │    └─ GET 172.30.200.101:3100/projects/juan-perez/dashboard-dolar/files/CHANGELOG.md
  │
  ├─ sandbox_write_file "src/App.jsx" → evento SSE: tool_start
  │    └─ POST .../files {path: "src/App.jsx", content: "..."}
  │    └─ evento SSE: tool_done
  │
  ├─ sandbox_write_file "CHANGELOG.md" → actualiza registro
  │
  ├─ sandbox_build → evento SSE: tool_start "🔨 Buildeando..."
  │    └─ POST .../build
  │         ├─ docker build
  │         ├─ docker run (reemplaza container anterior)
  │         ├─ nginx reload
  │         └─ waitForContainer() → OK
  │    └─ evento SSE: tool_done
  │
  └─ Claude responde con resumen → evento SSE: done
       └─ Guarda mensaje en DB

Frontend recibe eventos SSE en tiempo real y muestra progreso.
Si el usuario navega a otra sección:
  ├─ clientConnected = false
  ├─ Backend continúa procesando (no aborta)
  ├─ Guarda respuesta en DB al terminar
  └─ Al volver: polling cada 3s hasta que last message sea 'assistant'
```

---

## Estado actual de proyectos en producción

| Proyecto | Usuario | Puerto | Preview URL |
|---|---|---|---|
| dashboard-dolar | ramiro-schulmeister | 4001 | https://proyectos-sandbox.allaria.xyz/ramiro-schulmeister/dashboard-dolar/ |
| buscador-de-noticias | ramiro-schulmeister | 4002 | https://proyectos-sandbox.allaria.xyz/ramiro-schulmeister/buscador-de-noticias/ |

---

## Pendientes / Deuda técnica

1. **`prisma migrate dev`** nunca se corrió — se usó `prisma db push` siempre. En producción esto significa que no hay historial de migraciones. Si se necesita rollback o colaboración con otro dev, hace falta crear una migración baseline.

2. **nginx config del sandbox no persiste** entre rebuilds del agente si el archivo en el host fue modificado manualmente. El agente regenera la config en cada build de proyecto.

3. **El token de GitLab** debería rotarse periódicamente. Actualmente hardcodeado en `.env`.

4. **Port pool 4001-4100** — máximo 100 proyectos concurrentes. Si se necesita más, ajustar `PORT_RANGE_START/END` en el `.env` del sandbox agent.

5. **Proyectos parados** (`status: stopped`) siguen ocupando carpeta en `/projects/` pero no tienen container. Si quisieras limpiar espacio habría que borrar las carpetas manualmente o vía `DELETE /api/projects/:id`.

6. **CHANGELOG.md** — solo existe en proyectos creados/editados después de la sesión de hoy. Los proyectos anteriores no lo tienen.
