import type { ApplicationStatus, ApplicationView } from "@assessment/contracts";

const apiUrl = process.env.API_URL ?? "http://127.0.0.1:3001";
const demoCustomerId = process.env.DEMO_CUSTOMER_ID ?? "cus_amina_001";

/** Signals an application the current customer cannot see, or that is absent. */
export class ApplicationNotVisibleError extends Error {
  constructor() {
    super("Application is not available for this customer");
    this.name = "ApplicationNotVisibleError";
  }
}

export async function fetchApplication(
  applicationId: string,
): Promise<ApplicationView> {
  let response: Response;

  try {
    response = await fetch(
      `${apiUrl}/v1/applications/${encodeURIComponent(applicationId)}`,
      {
        cache: "no-store",
        headers: { "x-customer-id": demoCustomerId },
        signal: AbortSignal.timeout(5_000),
      },
    );
  } catch {
    // The API being unreachable or slow is an availability problem, not a
    // missing application. Surfaced separately so the page can say so.
    throw new Error("The application service is unavailable. Please try again.");
  }

  // 404 and 401 are deliberately indistinguishable at the API, so both become
  // the same "not visible" outcome here.
  if (response.status === 404 || response.status === 401) {
    throw new ApplicationNotVisibleError();
  }

  if (!response.ok) {
    throw new Error(`Application request failed with ${response.status}`);
  }

  return (await response.json()) as ApplicationView;
}

export function formatStatus(status: ApplicationStatus): string {
  return status
    .toLowerCase()
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}
