# Allaria Hub — Migración a CCE

## Contexto

Allaria Hub es una plataforma de IA interna donde cada usuario puede crear proyectos (mini-apps React) usando un agente de código. El stack original corría todo en VMs Docker en servidores dedicados. La migración a CCE (Huawei Cloud Container Engine) busca escalar horizontalmente — en particular los pods de agente de codeo y los deployments de proyectos de usuario, que hoy son containers estáticos en una sola VM.

---

## Arquitectura objetivo (foto)

```
Internet → ELB (ia.allaria.xyz / *.proyectos.allaria.xyz)
         ↓
   namespace: allaria-hub          ← SIEMPRE ACTIVO
   ┌─────────────────────────────┐
   │  Frontend (React/Vite)      │
   │  Backend (Express/Prisma)   │
   └─────────────────────────────┘
         ↓ (3) spawna pod + prompt
   namespace: agent-sandboxes      ← EFÍMERO POR SESIÓN
   ┌──────────────────────────────────┐
   │  Claude Agent SDK — session-001  │
   │  Claude Agent SDK — session-002  │
   │  (1 pod por usuario en workspace,│
   │   se destruye al terminar)       │
   └──────────────────────────────────┘
         ↓ (4) git push
   GitLab (gitlab.allaria.xyz)
         ↓ (5) dispara pipeline CI
   namespace: gitlab-runners         ← EFÍMERO ~4min
   ┌───────────────────────────────┐
   │  Runner Controller (siempre)  │
   │  CI Job Pod (build)           │
   │  → docker push SWR            │
   │  → kubectl apply              │
   └───────────────────────────────┘
         ↓ (7/8) apply + pull imagen
   namespace: user-projects          ← AUTO-SLEEP
   ┌─────────────────────────────────────┐
   │  juan-perez-mi-app                  │
   │  maria-gomez-crm                    │
   │  ... hasta ~2000 proyectos          │
   │  (auto-sleep cuando inactivos)      │
   └─────────────────────────────────────┘
```

**Externos conectados:** GitLab, SWR (registry), PostgreSQL, Anthropic API (vía LiteLLM)

---

## Estado de la migración

### ✅ FASE 1 — Hub en CCE (COMPLETADA — 2026-05-19)

El front y el back del Hub corren como pods en CCE. El resto del flujo (sandbox-agent, proyectos de usuarios) sigue igual que antes en Docker en el servidor .101.

#### Cluster CCE

| Campo | Valor |
|---|---|
| Cluster ID | `cbab2d15-52d5-11f1-8f6f-0255ac10023b` |
| Región | `la-south-2` (Chile) |
| Versión K8s | v1.33.5 |
| API server interno | `https://172.30.200.99:5443` |
| kubectl operativo desde | `172.30.200.101` (mismo subnet) |

**Node pools:**
- `system-pool`: 4 nodos `c7n.large.4` (2vCPU / 8GB) — IPs `.100`, `.107`, `.121`, `.123`
- `worker-pool`: 0–10 nodos autoscaling — para session pods (fase 2)

#### Namespaces creados

| Namespace | Uso |
|---|---|
| `allaria-hub` | Front + Back (activos) |
| `sandbox-sessions` | Session pods agente (fase 2) |
| `sandbox-projects` | Deployments proyectos usuario (fase 3) |
| `gitlab-runner` | GitLab Runner (fase 3) |
| `ingress-nginx` | Ingress controller (instalado, no en uso aún) |

#### Deployments activos (`namespace: allaria-hub`)

**Frontend**
- Image: `swr.la-south-2.myhuaweicloud.com/sandbox-allaria/allaria-hub-front:latest`
- Service: `NodePort 3097:30097`
- Nginx interno proxea `/api/*` → `back.allaria-hub.svc.cluster.local:3098`

**Backend**
- Image: `swr.la-south-2.myhuaweicloud.com/sandbox-allaria/allaria-hub-back:latest`
- Service: `ClusterIP :3098`
- DB: PostgreSQL `172.30.200.114:5432/allaria_hub`
- Sandbox Agent: `http://172.30.200.101:3100` (sigue en VM)
- LiteLLM: `http://172.30.200.101:4000/v1/chat/completions`

