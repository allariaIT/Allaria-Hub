# Proyectos Privados + Estrellas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Proyectos arrancan privados, el usuario puede publicarlos, y los proyectos publicados acumulan estrellas (1 por usuario) ordenadas de mayor a menor en el Hub de comunidad.

**Architecture:** Se agrega `isPublic Boolean @default(false)` al modelo `Project` y un nuevo modelo `ProjectStar` con unique constraint `[userId, projectId]`. El backend expone endpoints de publish/unpublish y star/unstar. El frontend muestra botones en la tarjeta de "Mis Proyectos", en el Workspace (sidebar), y botón de estrella en las tarjetas del Hub.

**Tech Stack:** Prisma + PostgreSQL, Express 5, React 19 + Vite

---

## File Map

| Archivo | Cambio |
|---------|--------|
| `back/prisma/schema.prisma` | Agregar `isPublic` a `Project`, nuevo modelo `ProjectStar`, relación `stars` en `User` |
| `back/src/routes/projects.js` | Nuevos endpoints publish/unpublish/star/unstar, modificar GET /community y GET / |
| `front/src/lib/api.js` | Agregar publishProject, unpublishProject, starProject, unstarProject |
| `front/src/pages/Projects.jsx` | Botón publish/unpublish en mis proyectos + estrella en hub |
| `front/src/pages/ProjectWorkspace.jsx` | Botón publish/unpublish en sidebar |

---

## Task 1: Schema de base de datos

**Files:**
- Modify: `back/prisma/schema.prisma`

- [ ] **Step 1: Agregar `isPublic` al modelo `Project` y nuevo modelo `ProjectStar`**

Reemplazar el modelo `Project` y agregar `ProjectStar` + relación en `User`. El archivo completo queda así:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id          String           @id // Google sub ID
  email       String           @unique
  name        String
  picture     String?
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt
  chats       Chat[]
  connections UserConnection[]
  projects    Project[]
  stars       ProjectStar[]
}

model Chat {
  id        String    @id @default(cuid())
  title     String    @default("Nuevo chat")
  userId    String
  user      User      @relation(fields: [userId], references: [id])
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  messages  Message[]

  @@index([userId])
}

model Message {
  id        String   @id @default(cuid())
  chatId    String
  chat      Chat     @relation(fields: [chatId], references: [id], onDelete: Cascade)
  role      String   // "user" | "assistant"
  content   String
  model     String?  // model used for this message
  createdAt DateTime @default(now())

  @@index([chatId])
}

model UserConnection {
  id           String    @id @default(cuid())
  userId       String
  user         User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  provider     String    // "gmail"
  accessToken  String
  refreshToken String
  scopes       String    // scopes otorgados, comma-separated
  expiresAt    DateTime?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  @@unique([userId, provider])
  @@index([userId])
}

model Project {
  id          String        @id @default(cuid())
  name        String                // "dashboard-ventas" (slug)
  title       String                // "Dashboard de Ventas"
  description String?
  userId      String
  user        User          @relation(fields: [userId], references: [id])
  gitlabId    Int?                  // ID del repo en GitLab
  repoUrl     String?               // URL del repo
  port        Int?                  // Puerto asignado
  status      String        @default("creating") // creating, running, stopped, error
  previewUrl  String?               // URL completa de preview
  template    String        @default("vite-react")
  chatId      String?               // Chat dedicado del proyecto
  isPublic    Boolean       @default(false)
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt
  stars       ProjectStar[]

  @@unique([userId, name])
  @@index([userId])
}

