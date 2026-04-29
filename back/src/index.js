import express from 'express'
import cors from 'cors'
import { authRouter } from './routes/auth.js'
import { chatRouter } from './routes/chats.js'
import { proxyRouter } from './routes/proxy.js'
import { authenticate } from './middleware/auth.js'

const app = express()
const PORT = process.env.PORT || 3098

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
}))
app.use(express.json({ limit: '50mb' }))

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }))

// Public
app.use('/api/auth', authRouter)

// Protected
app.use('/api/chats', authenticate, chatRouter)
app.use('/api/chat', authenticate, proxyRouter)

app.listen(PORT, () => {
  console.log(`[Allaria Hub API] Running on port ${PORT}`)
})
