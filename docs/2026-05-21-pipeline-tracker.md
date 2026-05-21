# Pipeline Tracker en el Workspace — 2026-05-21

## Que se construyo

Tracker visual en tiempo real del pipeline CI/CD en el workspace, mostrando al usuario el progreso del deploy sin necesidad de tener cuenta de GitLab.

## Motivacion

Cuando el agente hacia git push, el usuario no tenia feedback de si el CI termino, fallo o cuanto tarda. El unico mensaje era una linea "CI de GitLab desplegando..." que no se actualizaba.

## Diseño

Componente `PipelineTracker` que aparece en el chat como un "mensaje del bot" despues del push. Tres estados:

- **Running**: dot pulsante, tres pasos animados (📦 Empaquetando → 🚀 Lanzando → 🎉 Lista), input bloqueado
- **Success**: celebracion 🎉 con glow, todos los pasos en verde con duracion por etapa, boton "Ver mi app →"
- **Error**: etapa fallida con X rojo, mensaje tranquilizador ("la app anterior sigue funcionando"), boton "Reintentar" que pasa el contexto del error al bot

Persiste en reconexiones via el buffer de `active-streams.js` (replay de eventos).

## Archivos modificados

| Archivo | Cambio |
|---|---|
| `back/src/lib/sandbox-tools.js` | `pollGitlabPipeline` acepta `{ onStage }` callback, consulta `/jobs` API, retorna `duration` y `failedJob` |
| `back/src/routes/proxy.js` | Evento `pushed` inicia pipeline poll; emite `pipeline_stage/done/error`; SSE abierto hasta que termine via `pipelinePromise` en `finally` |
| `front/src/pages/ProjectWorkspace.jsx` | `consumeSSE` no rompe en `done`; `pipelineState` + 4 handlers SSE; `PipelineTracker` renderizado en el chat |
| `front/src/pages/ProjectWorkspace.css` | Estilos `pw-pipeline--running/success/error` |

## Eventos SSE nuevos

```
pushed           ->  frontend inicializa pipelineState con todos los stages en 'pending'
pipeline_stage   ->  { job: 'build'|'deploy', status: 'running'|'success'|'failed' }
pipeline_done    ->  { duration: { build: '1m 12s', deploy: '38s' } }
pipeline_error   ->  { failedJob: 'build'|'deploy'|null, message: string }
```

## Bugs encontrados durante el deploy

1. **`pipelinePromise` not defined** — declarada con `let` dentro del `try`, referenciada en `finally`. Fix: mover la declaracion antes del bloque `try`.

2. **Job names incorrectos** — el codigo asumia `docker:build`/`deploy:server` pero el CI real usa `build`/`deploy`. Fix: corregir en `PIPELINE_STAGES` y en `pollGitlabPipeline`.

3. **Retry sin contexto** — el boton "Reintentar" mandaba "Por favor reintenta el deploy" generico. Fix: pasar etapa fallida + mensaje de error al bot.

## Notas de arquitectura

- `pipelinePromise` SIEMPRE antes del `try` en `handleWorkspaceStream`. Nunca adentro.
- `consumeSSE` en el front NO rompe en `done`. Espera `_stream_ended`. Sin esto, los eventos del pipeline no llegan.
- El stream SSE se mantiene abierto ~2 min mientras el pipeline corre. El cliente puede desconectarse; los eventos se bufferean en `active-streams` y se replay al reconectar.
- Los job names del CI son `build` y `deploy`. Verificar con la API de GitLab si se cambia el template.
