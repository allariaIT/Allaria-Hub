// sandbox-agent/src/middleware/auth.js
export function createAuthMiddleware(secretKey) {
  return (req, res, next) => {
    const key = req.headers['x-sandbox-key']
    if (!key || key !== secretKey) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    next()
  }
}
