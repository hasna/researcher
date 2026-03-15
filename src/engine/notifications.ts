/**
 * Notification hooks — fire webhooks on cycle events.
 */

export interface NotificationConfig {
  webhook_url?: string
  slack_webhook?: string
}

export interface NotificationPayload {
  event: "cycle_complete" | "cycle_failed" | "knowledge_discovered" | "budget_exceeded"
  project?: string
  workspace?: string
  summary: string
  cost?: number
  timestamp: string
}

/**
 * Send a notification to configured webhooks.
 */
export async function notify(config: NotificationConfig, payload: NotificationPayload): Promise<void> {
  const promises: Promise<void>[] = []

  if (config.webhook_url) {
    promises.push(
      fetch(config.webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then(() => {}).catch(() => {}),
    )
  }

  if (config.slack_webhook) {
    const slackPayload = {
      text: `*[researcher]* ${payload.event}: ${payload.summary}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${payload.event}*\n${payload.summary}${payload.cost ? `\nCost: $${payload.cost.toFixed(4)}` : ""}`,
          },
        },
      ],
    }
    promises.push(
      fetch(config.slack_webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(slackPayload),
      }).then(() => {}).catch(() => {}),
    )
  }

  await Promise.allSettled(promises)
}
