# Workspace Agent — Fixes (2026-05-12)

## Contexto

Durante esta sesión se identificaron y resolvieron bugs en el flujo del agente de workspace (ProjectWorkspace). El flujo de edición via chat ya funcionaba a nivel de scaffold/build, pero el LLM a veces confirmaba cambios sin ejecutarlos, y el push a GitLab nunca funcionó.

---

## Bugs encontrados y resueltos

### 1. LLM responde "Listo!" sin ejecutar tools (CRÍTICO)

**Síntoma:** El usuario pedía "Cambia el fondo a negro" y el modelo respondía inmediatamente con "¡Listo! Cambié el fondo a negro." sin haber llamado ninguna tool. El archivo no se modificaba, el build no se ejecutaba, y el usuario veía los mismos resultados.

**Causa:** El system prompt tenía la regla prohibida pero era demasiado permisivo en su redacción. El flujo tampoco incluía el paso de push.

**Fix:** System prompt reescrito con regla más estricta y flujo de 4 pasos explícito:

```
FLUJO OBLIGATORIO para cualquier modificación (todos los pasos, sin omitir ninguno):
1. sandbox_read_file — Leé el archivo actual para no perder código existente
2. sandbox_write_file — Escribí el archivo completo con los cambios aplicados
3. sandbox_build — Rebuildeá y esperá confirmación de que el container quedó UP (running)
4. sandbox_push — Commiteá y pusheá los cambios al repo con un mensaje descriptivo
5. Recién después de completar los 4 pasos anteriores, confirmá al usuario: "✅ Listo, probalo: [previewUrl]"
```

También: la descripción de `sandbox_push` decía "Confirmá con el usuario antes de pushear", lo que hacía que el modelo pidiera permiso en vez de ejecutarlo automáticamente. Se cambió a "Llamá esto automáticamente después de cada sandbox_build exitoso".

---

### 2. "Sin respuesta." al completar tareas complejas

**Síntoma:** El usuario pedía "Hacelo CRM con sidebar y estilo profesional". El backend guardaba "Sin respuesta." en la DB. La respuesta anterior del chat era "Sin respuesta." (string literal).

**Causa:** El modelo agotaba los 10 rounds de tools (`MAX_TOOL_ROUNDS = 10`) escribiendo muchos archivos. Para una tarea así el modelo escribe: App.jsx, Sidebar.jsx, estilos CSS, varios componentes, CHANGELOG.md — fácilmente 12-16 tool calls (read + write por cada archivo, más build y push). Cuando se agotaban los rounds, el último `data.choices[0].message.content` era null y se guardaba "Sin respuesta.".

**Además:** El default `max_tokens = 4096` en el stream endpoint podía truncar a mitad la generación de archivos grandes (los argumentos de tool calls cuentan contra max_tokens). Un `sandbox_write_file` con un archivo CSS complejo fácilmente supera 4096 tokens, resultando en JSON truncado e inválido.

**Fixes:**
- `MAX_TOOL_ROUNDS`: 10 → 20 (`back/src/routes/proxy.js`)
- `max_tokens` default en stream: 4096 → 8192
- Mensaje de fallback: "Sin respuesta." → "La tarea tomó demasiado tiempo o no generó una respuesta. Podés pedirme que continúe o dividir la tarea en pasos más chicos."

---

### 3. Timeout de polling frontend muy corto

**Síntoma:** Si el usuario navegaba fuera del workspace y volvía mientras el build corría, el frontend mostraba "No se recibió respuesta del servidor" antes de que el backend terminara.

**Causa:** El polling cuando el último mensaje es del usuario esperaba 40 × 3s = 2 minutos. Pero con el nuevo flujo completo (read + write + build + push), el build solo puede tardar hasta 2 minutos de polling (20 × 6s). El total del flujo puede superar los 2 minutos.

**Fix:** Polling timeout aumentado de 40 a 80 intentos (4 minutos). `front/src/pages/ProjectWorkspace.jsx`

---

### 4. Git push al GitLab nunca funcionó (CRÍTICO)

Este bug tenía dos capas independientes. Ambas impedían que cualquier push llegara a GitLab.

#### Capa 1: URL sin credenciales

**Causa:** El `repoUrl` que se almacena en la DB y se pasa al sandbox agent es la URL pública de GitLab (`https://gitlab.allaria.xyz/allaria-sandbox/...`). Sin credenciales, `git push` falla silenciosamente con 401.

