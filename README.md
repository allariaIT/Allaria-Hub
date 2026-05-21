# Allaria Hub IA

Plataforma corporativa de inteligencia artificial de Allaria. Chat multi-modelo con conectores de Google (Gmail, Calendar, Tasks, Drive), hub de proyectos sandbox con agente de codigo, y documentacion interna.

**URL**: https://allaria-hub.allaria.xyz (tambien accesible como https://ia.allaria.xyz)

---

## Arquitectura

```
Internet
  |
  v
ELB Huawei (23.227.176.14)
  |
  +---> sandbox-nginx (.101:3099)
  |       |
  |       +---> proyectos-sandbox.allaria.xyz  --> contenedores de usuario (puertos 4001-4100 en .101)
  |       +---> allaria-hub.allaria.xyz        --> CCE NodePort 30097
  |
  v
CCE Cluster Huawei (la-south-2) / namespace: allaria-hub
  |
  +---> front pod (React+Vite, nginx :3097)
  |       - archivos estaticos
  |       - /api/* --> back pod
  |
  +---> back pod (Express+Prisma, :3098)
          |
          +---> PostgreSQL 172.30.200.114:5432/allaria_hub
          +---> LiteLLM http://172.30.200.101:4000/v1/chat/completions
          +---> Sandbox Agent http://172.30.200.101:3100
          +---> Session pods (CCE namespace sandbox-sessions)
          +---> Google APIs (Gmail, Calendar, Tasks, Drive)

Sandbox Agent (172.30.200.101:3100)
  - Crea proyectos Vite+React con scaffold
  - Hace git push a GitLab (gitlab.allaria.xyz / grupo allaria-sandbox)
  - CI pipeline (docker-deployment.yml) buildea imagen SWR y deploya en .101
  - sandbox-nginx expone cada proyecto en proyectos-sandbox.allaria.xyz/{userSlug}/{name}/

Session Agent (pods efimeros en CCE namespace sandbox-sessions)
  - Un pod por sesion de workspace activa
  - Clona el repo del proyecto via http://172.30.200.101 (IP directa, no https://gitlab)
  - Express :3200 — recibe POST /chat, ejecuta herramientas, streame SSE
  - Idle timeout: 60 min. Cleanup automatico via reconcile job del back (70 min).
  - Imagen: swr.la-south-2.myhuaweicloud.com/sandbox-allaria/session-agent:latest
```

---

## Stack

| Componente | Tecnologia |
|-----------|------------|
| Frontend | React 19, Vite 8, React Router 7 |
| Backend | Node.js, Express 5, Prisma ORM |
| Base de datos | PostgreSQL 172.30.200.114 |
| LLM Gateway | LiteLLM http://172.30.200.101:4000 (OpenAI-compat) |
| Auth | Google OAuth2 (login + conectores incrementales) |
| Deploy back/front | Manual: build Docker + push SWR + kubectl set image (ver seccion Deploy) |
| Deploy sandbox-agent | Docker Compose en 172.30.200.101 |
| Container registry | Huawei SWR (swr.la-south-2.myhuaweicloud.com/sandbox-allaria) |

---

## Estructura del monorepo

```
Allaria-Hub/
|-- front/              # React 19 + Vite 8, puerto 3097
|-- back/               # Express 5 + Prisma, puerto 3098
|-- sandbox-agent/      # Express 5, puerto 3100 en .101
|-- session-agent/      # Express 5, pods efimeros CCE namespace sandbox-sessions
|-- k8s/                # Manifests CCE (namespace, deployments, services, secrets)
|-- docs/               # Documentacion tecnica e historiales de implementacion
|-- .gitlab-ci.yml      # CI/CD: build-back, build-front, deploy-back, deploy-front
```

### front/src/

```
components/
  Layout.jsx             # Sidebar con nav + user info
  ProtectedRoute.jsx
  ConnectorPicker.jsx    # Menu conectores Google
context/
  AuthContext.jsx        # Google OAuth provider
lib/
  api.js                 # HTTP client para el backend
pages/
  Login.jsx
  Home.jsx
  Chat.jsx               # Chat multi-modelo + conectores + confirmaciones
  Projects.jsx           # Hub de proyectos + Mis Proyectos + modal crear
  ProjectWorkspace.jsx   # Workspace agente de codigo + SSE streaming + PipelineTracker
  Docs.jsx
```

