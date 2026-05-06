# Diseño: Proyectos Privados + Estrellas

**Fecha:** 2026-05-06
**Estado:** Aprobado

## Resumen

Los proyectos arrancan como privados por defecto. El usuario puede publicarlos para que aparezcan en el Hub de comunidad. Los proyectos publicados pueden recibir estrellas (1 por usuario). El Hub muestra proyectos ordenados por estrellas de mayor a menor.

---

## 1. Base de datos

### Cambio en `Project`
```prisma
isPublic  Boolean  @default(false)
```

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
}
```

- El `@@unique([userId, projectId])` garantiza 1 estrella por usuario por proyecto a nivel DB.
- `onDelete: Cascade` limpia estrellas si se borra el proyecto o el usuario.
- Al despublicar un proyecto (`isPublic: false`) las estrellas se conservan. Si se vuelve a publicar, recupera el conteo anterior.

---

## 2. Backend

### Endpoints nuevos en `/api/projects`

| Método | Ruta | Descripción |
|--------|------|-------------|
| PATCH | `/:id/publish` | Setea `isPublic: true`. Solo funciona si `status === 'running'` y el proyecto pertenece al usuario. |
| PATCH | `/:id/unpublish` | Setea `isPublic: false`. No borra estrellas. |
| POST | `/:id/star` | Agrega estrella. Idempotente (upsert). Solo en proyectos públicos ajenos. |
| DELETE | `/:id/star` | Quita estrella propia. |

### Cambio en `GET /community`

- Filtra `isPublic: true AND status: 'running'`
- Incluye `_count: { stars }` y flag `starredByMe: boolean` (si el usuario actual ya le dio estrella)
- Ordenado por `_count.stars DESC` (default, sin parámetro)

### Reglas de negocio

- Solo se puede publicar proyectos propios con `status: 'running'`
- No se puede dar estrella a proyectos propios
- No se puede dar estrella a proyectos no públicos
- `GET /api/projects` (mis proyectos) incluye `isPublic` y `_count: { stars }`

---

## 3. Frontend

### "Mis Proyectos" — tarjeta (`Projects.jsx`)

- Nuevo botón en `my-project-actions`: icono `Globe` (publicar) si `!isPublic`, icono `EyeOff` (despublicar) si `isPublic`. Solo visible si `status === 'running'`.
- Badge con contador de estrellas `⭐ N` junto al status badge, visible solo si `isPublic` o si tiene estrellas.
- `handlePublish(id)` / `handleUnpublish(id)` actualizan `myProjects` state localmente.

### Workspace del proyecto (`ProjectWorkspace.jsx`)

- Botón publish/unpublish en el panel de info/sidebar del proyecto.
- Mismo comportamiento que la tarjeta: solo si `status === 'running'`, actualiza estado local.

### Hub de comunidad — tarjeta (`Projects.jsx`)

- Botón estrella `★` con contador en el footer de la tarjeta.
- `starredByMe: true` → estrella rellena (color destacado); `false` → estrella outline.
- Click aplica optimistic update: cambia `starredByMe` y ajusta `_count.stars ± 1` antes de la respuesta API. Si falla, revierte.
- No se muestra el botón estrella en proyectos propios.
- Cards ordenadas por estrellas (el backend ya las devuelve en ese orden).

---

## 4. Flujo de datos

```
Usuario click "Publicar"
  → PATCH /api/projects/:id/publish
  → DB: isPublic = true
  → Frontend: myProjects[i].isPublic = true

Usuario click estrella en Hub
  → Optimistic: starredByMe = true, stars++
  → POST /api/projects/:id/star
  → DB: upsert ProjectStar
  → Si error: revert optimistic update
```

---

## 5. Archivos a modificar

| Archivo | Cambio |
|---------|--------|
| `back/prisma/schema.prisma` | Agregar `isPublic` a `Project` + nuevo modelo `ProjectStar` + relaciones en `User` |
| `back/src/routes/projects.js` | Nuevos endpoints publish/unpublish/star, modificar GET /community y GET / |
| `front/src/pages/Projects.jsx` | Botones publish/unpublish en mis proyectos, botón estrella en hub |
| `front/src/pages/ProjectWorkspace.jsx` | Botón publish/unpublish en sidebar/header |
| `front/src/lib/api.js` | Nuevos métodos: publishProject, unpublishProject, starProject, unstarProject |
