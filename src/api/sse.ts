/**
 * SSE (Server-Sent Events) endpoint for streaming research events
 * to external consumers (dashboards, other agents).
 *
 * Usage:
 *   const server = createSSEServer(emitter, { port: 8080 })
 *   // Clients connect to http://localhost:8080/events
 *   // server.stop() to shutdown
 */

import type { ResearchEventEmitter, TypedResearchEvent } from "../engine/events.ts"

export interface SSEServerConfig {
  port?: number
  hostname?: string
  /** Optional auth token — clients must send ?token=X */
  authToken?: string
}

export interface SSEServer {
  port: number
  stop: () => void
  clientCount: () => number
}

/**
 * Create an SSE server that streams research events to connected clients.
 */
export function createSSEServer(
  emitter: ResearchEventEmitter,
  config: SSEServerConfig = {},
): SSEServer {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const encoder = new TextEncoder()

  // Subscribe to all events
  const unsub = emitter.onAny((event: TypedResearchEvent) => {
    const data = `data: ${JSON.stringify(event)}\n\n`
    const encoded = encoder.encode(data)
    for (const controller of clients) {
      try {
        controller.enqueue(encoded)
      } catch {
        clients.delete(controller)
      }
    }
  })

  const server = Bun.serve({
    port: config.port ?? 0,
    hostname: config.hostname ?? "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url)

      // Auth check
      if (config.authToken) {
        const token = url.searchParams.get("token")
        if (token !== config.authToken) {
          return new Response("Unauthorized", { status: 401 })
        }
      }

      if (url.pathname === "/events") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            clients.add(controller)
            // Send initial connection event
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "connected", timestamp: Date.now() })}\n\n`))
          },
          cancel(controller) {
            clients.delete(controller)
          },
        })

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        })
      }

      if (url.pathname === "/health") {
        return Response.json({ status: "ok", clients: clients.size })
      }

      return new Response("Not found", { status: 404 })
    },
  })

  return {
    port: server.port ?? config.port ?? 0,
    stop: () => {
      unsub()
      for (const controller of clients) {
        try { controller.close() } catch {}
      }
      clients.clear()
      server.stop()
    },
    clientCount: () => clients.size,
  }
}
