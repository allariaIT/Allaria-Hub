# Login con contraseña para usuarios externos

**Fecha:** 2026-05-15
**Estado:** Aprobado

## Objetivo

Permitir el acceso a Allaria Hub IA a usuarios externos (no tienen cuenta Google @allaria.com.ar) mediante una contraseña compartida. Todos los usuarios externos ingresan como la misma cuenta `externo`.

## Cambios

### Backend — `back/src/routes/auth.js`

Nuevo endpoint `POST /api/auth/password`:
- Recibe `{ password }` en el body
- Valida contra la contraseña hardcodeada `HubIA2026+`
- Si es correcta: upsert del usuario externo en DB y devuelve `{ user, token }`
- Si es incorrecta: `401 { error: 'Contraseña incorrecta' }`

Usuario externo en DB:
- `id`: `"externo"`
- `name`: `"externo"`
- `email`: `"externo@allaria.xyz"`
- `picture`: `null`

Token: `SHA256("externo" + GOOGLE_CLIENT_ID)` — determinístico, compatible con el middleware existente sin cambios.

### Frontend — `front/src/context/AuthContext.jsx`

Nueva función `signInWithPassword(password)`:
- Llama `POST /api/auth/password`
- Si OK: guarda `token` + `user` en localStorage, igual que el flujo Google
- Si error: lanza excepción para que el componente lo maneje

### Frontend — `front/src/pages/Login.jsx`

Debajo del botón de Google, agregar:
1. Separador visual `─── o ───`
2. Botón texto "Otros métodos" que togglea un form colapsable
3. Form colapsable con:
   - Input `type="password"` con placeholder "Contraseña"
   - Botón "Ingresar"
   - Mensaje de error inline si la contraseña es incorrecta

### Frontend — `front/src/pages/Login.css`

Estilos nuevos para:
- `.login-divider` — separador "o"
- `.login-alt-btn` — botón texto "Otros métodos"
- `.login-password-form` — form colapsable (transición CSS)
- `.login-password-input` — input de contraseña
- `.login-password-submit` — botón Ingresar
- `.login-password-error` — mensaje de error inline

## Seguridad

- La contraseña **no** se almacena en el frontend ni en el bundle JS
- La validación ocurre 100% server-side
- Todos los externos comparten la misma sesión (`id: "externo"`)

## Archivos modificados

| Archivo | Tipo de cambio |
|---|---|
| `back/src/routes/auth.js` | Nuevo route `POST /api/auth/password` |
| `front/src/context/AuthContext.jsx` | Nueva función `signInWithPassword()` |
| `front/src/pages/Login.jsx` | UI: botón toggle + form contraseña |
| `front/src/pages/Login.css` | Estilos del form |
