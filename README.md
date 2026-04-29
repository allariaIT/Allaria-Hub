# Allaria Hub IA

Plataforma corporativa de inteligencia artificial de Allaria. Chat multi-modelo con conectores de Google (Gmail, Calendar, Tasks, Drive), hub de proyectos y documentacion interna.

**URL**: https://ia.allaria.xyz

## Arquitectura

```
ia.allaria.xyz (ELB Huawei)
       |
       v
   nginx (3097) ---- front (React + Vite)
       |
       | /api/*
       v
   Express (3098) ---- back (Node.js + Prisma)
       |                    |
       v                    v
   LiteLLM              PostgreSQL
   (litellm.allaria.xyz)  (172.26.20.32)
       |
       v
   Google APIs (Gmail, Calendar, Tasks, Drive)
```

## Stack

| Componente | Tecnologia |
|-----------|------------|
| Frontend | React 19, Vite 8, React Router 7, React Markdown, Lucide Icons |
| Backend | Node.js, Express 5, Prisma ORM, googleapis |
| Base de datos | PostgreSQL en 172.26.20.32 |
| LLM Gateway | LiteLLM en litellm.allaria.xyz |
| Auth | Google OAuth2 (login + conectores incrementales) |
| Deploy | Docker, Docker Compose, Huawei Cloud ELB |

## Estructura del Monorepo

```
Allaria-Hub/
|-- docker-compose.yml
|-- .github/workflows/
|
|-- front/                          # Puerto 3097
|   |-- Dockerfile
|   |-- src/
|   |   |-- components/
|   |   |   |-- Layout.jsx         # Sidebar con nav + user info
|   |   |   |-- ProtectedRoute.jsx
|   |   |   |-- ConnectorPicker.jsx # UI conectores Google (menu dropdown)
|   |   |   |-- ConnectorPicker.css
|   |   |-- context/
|   |   |   |-- AuthContext.jsx     # Google OAuth provider
|   |   |-- lib/
|   |   |   |-- api.js             # HTTP client para el backend
|   |   |-- pages/
|   |   |   |-- Home.jsx           # Dashboard
|   |   |   |-- Chat.jsx           # Chat multi-modelo + conectores + confirmaciones
|   |   |   |-- Chat.css
|   |   |   |-- Projects.jsx       # Hub de proyectos
|   |   |   |-- Docs.jsx           # Documentacion interna
|   |   |   |-- Login.jsx          # Login con Google
|   |   |-- data/
|   |       |-- mockData.js
|   |-- public/assets/
|
|-- back/                           # Puerto 3098
    |-- Dockerfile
    |-- prisma/
    |   |-- schema.prisma           # User, Chat, Message, UserConnection
    |-- src/
        |-- index.js                # Express server + rutas
        |-- lib/
        |   |-- prisma.js           # Prisma client
        |   |-- google-oauth.js     # Helper OAuth2 (auth URL, exchange, authed client)
        |   |-- gmail.js            # Gmail API wrapper
        |   |-- calendar.js         # Calendar API wrapper
        |   |-- gtasks.js           # Tasks API wrapper
        |   |-- drive.js            # Drive API wrapper
        |   |-- tools.js            # Tool definitions + executor + confirmables
        |-- middleware/
        |   |-- auth.js             # Verificacion de session token
        |-- routes/
            |-- auth.js             # POST /api/auth/google
            |-- chats.js            # CRUD /api/chats
            |-- proxy.js            # Proxy LiteLLM + tool calling + confirmaciones
            |-- connectors.js       # OAuth conectores Google
```

## Funcionalidades

### Chat IA Multi-Modelo
- **3 providers**: Gemini (Google), ChatGPT (OpenAI), Claude (Anthropic)
- **5 modelos**: Gemini Flash, Gemini Pro, GPT-4 Turbo, GPT-4o, Claude Sonnet 4.5
- Selector visual con logos y colores por provider
- **Archivos adjuntos**: imagenes, PDFs, audio, video, codigo, texto
- Auto-switch a Gemini al adjuntar archivos (mejor soporte multimodal)
- Historial de conversaciones persistido en PostgreSQL
- Crear, renombrar, eliminar chats
- Auto-titulo basado en el primer mensaje
- Markdown rendering con syntax highlight
- Typing indicator

