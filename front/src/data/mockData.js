export const projects = [
  {
    id: 1,
    title: 'API Gateway Allaria',
    author: 'Martín López',
    avatar: 'ML',
    description: 'Gateway centralizado para microservicios internos con rate limiting, autenticación JWT y logging distribuido.',
    tags: ['Go', 'gRPC', 'Redis'],
    status: 'En desarrollo',
    stars: 24,
    updatedAt: '2026-04-18',
  },
  {
    id: 2,
    title: 'Dashboard Analytics',
    author: 'Camila Fernández',
    avatar: 'CF',
    description: 'Panel de métricas en tiempo real para monitoreo de operaciones financieras y rendimiento de portafolios.',
    tags: ['React', 'D3.js', 'Python'],
    status: 'Producción',
    stars: 41,
    updatedAt: '2026-04-19',
  },
  {
    id: 3,
    title: 'Bot de Compliance',
    author: 'Santiago Ruiz',
    avatar: 'SR',
    description: 'Automatización de verificaciones regulatorias mediante procesamiento de lenguaje natural sobre documentos normativos.',
    tags: ['Python', 'NLP', 'FastAPI'],
    status: 'Beta',
    stars: 18,
    updatedAt: '2026-04-15',
  },
  {
    id: 4,
    title: 'Mobile Allaria App',
    author: 'Lucía Martínez',
    avatar: 'LM',
    description: 'Aplicación móvil nativa para clientes con consulta de portafolio, alertas de mercado y operaciones rápidas.',
    tags: ['React Native', 'TypeScript'],
    status: 'Producción',
    stars: 67,
    updatedAt: '2026-04-20',
  },
  {
    id: 5,
    title: 'ETL Pipeline Manager',
    author: 'Nicolás García',
    avatar: 'NG',
    description: 'Orquestador de pipelines de datos con soporte para múltiples fuentes, transformaciones y destinos.',
    tags: ['Airflow', 'Python', 'PostgreSQL'],
    status: 'En desarrollo',
    stars: 12,
    updatedAt: '2026-04-12',
  },
  {
    id: 6,
    title: 'Design System Allaria',
    author: 'Valentina Rossi',
    avatar: 'VR',
    description: 'Librería de componentes UI con los estándares de marca Allaria. Tokens, componentes y patrones reutilizables.',
    tags: ['React', 'Storybook', 'CSS'],
    status: 'Producción',
    stars: 53,
    updatedAt: '2026-04-17',
  },
]

