# Adjuntar archivos al chat de Proyectos

**Estado:** en producción desde 2026-07-23 (pipeline GitLab 6193, commit `39da280`).

Permite adjuntar archivos en el chat del workspace de un proyecto para que el
agente de desarrollo los use: ver referencias visuales, consumir datos, leer
specs y conservar assets en el repo.

> Documentos relacionados:
> - Diseño: [`docs/superpowers/specs/2026-07-23-adjuntar-archivos-chat-proyectos-design.md`](../superpowers/specs/2026-07-23-adjuntar-archivos-chat-proyectos-design.md)
> - Plan de implementación: [`docs/superpowers/plans/2026-07-23-adjuntar-archivos-chat-proyectos.md`](../superpowers/plans/2026-07-23-adjuntar-archivos-chat-proyectos.md)

---

## Qué hace

Desde el workspace de un proyecto (`ProjectWorkspace.jsx`), el usuario puede
adjuntar archivos junto a su mensaje. Casos cubiertos:

- **Referencias visuales** — mockups/screenshots de un diseño a replicar o de un bug. El agente los *ve* (multimodal).
- **Datos** — CSV / JSON que la app tiene que consumir. El agente los lee con `read_file`.
- **Documentos / specs** — PDF o texto con requerimientos que guían el desarrollo.
- **Assets** — logos, íconos, imágenes que la app va a usar. Quedan en el repo.

## Enfoque: híbrido (materializar + multimodal)

Cada adjunto se resuelve en dos planos:

1. **Materialización en el filesystem del pod.** Todos los archivos se escriben
   en `/workspace/.attachments/` dentro del repo clonado. Como el agente hace
   `git add -A` al pushear, los adjuntos **quedan commiteados en el repo**.
2. **Multimodal para lo visual.** Imágenes y PDF se mandan además a Claude como
   `image_url` (base64) para que el agente *vea* la referencia mientras
   desarrolla. (El `write_file` del agente es solo texto: por eso los binarios
   necesitan materializarse aparte — no se pueden "escribir" desde el LLM.)

## Flujo de datos

```
Front (archivos → base64/text en estado)
  → api.streamMessage(chatId, model, messages, connectors, projectId, attachments)
  → back  POST /api/chat/stream   (campo top-level `attachments`)
        - guarda el mensaje de usuario en DB con refs [📎 nombre]
        - reenvía attachments al pod
  → pod   POST :3200/chat  { message, history, attachments }
        - writeAttachments(): escribe cada archivo en /workspace/.attachments/<nombre saneado>
        - buildUserContent(): arma el mensaje del agente
            · texto del pedido + nota con las rutas de los adjuntos
            · image_url (base64) para imágenes/PDF
  → runAgent: el LLM ve las imágenes y conoce las rutas
  → el agente lee datos con read_file / referencia assets / desarrolla
  → git_push → `git add -A` commitea .attachments/ + el código
```

## Componentes por capa

### Frontend
- `front/src/pages/ProjectWorkspace.jsx` — botón de clip, `<input type=file>`,
  lectura a base64 (binarios) / texto, chips de preview con thumbnail,
  validación de límites, render de miniaturas en el historial, envío de
  `attachments`. Maneja error de `FileReader` (un archivo ilegible no cuelga la
  selección).
- `front/src/lib/api.js` — `streamMessage(...)` acepta el 6º parámetro
  `attachments` (se incluye en el body solo si hay).

### Backend
- `back/src/lib/attachments-refs.js` — `attachmentsToRefs(attachments)` →
  string `[📎 nombre]` para guardar en el mensaje de usuario en DB.
- `back/src/routes/proxy.js` — `/stream` y `handleWorkspaceStream` reciben
  `attachments`, guardan las refs en DB y reenvían los adjuntos al pod.

### Session-agent (pod)
- `session-agent/src/attachments.js` — `writeAttachments(attachments)`:
  decodifica base64 / escribe texto en `.attachments/`, sanea nombres (basename,
  sin control chars, sin path traversal), resuelve colisiones (`-1`, `-2`),
  saltea adjuntos rotos sin romper el resto.
- `session-agent/src/agent.js` — `buildUserContent(userMessage, attachments)`
  arma el `content` multimodal; `runAgent(..., attachments)` lo usa. Incluye el
  **degrade tolerante a fallos** (ver abajo).
- `session-agent/src/index.js` — `/chat` acepta `attachments`, los materializa
  antes de correr el agente; límite `express.json` subido a `30mb`.
  `SYSTEM_PROMPT` documenta la carpeta `.attachments/` para el agente.

## Límites y constantes

