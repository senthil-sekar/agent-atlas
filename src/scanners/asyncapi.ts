import { join, posix } from 'node:path';
import { parse } from 'yaml';
import { type Message, emptyResult, normalizeId } from '../model.js';
import { readText } from '../util.js';
import type { Scanner } from './types.js';

const NAME = /(^|[./-])asyncapi([.-][\w-]+)?\.(ya?ml|json)$/i;

function messageOf(msg: any): Message | undefined {
  const name = msg?.name ?? msg?.title ?? msg?.['x-parser-message-name'];
  if (!name) return undefined;
  return { name: String(name), ...(msg.summary ? { summary: String(msg.summary) } : {}) };
}

/**
 * AsyncAPI documents the message schemas that flow through a topic or queue, the way OpenAPI
 * documents a service's endpoints. Every topic/queue node gets a `messages` catalog; nothing here
 * is attached to a particular service, since AsyncAPI channels already name the resource directly.
 */
export const scanAsyncApi: Scanner = (ctx) => {
  const result = emptyResult();
  for (const f of ctx.files.filter((f) => NAME.test(posix.basename(f)))) {
    let doc: any;
    try { doc = parse(readText(join(ctx.root, f)) ?? ''); } catch { result.warnings!.push(`${f}: invalid AsyncAPI document`); continue; }
    if (!doc?.asyncapi || !doc.channels) continue;

    const byChannel = new Map<string, Message[]>();
    const collect = (channel: string, msg: any) => {
      const message = messageOf(msg);
      if (!message) return;
      const list = byChannel.get(channel) ?? [];
      if (!list.some((m) => m.name === message.name)) list.push(message);
      byChannel.set(channel, list);
    };

    for (const [key, channel] of Object.entries<any>(doc.channels)) {
      const name = channel?.address ?? key; // v3 names the resource in `address`; v2 uses the channel key
      if (channel?.messages) Object.values<any>(channel.messages).forEach((m) => collect(name, m)); // v3
      for (const op of ['publish', 'subscribe']) { // v2
        const msg = channel?.[op]?.message;
        if (!msg) continue;
        if (Array.isArray(msg.oneOf)) msg.oneOf.forEach((m: any) => collect(name, m));
        else collect(name, msg);
      }
    }

    for (const [channel, messages] of byChannel) {
      if (!messages.length) continue;
      result.nodes.push({ id: normalizeId(channel), kind: 'topic', messages, sources: ['asyncapi'] });
    }
  }
  return result;
};
