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
          +---> Google APIs (Gmail, Calendar, Tasks, Drive)

Sandbox Agent (172.30.200.101:3100)
  - Crea proyectos Vite+React con scaffold
  - Hace git push a GitLab (gitlab.allaria.xyz / grupo allaria-sandbox)
  - CI pipeline (docker-deployment.yml) buildea imagen SWR y deploya en .101
  - sandbox-nginx expone cada proyecto en proyectos-sandbox.allaria.xyz/{userSlug}/{name}/
```

---

## Stack

| Componente | Tecnologia |
|-----------|------------|
| Frontend | React 19, Vite 8, React Router 7 |
| Backend | Node.js, Express 5, Prisma ORM |
| Base de datos | PostgreSQL 172.30.200.114 |
| LLM Gateway | LiteLLM http://172.30.200.101:4000 |
| Auth | Google OAuth2 (login + conectores incrementales) |
| Deploy back/front | GitLab CI -> imagen SWR -> kubectl set image en CCE |
| Deploy sandbox-agent | Docker Compose en 172.30.200.101 |
| Container registry | Huawei SWR |

---

## Estructura del monorepo

```
Allaria-Hub/
|-- front/              # React 19 + Vite 8, puerto 3097
|-- back/               # Express 5 + Prisma, puerto 3098
|-- sandbox-agent/      # Express 5, puerto 3100 en .101
|-- k8s/                # Manifests CCE (namespace, deployments, services, ingress, secrets)
|-- docs/               # Documentacion tecnica
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
  ProjectWorkspace.jsx   # Workspace con agente de codigo + SSE streaming + sidebar
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
  sandbox-client.js      # HTTP client al sandbox agent (timeout 10s)
  sandbox-tools.js       # Tool definitions + executeSandboxTool + polling async
  tools.js               # Tools por conector; workspaceSandbox excluye sandbox_create_project
  google-oauth.js
  gmail.js / calendar.js / gtasks.js / drive.js
routes/
  auth.js                # POST /api/auth/google
  chats.js               # CRUD /api/chats (excluye chats vinculados a proyectos)
  projects.js            # CRUD /api/projects + community + workspace + publish + star
  proxy.js               # Proxy LiteLLM + tool calling + SSE streaming (POST /api/chat/stream)
  connectors.js          # OAuth conectores Google
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

- Crear mini-apps React via agente LLM (describe que queres y el agente genera el codigo) o via modal directo con nombre y descripcion
- Proyectos privados por defecto; el dueno puede publicarlos
- Stars: 1 por usuario por proyecto
- Preview publica: `https://proyectos-sandbox.allaria.xyz/{userSlug}/{name}/`

### Workspace por proyecto (agente de codigo)

Cada proyecto tiene un workspace con un agente LLM especializado. El agente sigue este flujo obligatorio:

1. `sandbox_read_file` -- leer el archivo antes de modificar
2. `sandbox_write_file` -- escribir el nuevo contenido
3. `sandbox_build` -- buildear y deployar el contenedor en .101
4. `sandbox_push` -- hacer git push a GitLab (automatico, sin pedir confirmacion)
5. Confirmar al usuario con la URL de preview

El agente usa el conector `workspaceSandbox` (que excluye `sandbox_create_project`, reservada para la creacion inicial).

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
| DELETE | `/api/projects/:id` | Eliminar proyecto |
| POST | `/api/projects/:id/publish` | Publicar |
| POST | `/api/projects/:id/unpublish` | Despublicar |
| POST | `/api/projects/:id/star` | Dar estrella |
| DELETE | `/api/projects/:id/star` | Quitar estrella |
| GET | `/api/projects/:id/chat` | Chat del workspace del proyecto |

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

---

## Variables de entorno del backend

Las variables viven en el secret de Kubernetes `back-secret` en el namespace `allaria-hub`. No hay `.env` en el repo.

```
DATABASE_URL        postgresql://root:***@172.30.200.114:5432/allaria_hub
LITELLM_URL         http://172.30.200.101:4000/v1/chat/completions
LITELLM_KEY         sk-allaria-***
SANDBOX_AGENT_URL   http://172.30.200.101:3100
SANDBOX_AGENT_KEY   5f983968...
SANDBOX_PREVIEW_URL https://proyectos-sandbox.allaria.xyz
GITLAB_URL          https://gitlab.allaria.xyz
GITLAB_GROUP_ID     54
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

### back y front (CCE)

Push a `main` en GitLab dispara el pipeline `.gitlab-ci.yml`:
1. `build-back` / `build-front`: buildea imagen Docker y la sube a Huawei SWR
2. `deploy-back` / `deploy-front`: `kubectl set image` en el deployment del namespace `allaria-hub`

No hay intervencion manual. El pod nuevo levanta y el viejo se termina.

Para sincronizar el schema de DB despues de un cambio en `prisma/schema.prisma`:

```bash
kubectl exec -n allaria-hub deployment/back -- npx prisma db push
```

### sandbox-agent (Docker en .101)

```bash
cd ~/Allaria-Hub/sandbox-agent && git pull && docker compose up -d --build
```

### Puertos

| Servicio | Puerto | Donde |
|----------|--------|-------|
| Frontend (nginx) | 3097 | CCE pod |
| Backend (Express) | 3098 | CCE pod |
| Sandbox Agent | 3100 | .101 |
| sandbox-nginx | 3099 | .101 |
| Proyectos de usuario | 4001-4100 | .101 |

---

## Notas criticas para developers nuevos

- **No usar dockerode en el sandbox server**: todas las operaciones Docker en `docker.js` y `nginx.js` usan `spawn('docker', [...])` via CLI. dockerode cuelga indefinidamente en este entorno (problema con .git y el socket). No revertir bajo ningun concepto.

- **Build asincrono**: POST /build responde inmediatamente con `status: 'building'`. El build corre en background. El backend hace polling al sandbox cada 6s hasta 20 intentos para saber el resultado.

- **Reconciliation job**: corre al iniciar el backend y cada 5 minutos. Sincroniza el status de los proyectos contra el sandbox. Solo marca un proyecto como `stopped` si el sandbox devuelve 404 explicito, nunca en caso de timeout (para evitar falsos negativos).

- **git safe.directory**: el Dockerfile del sandbox-agent configura `git config --global safe.directory '*'` para evitar el error "dubious ownership" de git 2.35+.

- **Networking sandbox**: `sandbox-nginx` y `sandbox-agent` necesitan `extra_hosts: host.docker.internal:host-gateway` para alcanzar puertos del host. Los `proxy_pass` usan `host.docker.internal:{port}`, no `localhost`.

- **Auth token**: `SHA256(userId + GOOGLE_CLIENT_ID)` guardado en localStorage. El backend lo verifica en cada request.

- **userSlug**: se deriva del email del usuario. `juan.perez@allaria.com.ar` -> `juan-perez`. Es parte de la URL de preview de los proyectos.

---

## Contactos e infraestructura

| Recurso | Detalle |
|---------|---------|
| DNS y TIC | tic@allaria.com.ar |
| Reviewer principal | Francisco Politi (mpoliti en GitLab) |
| GitLab | https://gitlab.allaria.xyz / grupo allaria-sandbox (ID 54) |
| CCE Cluster | Huawei Cloud la-south-2 / namespace allaria-hub |
| ELB | 23.227.176.14 |
| App server (CCE) | Nodos CCE, deployments back y front |
| Sandbox server | 172.30.200.101 / usuario allaria |
| DB PostgreSQL | 172.30.200.114:5432/allaria_hub |
| LiteLLM | http://172.30.200.101:4000 |
