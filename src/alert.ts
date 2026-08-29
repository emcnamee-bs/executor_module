// src/alert.ts

const RETRY_DELAY_MS = 2000;

/**
 * Ceiling on a single Slack POST, matching kalshiClient.ts's own
 * `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` convention. Undici's default
 * headersTimeout is 300 SECONDS: without this, one hung Slack connection keeps a
 * fire-and-forget request (which nothing awaits and nothing can cancel) alive for
 * up to five minutes, holding the Node event loop open past a clean shutdown.
 */
const ALERT_TIMEOUT_MS = 5000;

/**
 * A non-2xx response from Slack. Its message is built HERE, from the status and
 * the response body, so it is known not to carry the webhook URL -- which is what
 * lets `describeAlertError` log it in full while withholding every other error's
 * message.
 */
class SlackResponseError extends Error {}

/**
 * Renders a caught error for a log line without ever risking the webhook URL
 * ending up in it. `fetch()` against a malformed SLACK_WEBHOOK_URL throws a
 * TypeError whose MESSAGE embeds the full attempted URL, and a Slack incoming
 * webhook is a bearer-equivalent secret; this project's credential-hygiene rule is
 * absolute rather than risk-proportional (CLAUDE.md, HANDOFF §2), so a narrow
 * misconfiguration path is not an exemption. Only the error's type is logged --
 * except for SlackResponseError, whose message this file constructed itself.
 */
function describeAlertError(err: unknown): string {
  if (err instanceof SlackResponseError) return err.message;
  if (err instanceof Error) return `${err.name} (message withheld: it can embed SLACK_WEBHOOK_URL)`;
  return typeof err;
}

async function postToSlack(webhookUrl: string, message: string): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
    signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new SlackResponseError(`Slack webhook responded ${res.status}: ${text.slice(0, 500)}`);
  }
}

/**
 * Fire-and-forget from every call site except the startup unclean-exit alert
 * in main.ts (see the comment there for why that one is deliberately
 * awaited) -- this function never throws or rejects regardless, so no call
 * site needs its own try/catch or .catch(). On
 * failure, waits RETRY_DELAY_MS and tries once more; if that also fails, logs
 * loudly and gives up. Reads SLACK_WEBHOOK_URL from the environment at CALL
 * time (not import time) so tests can freely set/unset it per-case; if unset,
 * this is a logged no-op, so local dev and the test suite never need a real
 * webhook configured.
 */
export async function sendAlert(message: string): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('[alert] SLACK_WEBHOOK_URL is not set -- alert not sent:', message);
    return;
  }

  try {
    await postToSlack(webhookUrl, message);
  } catch (firstErr) {
    console.error('[alert] first attempt failed, retrying once:', describeAlertError(firstErr));
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    try {
      await postToSlack(webhookUrl, message);
    } catch (secondErr) {
      console.error('[alert] retry also failed, giving up:', describeAlertError(secondErr));
    }
  }
}