model ProjectStar {
  id        String   @id @default(cuid())
  userId    String
  projectId String
  createdAt DateTime @default(now())
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  project   Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@unique([userId, projectId])
}
```

- [ ] **Step 2: Aplicar schema a la DB**

Desde el servidor de la app:
```bash
docker compose exec back npx prisma db push
```

Expected output: `Your database is now in sync with your Prisma schema.`

- [ ] **Step 3: Commit**

```bash
git add back/prisma/schema.prisma
git commit -m "feat: schema isPublic en Project + modelo ProjectStar"
```

---

## Task 2: Backend — GET /community y GET / actualizados

**Files:**
- Modify: `back/src/routes/projects.js`

- [ ] **Step 1: Actualizar GET /community para incluir conteo de estrellas y `starredByMe`**

Reemplazar el handler de `GET /community` (líneas 104-112 actuales) con:

```js
// GET /api/projects/community - All public projects ordered by stars
projectsRouter.get('/community', async (req, res) => {
  const projects = await prisma.project.findMany({
    where: { isPublic: true, status: 'running' },
    orderBy: { stars: { _count: 'desc' } },
    include: {
      user: { select: { id: true, name: true, picture: true } },
      _count: { select: { stars: true } },
    },
  })

  const starred = await prisma.projectStar.findMany({
    where: { userId: req.user.id, projectId: { in: projects.map(p => p.id) } },
    select: { projectId: true },
  })
  const starredSet = new Set(starred.map(s => s.projectId))

  res.json(projects.map(p => ({
    ...p,
    starredByMe: starredSet.has(p.id),
  })))
})
```

- [ ] **Step 2: Actualizar GET / para incluir `isPublic` y conteo de estrellas**

Reemplazar el handler de `GET /` (líneas 114-121 actuales) con:

```js
// GET /api/projects - List user's projects
projectsRouter.get('/', async (req, res) => {
  const projects = await prisma.project.findMany({
    where: { userId: req.user.id },
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { stars: true } } },
  })
  res.json(projects)
})
```

- [ ] **Step 3: Commit**

```bash
git add back/src/routes/projects.js
git commit -m "feat: GET /community con estrellas y starredByMe, GET / con conteo"
```

---

## Task 3: Backend — Endpoints publish/unpublish

**Files:**
- Modify: `back/src/routes/projects.js`

- [ ] **Step 1: Agregar PATCH /:id/publish y /:id/unpublish**

Agregar estos dos endpoints **antes** del `DELETE /:id` (línea 175 actual):

```js
// PATCH /api/projects/:id/publish - Publicar proyecto
projectsRouter.patch('/:id/publish', async (req, res) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, userId: req.user.id },
  })
  if (!project) return res.status(404).json({ error: 'Proyecto no encontrado' })
  if (project.status !== 'running') return res.status(400).json({ error: 'Solo se pueden publicar proyectos activos' })

  const updated = await prisma.project.update({
    where: { id: project.id },
    data: { isPublic: true },
    include: { _count: { select: { stars: true } } },
  })
  res.json(updated)
})

// PATCH /api/projects/:id/unpublish - Despublicar proyecto (las estrellas se conservan)
projectsRouter.patch('/:id/unpublish', async (req, res) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, userId: req.user.id },
  })
  if (!project) return res.status(404).json({ error: 'Proyecto no encontrado' })

  const updated = await prisma.project.update({
    where: { id: project.id },
    data: { isPublic: false },
    include: { _count: { select: { stars: true } } },
  })
  res.json(updated)
})
```

- [ ] **Step 2: Verificar que el servidor levanta sin errores**

```bash
docker compose logs back --tail=20
```

Expected: sin líneas de error de sintaxis.

- [ ] **Step 3: Commit**

```bash
git add back/src/routes/projects.js
git commit -m "feat: endpoints publish/unpublish para proyectos"
```

---

## Task 4: Backend — Endpoints star/unstar

**Files:**
- Modify: `back/src/routes/projects.js`

- [ ] **Step 1: Agregar POST /:id/star y DELETE /:id/star**

Agregar a continuación de los endpoints publish/unpublish:

```js
// POST /api/projects/:id/star - Dar estrella
projectsRouter.post('/:id/star', async (req, res) => {
  const project = await prisma.project.findFirst({
    where: { id: req.params.id, isPublic: true, status: 'running' },
  })
  if (!project) return res.status(404).json({ error: 'Proyecto no encontrado o no público' })
  if (project.userId === req.user.id) return res.status(400).json({ error: 'No podés darle estrella a tu propio proyecto' })

  await prisma.projectStar.upsert({
    where: { userId_projectId: { userId: req.user.id, projectId: project.id } },
    create: { userId: req.user.id, projectId: project.id },
    update: {},
  })

  const count = await prisma.projectStar.count({ where: { projectId: project.id } })
  res.json({ stars: count })
})