**Fix:** En `back/src/lib/sandbox-tools.js`, se agregó una función `repoUrlWithAuth(url)` que embebe el token de GitLab en la URL antes de pasarla al sandbox agent:

```js
function repoUrlWithAuth(url) {
  if (!url || !GITLAB_TOKEN) return url
  return url.replace('https://', `https://oauth2:${GITLAB_TOKEN}@`)
}
```

Se aplica en dos lugares:
- `sandbox_create_project`: al llamar `sandboxCreateProject(..., repoUrlWithAuth(repoUrl))` → el `git remote add origin` queda con token desde el inicio
- `sandbox_push`: al llamar `sandboxPush(..., repoUrlWithAuth(project.repoUrl))` → para proyectos existentes

El token-embedded URL se pasa al sandbox agent en el body del POST `/push`. `git.js` lo usa directamente con `spawnSync('git', ['push', pushUrl, 'HEAD:main'])` (no `run()`) para evitar que el token aparezca en la línea de comando de un proceso hijo de shell.

#### Capa 2: `git: detected dubious ownership`

**Síntoma:** Incluso con credenciales, `git add`, `git commit` y `git push` fallaban todos con `fatal: detected dubious ownership in repository at '/projects/...'`.

**Causa:** Git 2.35+ bloquea la ejecución en directorios con un owner diferente al usuario que corre el proceso. El sandbox agent corre como `root` dentro del container Docker, pero el directorio `/projects` está montado desde el host donde pertenece al usuario `allaria`. Esta discrepancia activa el check de seguridad de git.

**Fix:** En `sandbox-agent/Dockerfile`, configurar git global al momento del build del container:

```dockerfile
RUN apk add --no-cache git docker-cli nginx && \
    git config --global --add safe.directory '*' && \
    git config --global user.email "sandbox@allaria.xyz" && \
    git config --global user.name "Allaria Sandbox"
```

`safe.directory = '*'` permite ejecutar git en cualquier directorio independientemente del owner. También se configuró `user.email` y `user.name` globalmente para que los commits no fallen por falta de identidad.

---

## Archivos modificados

| Archivo | Cambio |
|---------|--------|
| `front/src/pages/ProjectWorkspace.jsx` | System prompt más estricto + flujo con push; timeout polling 2→4 min |
| `back/src/lib/sandbox-tools.js` | `repoUrlWithAuth()` para crear proyecto y push |
| `back/src/lib/sandbox-client.js` | `sandboxPush()` acepta `repoUrl` como parámetro |
| `back/src/routes/proxy.js` | MAX_TOOL_ROUNDS 10→20; max_tokens 4096→8192; mensaje de fallback útil |
| `sandbox-agent/src/lib/git.js` | `gitCommitAndPush()` acepta `pushUrl` opcional |
| `sandbox-agent/src/routes/projects.js` | Push endpoint acepta `repoUrl` del body |
| `sandbox-agent/Dockerfile` | `git safe.directory '*'` + user.email + user.name global |

---

## Flujo final del agente (post-fixes)

```
Usuario: "Cambia el fondo a negro"
  → sandbox_read_file(src/App.css)          [lee estado actual]
  → sandbox_write_file(src/App.css, ...)    [escribe cambio completo]
  → sandbox_build()                         [rebuild + polling hasta running]
  → sandbox_push("feat: fondo negro")       [commit + push con token a GitLab]
  → "✅ Listo, probalo: https://proyectos-sandbox.allaria.xyz/..."
```

Si el flujo se interrumpe (backend reiniciado durante el proceso), el frontend hace polling por 4 minutos antes de mostrar el mensaje de timeout.

---

## Diagnóstico de push fallido

```bash
# Verificar que git funciona dentro del container
docker exec sandbox-agent git -C /projects/{user}/{name} log --oneline -3

# Error "dubious ownership" → Dockerfile no tiene safe.directory
# Error "Authentication failed" → repoUrlWithAuth() no está llegando al sandbox

# Testear push manualmente desde el sandbox server
curl -s -X POST http://localhost:3100/projects/{user}/{name}/push \
  -H "X-Sandbox-Key: ..." \
  -H "Content-Type: application/json" \
  -d '{"message": "test push", "repoUrl": "https://oauth2:TOKEN@gitlab.allaria.xyz/..."}'
```