| Qué | Valor |
|-----|-------|
| Archivos por mensaje | máx **5** |
| Tamaño por archivo | máx **10 MB** |
| Tamaño total por mensaje | máx **20 MB** |
| `accept` del input | `image/*,audio/*,video/*,.pdf,.txt,.csv,.json,.md,.py,.js,.ts,.jsx,.tsx,.html,.css` |
| MIME que van al LLM como `image_url` | `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `application/pdf` |
| Carpeta de materialización | `/workspace/.attachments/` |
| Límite body `express.json` | back `50mb` · pod `30mb` |

El tope de 20 MB crudos (~27 MB en base64) entra holgado bajo el límite del pod
(30 MB) y del back (50 MB), así que un mensaje al máximo no puede dar 413.

## Manejo de errores

- **Archivo grande / demasiados archivos** → validación en el front (mensaje de
  error), sin romper el stream.
- **PDF/imagen rechazado por Claude (degrade tolerante a fallos)** → si la
  primera llamada a LiteLLM falla y el mensaje tiene partes `image_url`, el
  agente **reintenta una vez sin las partes visuales** en lugar de romper todo
  el mensaje. Emite un aviso al usuario y sigue: el archivo ya quedó en
  `.attachments/` y se puede leer con `read_file` si es de texto.
  Implementado en `runAgent` / `stripImageParts` (`agent.js`).
- **base64 inválido / fallo de escritura** → `writeAttachments` saltea ese
  archivo con warning; el resto continúa.
- **Path traversal** → bloqueado por el saneo de nombre dentro de `.attachments/`.
- **FileReader falla en el front** → el archivo ilegible se reporta y se
  descartan solo ese, no cuelga la selección (`Promise.all` + `onerror`).

## Deploy

Todo el deploy lo maneja el **pipeline de GitLab** al pushear a `main`
(remote `gitlab`, ver [`reference_deploy_hub_cce`]). El `.gitlab-ci.yml`:

- `build-back` / `build-front` / `build-session-agent` → build + push a SWR
  (`:<sha>` y `:latest`).
- `deploy-back` / `deploy-front` → `kubectl set image` al tag `:<sha>` + rollout
  en el namespace `allaria-hub`.

El **session-agent** no tiene job de deploy: se publica como `:latest` y los
pods de sesión (efímeros, namespace `sandbox-sessions`) lo pullean al crearse.
Los pods de sesión que estén corriendo al momento del deploy siguen con la
imagen vieja hasta que ciclan por idle timeout (60 min).

### Redeploy manual (fallback)

Si el pipeline falla, se puede buildear/pushear desde el `.101` — ver el
procedimiento completo en `reference_deploy_hub_cce`. Puntos clave:
`docker build --provenance=false --sbom=false` y `kubectl set image` (no
`rollout restart`, que no pullea si el tag está pinned).

## Verificación end-to-end

Tras el deploy 2026-07-23 se verificó vía `.101` + kubectl:

```bash
# back/front en el tag nuevo
kubectl -n allaria-hub get deploy back  -o jsonpath='{.spec.template.spec.containers[*].image}'
kubectl -n allaria-hub get deploy front -o jsonpath='{.spec.template.spec.containers[*].image}'
kubectl -n allaria-hub exec deploy/back -- ls /app/src/lib/attachments-refs.js

# imagen session-agent:latest (pod temporal desde la imagen)
kubectl -n sandbox-sessions run verify --image=<...>/session-agent:latest \
  --overrides='{"spec":{"imagePullSecrets":[{"name":"swr-pull-secret"}]}}' \
  --command -- sleep 120
kubectl -n sandbox-sessions exec verify -- ls src/attachments.js
```

## Smoke test (funcional, desde la app)

1. Abrir un workspace de proyecto.
2. Adjuntar una **imagen** (PNG) y pedir "replicá este diseño" → el agente debe
   tener en cuenta la imagen.
3. Adjuntar un **CSV** → el agente lo lee con `read_file` (se ve el `read_file
   .attachments/...` en la actividad).
4. Verificar que tras `git_push` los archivos quedan en `.attachments/` del repo
   en GitLab.
5. Probar el límite (6 archivos o uno > 10 MB) → aparece el error y no se agregan.

## Limitaciones conocidas / follow-ups

- **PDF**: se manda como `image_url`. No está confirmado que LiteLLM/Claude lo
  acepte; si lo rechaza, el degrade evita que se rompa el mensaje pero el PDF no
  se "ve" (queda solo materializado). Pendiente probar con un PDF real.
- Un dotfile (`.env`, `.gitignore`) se renombra a `env`/`gitignore` al sanear.
- Un SVG se rutea como texto (sin thumbnail) porque el MIME contiene `xml`.
- Un mensaje con solo adjuntos (sin texto) renderiza un `<p>` vacío (cosmético).
- La ref `[📎 nombre]` en DB usa el nombre original, no el saneado/colisión.