### back/src/

```
index.js                 # Express server + rutas + job reconcileProjects
middleware/
  auth.js                # Verificacion session token (SHA256)
lib/
  prisma.js
  gitlab.js              # GitLab API client
  k8s.js                 # createSessionPod(), waitForPodReady(120s), deleteSessionPod()
  active-streams.js      # Buffer SSE por chatId; replay para reconexiones
  sandbox-client.js      # HTTP client al sandbox agent (timeout 10s)
  sandbox-tools.js       # Tool definitions + executeSandboxTool + pollGitlabPipeline
  tools.js               # Tools por conector; workspaceSandbox excluye sandbox_create_project
  google-oauth.js
  gmail.js / calendar.js / gtasks.js / drive.js
routes/
  auth.js                # POST /api/auth/google
  chats.js               # CRUD /api/chats (excluye chats vinculados a proyectos)
  projects.js            # CRUD /api/projects + community + publish + star + workspace
  sessions.js            # REST CRUD /api/projects/:id/session (session pods CCE)
  proxy.js               # handleWorkspaceStream() — SSE proxy al session pod + pipeline tracker
  connectors.js          # OAuth conectores Google
```

### session-agent/src/

```
index.js                 # Express :3200, idle timeout 60min, GET /health, POST /chat
agent.js                 # LLM loop con MAX_ROUNDS=20, fetch OpenAI-compat a LiteLLM
tools.js                 # read_file, write_file, list_files, bash, git_push
git.js                   # gitClone (http://172.30.200.101 directo), gitCommitAndPush
```

### sandbox-agent/src/

```
index.js
lib/
  scaffold.js            # Template Vite+React (nginx.conf, /health)
  docker.js              # Operaciones Docker via CLI spawn (NO dockerode)
  nginx.js               # Genera config sandbox-nginx y recarga via spawn
  git.js                 # git init, commit, push (spawnSync)
routes/
  projects.js            # Todos los endpoints; build/rebuild async con semaforo
```

---

## Funcionalidades

### Chat IA multi-modelo

- Chat con historial persistido en PostgreSQL
- Streaming via SSE (POST /api/chat/stream)
- Heartbeat cada 15s; continua despues de disconnect del cliente, poll al reconectar
- Auto-titulo con primer mensaje (50 chars)
- Markdown rendering con syntax highlight
- Adjuntos: se envia base64 a LiteLLM; en DB se guarda solo la referencia `[adjunto nombre]`
- MAX_TOOL_ROUNDS: 20 rondas maximas de tool calling por request
- max_tokens: 8192 en el stream endpoint

### Conectores Google (OAuth incremental)

Los permisos se piden al activar cada conector por primera vez. Una vez conectado, el usuario puede activarlo/desactivarlo en cada chat.

| Conector | Tools | Requiere confirmacion |
|----------|-------|-----------------------|
| Gmail | gmail_list, gmail_read, gmail_send, gmail_search | gmail_send |
| Calendar | calendar_list, calendar_create, calendar_search | calendar_create |
| Tasks | tasks_list, tasks_create, tasks_complete, tasks_search | tasks_create, tasks_complete |
| Drive | drive_list, drive_search, drive_get | ninguna (solo lectura) |

### Confirmacion de acciones destructivas

Las tools marcadas como confirmables no se ejecutan hasta que el usuario aprueba la accion:

1. LLM emite tool_call para una accion confirmable
2. Backend pausa y devuelve `_pendingConfirmations` con preview al frontend
3. Frontend muestra card con detalle (destinatario, asunto, cuerpo, etc.)
4. Usuario confirma o cancela
5. POST /api/chat/confirm ejecuta o rechaza la accion

### Hub de Proyectos

- Crear mini-apps React via agente LLM o via modal directo
- Proyectos privados por defecto; el dueno puede publicarlos en el hub de comunidad
- Stars: 1 por usuario por proyecto
- Preview publica: `https://proyectos-sandbox.allaria.xyz/{userSlug}/{name}/`

### Workspace por proyecto (agente de codigo)

Cada proyecto tiene un workspace con un agente LLM en un pod efimero de CCE. Flujo completo:

