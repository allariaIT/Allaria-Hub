# Fixes Post-Implementación — Documentación

**Fecha:** 2026-05-05 (segunda parte de la sesión)
**Contexto:** Correcciones y mejoras descubiertas durante el uso real en producción

---

## 1. Build asíncrono — fix del timeout de red

### Problema

Al crear un proyecto, el backend llamaba a `POST /projects` en el sandbox agent y esperaba la respuesta. El proceso completo (scaffold + docker build + run + waitForContainer) tarda 60-90 segundos. Las conexiones entre servidores tienen un timeout de red (~60s) que cortaba la conexión antes de que el sandbox respondiera.

Síntoma: el usuario veía "Error al crear el proyecto" pero el container **sí** se había creado en el sandbox server. El proyecto quedaba en status `error` en la DB con el container corriendo.

### Solución

**Sandbox agent — `sandbox-agent/src/routes/projects.js`:**

`POST /projects` ahora:
1. Hace scaffold + git init + reserva el puerto (rápido, ~2 segundos)
2. Guarda `.sandbox-meta.json` con `status: building`
3. **Responde inmediatamente** con `{ok: true, port, status: 'building'}`
4. El docker build + run + nginx + waitForContainer corren en un **IIFE async en background** con el semáforo de concurrencia
5. Al terminar, actualiza `.sandbox-meta.json` con `status: running` o `status: error`

```javascript
// Responder inmediatamente
res.json({ ok: true, port, status: 'building', previewUrl: `/${userSlug}/${name}/` })

// Build en background con semáforo
;(async () => {
  await acquireBuildSlot()
  try {
    await buildImage(...)
    await runContainer(...)
    await writeAndReloadNginx(...)
    gitCommitAndPush(...)
    const check = await waitForContainer(port)
    const finalStatus = check.ok ? 'running' : 'error'
    fs.writeFileSync(metaPath, JSON.stringify({ ...meta, status: finalStatus }, null, 2))
  } finally {
    releaseBuildSlot()
  }
})()
```

**Backend — `back/src/routes/projects.js`:**

`POST /api/projects` ahora:
1. Llama al sandbox (responde en ~2s)
2. Actualiza DB con port, chatId, previewUrl, status: `creating`
3. **Devuelve al frontend inmediatamente**
4. Un worker en background hace polling al sandbox cada 6s hasta que el status sea `running` (máximo 2 minutos = 20 intentos)
5. Actualiza DB a `running` cuando el sandbox confirma

```javascript
res.json(updated) // devuelve con status: 'creating'

;(async () => {
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 6000))
    const status = await sandboxStatus(userSlug, name)
    if (status.status === 'running') {
      await prisma.project.update({ where: { id: project.id }, data: { status: 'running' } })
      return
    }
  }
  // Timeout → error
  await prisma.project.update({ where: { id: project.id }, data: { status: 'error' } })
})()
```

**Frontend — `front/src/pages/Projects.jsx`:**

Polling automático: si hay proyectos con status `creating`, refresca `GET /api/projects` cada 5 segundos hasta que cambien.

```javascript
useEffect(() => {
  const hasCreating = myProjects.some(p => p.status === 'creating')
  if (!hasCreating) return
  const interval = setInterval(() => {
    api.getProjects().then(setMyProjects)
  }, 5000)
  return () => clearInterval(interval)
}, [myProjects])
```

Cards en `creating` muestran un spinner animado en el badge de status.

---

## 2. Queue de builds concurrentes

### Problema

Si muchos usuarios crean proyectos simultáneamente, todos los docker builds arrancan en paralelo. Cada build consume ~1-2 GB de RAM y CPU intensivo. 10+ builds simultáneos tiran el servidor.

### Solución

Semáforo (mutex) en el sandbox agent que limita los builds concurrentes:

