// sandbox-agent/src/index.js
import 'dotenv/config'
import express from 'express'
import { createAuthMiddleware } from './middleware/auth.js'
import { projectsRouter } from './routes/projects.js'

const app = express()
const PORT = process.env.PORT || 3100

app.use(express.json({ limit: '10mb' }))

app.get('/health', (req, res) => res.json({ status: 'ok' }))

const auth = createAuthMiddleware(process.env.SANDBOX_KEY)
app.use('/projects', auth, projectsRouter)

app.listen(PORT, () => {
  console.log(`[Sandbox Agent] Running on port ${PORT}`)
})

export { app }