#### CI/CD (`.gitlab-ci.yml`)

Push a `main` en GitLab dispara:
1. **build-back / build-front** — docker build + push a SWR (`sandbox-allaria/allaria-hub-back:latest`)
2. **deploy-back / deploy-front** — `kubectl set image` + `rollout status` con timeout 300s

Variable requerida en GitLab CI: `KUBE_CONFIG_B64` (kubeconfig en base64 del cluster CCE).

#### Arquitectura de red

```
Internet (HTTPS)
   → ELB público 23.227.176.14  (allaria-hub.allaria.xyz)
   → CCE NodePort 30097 en nodos 172.30.200.x
   → pod front (nginx :3097)
        → /api/* → pod back (:3098) vía K8s DNS
        → / → archivos estáticos React

Pods → LiteLLM → http://172.30.200.101:4000 (directo, sin ELB)
Pods → Sandbox Agent → http://172.30.200.101:3100 (directo)
Pods → PostgreSQL → 172.30.200.114:5432
```

#### LiteLLM (migrado a .101 en esta fase)

Corría en `172.26.20.178`. Migrado a `172.30.200.101` para que los pods CCE lo alcancen sin cruzar subnets.

| Campo | Valor |
|---|---|
| Directorio | `/home/allaria/litellm-proxy/` |
| Puerto host | 4000 |
| DB | PostgreSQL `172.30.200.114:5432/litellm` |
| Master Key | `sk-allaria-c72b517ee924cce3a1963264` |
| Imágenes SWR | `sandbox-allaria/allaria-litellm-proxy:latest`, `sandbox-allaria/allaria-mcp:latest` |

Modelos cargados: Claude (opus-4, 3-7-sonnet, 3-5-sonnet, 3-5-haiku, 3-opus, **sonnet-4-5**), GPT-4o/mini/turbo, o1/o3/o4, Gemini 2.5 Pro/Flash, DALL-E, Whisper, TTS.

#### Nginx routing (sandbox-nginx en .101)

El ELB público enruta todo HTTPS a `sandbox-nginx` corriendo en `.101:3099`. El conf.d tiene:

| Archivo | Propósito |
|---|---|
| `sandbox-projects.conf` | Proyectos de usuario → sus containers por puerto |
| `zzz-litellm.conf` | `sandbox-litellm.allaria.xyz` → `:4000` (carga último — importante) |

> **Importante:** el archivo de LiteLLM debe llamarse `zzz-litellm.conf` (o cualquier nombre que cargue después de `sandbox-projects.conf`). Si carga primero alfabéticamente se convierte en el servidor default de nginx y rompe todas las rutas de proyectos.

#### Bugs resueltos durante Fase 1

| Bug | Causa | Fix |
|---|---|---|
| `502 Bad Gateway` en todas las llamadas `/api/*` | CoreDNS en CrashLoopBackOff por `bind {}` en ConfigMap | Corregido a `bind 0.0.0.0`, pods reiniciados |
| Chat devuelve `{"detail":"Not Found"}` | `litellm.conf` cargaba antes que `sandbox-projects.conf` y se volvía servidor default | Renombrado a `zzz-litellm.conf` |
| `Invalid model name claude-sonnet-4-5` | Nueva DB de LiteLLM sin tokens virtuales ni modelos de la DB vieja | Modelo agregado vía API + `LITELLM_KEY` actualizado al master key |
| `Authentication Error` en LiteLLM | El back enviaba el token virtual de la DB antigua | `LITELLM_KEY` en `back-secret` actualizado al `LITELLM_MASTER_KEY` |

---

### ✅ FASE 2 — Session Pods (COMPLETADA — 2026-05-20)

Cada vez que un usuario abre el workspace de un proyecto, el back crea un pod efímero en `namespace: sandbox-sessions`. El pod corre el `session-agent` — un Express app con el agente de código que tiene acceso al repo vía git clone. Al cerrar el workspace (o por inactividad de 60 min), el pod se destruye.

