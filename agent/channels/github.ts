import { defineChannel, POST } from "eve/channels";
import { config, required, repositoryAllowed } from "@/config";
import { createGitHub } from "@/github";
import { parseEvent, verifySignature } from "@/webhook";

export default defineChannel({
  turnPolicy: "queue",
  routes: [
    POST("/webhooks/github", async (request, { from }) => {
      const raw = Buffer.from(await request.arrayBuffer());

      const signatureValid = await verifySignature(
        raw,
        request.headers.get("x-hub-signature-256"),
        required("GITHUB_WEBHOOK_SECRET"),
      );

      if (!signatureValid) {
        return new Response("Invalid signature", { status: 401 });
      }

      const delivery = request.headers.get("x-github-delivery");

      if (!delivery) {
        return new Response("Invalid delivery ID", { status: 400 });
      }

      const eventName = request.headers.get("x-github-event") ?? "";

      if (eventName === "ping") {
        return Response.json({ ok: true });
      }

      let event;

      try {
        event = parseEvent(eventName, raw.toString("utf8"));
      } catch {
        return new Response("Invalid event payload", { status: 400 });
      }

      if (!event) {
        return Response.json({ ignored: true });
      }

      if (!repositoryAllowed(event.repository, config())) {
        return new Response("Repository not allowed", { status: 403 });
      }

      // GitHub sometimes omits PR associations on check events, especially forks.
      const numbers = event.numbers.length
        ? event.numbers
        : event.sha
          ? await createGitHub({ repository: event.repository }).prsForCommit(
              event.repository,
              event.sha,
            )
          : [];

      const sessions = await Promise.all(
        [...new Set(numbers)].map(async (number) => {
          const session = await from(`${event.repository}#${number}`).send(
            "Evaluate the verified pull request with review-pull-request.",
            {
              auth: {
                authenticator: "github-webhook",
                principalType: "service",
                principalId: event.repository,
                attributes: { repository: event.repository, number: String(number), delivery },
              },
            },
          );

          return session.id;
        }),
      );

      // Await durable acceptance; never run the merge in a detached HTTP promise.
      return Response.json({ accepted: true, sessions }, { status: 202 });
    }),
  ],
});
