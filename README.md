# Allaria Hub IA

Plataforma corporativa de inteligencia artificial de Allaria. Chat multi-modelo, hub de proyectos y documentación interna.

**URL**: https://ia.allaria.xyz

## Arquitectura

```
ia.allaria.xyz (ELB Huawei)
       │
       ▼
   nginx (3097) ──── front (React + Vite)
       │
       │ /api/*
       ▼
   Express (3098) ──── back (Node.js + Prisma)
       │                    │
       ▼                    ▼
   LiteLLM              PostgreSQL
   (litellm.allaria.xyz)  (172.26.20.32)
```

## Stack

| Componente | Tecnología |
|-----------|------------|
| Frontend | React 19, Vite, React Router, React Markdown, Lucide Icons |
| Backend | Node.js, Express 5, Prisma ORM |
| Base de datos | PostgreSQL (con pgvector) en 172.26.20.32 |
| LLM Gateway | LiteLLM en litellm.allaria.xyz |
| Auth | Google OAuth (Google Identity Services) |
| Deploy | Docker, Docker Compose, Huawei Cloud ELB |

## Estructura del Monorepo

```
Allaria-Hub/
├── docker-compose.yml          # Levanta front + back
├── .github/                    # CI/CD workflows
│
├── front/                      # Puerto 3097
│   ├── Dockerfile              # Multi-stage: node build + nginx
│   ├── nginx.conf              # SPA + proxy /api → back:3098
│   ├── src/
│   │   ├── components/
│   │   │   ├── Layout.jsx      # Sidebar con nav + user info
│   │   │   └── ProtectedRoute.jsx
│   │   ├── context/
│   │   │   └── AuthContext.jsx  # Google OAuth provider
│   │   ├── lib/
│   │   │   └── api.js          # HTTP client para el backend
│   │   ├── pages/
│   │   │   ├── Home.jsx        # Dashboard con stats y acceso rápido
│   │   │   ├── Chat.jsx        # Chat multi-modelo con adjuntos
│   │   │   ├── Projects.jsx    # Hub de proyectos con búsqueda
│   │   │   ├── Docs.jsx        # Documentación interna
│   │   │   └── Login.jsx       # Login con Google
│   │   └── data/
│   │       └── mockData.js     # Datos demo de proyectos y docs
│   └── public/assets/          # Logos e iconos Allaria
│
└── back/                       # Puerto 3098
    ├── Dockerfile              # Node.js + Prisma
    ├── .env                    # Variables de entorno
    ├── prisma/
    │   └── schema.prisma       # Modelos: User, Chat, Message
    └── src/
        ├── index.js            # Express server
        ├── lib/prisma.js       # Prisma client
        ├── middleware/
        │   └── auth.js         # Verificación de session token
        └── routes/
            ├── auth.js         # POST /api/auth/google
            ├── chats.js        # CRUD /api/chats
            └── proxy.js        # POST /api/chat/completions
```

## Funcionalidades

### Chat IA Multi-Modelo
- **3 providers**: Gemini (Google), ChatGPT (OpenAI), Claude (Anthropic)
- **5 modelos**: Gemini Rápido, Gemini Pensar, ChatGPT Rápido, ChatGPT Pensar, Claude Sonnet 4.5
- Selector visual con logos y colores por provider
- Hover en Gemini/ChatGPT despliega variantes (Rápido/Pensar)
- **Archivos adjuntos**: imágenes, PDFs, audio, video, código, texto
- Auto-switch a Gemini al adjuntar archivos (mejor soporte multimodal)
- Toast de notificación al cambiar de modelo
- Historial de conversaciones por usuario (persistido en PostgreSQL)
- Crear, renombrar, eliminar chats
- Auto-título basado en el primer mensaje
- System prompt que identifica el modelo y habilita análisis de adjuntos
- Markdown rendering con syntax highlight para código
- Botón de copiar respuestas
- Typing indicator

### Autenticación
- Google OAuth via Google Identity Services (One Tap)
- Session token persistente (SHA256 de Google sub + Client ID)
- Upsert de usuario en DB al loguearse
- Foto, nombre y email de Google visibles en sidebar
- Botón de cerrar sesión

### Hub de Proyectos
- Grid de proyectos con cards (título, autor, descripción, tags, estrellas)
- Búsqueda por título, autor, tecnología
- Filtro por estado: Producción, En desarrollo, Beta
- Datos mock (6 proyectos demo)