export const docSections = [
  {
    id: 'getting-started',
    title: 'Empezar en el Hub',
    icon: '🚀',
    articles: [
      {
        title: '¿Qué es Allaria Hub?',
        readTime: '2 min',
        content: `## ¿Qué es Allaria Hub?

Allaria Hub es el espacio de trabajo interno del equipo de Allaria para crear, explorar y compartir herramientas digitales — sin necesitar conocimientos técnicos avanzados.

### Una plataforma para construir y colaborar

Con el Hub podés:
- **Crear aplicaciones web** con la ayuda de un agente de inteligencia artificial
- **Chatear con distintos modelos de IA** para resolver dudas, analizar información o redactar contenido
- **Explorar proyectos del equipo** y ver lo que otros están construyendo

### ¿Quién lo usa?

Cualquier persona del equipo Allaria. No importa si venís del área de tecnología, finanzas, legal o comercial — el Hub está pensado para que todos puedan aprovechar la IA en su trabajo diario.

### ¿Cómo está organizado?

El Hub tiene tres secciones principales:

- **Chat con IA** — para conversaciones generales con el asistente
- **Hub de Proyectos** — para crear y gestionar aplicaciones web con el agente
- **Documentación** — esta sección, donde encontrás guías y respuestas a las preguntas más comunes`,
      },
      {
        title: 'Cómo ingresar',
        readTime: '2 min',
        content: `## Cómo ingresar al Hub

El acceso al Hub es con tu cuenta de Google corporativa de Allaria.

### Pasos para entrar

1. Abrí el Hub en tu navegador
2. Hacé click en **"Continuar con Google"**
3. Seleccioná tu cuenta \`@allaria.com.ar\`
4. ¡Listo! Ya estás adentro

### Problemas frecuentes

**"No tengo acceso"** — El Hub solo acepta cuentas \`@allaria.com.ar\`. Si usás otra cuenta, no vas a poder ingresar. Contactá a TIC si creés que deberías tener acceso.

**"La página no carga"** — El Hub corre en la red interna de Allaria. Si estás fuera de la oficina, necesitás estar conectado a la VPN.

### Tu sesión

La sesión se mantiene activa durante varios días. No necesitás volver a ingresar cada vez que abrís el Hub.`,
      },
      {
        title: 'La pantalla de inicio',
        readTime: '3 min',
        content: `## La pantalla de inicio

Cuando ingresás al Hub, lo primero que ves es la pantalla de inicio con un resumen de la actividad del equipo.

### Qué vas a encontrar

**Estadísticas generales** — En la parte superior aparecen números clave: cuántos proyectos hay activos, cuántos usuarios están usando el Hub y cómo está el uptime de los servicios.

**Proyectos destacados** — Una selección de los proyectos más populares del equipo, ordenados por estrellas. Es una buena forma de descubrir qué está construyendo la gente.

**Acceso rápido** — Desde la barra lateral izquierda podés navegar a cualquier sección en cualquier momento:
- 🏠 Inicio
- 💬 Chat con IA
- 📁 Hub de Proyectos
- 📖 Documentación

### La barra lateral

La barra lateral siempre está visible. En la parte superior muestra el logo de Allaria y el nombre de la sección donde estás. Abajo del todo aparece tu avatar y nombre de usuario.`,
      },
    ],
  },
  {
    id: 'projects',
    title: 'Proyectos',
    icon: '📁',
    articles: [
      {
        title: 'Crear tu primer proyecto',
        readTime: '4 min',
        content: `## Crear tu primer proyecto

Un proyecto en el Hub es una aplicación web que el agente de IA construye por vos. Puede ser una herramienta interna, un dashboard, una calculadora, un formulario — lo que necesites.

### Cómo crear un proyecto

1. Andá al **Hub de Proyectos** desde el menú lateral
2. Hacé click en el botón **"Nuevo proyecto"** (arriba a la derecha)
3. Dale un nombre y una descripción breve a tu proyecto
4. Hacé click en **"Crear"**

El agente arranca a trabajar de forma automática. En unos minutos vas a tener una primera versión de tu herramienta online.

### ¿Qué le cuento al agente?

Cuanto más claro y específico seas, mejor resultado vas a obtener. En vez de decir _"quiero un dashboard"_, probá con _"quiero un dashboard que muestre las ventas del mes con un gráfico de barras"_.

No importa si no sabés cómo se llama la tecnología — describí lo que querés que haga, no cómo tiene que estar hecho.

### ¿Cuánto tarda?

La creación inicial tarda entre 2 y 5 minutos. El agente genera el código y lo publica automáticamente. Cuando termina, aparece un botón para ver tu aplicación en el navegador.`,
      },
      {
        title: 'El agente: qué puede hacer',
        readTime: '5 min',
        content: `## El agente: qué puede hacer

Cuando abrís el workspace de un proyecto, estás hablando con un agente de IA especializado en construir y modificar aplicaciones. No es un chat genérico — este agente tiene herramientas concretas para actuar sobre tu proyecto.

### Qué puede hacer el agente

**Escribir y editar código** — Puede crear archivos nuevos, modificar los existentes y reorganizar la estructura del proyecto. Vos le describís qué querés y él lo implementa.

**Subir los cambios** — Cuando terminó de trabajar, el agente sube el código automáticamente. No necesitás tocar nada técnico.

**Deployar la aplicación** — Después de subir el código, el sistema compila y publica la nueva versión. Podés ver el progreso en tiempo real en el mismo chat.

**Leer archivos del proyecto** — Si le preguntás cómo está armado algo, el agente puede revisar el código y explicártelo en términos simples.

### Qué NO puede hacer

- No tiene acceso a Internet para buscar información externa
- No puede leer datos de sistemas externos a menos que vos los conectes
- No recuerda conversaciones anteriores entre sesiones distintas

### Tips para trabajar bien con el agente

- Describí cambios de a uno: "Agregá un botón para exportar a Excel" es mejor que "mejorá todo el dashboard"
- Si algo no quedó como querías, explicá qué falta o qué está mal — el agente puede corregirlo
- Podés preguntarle cómo está armada cualquier parte de tu aplicación`,
      },
      {
        title: 'Ver el progreso de tu proyecto',
        readTime: '3 min',
        content: `## Ver el progreso de tu proyecto

Cuando el agente trabaja en tu proyecto, podés seguir el progreso en tiempo real desde el mismo chat.

### El tracker de pipeline

Cada vez que el agente sube cambios, aparece en el chat un indicador de progreso con tres etapas:

| Etapa | Qué pasa |
|---|---|
| 📦 Compilando | El sistema construye tu aplicación con los últimos cambios |
| 🚀 Publicando | La nueva versión se sube al servidor |
| 🎉 Online | Tu app está disponible con los cambios aplicados |

### Cuando todo sale bien

Al terminar el pipeline, aparece un botón **"Ver mi app →"** que abre tu aplicación en una nueva pestaña. Los cambios son inmediatos.

### Cuando algo falla

Si el pipeline falla, el chat te muestra en qué etapa ocurrió el problema y un botón de **reintentar**. El agente recibe el contexto del error y puede intentar corregirlo automáticamente.

### El estado de tu proyecto

En la lista del Hub de Proyectos, cada proyecto muestra su estado actual:
- **Creando** — el proyecto está siendo generado por primera vez
- **Online** — la aplicación está activa y funcionando
- **Error** — hubo un problema en el último deploy`,
      },
      {
        title: 'Explorar proyectos de otros',
        readTime: '2 min',
        content: `## Explorar proyectos de otros

El Hub de Proyectos no solo muestra los tuyos — también podés ver lo que está construyendo el resto del equipo.

### La galería de proyectos

En la sección **"Hub de Proyectos"** hay una galería con todos los proyectos compartidos. Cada tarjeta muestra:
- El nombre y descripción del proyecto
- Quién lo creó
- Las tecnologías usadas
- Cuántas estrellas tiene

### Dar una estrella ⭐

Si encontrás un proyecto útil o interesante, podés darle una estrella haciendo click en el ícono ⭐ de la tarjeta. Las estrellas son la forma de destacar los proyectos más valiosos del equipo.

### Mis proyectos

La pestaña **"Mis proyectos"** muestra solo los proyectos que creaste vos. Desde ahí podés abrir el workspace, ver el estado de cada uno o eliminarlos.

### ¿Puedo editar el proyecto de otra persona?

No directamente. Si querés proponer cambios en el proyecto de alguien, lo mejor es hablar con esa persona — el agente puede hacer las modificaciones en el workspace del dueño del proyecto.`,
      },
    ],
  },
  {
    id: 'chat',
    title: 'Chat con IA',
    icon: '💬',
    articles: [
      {
        title: 'Hablar con el asistente',
        readTime: '3 min',
        content: `## Hablar con el asistente

La sección **Chat con IA** es un espacio de conversación general, separado de los proyectos. Podés usarla para hacer preguntas, redactar texto, analizar datos o lo que necesites.

### Cómo funciona

Es un chat clásico: escribís tu mensaje, presionás Enter (o el botón de enviar) y el asistente responde. La conversación queda guardada en el historial de la izquierda.

### Para qué sirve

- Resumir documentos o correos largos
- Redactar comunicaciones, reportes o propuestas
- Hacer preguntas sobre temas financieros, legales o de cualquier área
- Analizar datos pegados directamente en el chat
- Pensar ideas o hacer brainstorming

### Historial de conversaciones

Cada conversación se guarda automáticamente con el título del primer mensaje. Podés volver a cualquier conversación anterior desde el panel izquierdo del Chat.

Para empezar una conversación nueva, hacé click en el botón **"+"** arriba del historial.

### No es el workspace del proyecto

El chat general sirve para consultas y tareas de texto. El workspace de un proyecto sirve para construir y modificar aplicaciones. Son dos cosas distintas.`,
      },
      {
        title: 'Adjuntar archivos e imágenes',
        readTime: '2 min',
        content: `## Adjuntar archivos e imágenes

Podés adjuntar archivos a tus mensajes para que el asistente los analice, resuma o use como contexto.

### Cómo adjuntar

Hacé click en el ícono de clip 📎 en la barra de mensajes, o arrastrá el archivo directamente al área de chat.

### Qué tipos de archivos acepta

| Tipo | Formatos |
|---|---|
| Imágenes | JPG, PNG, GIF, WebP |
| Documentos | PDF |
| Texto plano | TXT, CSV, Markdown |

Los archivos de Office (Word, Excel, PowerPoint) no son compatibles directamente. Si necesitás analizar uno, exportalo a PDF o copiá el contenido al chat.

### ¿Qué puede hacer el asistente con los archivos?

- **Imágenes**: describir el contenido, leer texto, analizar gráficos o diagramas
- **PDFs**: resumir, responder preguntas sobre el contenido, extraer información clave
- **CSVs**: analizar datos, calcular totales, identificar patrones

### Límite de tamaño

El tamaño máximo por archivo es de **10 MB**. Para archivos más grandes, intentá dividirlos o pegá solo la parte relevante.`,
      },
      {
        title: 'Elegir el modelo de IA',
        readTime: '3 min',
        content: `## Elegir el modelo de IA

El Hub te permite elegir con qué modelo de IA querés hablar. Cada modelo tiene distintas fortalezas.

### Cómo cambiar el modelo

En el chat, encontrás un selector de modelo arriba de la caja de texto. Hacé click para ver las opciones disponibles.

### Los modelos disponibles

**Claude (Anthropic)** — Muy bueno para redacción, análisis de documentos, razonamiento complejo y conversaciones largas. Es el modelo que usa el agente de proyectos.

**GPT-4 (OpenAI)** — Equilibrado y versátil. Funciona bien para una amplia variedad de tareas.

**Gemini (Google)** — Buena opción para tareas que involucran información o integración con servicios de Google.

### ¿Cuál usar?

Para la mayoría de las tareas del día a día, cualquiera de los modelos va a funcionar bien. Si no sabés cuál elegir, quedate con el que está seleccionado por defecto.

Si tenés una tarea muy específica — analizar un contrato legal largo, hacer cálculos complejos, escribir un documento extenso — vale la pena probar con Claude.

### El modelo del workspace

El workspace de proyectos siempre usa Claude. No podés cambiarlo desde el workspace.`,
      },
    ],
  },
  {
    id: 'account',
    title: 'Tu cuenta',
    icon: '⭐',
    articles: [
      {
        title: 'Tus proyectos y favoritos',
        readTime: '2 min',
        content: `## Tus proyectos y favoritos

### Mis proyectos

Desde la pestaña **"Mis proyectos"** en el Hub de Proyectos podés ver todas las aplicaciones que creaste. Para cada proyecto podés:

- **Abrir el workspace** — hacé click en el nombre del proyecto para empezar a trabajar con el agente
- **Ver la app** — si el proyecto está online, hay un botón directo para abrirlo en el navegador
- **Eliminar el proyecto** — esta acción es permanente y no se puede deshacer

### Proyectos favoritos

Cuando le das una estrella ⭐ a un proyecto (tuyo o de otra persona), lo podés encontrar rápido desde tu lista. Es una forma de marcar los proyectos que usás seguido o que te parecen útiles.

### Estado de los proyectos

Cada proyecto muestra su estado actual en la tarjeta:

- 🟡 **Creando** — el proyecto está siendo generado por primera vez
- 🟢 **Online** — la aplicación está activa
- 🔴 **Error** — hubo un problema. Abrí el workspace y pedile al agente que lo resuelva.`,
      },
      {
        title: 'Conectar herramientas',
        readTime: '3 min',
        content: `## Conectar herramientas

Desde tu perfil podés conectar herramientas externas para que el asistente pueda usarlas en el chat.

### ¿Para qué sirve?

Conectar una herramienta le da al asistente acceso a información adicional. Por ejemplo, si conectás una fuente de datos, el asistente puede consultarla directamente en la conversación en vez de que vos tengas que copiar y pegar la información.

### Cómo conectar

1. Hacé click en tu avatar en la barra lateral izquierda
2. Andá a la sección de conexiones o integraciones
3. Elegí la herramienta que querés conectar y seguí los pasos

### Herramientas disponibles

Las herramientas disponibles dependen de las integraciones que el equipo de TIC fue habilitando. Si necesitás conectar algo específico que no está en la lista, contactá a TIC.

### Seguridad

Las credenciales de conexión se guardan de forma segura. El Hub no almacena contraseñas en texto plano. Si querés revocar el acceso, podés desconectar la herramienta desde el mismo panel en cualquier momento.`,
      },
    ],
  },
]

export const stats = [
  { label: 'Proyectos activos', value: '24', change: '+3 este mes' },
  { label: 'Usuarios', value: '18', change: '+2 nuevos' },
  { label: 'Actualización de proyectos este mes', value: '142', change: '+12% vs anterior' },
  { label: 'Uptime', value: '99.97%', change: 'Último mes' },
]