// DELETE /api/projects/:id/star - Quitar estrella
projectsRouter.delete('/:id/star', async (req, res) => {
  await prisma.projectStar.deleteMany({
    where: { userId: req.user.id, projectId: req.params.id },
  })
  const count = await prisma.projectStar.count({ where: { projectId: req.params.id } })
  res.json({ stars: count })
})
```

- [ ] **Step 2: Commit**

```bash
git add back/src/routes/projects.js
git commit -m "feat: endpoints star/unstar para proyectos públicos"
```

---

## Task 5: Frontend — api.js

**Files:**
- Modify: `front/src/lib/api.js`

- [ ] **Step 1: Agregar los 4 nuevos métodos al objeto `api`**

Después de `stopProject` (línea 102 actual), agregar:

```js
  publishProject: (id) => request(`/api/projects/${id}/publish`, { method: 'PATCH' }),
  unpublishProject: (id) => request(`/api/projects/${id}/unpublish`, { method: 'PATCH' }),
  starProject: (id) => request(`/api/projects/${id}/star`, { method: 'POST' }),
  unstarProject: (id) => request(`/api/projects/${id}/star`, { method: 'DELETE' }),
```

- [ ] **Step 2: Commit**

```bash
git add front/src/lib/api.js
git commit -m "feat: métodos api publish/unpublish/star/unstar"
```

---

## Task 6: Frontend — Projects.jsx

**Files:**
- Modify: `front/src/pages/Projects.jsx`

- [ ] **Step 1: Agregar imports de iconos nuevos**

En la línea 2 actual, agregar `Globe` y `EyeOff` y `Star` al import de lucide-react:

```js
import { Search, ArrowUpRight, Plus, Loader2, ExternalLink, GitBranch, Square, Trash2, X, Globe, EyeOff, Star } from 'lucide-react'
```

- [ ] **Step 2: Agregar handlers handlePublish y handleUnpublish**

Después de `handleStop` (línea 96 actual), agregar:

```js
  const handlePublish = async (e, id) => {
    e.stopPropagation()
    try {
      const updated = await api.publishProject(id)
      setMyProjects(prev => prev.map(p => p.id === id ? { ...p, ...updated } : p))
    } catch (err) {
      alert('Error: ' + err.message)
    }
  }

  const handleUnpublish = async (e, id) => {
    e.stopPropagation()
    try {
      const updated = await api.unpublishProject(id)
      setMyProjects(prev => prev.map(p => p.id === id ? { ...p, ...updated } : p))
    } catch (err) {
      alert('Error: ' + err.message)
    }
  }
```

- [ ] **Step 3: Agregar handler handleStar**

Después de `handleUnpublish`, agregar:

```js
  const handleStar = async (project) => {
    const wasStarred = project.starredByMe
    // Optimistic update
    setCommunityProjects(prev => prev.map(p =>
      p.id === project.id
        ? { ...p, starredByMe: !wasStarred, _count: { ...p._count, stars: p._count.stars + (wasStarred ? -1 : 1) } }
        : p
    ))
    try {
      if (wasStarred) {
        await api.unstarProject(project.id)
      } else {
        await api.starProject(project.id)
      }
    } catch {
      // Revertir si falla
      setCommunityProjects(prev => prev.map(p =>
        p.id === project.id
          ? { ...p, starredByMe: wasStarred, _count: { ...p._count, stars: p._count.stars + (wasStarred ? 1 : -1) } }
          : p
      ))
    }
  }
```

- [ ] **Step 4: Actualizar la tarjeta de "Mis Proyectos" — agregar botón publish/unpublish y badge de estrellas**

En el bloque `my-project-actions` (línea 158), agregar el botón publish/unpublish **antes** del botón Stop:

```jsx
  {project.status === 'running' && (
    project.isPublic
      ? <button className="my-project-btn" onClick={(e) => handleUnpublish(e, project.id)} title="Despublicar">
          <EyeOff size={13} /> Despublicar
        </button>
      : <button className="my-project-btn publish" onClick={(e) => handlePublish(e, project.id)} title="Publicar en el Hub">
          <Globe size={13} /> Publicar
        </button>
  )}
```

Y en el status badge (línea 149), agregar el contador de estrellas justo después del badge existente:

```jsx
  {(project.isPublic || project._count?.stars > 0) && (
    <span className="my-project-stars">
      <Star size={11} style={{ fill: '#eab308', color: '#eab308' }} />
      {project._count?.stars ?? 0}
    </span>
  )}