### Documentación
- 4 secciones: Primeros Pasos, Arquitectura, APIs, DevOps
- Sidebar de navegación con secciones expandibles
- Buscador de artículos
- Tiempo de lectura estimado

### Home / Dashboard
- Hero con branding Allaria
- 4 stat cards (proyectos, usuarios, actualizaciones, uptime)
- 3 cards de acceso rápido (Chat, Proyectos, Docs)

## API del Backend

### Auth
| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/auth/google` | Verificar token de Google, crear/actualizar usuario, devuelve session token |

### Chats
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/chats` | Listar chats del usuario con mensajes |
| POST | `/api/chats` | Crear nuevo chat |
| PATCH | `/api/chats/:id` | Renombrar chat |
| DELETE | `/api/chats/:id` | Eliminar chat |
| DELETE | `/api/chats/:id/messages` | Limpiar mensajes de un chat |

### Chat Completions (Proxy LiteLLM)
| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/chat/completions` | Proxy a LiteLLM. Guarda mensajes en DB. Envía email del usuario |

### Health
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Health check |

## Base de Datos

### Modelos Prisma

**User**
- `id` (String, PK) — Google sub ID
- `email` (String, unique)
- `name`, `picture`
- `createdAt`, `updatedAt`

**Chat**
- `id` (String, PK, cuid)
- `title` (default: "Nuevo chat")
- `userId` → User
- `createdAt`, `updatedAt`

**Message**
- `id` (String, PK, cuid)
- `chatId` → Chat (cascade delete)
- `role` — "user" | "assistant"
- `content` — Texto plano (adjuntos se guardan como `[📎 nombre]`)
- `model` — Modelo usado (solo en respuestas)
- `createdAt`

## Variables de Entorno

### back/.env
```env
DATABASE_URL=postgresql://root:02DeAbril@172.26.20.32:5432/allaria_hub
GOOGLE_CLIENT_ID=789748745254-xxx.apps.googleusercontent.com
LITELLM_URL=https://litellm.allaria.xyz/v1/chat/completions
LITELLM_KEY=sk-xxx
PORT=3098
CORS_ORIGIN=https://ia.allaria.xyz
```

### front/.env
```env
VITE_API_URL=    # Vacío = rutas relativas (nginx proxea /api)
```

### Google Cloud Console
- Proyecto: Allaria Hub
- OAuth 2.0 Client ID (Web application)
- Authorized JavaScript origins: `https://ia.allaria.xyz`, `http://localhost:5174`

## Deploy

### Requisitos
- Docker + Docker Compose
- Red Docker `red-docker` existente
- PostgreSQL accesible desde el servidor
- DNS `ia.allaria.xyz` apuntando al ELB (puerto 3097)

### Primer deploy
```bash
git clone https://github.com/AllariaIT/Allaria-Hub.git
cd Allaria-Hub
docker compose up -d --build
```

### Actualizar
```bash
git pull
docker compose up -d --build
```

### Puertos
| Servicio | Puerto |
|----------|--------|
| Frontend (nginx) | 3097 |
| Backend (Express) | 3098 |

## Design System

- **Colores**: Navy `#0B3D7A`, Gold `#B69A5B`
- **Tipografía**: Playfair Display (headings), DM Sans (body), JetBrains Mono (code)
- **Patrones**: Diagonales inspiradas en el logo Allaria
- **Responsive**: Sidebar colapsable en mobile

## Modelos disponibles

| Selector | Model ID (LiteLLM) | Provider |
|----------|-------------------|----------|
| Gemini Rápido | `gemini/gemini-2.5-flash` | Google |
| Gemini Pensar | `gemini/gemini-2.5-pro` | Google |
| ChatGPT Rápido | `openai/gpt-4-turbo` | OpenAI |
| ChatGPT Pensar | `openai/gpt-4o` | OpenAI |
| Claude Sonnet 4.5 | `claude-sonnet-4-5` | Anthropic |

## Soporte de archivos adjuntos

| Tipo | Gemini | ChatGPT | Claude |
|------|--------|---------|--------|
| Imágenes (png, jpg, webp, gif) | ✅ | ✅ | ✅ |
| PDF | ✅ | ✅ | ✅ |
| Audio (mp3, wav, ogg) | ✅ | ✅ | ❌ |
| Video | ✅ | ❌ | ❌ |
| Texto/código | ✅ | ✅ | ✅ |

> Al adjuntar un archivo, el chat cambia automáticamente a Gemini (mejor soporte multimodal).
