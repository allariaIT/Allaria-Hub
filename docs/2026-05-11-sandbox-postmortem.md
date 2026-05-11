# Sandbox Reliability — Postmortem y Fixes (2026-05-06 al 2026-05-11)

## Resumen ejecutivo

Durante esta sesión se identificaron y resolvieron todos los bugs críticos del flujo de creación y actualización de proyectos sandbox. El problema raíz fue que **dockerode cuelga indefinidamente en el sandbox server**, lo que hacía que todos los builds, stops y exec de containers quedaran bloqueados para siempre. Se reemplazó toda la interacción con Docker por llamadas directas al CLI vía `spawn`.

---

## Bugs encontrados y resueltos

### 1. dockerode cuelga en todas las operaciones (CRÍTICO)

**Síntoma:** El LLM pedía un cambio, el build se "iniciaba" pero nunca terminaba. La UI quedaba trabada en "Buildeando..." indefinidamente.

**Causa raíz:** `docker.buildImage()`, `docker.createContainer()`, `docker.exec()` y todos los métodos de dockerode que requieren comunicación con el daemon se cuelgan sin timeout en este entorno. Se diagnosticó que `docker.buildImage()` nunca llegaba al daemon (el proceso `docker build` nunca aparecía en `ps aux`) porque dockerode intentaba crear un tar del contexto incluyendo el `.git`, y eso lo bloqueaba. Los métodos siguientes (`createContainer`, `exec`) también colgaban por estado corrupto de la conexión al socket.

**Fix:** Reemplazamos **100% de dockerode** con `spawn('docker', [...])` vía CLI en:
- `sandbox-agent/src/lib/docker.js` — build, run, stop, inspect, exec, prune
- `sandbox-agent/src/lib/nginx.js` — `docker exec sandbox-nginx nginx -s reload`

**Lección:** En este entorno, dockerode no es viable. Usar siempre Docker CLI directo.

---

### 2. GET /status pisaba status 'building' con estado live de Docker

**Síntoma:** El backend polling veía 'running' al instante porque el container viejo seguía corriendo durante el rebuild.

**Fix:** En `GET /projects/:user/:name`, si `meta.status === 'building'`, retornar el meta sin consultar Docker. Solo consultar Docker cuando el meta no dice 'building'.

```js
if (meta.status === 'building') return res.json(meta)
const status = await getContainerStatus(...)
res.json({ ...meta, status })
```

---

### 3. sandbox_build marcaba 'running' sin esperar el build

**Síntoma:** El backend tool `sandbox_build` hacía el trigger y de inmediato actualizaba DB a 'running', sin esperar que el container realmente arrancara.

**Fix:** Polling loop de 20 × 6s (igual que el create flow):
```js
await sandboxBuild(userSlug, name)  // trigger async
for (let i = 0; i < 20; i++) {
  await sleep(6000)
  const status = await sandboxStatus(...)
  if (status.status === 'running') { update DB; return ok }
  if (status.status === 'error') { update DB; return error }
}
// timeout → error
```

---

### 4. sandbox_create_project vía LLM sin rollback

**Fix:** Si falla el sandbox agent al crear, rollback de DB record + GitLab repo + Chat dedicado.

---

### 5. gitCommitAndPush crasheaba el proceso Node.js

**Causa:** `execSync('git ...', { cwd })` lanzaba `spawnSync /bin/sh ENOENT` si el directorio no existía, el catch block intentaba escribir el meta (también ENOENT), y el unhandled rejection crasheaba el proceso.

**Fix:**
- `gitCommitAndPush` envuelto en try/catch no-fatal (git es opcional, el deploy funciona igual)
- `fs.writeFileSync(metaPath, ...)` en los catch blocks envuelto en try/catch

---

### 6. Reconciliation marcaba proyectos como 'stopped' en timeouts de red

**Síntoma:** Cuando el sandbox-agent se reiniciaba, el reconciliation job llamaba a todos los proyectos 'running'. Si el agent tardaba en responder (timeout 10s), marcaba todos como 'stopped'.

**Fix:** Solo marcar como 'stopped' si la respuesta contiene explícitamente '404' o 'no encontrado'. Ignorar timeouts y otros errores de red.

```js
} catch (err) {
  if (err.message?.includes('404') || err.message?.includes('no encontrado')) {
    // marcar stopped
  }
  // timeout/red: ignorar
}
```

---

### 7. Containerd layer error en builds concurrentes

**Síntoma:** Cuando dos proyectos Vite+React se buildean al mismo tiempo, comparten el mismo layer hash de `npm ci`. Containerd falla con `CreateDiff: mount callback failed... failed to commit: rename`.

**Fix:** Retry automático con `--no-cache` si el build falla con ese error:
```js
export async function buildImage(contextDir, tag) {
  try {
    await spawnBuild(contextDir, tag)
  } catch (err) {
    if (err.message.includes('CreateDiff') || err.message.includes('mount callback')) {
      await spawnBuild(contextDir, tag, true) // --no-cache
    } else throw err
  }
}
```