```
Usuario envia mensaje
  -> back crea/reutiliza session pod en CCE (namespace sandbox-sessions)
  -> pod clona repo de GitLab via http://172.30.200.101 (NO via https://gitlab.allaria.xyz)
  -> back espera pod ready (hasta 120s)
  -> back proxea SSE al pod: POST http://{podIP}:3200/chat

Agente en el pod:
  1. read_file    -- leer archivo actual
  2. write_file   -- escribir cambios
  3. git_push     -- commit + push a GitLab (emite evento 'pushed')

Back recibe evento 'pushed':
  -> inicia pollGitlabPipeline() con onStage callback
  -> emite pipeline_stage / pipeline_done / pipeline_error via SSE
  -> SSE stream se mantiene abierto hasta que el pipeline termine
  -> endStream() solo se llama en finally, despues de await pipelinePromise

Front recibe eventos del pipeline:
  -> PipelineTracker en el chat muestra 📦 Empaquetando -> 🚀 Lanzando -> 🎉 Lista
  -> Input bloqueado mientras el pipeline corre (sending=true hasta _stream_ended)
  -> En exito: boton "Ver mi app ->" + input desbloqueado
  -> En error: etapa fallida + boton "Reintentar" (pasa contexto del error al bot)
```

**Persistencia**: todos los eventos SSE se bufferean en `active-streams.js` por chatId. Si el usuario sale y vuelve al workspace, los eventos del pipeline se replay y el PipelineTracker reconstruye su estado.

**Job names del CI**: los jobs reales del pipeline son `build` y `deploy` (no `docker:build` / `deploy:server`). Esto esta reflejado en `PIPELINE_STAGES` en `ProjectWorkspace.jsx` y en `pollGitlabPipeline` en `sandbox-tools.js`.

---

## API del backend

### Auth
| Metodo | Ruta | Descripcion |
|--------|------|-------------|
| POST | `/api/auth/google` | Login con credential de Google |

### Chats
| Metodo | Ruta | Descripcion |
|--------|------|-------------|
| GET | `/api/chats` | Listar chats del usuario (excluye chats de proyectos) |
| POST | `/api/chats` | Crear nuevo chat |
| GET | `/api/chats/:id` | Obtener chat con mensajes |
| PATCH | `/api/chats/:id` | Renombrar chat |
| DELETE | `/api/chats/:id` | Eliminar chat |
| DELETE | `/api/chats/:id/messages` | Limpiar mensajes |

### Chat IA
| Metodo | Ruta | Descripcion |
|--------|------|-------------|
| POST | `/api/chat/stream` | Proxy LiteLLM + tool calling, responde SSE |
| POST | `/api/chat/confirm` | Confirmar o rechazar accion pendiente |

### Proyectos
| Metodo | Ruta | Descripcion |
|--------|------|-------------|
| GET | `/api/projects` | Proyectos del usuario |
| POST | `/api/projects` | Crear proyecto (trigerea agente sandbox) |
| GET | `/api/projects/community` | Proyectos publicos |
| GET | `/api/projects/:id` | Detalle de proyecto |
| PATCH | `/api/projects/:id` | Editar proyecto |
| DELETE | `/api/projects/:id` | Eliminar proyecto + session pod activo |
| POST | `/api/projects/:id/publish` | Publicar |
| POST | `/api/projects/:id/unpublish` | Despublicar |
| POST | `/api/projects/:id/star` | Dar estrella |
| DELETE | `/api/projects/:id/star` | Quitar estrella |
| GET | `/api/projects/:id/chat` | Chat del workspace del proyecto |

### Workspace / Sessions
| Metodo | Ruta | Descripcion |
|--------|------|-------------|
| POST | `/api/chat/stream` | Workspace SSE (con connectors=workspaceSandbox y projectId) |
| POST | `/api/projects/:id/session` | Crear/obtener session pod |
| GET | `/api/projects/:id/session` | Estado de la session (status: starting/ready/none) |
| DELETE | `/api/projects/:id/session` | Terminar session pod |
| GET | `/api/projects/:id/session/active-stream` | SSE con replay del buffer para reconexion |

### Conectores Google
| Metodo | Ruta | Descripcion |
|--------|------|-------------|
| GET | `/api/connectors` | Listar conexiones del usuario |
| POST | `/api/connectors/auth` | Iniciar OAuth para un provider |
| GET | `/api/connectors/callback` | Callback OAuth (publico) |
| DELETE | `/api/connectors/:provider` | Desconectar provider |

