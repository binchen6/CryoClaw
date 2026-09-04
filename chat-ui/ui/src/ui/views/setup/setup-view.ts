/**
 * Setup View — top-level container for the Setup wizard.
 * Renders a 4-step wizard inside the Chat UI single window.
 */
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import * as ipc from "../../data/ipc-bridge.ts";
import type { DetectionResult } from "../../data/ipc-bridge.ts";
import { renderStep0 } from "./setup-step0-conflict.ts";
import { renderStep1 } from "./setup-step1-welcome.ts";
import { renderStep2 } from "./setup-step2-provider.ts";
import { renderStep3 } from "./setup-step3-done.ts";

/* ── module-level state ── */

const setupState = {
  currentStep: -1, // -1 = detecting, 0..3 = steps
  conflictResult: null as DetectionResult | null,
  initialized: false,
};

/* ── init: detect conflict to decide starting step ── */

async function init(state: AppViewState) {
  if (setupState.initialized) return;
  setupState.initialized = true;
  try {
    const result = await ipc.detectInstallation();
    if (result.portInUse || result.globalInstalled) {
      setupState.conflictResult = result;
      setupState.currentStep = 0;
    } else {
      setupState.currentStep = 1;
    }
  } catch {
    setupState.currentStep = 1;
  }
  state.requestUpdate();
}

/* ── navigation ── */

function goToStep(step: number, state: AppViewState) {
  setupState.currentStep = step;
  state.requestUpdate();
}

/* ── render entry point ── */

export function renderSetupView(state: AppViewState) {
  if (!setupState.initialized) init(state);

  const step = setupState.currentStep;
  const totalSteps = 4;

  return html`
    <div class="oc-setup-container ${step === 2 ? 'oc-setup-container--step2' : ''}">
      ${step >= 0 ? html`
        <div class="oc-setup-progress">
          ${[0, 1, 2, 3].map(i => html`
            <div class="oc-setup-progress-dot ${i < step ? 'oc-setup-progress-dot--done' : i === step ? 'oc-setup-progress-dot--active' : ''}"></div>
          `)}
        </div>
      ` : nothing}

      ${step === -1 ? html`<div class="oc-setup-spinner oc-setup-spinner--lg"></div>` : nothing}
      ${step === 0 ? renderStep0(state, setupState.conflictResult!, (s) => goToStep(s, state)) : nothing}
      ${step === 1 ? renderStep1(state, (s) => goToStep(s, state)) : nothing}
      ${step === 2 ? renderStep2(state, (s) => goToStep(s, state)) : nothing}
      ${step === 3 ? renderStep3(state) : nothing}
    </div>
  `;
}