```

El bloque completo del header de la tarjeta queda así:

```jsx
<div className="my-project-card-top">
  <div className="my-project-avatar">{project.title.slice(0, 2).toUpperCase()}</div>
  <div className="my-project-info">
    <span className="my-project-title">{project.title}</span>
    <span className="my-project-slug">{project.name}</span>
  </div>
  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
    {(project.isPublic || project._count?.stars > 0) && (
      <span className="my-project-stars">
        <Star size={11} style={{ fill: '#eab308', color: '#eab308' }} />
        {project._count?.stars ?? 0}
      </span>
    )}
    <span
      className="my-project-status"
      style={{ '--sc': STATUS_COLORS[project.status] || '#888' }}
    >
      {project.status === 'creating' && <Loader2 size={11} className="spin-icon" style={{ marginRight: 4 }} />}
      {STATUS_LABELS[project.status] || project.status}
    </span>
  </div>
</div>
```

Y el bloque de acciones completo:

```jsx
<div className="my-project-actions" onClick={e => e.stopPropagation()}>
  {project.previewUrl && (
    <a href={project.previewUrl} target="_blank" rel="noopener noreferrer" className="my-project-btn">
      <ExternalLink size={13} /> Preview
    </a>
  )}
  {project.repoUrl && (
    <a href={project.repoUrl} target="_blank" rel="noopener noreferrer" className="my-project-btn">
      <GitBranch size={13} /> GitLab
    </a>
  )}
  {project.status === 'running' && (
    project.isPublic
      ? <button className="my-project-btn" onClick={(e) => handleUnpublish(e, project.id)} title="Despublicar">
          <EyeOff size={13} /> Despublicar
        </button>
      : <button className="my-project-btn publish" onClick={(e) => handlePublish(e, project.id)} title="Publicar en el Hub">
          <Globe size={13} /> Publicar
        </button>
  )}
  {project.status === 'running' && (
    <button className="my-project-btn stop" onClick={(e) => handleStop(e, project.id)}>
      <Square size={13} /> Detener
    </button>
  )}
  <button className="my-project-btn delete" onClick={(e) => handleDelete(e, project.id)}>
    <Trash2 size={13} />
  </button>
</div>
```

- [ ] **Step 5: Actualizar la tarjeta del Hub — agregar botón de estrella**

Agregar el `useAuth` import para conocer el usuario actual:

```js
import { useAuth } from '../context/AuthContext'
```

Dentro de la función `Projects()`, agregar al inicio:

```js
const { user } = useAuth()
```

En el footer de la tarjeta del Hub (alrededor de línea 235), reemplazar el bloque `project-footer` con:

```jsx
<div className="project-footer">
  <span
    className="my-project-status"
    style={{ '--sc': STATUS_COLORS[project.status] || '#888' }}
  >
    {STATUS_LABELS[project.status] || project.status}
  </span>
  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
    <span className="project-stat" style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
      {new Date(project.createdAt).toLocaleDateString('es-AR')}
    </span>
    {project.user?.id !== user?.id && (
      <button
        className={`star-btn${project.starredByMe ? ' star-btn--active' : ''}`}
        onClick={(e) => { e.stopPropagation(); handleStar(project) }}
        title={project.starredByMe ? 'Quitar estrella' : 'Dar estrella'}
      >
        <Star size={13} />
        <span>{project._count?.stars ?? 0}</span>
      </button>
    )}
    {project.user?.id === user?.id && project._count?.stars > 0 && (
      <span className="star-count-own">
        <Star size={13} style={{ fill: '#eab308', color: '#eab308' }} />
        {project._count.stars}
      </span>
    )}
  </div>
</div>
```

- [ ] **Step 6: Agregar estilos en `Projects.css`**

Abrir `front/src/pages/Projects.css` y agregar al final:

```css
/* Publish button */
.my-project-btn.publish {
  color: #22c55e;
  border-color: rgba(34, 197, 94, 0.3);
}
.my-project-btn.publish:hover {
  background: rgba(34, 197, 94, 0.1);
}

/* Stars badge en mis proyectos */
.my-project-stars {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: #eab308;
  font-weight: 600;
}