---

## Base de datos

Esquema gestionado con Prisma (sin migration history, se sincroniza con `prisma db push`).

**User** -- id (Google sub), email, name, picture. Relaciones: chats, connections, projects, stars.

**Chat** -- id (cuid), title, userId. Puede estar vinculado a un Project (chatId en Project).

**Message** -- id, chatId, role, content, model. Cascade delete con el chat.

**UserConnection** -- userId + provider (gmail/calendar/tasks/drive). Guarda accessToken, refreshToken, scopes, expiresAt. Unique [userId, provider]. Los tokens se auto-refrescan.

**Project** -- id, name, userSlug, userId, description, chatId, port, status, isPublic, gitlabProjectId.

**ProjectStar** -- userId + projectId. Unique [userId, projectId].

**Session** -- id, projectId, podName, podIP, status (starting/ready/none), lastActivity.

---

## Variables de entorno del backend

Las variables viven en el secret de Kubernetes `back-secret` en el namespace `allaria-hub`. No hay `.env` en el repo.

```
DATABASE_URL        postgresql://root:***@172.30.200.114:5432/allaria_hub
LITELLM_URL         http://172.30.200.101:4000/v1/chat/completions
LITELLM_BASE_URL    http://172.30.200.101:4000
LITELLM_KEY         sk-allaria-***
SANDBOX_AGENT_URL   http://172.30.200.101:3100
SANDBOX_AGENT_KEY   5f983968...
SANDBOX_PREVIEW_URL https://proyectos-sandbox.allaria.xyz
GITLAB_URL          https://gitlab.allaria.xyz
GITLAB_GROUP_ID     54
GITLAB_TOKEN        glpat-...
CORS_ORIGIN         https://allaria-hub.allaria.xyz
FRONT_URL           https://allaria-hub.allaria.xyz
GOOGLE_CLIENT_ID    ...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET GOCSPX-...
GOOGLE_REDIRECT_URI https://allaria-hub.allaria.xyz/api/connectors/callback
PORT                3098
```

Para el sandbox-agent las variables viven en `sandbox-agent/.env` en el servidor .101.

---

## Deploy

### back y front (CCE) — deploy MANUAL

**El workflow de GitHub Actions esta roto** (apunta a registry/org incorrectos). No usarlo.
El deploy se hace manualmente desde el servidor .101:

```bash
# SSH al servidor
ssh allaria@172.30.200.101  # password: 25DeMayo

cd ~/Allaria-Hub && git pull origin main
TAG=$(git rev-parse --short HEAD)
REG=swr.la-south-2.myhuaweicloud.com/sandbox-allaria
KB=/home/allaria/bin/kubectl   # kubectl esta en ~/bin/kubectl, no en PATH

# Build + push (OBLIGATORIO --provenance=false --sbom=false)
# Sin esas flags, SWR rechaza con "Invalid image, fail to parse manifest.json"
docker build --provenance=false --sbom=false \
  -t $REG/allaria-hub-back:$TAG -t $REG/allaria-hub-back:latest ./back
docker push $REG/allaria-hub-back:$TAG

docker build --provenance=false --sbom=false \
  -t $REG/allaria-hub-front:$TAG -t $REG/allaria-hub-front:latest ./front
docker push $REG/allaria-hub-front:$TAG

# kubectl set image (NO usar rollout restart solo — los deployments estan pinned a tag)
$KB -n allaria-hub set image deployment/back back=$REG/allaria-hub-back:$TAG
$KB -n allaria-hub set image deployment/front front=$REG/allaria-hub-front:$TAG
$KB -n allaria-hub rollout status deployment/back --timeout=180s
$KB -n allaria-hub rollout status deployment/front --timeout=180s
```

Tiempos tipicos con cache: ~2-3 min total. Sin cache: ~5-10 min.

Para sincronizar schema de DB despues de cambiar `prisma/schema.prisma`:

```bash
$KB exec -n allaria-hub deployment/back -- npx prisma db push
```

### sandbox-agent (Docker en .101)

```bash
cd ~/Allaria-Hub/sandbox-agent && git pull && docker compose up -d --build
```