#### Flujo de una sesión

```
Usuario envía mensaje en ProjectWorkspace
  ↓
POST /api/chat/stream (projectId)
  ↓ back/src/routes/proxy.js → getOrCreateSession()
createSessionPod() → K8s API crea pod en namespace sandbox-sessions
  - Imagen: swr.la-south-2.myhuaweicloud.com/sandbox-allaria/session-agent:latest
  - Env: REPO_URL (http://oauth2:TOKEN@172.30.200.101/path.git), LITELLM_KEY, LITELLM_BASE_URL, SESSION_ID, BACK_URL
  - restartPolicy: Never | resources: 10m/64Mi req, 500m/512Mi limit
  ↓
waitForPodReady() — polling K8s cada 3s hasta 120s
  ↓
Pod listo → back hace proxy SSE a http://{podIP}:3200/chat
  ↓
Session agent: clone repo → runAgent() → tools (read/write/bash/git_push)
  ↓ (cuando el agente llama git_push)
git push → evento 'pushed' → back triggeriza pollGitlabPipeline()
  ↓
GitLab CI: docker build → push SWR → SSH deploy en .101
```

#### Archivos clave

| Archivo | Propósito |
|---|---|
| `back/src/lib/k8s.js` | `createSessionPod()`, `waitForPodReady()`, `deleteSessionPod()` |
| `back/src/routes/sessions.js` | REST endpoints `/api/projects/:id/session` |
| `back/src/routes/proxy.js` | `getOrCreateSession()`, `handleWorkspaceStream()` |
| `session-agent/src/index.js` | Express app del pod, startup (git clone), idle timeout 60min |
| `session-agent/src/agent.js` | Loop agentic con fetch → LiteLLM `/v1/chat/completions` |
| `session-agent/src/tools.js` | read_file, write_file, list_files, bash, git_push |
| `session-agent/src/git.js` | gitClone, gitCommitAndPush |
| `k8s/session-rbac.yaml` | ServiceAccount `hub-back` + Role `session-manager` en sandbox-sessions |

#### Decisiones de implementación

- **Git clone usa IP directa HTTP**: `http://oauth2:TOKEN@172.30.200.101/path.git` — evita el routing ELB→nginx que no tiene vhost de GitLab
- **LiteLLM con formato OpenAI**: el session-agent usa `fetch` a `/v1/chat/completions` (Authorization: Bearer). El endpoint `/v1/messages` de LiteLLM tiene un bug que pasa el x-api-key del usuario directo a Anthropic en vez de usar su propia key configurada. El `@anthropic-ai/sdk` fue eliminado.
- **LITELLM_BASE_URL**: env var separado con solo el host:port (`http://172.30.200.101:4000`), sin path
- **waitForPodReady timeout**: 120s (el pod tarda ~60-90s entre git clone + node startup + readiness probe)
- **Cleanup al borrar proyecto**: `DELETE /api/projects/:id` mata los pods activos antes de borrar la DB
- **404 handling**: si el pod es eliminado mientras `waitForPodReady` está polling, falla inmediatamente (no espera el timeout de 120s)

#### RBAC — manifests a aplicar

```bash
# Desde 172.30.200.101
/home/allaria/bin/kubectl apply -f k8s/session-rbac.yaml
```

El `session-rbac.yaml` crea:
- `ServiceAccount: hub-back` (namespace allaria-hub)  
- `Role: session-manager` (namespace sandbox-sessions) — permisos create/get/list/delete/watch en pods
- `RoleBinding: hub-back-session-manager` — vincula el SA con el Role

El back-deployment.yaml ya tiene `serviceAccountName: hub-back`.

#### Bugs resueltos durante FASE 2 (2026-05-20)

