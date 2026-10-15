import { defineChannel, POST } from 'eve/channels';
import { config, required } from '../../src/config.js';
import { createGitHub } from '../../src/github.js';
import { parseEvent, verifySignature } from '../../src/webhook.js';

export default defineChannel({
  turnPolicy: 'queue',
  routes: [POST('/webhooks/github', async (request, { from }) => {
    // Bound actual streamed bytes, not only the caller-provided Content-Length.
    const reader = request.body?.getReader();
    if (!reader) return new Response('Missing body', { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 2_000_000) { await reader.cancel(); return new Response('Payload too large', { status: 413 }); }
      chunks.push(part.value);
    }
    const raw = Buffer.concat(chunks);
    if (!verifySignature(raw, request.headers.get('x-hub-signature-256'), required('GITHUB_WEBHOOK_SECRET'))) return new Response('Invalid signature', { status: 401 });
    const delivery = request.headers.get('x-github-delivery');
    if (!delivery || !/^[\w-]{1,128}$/.test(delivery)) return new Response('Invalid delivery ID', { status: 400 });
    const eventName = request.headers.get('x-github-event') || '';
    if (eventName === 'ping') return Response.json({ ok: true });
    let event;
    try { event = parseEvent(eventName, JSON.parse(raw.toString('utf8'))); }
    catch { return new Response('Invalid event payload', { status: 400 }); }
    if (!event) return Response.json({ ignored: true });
    if (!config().repositories.has(event.repository)) return new Response('Repository not allowed', { status: 403 });
    // GitHub sometimes omits PR associations on check events, especially forks.
    const numbers = event.numbers.length ? event.numbers : event.sha ? await createGitHub().prsForCommit(event.repository, event.sha) : [];
    const sessions: string[] = [];
    for (const number of new Set(numbers)) {
      const session = await from(`${event.repository}#${number}`).send('Evaluate the verified pull request with review_pull_request.', {
        auth: {
          authenticator: 'github-webhook', principalType: 'service', principalId: event.repository,
          attributes: { repository: event.repository, number: String(number), delivery },
        },
      });
      sessions.push(session.id);
    }
    // Await durable acceptance; never run the merge in a detached HTTP promise.
    return Response.json({ accepted: true, sessions }, { status: 202 });
  })],
});