### session-agent (imagen SWR)

La imagen se buildea y pushea manualmente cuando hay cambios:

```bash
TAG=$(git rev-parse --short HEAD)
REG=swr.la-south-2.myhuaweicloud.com/sandbox-allaria
docker build --provenance=false --sbom=false \
  -t $REG/session-agent:$TAG -t $REG/session-agent:latest ./session-agent
docker push $REG/session-agent:latest
```

Los pods se levantan con `imagePullPolicy: Always` y descargan `:latest` automaticamente.

### Puertos

| Servicio | Puerto | Donde |
|----------|--------|-------|
| Frontend (nginx) | 3097 | CCE pod |
| Backend (Express) | 3098 | CCE pod |
| Sandbox Agent | 3100 | .101 |
| sandbox-nginx | 3099 | .101 |
| Proyectos de usuario | 4001-4100 | .101 |
| Session agents | 3200 | pods en CCE sandbox-sessions |

---

## Notas criticas para developers nuevos

- **No usar dockerode en el sandbox server**: todas las operaciones Docker en `docker.js` y `nginx.js` usan `spawn('docker', [...])` via CLI. dockerode cuelga indefinidamente en este entorno. No revertir.

- **git clone desde pods CCE debe usar IP directa**: `http://172.30.200.101/...git`, NO `https://gitlab.allaria.xyz`. La URL publica pasa por el ELB y nginx sin virtual host de GitLab -> falla.

- **LiteLLM desde pods**: usar `LITELLM_BASE_URL=http://172.30.200.101:4000` con endpoint `/v1/chat/completions` (OpenAI-compat). NO usar el SDK de Anthropic ni el endpoint `/v1/messages` — LiteLLM pasa x-api-key directo a Anthropic y da 401.

- **pipelinePromise scope**: en `handleWorkspaceStream` en proxy.js, `pipelinePromise` DEBE declararse con `let` ANTES del bloque `try`, no adentro. Si se declara dentro del `try`, el `finally` no puede accederla y lanza ReferenceError.

- **consumeSSE no rompe en done**: el frontend lee el stream SSE hasta recibir `_stream_ended`, no hasta `done`. Esto es necesario para recibir los eventos del pipeline tracker despues de que el agente termina de escribir.

- **Job names del CI**: los jobs del pipeline sandbox son `build` y `deploy`. No `docker:build` ni `deploy:server`. Verificar con `GET /api/v4/projects/:id/pipelines/:pid/jobs` si cambian.

- **Build asincrono (sandbox_build)**: POST /build responde inmediatamente con `status: 'building'`. El build corre en background. El backend hace polling al sandbox cada 6s hasta 20 intentos.

- **Reconciliation job**: corre al iniciar el backend y cada 5 minutos. Sincroniza el status de los proyectos contra el sandbox. Solo marca un proyecto como `stopped` si el sandbox devuelve 404 explicito.

- **git safe.directory**: el Dockerfile del sandbox-agent configura `git config --global safe.directory '*'` para evitar el error "dubious ownership" de git 2.35+.

- **Networking sandbox**: `sandbox-nginx` y `sandbox-agent` necesitan `extra_hosts: host.docker.internal:host-gateway`. Los `proxy_pass` usan `host.docker.internal:{port}`, no `localhost`.

- **Auth token**: `SHA256(userId + GOOGLE_CLIENT_ID)` guardado en localStorage. El backend lo verifica en cada request.

- **userSlug**: se deriva del email. `juan.perez@allaria.com.ar` -> `juan-perez`. Es parte de la URL de preview.

---

## Contactos e infraestructura

| Recurso | Detalle |
|---------|---------|
| DNS y TIC | tic@allaria.com.ar |
| Reviewer principal | Francisco Politi (mpoliti en GitLab) |
| GitLab | https://gitlab.allaria.xyz / grupo allaria-sandbox (ID 54) |
| CCE Cluster | Huawei Cloud la-south-2 / namespaces: allaria-hub, sandbox-sessions |
| ELB | 23.227.176.14 (publico) / 172.30.200.105 (privado) |
| Sandbox server | 172.30.200.101 / usuario allaria / pass 25DeMayo |
| DB PostgreSQL | 172.30.200.114:5432/allaria_hub |
| LiteLLM | http://172.30.200.101:4000 |