### Conectores de Google

Cada conector se conecta de forma independiente via **OAuth incremental** - los permisos se piden al momento de activar el conector por primera vez.

| Conector | Scopes | Tools | Confirmacion |
|----------|--------|-------|-------------|
| **Gmail** | gmail.readonly, gmail.send, gmail.modify | `gmail_list`, `gmail_read`, `gmail_send`, `gmail_search` | `gmail_send` |
| **Calendar** | calendar.readonly, calendar.events | `calendar_list`, `calendar_create`, `calendar_search` | `calendar_create` |
| **Tasks** | tasks | `tasks_list`, `tasks_create`, `tasks_complete`, `tasks_search` | `tasks_create`, `tasks_complete` |
| **Drive** | drive.readonly, drive.metadata.readonly | `drive_list`, `drive_search`, `drive_get` | Ninguna (solo lectura) |

**UI del picker:**
- Boton con icono de plug en el header del chat
- Menu dropdown con cada conector: logo, nombre, descripcion
- Estados: no conectado (boton "Conectar") / conectado (toggle on/off + "Desconectar")
- Badge inline con dot verde pulsante cuando un conector esta activo

### Confirmacion de Acciones

Las tools que modifican datos requieren **confirmacion explicita** del usuario antes de ejecutarse. El backend pausa la ejecucion y devuelve una preview al frontend.

**Flujo:**
```
1. LLM pide ejecutar gmail_send({to, subject, body})
2. Backend detecta que es confirmable -> NO la ejecuta
3. Devuelve _pendingConfirmations con los detalles
4. Frontend muestra card con preview:
   - Para: destinatario@email.com
   - Asunto: ...
   - Cuerpo: (texto completo)
5. Botones "Confirmar" (verde) / "Cancelar" (gris)
6. Si confirma -> POST /api/chat/confirm -> se ejecuta
7. Si cancela -> el LLM recibe "El usuario cancelo esta accion"
```

**Tools confirmables:** `gmail_send`, `calendar_create`, `tasks_create`, `tasks_complete`

### Tool Calling - Flujo Completo

```
1. Usuario envia mensaje con conectores activos
2. Backend arma request a LiteLLM con tools[] segun conectores
3. LiteLLM responde con tool_calls
4. Si la tool es confirmable -> pausar, devolver preview al frontend
5. Si no -> ejecutar con tokens del usuario autenticado
6. Resultado vuelve al LLM -> puede pedir mas tools (loop max 5 rondas)
7. Respuesta final se guarda en DB y se devuelve al frontend
```

### Autenticacion
- Google OAuth via Google Identity Services (One Tap)
- Session token persistente (SHA256 de Google sub + Client ID)
- Upsert de usuario en DB al loguearse

### Hub de Proyectos
- Grid de proyectos con cards (titulo, autor, descripcion, tags)
- Busqueda y filtro por estado

### Documentacion
- 4 secciones con sidebar de navegacion
- Buscador de articulos

## API del Backend

### Auth
| Metodo | Ruta | Descripcion |
|--------|------|-------------|
| POST | `/api/auth/google` | Login con credential de Google |

### Chats
| Metodo | Ruta | Descripcion |
|--------|------|-------------|
| GET | `/api/chats` | Listar chats del usuario con mensajes |
| POST | `/api/chats` | Crear nuevo chat |
| GET | `/api/chats/:id` | Obtener chat con mensajes |
| PATCH | `/api/chats/:id` | Renombrar chat |
| DELETE | `/api/chats/:id` | Eliminar chat |
| DELETE | `/api/chats/:id/messages` | Limpiar mensajes de un chat |

### Chat IA (Proxy LiteLLM)
| Metodo | Ruta | Descripcion |
|--------|------|-------------|
| POST | `/api/chat/completions` | Proxy a LiteLLM + tool calling. Acepta `connectors[]` |
| POST | `/api/chat/confirm` | Confirmar/rechazar accion pendiente |

