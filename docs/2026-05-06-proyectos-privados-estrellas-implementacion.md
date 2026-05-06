# Proyectos Privados + Estrellas — Documentación de Implementación

**Fecha:** 2026-05-06
**Estado:** En producción
**Commits:** `6184b5d` → `e35335e` (10 commits)

---

## Resumen

Los proyectos arrancan como privados por defecto. El usuario puede publicarlos para que aparezcan en el Hub de comunidad. Los proyectos publicados acumulan estrellas (1 por usuario). El Hub muestra proyectos ordenados de mayor a menor por estrellas.

---

## Cambios en la base de datos

### Campo nuevo en `Project`
```prisma
isPublic  Boolean  @default(false)
```
Todos los proyectos nuevos arrancan como privados. Los 4 proyectos existentes en producción se dejaron como privados al activar la feature (los usuarios los publican manualmente).

### Nuevo modelo `ProjectStar`
```prisma
model ProjectStar {
  id        String   @id @default(cuid())
  userId    String
  projectId String
  createdAt DateTime @default(now())
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  project   Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@unique([userId, projectId])
  @@index([projectId])
}
```

- `@@unique([userId, projectId])` garantiza 1 estrella por usuario por proyecto a nivel DB
- `onDelete: Cascade` limpia estrellas si se borra el proyecto o el usuario
- Al despublicar, las estrellas se conservan — si se vuelve a publicar, recupera el conteo
- `@@index([projectId])` para performance en queries de conteo

---

## Endpoints backend (`back/src/routes/projects.js`)

### Modificados

**`GET /api/projects/community`**
- Antes: filtraba `status: running|stopped`, sin estrellas
- Ahora: filtra `isPublic: true AND status: running`, ordena por `_count(stars) DESC`
- Incluye `user.id` (necesario para que el frontend detecte proyectos propios)
- Una sola query con `stars: { where: { userId } }` anidado para calcular `starredByMe`
- Responde con `starredByMe: boolean` y `_count: { stars: N }` por proyecto

```js
// Optimización: 1 query en lugar de 2
const projects = await prisma.project.findMany({
  where: { isPublic: true, status: 'running' },
  orderBy: { stars: { _count: 'desc' } },
  include: {
    user: { select: { id: true, name: true, picture: true } },
    _count: { select: { stars: true } },
    stars: { where: { userId: req.user.id }, select: { id: true } },
  },
})

res.json(projects.map(p => ({
  ...p,
  starredByMe: p.stars.length > 0,
  stars: undefined, // no exponer datos de quién dio estrella
})))
```

**`GET /api/projects`** (mis proyectos)
- Agrega `include: { _count: { select: { stars: true } } }` para mostrar conteo en la tarjeta

### Nuevos

| Método | Ruta | Descripción |
|--------|------|-------------|
| PATCH | `/:id/publish` | Setea `isPublic: true`. Solo si `status === 'running'`. |
| PATCH | `/:id/unpublish` | Setea `isPublic: false`. Conserva estrellas. |
| POST | `/:id/star` | Upsert de estrella. No se puede dar a proyecto propio. |
| DELETE | `/:id/star` | Quita estrella propia. Idempotente. |

**Reglas de negocio:**
- Solo se puede publicar si `status === 'running'`
- No se puede dar estrella a proyecto propio (backend retorna 400)
- No se puede dar estrella a proyecto privado o no running (backend retorna 404)

---

## Frontend

### `front/src/lib/api.js`
Métodos nuevos:
```js
publishProject:   (id) => request(`/api/projects/${id}/publish`,   { method: 'PATCH' }),
unpublishProject: (id) => request(`/api/projects/${id}/unpublish`, { method: 'PATCH' }),
starProject:      (id) => request(`/api/projects/${id}/star`,      { method: 'POST' }),
unstarProject:    (id) => request(`/api/projects/${id}/star`,      { method: 'DELETE' }),
```

### `front/src/pages/Projects.jsx`

**Mis Proyectos — cambios por tarjeta:**
- Header: badge de estrellas (⭐ N) visible si `isPublic || _count.stars > 0`
- Acciones: botón `Globe / Publicar` (verde) o `EyeOff / Despublicar`, solo si `status === 'running'`
- Al publicar/despublicar: merge selectivo `{ ...p, isPublic, _count }` para preservar campo `user`

**Hub de comunidad — cambios por tarjeta:**
- Footer: botón `⭐ N` interactivo para proyectos ajenos (con `user &&` guard para usuarios no autenticados)
- Estado activo: clase `star-btn--active` cuando `starredByMe === true`
- Optimistic update con rollback: la estrella se refleja en la UI antes de que responda el backend; si falla, revierte
- Para proyectos propios: muestra contador de solo lectura (`star-count-own`) si tiene estrellas

### `front/src/pages/ProjectWorkspace.jsx`

Nueva sección **Visibilidad** en el sidebar (entre Descripción y Detalles):
- Botón `Globe / Publicar en el Hub` o `EyeOff / Despublicar` según `project.isPublic`
- Solo aparece si `project.status === 'running'`; si no, muestra texto explicativo
- Al publicar: `setProject(prev => ({ ...prev, ...updated }))`
- Cuando está publicado: mensaje verde "Visible en el Hub de comunidad"

---

## Estilos nuevos

### `Projects.css`
- `.my-project-btn.publish` — botón Publicar en verde
- `.my-project-stars` — badge de estrellas en tarjeta propia
- `.star-btn` / `.star-btn--active` — botón de estrella en hub
- `.star-count-own` — contador de estrellas (solo lectura) para proyectos propios

### `ProjectWorkspace.css`
- `.pw-visibility-btn` — botón base de visibilidad en sidebar
- `.pw-visibility-btn--public` — estado publicado (verde); hover muestra rojo para indicar "despublicar"

---

## Flujo completo

```
Usuario click "Publicar"
  → PATCH /api/projects/:id/publish
  → Valida: proyecto propio + status running
  → DB: isPublic = true
  → Responde proyecto con _count.stars
  → Frontend: actualiza isPublic y _count en myProjects[]

Proyecto aparece en GET /community
  → Visible para todos los usuarios
  → Ordenado por _count(stars) DESC

Usuario click estrella
  → Optimistic: starredByMe = true, stars++
  → POST /api/projects/:id/star
  → DB: upsert ProjectStar (idempotente)
  → Si error: revert optimistic update

Usuario despublica
  → PATCH /api/projects/:id/unpublish
  → DB: isPublic = false (estrellas se conservan)
  → Desaparece del Hub pero mantiene _count.stars
  → Si vuelve a publicar: reaparece con las mismas estrellas
```

---

## Fix incluido: `sandboxStatus` import

Durante la implementación se detectó que `sandboxStatus` se usaba en el polling de build pero no estaba importado. Corregido en el mismo PR:

```js
// Antes (dos líneas separadas, faltaba sandboxStatus)
import { sandboxDelete, sandboxStop } from '../lib/sandbox-client.js'
import { sandboxCreateProject } from '../lib/sandbox-client.js'

// Después
import { sandboxDelete, sandboxStop, sandboxStatus, sandboxCreateProject } from '../lib/sandbox-client.js'
```

---

## Deploy

```bash
# App server
ssh allaria@172.26.20.90
cd ~/Allaria-Hub && git pull && docker compose up -d --build
docker compose exec back npx prisma db push

# Proyectos existentes — dejar en privado (por defecto)
# Los usuarios los publican manualmente desde la UI
```

Los 4 proyectos existentes en producción quedaron en `isPublic = false`. Cada usuario puede publicarlos desde la tarjeta en "Mis Proyectos" o desde el sidebar del workspace.