/* Star button en hub */
.star-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.1);
  background: transparent;
  color: var(--text-tertiary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.star-btn:hover {
  background: rgba(234, 179, 8, 0.1);
  color: #eab308;
  border-color: rgba(234, 179, 8, 0.3);
}
.star-btn--active {
  color: #eab308;
  border-color: rgba(234, 179, 8, 0.4);
  background: rgba(234, 179, 8, 0.08);
}
.star-btn--active svg {
  fill: #eab308;
}

/* Star count propio (sin botón) */
.star-count-own {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  color: #eab308;
}
```

- [ ] **Step 7: Commit**

```bash
git add front/src/pages/Projects.jsx front/src/pages/Projects.css
git commit -m "feat: publish/unpublish y estrellas en hub de proyectos"
```

---

## Task 7: Frontend — ProjectWorkspace.jsx (botón publish/unpublish en sidebar)

**Files:**
- Modify: `front/src/pages/ProjectWorkspace.jsx`

- [ ] **Step 1: Agregar imports de iconos**

En la línea 4 actual, agregar `Globe` y `EyeOff`:

```js
import {
  ArrowLeft, ExternalLink, GitBranch, Pencil, Check, X,
  Send, Bot, User, Copy, CheckCheck, Loader2, Code, GitBranch as GitPush,
  ShieldAlert, RotateCcw, Globe, EyeOff
} from 'lucide-react'
```

- [ ] **Step 2: Agregar handler handlePublishToggle**

Después de `saveDesc` (línea ~128), agregar:

```js
  const handlePublishToggle = async () => {
    try {
      const updated = project.isPublic
        ? await api.unpublishProject(id)
        : await api.publishProject(id)
      setProject(prev => ({ ...prev, ...updated }))
    } catch (err) {
      alert('Error: ' + err.message)
    }
  }
```

- [ ] **Step 3: Agregar sección "Visibilidad" en el sidebar**

En el sidebar, después del bloque `pw-sidebar-section` de "Descripción" (línea ~327), agregar:

```jsx
<div className="pw-sidebar-section">
  <h4>Visibilidad</h4>
  {project.status === 'running' ? (
    <button
      className={`pw-visibility-btn${project.isPublic ? ' pw-visibility-btn--public' : ''}`}
      onClick={handlePublishToggle}
    >
      {project.isPublic
        ? <><EyeOff size={13} /> Despublicar</>
        : <><Globe size={13} /> Publicar en el Hub</>
      }
    </button>
  ) : (
    <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
      Solo se pueden publicar proyectos activos
    </span>
  )}
  {project.isPublic && (
    <p style={{ fontSize: '11px', color: '#22c55e', marginTop: '6px' }}>
      Visible en el Hub de comunidad
    </p>
  )}
</div>
```

- [ ] **Step 4: Agregar estilos en `ProjectWorkspace.css`**

Abrir `front/src/pages/ProjectWorkspace.css` y agregar al final:

```css
.pw-visibility-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.12);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
  text-align: left;
}
.pw-visibility-btn:hover {
  background: rgba(34, 197, 94, 0.08);
  color: #22c55e;
  border-color: rgba(34, 197, 94, 0.3);
}
.pw-visibility-btn--public {
  color: #22c55e;
  border-color: rgba(34, 197, 94, 0.3);
}
.pw-visibility-btn--public:hover {
  background: rgba(239, 68, 68, 0.08);
  color: #ef4444;
  border-color: rgba(239, 68, 68, 0.3);
}
```

- [ ] **Step 5: Commit**

```bash
git add front/src/pages/ProjectWorkspace.jsx front/src/pages/ProjectWorkspace.css
git commit -m "feat: botón publish/unpublish en workspace sidebar"
```

---

## Task 8: Deploy

- [ ] **Step 1: Push al repositorio**

```bash
git push origin main
```

- [ ] **Step 2: Deploy en servidor de la app**

```bash
ssh allaria@172.26.20.90
cd ~/Allaria-Hub && git pull && docker compose up -d --build
```

- [ ] **Step 3: Aplicar schema a la DB en producción**

```bash
docker compose exec back npx prisma db push
```

Expected: `Your database is now in sync with your Prisma schema.`

- [ ] **Step 4: Verificar que el frontend levanta**

Abrir `https://ia.allaria.xyz/proyectos` y verificar:
- Proyectos existentes siguen mostrando, ahora con botón "Publicar"
- Hub de comunidad vacío (proyectos existentes eran visibles porque `status = running` — ahora necesitan `isPublic = true`)

- [ ] **Step 5: Publicar proyectos existentes en producción (si se desea)**

Si se quiere que los 4 proyectos existentes sigan apareciendo en el Hub:

```bash
docker run --rm postgres:15-alpine psql postgresql://root:02DeAbril@172.26.20.32:5432/allaria_hub \
  -c "UPDATE \"Project\" SET \"isPublic\"=true WHERE status='running';"
```