```javascript
const MAX_CONCURRENT_BUILDS = parseInt(process.env.MAX_CONCURRENT_BUILDS || '3')
let activeBuilds = 0
const buildQueue = []

function acquireBuildSlot() {
  return new Promise((resolve) => {
    if (activeBuilds < MAX_CONCURRENT_BUILDS) {
      activeBuilds++
      resolve()
    } else {
      buildQueue.push(resolve) // espera en cola
    }
  })
}

function releaseBuildSlot() {
  if (buildQueue.length > 0) {
    buildQueue.shift()() // libera el siguiente en cola
  } else {
    activeBuilds--
  }
}
```

El semáforo aplica tanto a **creación de proyectos** como a **rebuilds** (cuando la IA modifica archivos).

**Configuración:** `MAX_CONCURRENT_BUILDS=3` en `sandbox-agent/.env`. Ajustar según RAM disponible del servidor.

**Comportamiento con 50 usuarios simultáneos:**
- Usuarios 1-3: build arranca inmediatamente
- Usuarios 4-50: el frontend muestra "Creando..." con spinner, el build espera en la cola interna del sandbox agent
- Cada vez que termina un build, el siguiente de la cola arranca automáticamente
- El polling del frontend detecta cuando pasa a `running` y actualiza la card

---

## 3. Reconciliación automática de proyectos

### Problema

Proyectos que quedaron en status `creating` o `error` en la DB pero que en realidad estaban corriendo en el sandbox server. Requería corrección manual con SQL.

Casos que lo causan:
- El backend se reinicia durante el polling
- Un timeout de red corta la comunicación mientras el sandbox sí terminó el build
- Cualquier error inesperado entre el sandbox terminar y el backend actualizar la DB

### Solución

Job de reconciliación en `back/src/index.js`:

```javascript
async function reconcileProjects() {
  // Busca proyectos con status incompleto que tienen un puerto asignado
  const stale = await prisma.project.findMany({
    where: { status: { in: ['creating', 'error'] }, port: { not: null } },
    include: { user: { select: { email: true } } },
  })

  for (const project of stale) {
    try {
      const userSlug = slugFromEmail(project.user.email)
      const status = await sandboxStatus(userSlug, project.name)
      if (status.status === 'running') {
        await prisma.project.update({ where: { id: project.id }, data: { status: 'running' } })
        console.log(`[reconcile] ${project.name} → running`)
      }
    } catch { /* sandbox no tiene el proyecto */ }
  }

  setTimeout(reconcileProjects, 5 * 60 * 1000) // volver a correr en 5 minutos
}
```

Se ejecuta:
1. **Al iniciar el backend** — corrige inmediatamente proyectos stuck
2. **Cada 5 minutos** — chequeo periódico continuo

---

## 4. Bloqueo de workspace para proyectos no listos

### Problema

Un proyecto en status `creating` o `error` era clickeable y abría el workspace, mostrando un chat vacío o en estado inconsistente.

### Solución

**`front/src/pages/Projects.jsx`:** Cards con status `creating` o `error` tienen clase CSS `my-project-card--disabled` → sin hover effect, sin cursor pointer, no navegan.

**`front/src/pages/ProjectWorkspace.jsx`:** Guards antes del render principal:

```jsx
if (project?.status === 'creating') return (
  <div className="pw-error">
    <Loader2 size={32} className="pw-spin" />
    <p>El proyecto se está creando...</p>
    <p>Esto puede tardar hasta un minuto.</p>
    <button onClick={() => navigate('/proyectos')}>Volver al hub</button>
  </div>
)

if (project?.status === 'error') return (
  <div className="pw-error">
    <p>⚠️ El proyecto tuvo un error al crearse</p>
    <button onClick={() => navigate('/proyectos')}>Volver al hub</button>
  </div>
)
```

**`front/src/pages/Projects.jsx`:** Al crear proyecto vía modal, solo navega al workspace si `project.status === 'running'`. Si quedó en `creating`, el usuario se queda en el hub y ve la card con el spinner.

---

## 5. Proyectos corregidos manualmente en esta sesión

