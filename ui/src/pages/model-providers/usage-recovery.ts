import type { ReactiveController, ReactiveControllerHost } from "lit";

/**
 * Retries a failed `usage.status` when the operator returns to the tab.
 *
 * The page's reload check only recovers on a connection transition, so a usage
 * failure while the Gateway stays connected would leave the cards empty until a
 * manual Refresh. Returning to the tab is the natural retry point; the host
 * owns the guard so a healthy payload never refetches.
 */
export class ModelProvidersUsageRecovery implements ReactiveController {
  constructor(
    host: ReactiveControllerHost,
    private readonly options: { canRecover: () => boolean; recover: () => void },
  ) {
    host.addController(this);
  }

  private readonly handleActivation = () => {
    // `focus` can fire while the document is still hidden, so check both.
    if (document.hidden || !this.options.canRecover()) {
      return;
    }
    this.options.recover();
  };

  hostConnected(): void {
    document.addEventListener("visibilitychange", this.handleActivation);
    globalThis.addEventListener("focus", this.handleActivation);
  }

  hostDisconnected(): void {
    document.removeEventListener("visibilitychange", this.handleActivation);
    globalThis.removeEventListener("focus", this.handleActivation);
  }
}
