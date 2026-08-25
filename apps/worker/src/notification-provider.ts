export interface StatusNotification {
  idempotencyKey: string;
  recipient: string;
  customerName: string;
  applicationId: string;
  status: string;
  reason?: string | null;
}

export interface NotificationSender {
  sendStatusUpdate(notification: StatusNotification): Promise<void>;
}

export class MockEmailProvider implements NotificationSender {
  /**
   * Keys the provider has already accepted. A real provider keeps this
   * server-side; here it stands in for that behaviour so the worker can be
   * stopped between the provider accepting a request and local state being
   * recorded without the customer receiving a second email.
   */
  private readonly acceptedKeys = new Set<string>();

  async sendStatusUpdate(notification: StatusNotification): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 75));

    if (notification.recipient.endsWith("@retry.invalid")) {
      throw new Error("mock provider is temporarily unavailable");
    }

    if (this.acceptedKeys.has(notification.idempotencyKey)) {
      console.info(
        `[email] skipped duplicate ${notification.idempotencyKey} for ${notification.applicationId}`,
      );
      return;
    }

    this.acceptedKeys.add(notification.idempotencyKey);

    console.info(
      `[email] sent ${notification.status} update for ${notification.applicationId} to ${notification.recipient}`,
    );
  }
}
