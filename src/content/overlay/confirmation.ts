/**
 * @file src/content/overlay/confirmation.ts
 * @description In-page confirmation dialog for high-risk (R3/R4) actions.
 *
 * SRS IR-UI-05 requirements:
 * - role="alertdialog"
 * - Focus-trapped inside the dialog
 * - Keyboard operable: Enter = confirm, Escape = cancel
 * - Announced to screen readers via aria-live
 * - Mirrored by TTS (handled in offscreen)
 * - Shows action summary and target element
 */

import type { AgentPlan } from "@shared/types.js";
import { RiskTier } from "@shared/types.js";

/** Risk tier labels for display. */
const RISK_LABELS: Record<number, { label: string; color: string }> = {
  [RiskTier.R3]: { label: "High Risk", color: "#f59e0b" },
  [RiskTier.R4]: { label: "Critical — Irreversible", color: "#ef4444" },
};

/**
 * ConfirmationDialog renders a modal-style dialog inside the shadow root.
 * Returns a Promise<boolean> that resolves on user interaction.
 */
export class ConfirmationDialog {
  private dialogEl: HTMLElement | null = null;
  private styleEl: HTMLStyleElement | null = null;
  private resolveConfirmation: ((confirmed: boolean) => void) | null = null;

  constructor(private readonly shadowRoot: ShadowRoot) {
    this.injectStyles();
  }

  /**
   * Show the confirmation dialog for a plan.
   * Resolves when the user confirms or cancels.
   *
   * @param plan - The plan awaiting confirmation.
   * @returns true = confirmed, false = cancelled.
   */
  show(plan: AgentPlan): Promise<boolean> {
    this.dismiss();

    return new Promise<boolean>((resolve) => {
      this.resolveConfirmation = resolve;

      const riskInfo = RISK_LABELS[plan.risk] ?? { label: "Confirm", color: "#6366f1" };

      const dialog = document.createElement("div");
      dialog.id = "vp-confirmation";
      dialog.setAttribute("role", "alertdialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-label", "VoxPilot action confirmation");
      dialog.setAttribute("aria-describedby", "vp-confirm-desc");
      dialog.setAttribute("tabindex", "-1");

      dialog.innerHTML = `
        <div class="vp-confirm-backdrop"></div>
        <div class="vp-confirm-card" role="document">
          <div class="vp-confirm-risk-badge" style="background:${riskInfo.color}">
            ${riskInfo.label}
          </div>
          <h2 class="vp-confirm-title">Confirm Action</h2>
          <p class="vp-confirm-intent" id="vp-confirm-desc">${this.escapeHtml(plan.intent)}</p>
          <div class="vp-confirm-actions-list">
            ${plan.actions
              .filter((a) => a.type !== "done")
              .slice(0, 5)
              .map((a) => `<div class="vp-confirm-action-item">• ${this.describeAction(a)}</div>`)
              .join("")}
            ${plan.actions.length > 6 ? `<div class="vp-confirm-action-item vp-muted">…and ${plan.actions.length - 5} more</div>` : ""}
          </div>
          <div class="vp-confirm-buttons">
            <button class="vp-btn vp-btn-cancel" id="vp-btn-cancel" type="button">
              Cancel <kbd>Esc</kbd>
            </button>
            <button class="vp-btn vp-btn-confirm" id="vp-btn-confirm" type="button" autofocus>
              Confirm <kbd>Enter</kbd>
            </button>
          </div>
        </div>
      `;

      dialog.querySelector("#vp-btn-confirm")?.addEventListener("click", () => this.resolve(true));
      dialog.querySelector("#vp-btn-cancel")?.addEventListener("click", () => this.resolve(false));

      // Keyboard handler
      dialog.addEventListener("keydown", (e: Event) => {
        const ke = e as KeyboardEvent;
        if (ke.key === "Enter") { e.preventDefault(); this.resolve(true); }
        if (ke.key === "Escape") { e.preventDefault(); this.resolve(false); }
        // Focus trap — keep focus inside dialog
        if (ke.key === "Tab") { this.trapFocus(ke, dialog); }
      });

      this.shadowRoot.appendChild(dialog);
      this.dialogEl = dialog;

      // Focus the confirm button
      requestAnimationFrame(() => {
        dialog.querySelector<HTMLElement>("#vp-btn-confirm")?.focus();
      });
    });
  }