### Conectores
| Metodo | Ruta | Descripcion |
|--------|------|-------------|
| GET | `/api/connectors` | Listar conexiones del usuario |
| POST | `/api/connectors/auth` | Iniciar OAuth para un provider |
| GET | `/api/connectors/callback` | Callback de Google OAuth (publico) |
| DELETE | `/api/connectors/:provider` | Desconectar un provider |

### Health
| Metodo | Ruta | Descripcion |
|--------|------|-------------|
| GET | `/health` | Health check |

## Base de Datos

### Modelos Prisma

**User**
- `id` (String, PK) - Google sub ID
- `email` (unique), `name`, `picture`
- Relaciones: `chats[]`, `connections[]`

**Chat**
- `id` (cuid), `title` (default: "Nuevo chat"), `userId`
- Relacion: `messages[]`

**Message**
- `id` (cuid), `chatId`, `role` (user/assistant), `content`, `model?`
- Cascade delete al borrar chat

**UserConnection**
- `id` (cuid), `userId`, `provider` (gmail/calendar/tasks/drive)
- `accessToken`, `refreshToken`, `scopes`, `expiresAt`
- Constraint unique: `[userId, provider]`
- Los tokens se auto-refrescan cuando expiran via listener `tokens`

## Variables de Entorno

### back/.env (no esta en el repo - gitignore)
```env
DATABASE_URL=postgresql://user:pass@host:5432/allaria_hub
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_REDIRECT_URI=https://ia.allaria.xyz/api/connectors/callback
LITELLM_URL=https://litellm.allaria.xyz/v1/chat/completions
LITELLM_KEY=sk-...
PORT=3098
CORS_ORIGIN=https://ia.allaria.xyz
FRONT_URL=https://ia.allaria.xyz
```

### Google Cloud Console
- APIs habilitadas: Gmail, Calendar, Tasks, Drive
- OAuth 2.0 Client ID (Web application)
- Authorized redirect URI: `https://ia.allaria.xyz/api/connectors/callback`
- Authorized JavaScript origins: `https://ia.allaria.xyz`

## Deploy

### Actualizar
```bash
git pull && docker compose up -d --build
```

### Puertos
| Servicio | Puerto |
|----------|--------|
| Frontend (nginx) | 3097 |
| Backend (Express) | 3098 |

El Dockerfile del back ejecuta `prisma db push` al iniciar (sincroniza schema automaticamente). El `.env` debe existir en el server antes del deploy.

## Privacidad

- Cada usuario solo accede a sus propios datos (tokens, chats, conexiones)
- Los tokens OAuth se guardan en la DB asociados al userId
- El LLM nunca ve tokens - solo recibe los resultados de las tools
- Los adjuntos se guardan como referencia `[adjunto nombre]` en DB, no el contenido
- Las acciones destructivas requieren confirmacion explicita del usuario

## Modelos disponibles

| Selector | Model ID (LiteLLM) | Provider |
|----------|-------------------|----------|
| Gemini Rapido | `gemini/gemini-2.5-flash` | Google |
| Gemini Pensar | `gemini/gemini-2.5-pro` | Google |
| ChatGPT Rapido | `openai/gpt-4-turbo` | OpenAI |
| ChatGPT Pensar | `openai/gpt-4o` | OpenAI |
| Claude Sonnet 4.5 | `claude-sonnet-4-5` | Anthropic |

## Soporte de archivos adjuntos

| Tipo | Gemini | ChatGPT | Claude |
|------|--------|---------|--------|
| Imagenes (png, jpg, webp, gif) | Si | Si | Si |
| PDF | Si | Si | Si |
| Audio (mp3, wav, ogg) | Si | Si | No |
| Video | Si | No | No |
| Texto/codigo | Si | Si | Si |

Al adjuntar un archivo, el chat cambia automaticamente a Gemini (mejor soporte multimodal).

## Design System

- **Colores**: Navy `#0B3D7A`, Gold `#B69A5B`
- **Tipografia**: Playfair Display (headings), DM Sans (body), JetBrains Mono (code)
- **Responsive**: Sidebar colapsable en mobile
