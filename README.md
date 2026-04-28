# 🚀 Allaria IT - Service Template

Este repositorio es una plantilla base para servicios desplegados en **Huawei Cloud SWR** mediante el ecosistema de despliegue de **allariaIT**.

## 🛠 Estructura del Proyecto

* **.github/workflows/deployment.yml**: Pipeline CI/CD preconfigurado.
* **Dockerfile**: Servidor Node.js minimalista.
* **docker-compose.yml**: Orquestación de contenedores con red externa y volúmenes NFS.

## 📋 Guía de Inicio (Setup del Nuevo Repo)

Al crear un repositorio desde esta plantilla, el pipeline estará listo para ejecutarse, pero necesitas configurar los ambientes y secretos:

### 1. Configurar Ambientes y Ramas

En `Settings > Environments` del repositorio, crea los siguientes ambientes para controlar el despliegue:

* `dev` -> rama `dev` (desarrollo)
* `stg` -> rama `stg` (staging)
* `prd` -> rama `prd` (producción)
* `tst` -> rama `tst` (testing)

### 2. Variables y Secretos

El pipeline utiliza configuración heredada de la Organización y específica del repositorio.

**Configuración del Workflow (`.github/workflows/deployment.yml`):**
Edita los valores en la sección `with:` si tu proyecto requiere una configuración distinta a la default:

* `registry_url`: Endpoint de SWR (default: `swr.sa-argentina-1.myhuaweicloud.com`).
* `registry_organization`: Organización SWR (default: `developers`).

**Variables de Repositorio (`Settings > Secrets and variables > Actions > Variables`):**

* `APP_PORT`: (Requerido) Puerto TCP donde escucha la aplicación (ej. `8080`).

**Secretos de Repositorio (`Settings > Secrets and variables > Actions > Secrets`):**

* `SWR_USER`: Usuario de Huawei SWR.
* `SWR_PASS`: Contraseña de Huawei SWR.

**Secretos de Ambiente (`Settings > Secrets and variables > Actions > Environments > [ENVIRONMENT_NAME] > Secrets`):**

* `SERVER_PRIV_KEY`: Llave SSH para conexión al host de despliegue.
* `SERVER_ADDRESS`: Dirección IP del host de despliegue.
* `SERVER_USER`: Usuario del host de despliegue.

#### Agregar nuevos secretos

* Agregar los secretos en la sección `Secrets` de cada ambiente.
* Editar el archivo `.github/workflows/deployment.yml` para agregar los nuevos secretos. (En `env_secrets`)

## 📦 Almacenamiento (SFS)

El stack monta un volumen NFS compartido automáticamente (CREAR ANTES DEL DESPLIEGUE):

* **Host**: `172.30.20.83:/SFS/${REPO_NAME}/`
* **Container**: `/data`

Cualquier archivo que deba persistir entre despliegues debe guardarse en `/data`.

## 🌐 Red

El contenedor se conecta a la red externa `red-docker`. Asegúrate de que esta red exista en el servidor de destino antes del despliegue.