Durante la sesión se corrigieron 3 proyectos que quedaron stuck por el bug anterior:

```sql
-- buscador-de-noticias (Ramiro)
UPDATE "Project" SET status='running', port=4002,
  "previewUrl"='https://proyectos-sandbox.allaria.xyz/ramiro-schulmeister/buscador-de-noticias/'
WHERE name='buscador-de-noticias';

-- bot-automatizador (Ramiro)
UPDATE "Project" SET status='running', port=4003,
  "previewUrl"='https://proyectos-sandbox.allaria.xyz/ramiro-schulmeister/bot-automatizador/'
WHERE name='bot-automatizador';

-- cc (Martin Politi)
UPDATE "Project" SET status='running', port=4004,
  "previewUrl"='https://proyectos-sandbox.allaria.xyz/mpoliti/cc/'
WHERE name='cc';
```

**Con la reconciliación automática implementada, esto ya no va a ser necesario.**

---

## 6. Estado final de proyectos en producción

| Proyecto | Usuario | Slug | Puerto | Preview URL |
|---|---|---|---|---|
| dashboard-dolar | Ramiro Schulmeister | ramiro-schulmeister | 4001 | https://proyectos-sandbox.allaria.xyz/ramiro-schulmeister/dashboard-dolar/ |
| Buscador de noticias | Ramiro Schulmeister | ramiro-schulmeister | 4002 | https://proyectos-sandbox.allaria.xyz/ramiro-schulmeister/buscador-de-noticias/ |
| Bot-Automatizador | Ramiro Schulmeister | ramiro-schulmeister | 4003 | https://proyectos-sandbox.allaria.xyz/ramiro-schulmeister/bot-automatizador/ |
| cc | Martin Politi | mpoliti | 4004 | https://proyectos-sandbox.allaria.xyz/mpoliti/cc/ |

---

## 7. Respuesta a preguntas de escalabilidad

### ¿Pueden 50 personas crear proyectos a la vez?

**Sí**, con la siguiente distribución de trabajo:

- **Creación en la DB + GitLab + respuesta al frontend**: ilimitada, instantánea (~2s por request)
- **Builds de Docker**: máximo 3 simultáneos (configurable con `MAX_CONCURRENT_BUILDS`), los demás en cola
- **Containers corriendo**: hasta 100 (puertos 4001-4100). Si se necesitan más, ajustar `PORT_RANGE_END`
- **Preview via nginx**: sin límite, todos los containers accesibles por el mismo proxy

Escenario real de 50 usuarios simultáneos:
```
t=0s:   Usuarios 1-50 crean proyectos
        → Todos reciben respuesta "Creando..." en ~2s
        → Builds 1, 2, 3 arrancan en sandbox
        → Builds 4-50 esperan en cola

t=90s:  Builds 1, 2, 3 terminan → status: running en DB
        → Cards de usuarios 1-3 se actualizan automáticamente
        → Builds 4, 5, 6 arrancan

t=~30min: Todos los 50 proyectos terminados
```

### ¿El agente trabaja con 1 proyecto a la vez?

No. El sandbox agent es Node.js async — maneja múltiples requests concurrentemente. Lo que se limita son los **builds** (CPU/RAM intensivos). Operaciones como escribir archivos, leer archivos, listar, ver status, etc., son completamente concurrentes sin límite.

---

## Archivos modificados en esta sesión (post-documentación inicial)

| Archivo | Cambio |
|---|---|
| `back/src/index.js` | Job de reconciliación automática cada 5 minutos |
| `back/src/routes/projects.js` | POST async: devuelve inmediatamente + polling background |
| `sandbox-agent/src/routes/projects.js` | Build en background + semáforo de concurrencia |
| `front/src/pages/Projects.jsx` | Polling de proyectos en creating + cards disabled |
| `front/src/pages/ProjectWorkspace.jsx` | Guards para status creating/error |
| `front/src/pages/Projects.css` | Estilo `.my-project-card--disabled` |