| # | Bug | Causa | Fix |
|---|---|---|---|
| 1 | `Pod phase=Failed` | git clone `https://gitlab.allaria.xyz` va por ELB→nginx sin vhost de GitLab | URL de clone cambiada a `http://172.30.200.101` directo |
| 2 | `401 invalid x-api-key` | LiteLLM `/v1/messages` pasa el key del usuario a Anthropic en vez de su propia API key | Reemplazado Anthropic SDK por fetch + OpenAI compat (`/v1/chat/completions`) |
| 3 | `LITELLM_URL` con path en baseURL | SDK de Anthropic usaba el path completo como base → URL incorrecta | Nuevo env var `LITELLM_BASE_URL=http://172.30.200.101:4000` (sin path) |
| 4 | Timeout 60s insuficiente | Pod tarda 60-90s en arrancar (clone + startup) | `waitForPodReady` timeout subido a 120s |
| 5 | Pods zombie al borrar proyecto | `DELETE /api/projects/:id` no mataba pods activos | Se agregan `deleteSessionPod()` calls antes de borrar en DB |
| 6 | Wait 120s al borrar con workspace abierto | 404 de pod eliminado no era manejado en `waitForPodReady` | Catch explícito de 404 → falla inmediatamente |
| 7 | sandbox-agent caído (502 en crear proyectos) | Container parado por conflicto de nombres tras restart | `docker rm` del container viejo + `docker compose up -d` |
| 8 | `fetch failed` después de varias llamadas al LLM | Node.js reutilizaba conexión keep-alive que LiteLLM cerraba → ECONNRESET | `Connection: close` en cada request a LiteLLM |
| 9 | Timeout de operación abortada (5 min) | Tareas complejas (npm install + escribir varios archivos) superaban el timeout del proxy | Proxy back→pod subido de 5 a 15 min; bash tool de 2 a 5 min |
| 10 | `prompt is too long — 208k tokens` | Tool results + rondas de tools acumuladas en el contexto sin límite | `pruneToolRounds()` ventana deslizante de 6 rondas; cap de 4KB por tool result; `read_file` limitado a 150 líneas; bash output últimas 2KB |

#### Límites de tokens actuales

| Fuente | Límite |
|---|---|
| Historial enviado al pod | Últimos 6 mensajes |
| Tool rounds en contexto | Últimas 6 rondas (sliding window) |
| Cada tool result | 4KB máx |
| read_file | 150 líneas máx |
| bash stdout/stderr | 2KB finales |
| max_tokens respuesta LLM | 8192 |
| **Peor caso estimado** | **~25k tokens** |

---

### ⏳ FASE 3 — User Projects en CCE

Hoy cada proyecto de usuario es un container Docker corriendo en `.101` en un puerto fijo (4001, 4002, ...). El nginx de `.101` lo expone via `proyectos-sandbox.allaria.xyz/user/proyecto/`.

**Objetivo:** cada proyecto es un **Deployment en `namespace: user-projects`** con su propio Service e Ingress en `*.proyectos.allaria.xyz`. Con auto-sleep cuando están inactivos (0 réplicas).

**Qué implica:**

1. **GitLab CI por proyecto**: el pipeline de cada proyecto hace `docker build` + `docker push` a SWR + `kubectl apply` del deployment
2. **GitLab Runner en CCE** (`namespace: gitlab-runners`): Runner Controller siempre activo, CI Job Pods efímeros (~4min)
3. **Ingress wildcard** `*.proyectos.allaria.xyz` → ingress-nginx en CCE
4. **Auto-sleep**: CronJob o HPA que escala a 0 réplicas después de N minutos de inactividad
5. **Migración de proyectos existentes**: 7 proyectos actuales en Docker → Deployments K8s

**Estado actual:** namespaces `gitlab-runner`, `sandbox-projects`, `ingress-nginx` creados. Ingress-nginx instalado vía Helm con NodePort. Pendiente: instalar GitLab Runner, crear manifests de CI por proyecto, configurar DNS wildcard.

---

## Servidores — qué corre dónde hoy

