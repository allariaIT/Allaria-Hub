// sandbox-agent/src/routes/projects.js
import { Router } from 'express'

export const projectsRouter = Router()

// GET /projects - list all projects
projectsRouter.get('/', (req, res) => {
  res.json([])
})
