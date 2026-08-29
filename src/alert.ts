// src/alert.ts

const RETRY_DELAY_MS = 2000;

async function postToSlack(webhookUrl: string, message: string): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Slack webhook responded ${res.status}: ${text.slice(0, 500)}`);
  }
}

/**
 * Fire-and-forget from every call site (never awaited) -- this function never
 * throws or rejects, so no call site needs its own try/catch or .catch(). On
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
    console.error('[alert] first attempt failed, retrying once:', firstErr);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    try {
      await postToSlack(webhookUrl, message);
    } catch (secondErr) {
      console.error('[alert] retry also failed, giving up:', secondErr);
    }
  }
}