| Servidor | IP | Rol | NO apagar porque... |
|---|---|---|---|
| **CCE nodes** | `.100`, `.107`, `.121`, `.123` | Pods front/back + session pods (workspace agente) | Es el cluster |
| **srv-docker-sandbox** | `172.30.200.101` | GitLab CE, sandbox-agent, sandbox-nginx, LiteLLM, proyectos Docker usuarios | Todo pasa por acá |
| **srv-docker-app** | `172.26.20.90` | Muchas apps Allaria (cheques, rgestor, n8n...) | Tiene back/front del Hub todavía levantados (se pueden bajar) |
| **srv-docker-tst** | `172.26.20.178` | LiteLLM viejo (ya migrado), otras apps | Otras apps en producción |
| **srv-docker-dev** | `172.30.200.115` | Entorno dev de varios proyectos | Proyectos dev activos |
| **PostgreSQL** | `172.30.200.114` | DB principal Allaria | Todo |
| **ELB** | `172.30.200.105` / `23.227.176.14` | Load balancer — todas las apps | Es el entry point |

---

## Pendiente operativo inmediato

- [x] **FASE 2 completada (2026-05-20)** — Session pods en `namespace: sandbox-sessions` operativos. Próximo paso: FASE 3 (proyectos de usuario como Deployments en CCE).
- [ ] TIC: crear DNS `sandbox-litellm.allaria.xyz` → `172.30.200.105`
- [ ] Bajar el Hub de `172.26.20.90` (`docker compose down`) — ya no es necesario
- [ ] Actualizar `CORS_ORIGIN` y `FRONT_URL` en `back-secret` si se cambia el dominio de `allaria-hub.allaria.xyz` a `ia.allaria.xyz`
- [ ] Fix healthcheck de LiteLLM: el container no tiene `wget`, cambiar a `python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:8766/health/liveliness', timeout=3)"`

---

## Variables de entorno K8s (back-secret)

```
DATABASE_URL       postgresql://root:***@172.30.200.114:5432/allaria_hub
LITELLM_URL        http://172.30.200.101:4000/v1/chat/completions
LITELLM_KEY        sk-allaria-c72b517ee924cce3a1963264  ← master key del LiteLLM en .101
SANDBOX_AGENT_URL  http://172.30.200.101:3100
SANDBOX_AGENT_KEY  5f98396823e95b7ed633b2970d234c210e2fca50f927f68cc69ba62950929761
SANDBOX_PREVIEW_URL https://proyectos-sandbox.allaria.xyz
GITLAB_URL         https://gitlab.allaria.xyz
GITLAB_GROUP_ID    54
CORS_ORIGIN        https://allaria-hub.allaria.xyz
FRONT_URL          https://allaria-hub.allaria.xyz
GOOGLE_REDIRECT_URI https://allaria-hub.allaria.xyz/api/connectors/callback
```

---

## Comandos útiles

```bash
# Ver estado del cluster desde .101
/home/allaria/bin/kubectl -n allaria-hub get pods,svc,ingress

# Logs del back en tiempo real
/home/allaria/bin/kubectl -n allaria-hub logs -f deployment/back

# Actualizar un secret y reiniciar el back
/home/allaria/bin/kubectl -n allaria-hub patch secret back-secret --type=json \
  -p '[{"op":"replace","path":"/data/LITELLM_KEY","value":"BASE64_VALOR"}]'
/home/allaria/bin/kubectl -n allaria-hub rollout restart deployment/back

# Agregar/actualizar config nginx (desde .101)
# Escribir: docker exec sandbox-agent sh -c 'echo BASE64 | base64 -d > /etc/nginx/conf.d/archivo.conf'
# Recargar: docker exec sandbox-nginx nginx -s reload

# LiteLLM — agregar modelo
curl -s -X POST http://localhost:4000/model/new \
  -H "Authorization: Bearer sk-allaria-c72b517ee924cce3a1963264" \
  -H "Content-Type: application/json" \
  -d '{"model_name":"nuevo-modelo","litellm_params":{"model":"anthropic/modelo","api_key":"os.environ/ANTHROPIC_API_KEY"}}'
```