---

### 8. System prompt del workspace demasiado permisivo

**Síntoma:** El LLM respondía "¡listo!" sin llamar ninguna tool. A veces llamaba `sandbox_build` pero sin haber modificado el archivo primero.

**Fix:** Regla fundamental explícita en el system prompt:
```
REGLA FUNDAMENTAL — SIN EXCEPCIONES:
Cualquier cambio DEBE ejecutarse con sandbox_write_file. NUNCA digas "listo"
sin haber llamado sandbox_write_file primero.

FLUJO OBLIGATORIO:
1. sandbox_read_file (leer archivo actual)
2. sandbox_write_file (escribir cambio completo)
3. sandbox_build (deployar)
4. Confirmar al usuario
```

---

## Otros cambios realizados (sesión 2026-05-06)

Antes de los bugs de dockerode, se implementaron las siguientes mejoras:

- **Build async unificado**: `/build` endpoint responde inmediatamente, build corre en background con semáforo
- **Reserved ports**: Set en memoria para evitar race condition al asignar puertos en builds concurrentes
- **MAX_TOOL_ROUNDS = 10**: subido de 5 para tareas con múltiples archivos
- **Connector workspaceSandbox**: el workspace no tiene acceso a `sandbox_create_project`
- **Timeout 10s en sandboxRequest**: evita cuelgues si el sandbox no responde
- **Reconciliation second pass**: detecta containers eliminados manualmente
- **ProjectWorkspace auto-refresh**: cuando status='creating', polling automático sin recargar
- **Interrupted polling timeout**: 2 minutos máximo, luego muestra error
- **Dockerfile determinístico**: `npm install --package-lock-only` + `npm ci`
- **spawnSync para commit message**: previene inyección de shell en mensajes de git

---

## Prompt del agente (ProjectWorkspace — SANDBOX_SYSTEM_PROMPT)

```
Sos el asistente de desarrollo de este proyecto web.

REGLA FUNDAMENTAL — SIN EXCEPCIONES:
Cualquier cambio de código, estilo o contenido DEBE ejecutarse con sandbox_write_file.
NUNCA describas un cambio sin haberlo escrito con la tool. NUNCA digas "listo", "hecho"
o "cambié X" sin haber llamado sandbox_write_file primero. Si el usuario pide cambiar
algo, la única respuesta válida es ejecutar la tool y después confirmar.

FLUJO OBLIGATORIO para cualquier modificación:
1. Leé el archivo actual con sandbox_read_file (para no perder código existente)
2. Escribí el archivo completo modificado con sandbox_write_file
3. Llamá sandbox_build para deployar
4. Confirmá al usuario que el cambio fue aplicado

REGLAS ADICIONALES:
- Cuando el usuario pregunte "¿en qué estábamos?" o similar, leé PRIMERO el CHANGELOG.md.
- Cada vez que modifiques archivos, actualizá CHANGELOG.md con fecha y descripción.
- Para pushear a GitLab usá sandbox_push cuando el usuario lo pida.
- NO creés proyectos nuevos. Solo trabajás dentro del proyecto activo indicado abajo.

Tools disponibles: sandbox_write_file, sandbox_read_file, sandbox_list_files,
sandbox_build, sandbox_push, sandbox_status.

El proyecto activo es "{projectName}". Cuando uses las tools de sandbox,
el projectName es siempre "{projectName}".
```

---

## Estado de proyectos al cierre de sesión

| nombre | usuario | puerto | status |
|--------|---------|--------|--------|
| dashboard-dolar | ramiro-schulmeister | 4001 | running |
| buscador-de-noticias | ramiro-schulmeister | 4002 | running |
| test | ramiro-schulmeister | 4003 | running |
| cc | mpoliti | 4004 | running |
| ingresos-por-zeus | tiziano-cristiani | 4005 | running |
| to-do | matias-ledesma | 4006 | running |
| prueba-oli | alejandro-oliveira | 4007 | running |

---

## Comandos útiles de diagnóstico

```bash
# Ver logs del sandbox-agent
docker logs sandbox-agent 2>&1 | tail -30

# Ver metas de todos los proyectos
docker exec sandbox-agent find /projects -name .sandbox-meta.json -exec sh -c "echo === {} === && cat {}" \;

# Ver containers sandbox
docker ps -a --filter name=sandbox- --format "{{.Names}}  {{.Status}}"

# Fix DB: proyecto en estado incorrecto (requiere PTY para evitar problemas de quoting)
# Ver MEMORY.md para el snippet de Python con paramiko PTY

# Trigger rebuild manual
curl -s -X POST http://localhost:3100/projects/{user}/{name}/build \
  -H "X-Sandbox-Key: 5f98396823e95b7ed633b2970d234c210e2fca50f927f68cc69ba62950929761"

# Limpiar build cache si hay errores de containerd
docker builder prune -af
```
