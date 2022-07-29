import express, { Request, Response } from 'express'
import fetch from 'node-fetch'
import HttpsProxyAgent from 'https-proxy-agent'
import log from './logger'

const PORT = Math.floor(Math.random() * 10000) + 10000

;(async () => {
  const app = express()

  app.get('/proxyStatus', (req: Request, res: Response) => {
    res.status(200).send()
  })

  app.all('*', (req: Request, res: Response) => {
    res.status(403).send(`Forbidden: ${req.method} ${req.url}`)
  })

  app.listen(PORT)
})()

export default async function () {
  try {
    await fetch(`http://127.0.0.1:${PORT}/proxyStatus`, {
      agent: HttpsProxyAgent(process.env.HTTP_PROXY || '')
    })
    return true
  } catch (error) {
    log.error('ProxyStatus', 'Proxy is down')
    process.exit(1)
  }
}