  /** Dismiss the dialog without resolving (cleanup). */
  dismiss(): void {
    this.dialogEl?.remove();
    this.dialogEl = null;
    this.resolveConfirmation = null;
  }

  private resolve(confirmed: boolean): void {
    this.resolveConfirmation?.(confirmed);
    this.dismiss();
  }

  /**
   * Keep Tab key focus inside the dialog (accessibility requirement).
   */
  private trapFocus(e: KeyboardEvent, dialog: HTMLElement): void {
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")
    );
    if (focusable.length === 0) return;

    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  /** Produce a human-readable description of an action for the confirmation UI. */
  private describeAction(action: { type: string; [key: string]: unknown }): string {
    switch (action.type) {
      case "click":         return `Click "${action["label"] ?? action["handle"]}"`;
      case "type":          return `Type "${String(action["text"]).slice(0, 40)}" into ${action["handle"]}`;
      case "select":        return `Select "${action["option"]}"`;
      case "navigate":      return `Navigate to ${action["url"]}`;
      case "tab":           return `Tab: ${action["operation"]}`;
      case "fill_from_vault": return `Fill ${action["handle"]} from vault`;
      default:              return action.type;
    }
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  private injectStyles(): void {
    this.styleEl = document.createElement("style");
    this.styleEl.textContent = `
      #vp-confirmation {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: all;
      }

      .vp-confirm-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        backdrop-filter: blur(2px);
      }

      .vp-confirm-card {
        position: relative;
        background: #fff;
        border-radius: 12px;
        padding: 24px;
        max-width: 420px;
        width: calc(100% - 48px);
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        z-index: 1;
      }

      @media (prefers-color-scheme: dark) {
        .vp-confirm-card {
          background: #1e293b;
          color: #f1f5f9;
        }
        .vp-confirm-action-item { color: #94a3b8; }
        .vp-confirm-intent { color: #cbd5e1; }
      }

      .vp-confirm-risk-badge {
        display: inline-block;
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 2px 10px;
        border-radius: 20px;
        margin-bottom: 12px;
      }

      .vp-confirm-title {
        font-size: 18px;
        font-weight: 700;
        margin: 0 0 8px;
        color: inherit;
      }

      .vp-confirm-intent {
        font-size: 14px;
        color: #475569;
        margin: 0 0 16px;
        line-height: 1.5;
      }

      .vp-confirm-actions-list {
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        padding: 10px 14px;
        margin-bottom: 20px;
        font-size: 13px;
      }

      @media (prefers-color-scheme: dark) {
        .vp-confirm-actions-list {
          background: #0f172a;
          border-color: #334155;
        }
      }

      .vp-confirm-action-item { margin: 4px 0; color: #64748b; }
      .vp-muted { font-style: italic; }

      .vp-confirm-buttons {
        display: flex;
        gap: 10px;
        justify-content: flex-end;
      }

      .vp-btn {
        padding: 8px 20px;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        border: 2px solid transparent;
        transition: all 0.15s;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .vp-btn:focus-visible {
        outline: 3px solid #2563eb;
        outline-offset: 2px;
      }

      .vp-btn-cancel {
        background: transparent;
        border-color: #e2e8f0;
        color: #64748b;
      }

      .vp-btn-cancel:hover { background: #f1f5f9; }

      .vp-btn-confirm {
        background: #2563eb;
        color: #fff;
      }

      .vp-btn-confirm:hover { background: #1d4ed8; }

      kbd {
        font-size: 10px;
        background: rgba(255,255,255,0.2);
        border-radius: 3px;
        padding: 1px 4px;
        font-family: monospace;
      }

      .vp-btn-cancel kbd { background: rgba(0,0,0,0.08); color: inherit; }
    `;
    this.shadowRoot.appendChild(this.styleEl);
  }
}

