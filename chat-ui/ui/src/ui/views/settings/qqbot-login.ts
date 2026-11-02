/** Renderer lifecycle only. Credentials are persisted by the main-process owner. */
export interface QqbotLoginResult {
  attemptId: string;
  status: "waiting" | "connected" | "expired" | "error" | "canceled";
  qrDataUrl?: string;
  message: string;
  accounts?: Array<{ accountId: string; appId: string; name?: string }>;
}

export interface QqbotLoginState {
  status: QqbotLoginResult["status"] | "idle" | "starting";
  qrDataUrl: string;
  message: string;
}

interface LoginDependencies {
  start: () => Promise<QqbotLoginResult>;
  wait: (params: { attemptId: string }) => Promise<QqbotLoginResult>;
  cancel: (params: { attemptId: string }) => Promise<unknown>;
  onChange: (state: QqbotLoginState) => void;
  onConnected: (result: QqbotLoginResult, isCurrent: () => boolean) => Promise<void>;
  schedule?: (fn: () => void) => () => void;
}

export class QqbotLoginController {
  state: QqbotLoginState = { status: "idle", qrDataUrl: "", message: "" };
  private generation = 0;
  private attemptId = "";
  private clearTimer?: () => void;
  constructor(private readonly deps: LoginDependencies) {}

  cancel(): void {
    ++this.generation;
    this.clearTimer?.(); this.clearTimer = undefined;
    const id = this.attemptId; this.attemptId = "";
    if (id) void this.deps.cancel({ attemptId: id }).catch(() => {});
    this.update({ status: "idle", qrDataUrl: "", message: "" });
  }

  async start(): Promise<void> {
    this.cancel();
    const generation = this.generation;
    this.update({ status: "starting", qrDataUrl: "", message: "" });
    try {
      const result = await this.deps.start();
      if (generation !== this.generation) {
        void this.deps.cancel({ attemptId: result.attemptId }).catch(() => {});
        return;
      }
      this.attemptId = result.attemptId;
      await this.accept(result, generation);
    } catch (error) { this.fail(error, generation); }
  }

  private update(state: QqbotLoginState) { this.state = state; this.deps.onChange(state); }

  private async accept(result: QqbotLoginResult, generation: number): Promise<void> {
    if (generation !== this.generation || result.attemptId !== this.attemptId) return;
    const qrDataUrl = result.qrDataUrl && /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,/.test(result.qrDataUrl)
      ? result.qrDataUrl : this.state.qrDataUrl;
    this.update({ status: result.status, qrDataUrl: result.status === "waiting" ? qrDataUrl : "", message: result.message });
    if (result.status === "connected") {
      this.attemptId = "";
      await this.deps.onConnected(result, () => generation === this.generation);
    } else if (result.status === "waiting") {
      const schedule = this.deps.schedule ?? ((fn: () => void) => { const timer = setTimeout(fn, 1000); return () => clearTimeout(timer); });
      this.clearTimer = schedule(() => {
        this.clearTimer = undefined;
        if (generation !== this.generation) return;
        // Schedule the next poll only after this promise settles.
        void this.deps.wait({ attemptId: this.attemptId })
          .then(next => this.accept(next, generation))
          .catch(error => this.fail(error, generation));
      });
    } else {
      this.attemptId = "";
    }
  }

  private fail(error: unknown, generation: number): void {
    if (generation !== this.generation) return;
    const id = this.attemptId; this.attemptId = "";
    if (id) void this.deps.cancel({ attemptId: id }).catch(() => {});
    this.update({ status: "error", qrDataUrl: "", message: error instanceof Error ? error.message : String(error) });
  }
}
