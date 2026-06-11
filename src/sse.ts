import type { Response } from "express";
import type { Message } from "./store.js";

/** SSE client connection tracking, shared by the REST server and mesh delivery paths. */
export interface SseClient {
  res: Response;
  rooms: string[] | null;
}

const sseClients = new Map<string, Set<SseClient>>();

export function addSseClient(sessionId: string, client: SseClient): void {
  if (!sseClients.has(sessionId)) {
    sseClients.set(sessionId, new Set());
  }
  sseClients.get(sessionId)!.add(client);
}

export function removeSseClient(sessionId: string, client: SseClient): void {
  const clients = sseClients.get(sessionId);
  if (clients) {
    clients.delete(client);
    if (clients.size === 0) sseClients.delete(sessionId);
  }
}

/** Push a message to all matching SSE clients for a given sessionId. */
export function notifySseClients(sessionId: string, message: Message): void {
  const clients = sseClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  for (const client of clients) {
    if (client.rooms && message.room) {
      if (!client.rooms.includes(message.room)) continue;
    } else if (client.rooms && !message.room) {
      continue;
    }
    client.res.write(`data: ${JSON.stringify(message)}\n\n`);
  }
}
