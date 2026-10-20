/**
 * Setup View — top-level container for the Setup wizard.
 * Renders a 4-step wizard inside the Chat UI single window.
 */
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import * as ipc from "../../data/ipc-bridge.ts";
import type { DetectionResult } from "../../data/ipc-bridge.ts";
import {t} from "../../i18n.ts";
import {createSetupFlow,detectSetup} from "./setup-flow.ts";
import { renderStep0 } from "./setup-step0-conflict.ts";
import { renderStep1 } from "./setup-step1-welcome.ts";
import { renderStep2 } from "./setup-step2-provider.ts";
import { renderStep3 } from "./setup-step3-done.ts";

/* ── module-level state ── */

const setupState={...createSetupFlow(),initialized:false};

/* ── init: detect conflict to decide starting step ── */

async function init(state: AppViewState,force=false) {
  if (setupState.initialized && !force) return;
  setupState.initialized = true;
  await detectSetup(setupState,ipc.detectInstallation,()=>state.requestUpdate());
  focusStep(state);
}

/* ── navigation ── */

function goToStep(step: number, state: AppViewState) {
  setupState.currentStep = step;
  state.requestUpdate();
  focusStep(state);
}

function focusStep(state:AppViewState){void state.updateComplete.then(()=>{
  const body=document.querySelector<HTMLElement>(".oc-setup-step-body");if(body)body.scrollTop=0;
  const heading=document.querySelector<HTMLElement>(".oc-setup-step h2, .oc-setup-detect h2");
  if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}
});}

/* ── render entry point ── */

export function renderSetupView(state: AppViewState) {
  if (!setupState.initialized) init(state);

  const step = setupState.currentStep;
  const steps=["check","welcome","connect","finish"];

  return html`
    <div class="oc-setup-container ${step === 2 ? 'oc-setup-container--step2' : ''}">
      ${step >= 0 ? html`
        <ol class="oc-setup-progress" aria-label=${t("setup.progress.label")}>
          ${steps.map((name,i) => html`
            <li class="oc-setup-progress-item" aria-current=${i===step?"step":nothing}>
              <span aria-hidden="true" class="oc-setup-progress-dot ${i < step ? 'oc-setup-progress-dot--done' : i === step ? 'oc-setup-progress-dot--active' : ''}"></span>
              <span>${t(`setup.progress.${name}`)}</span>
            </li>
          `)}
        </ol>
      ` : nothing}

      ${step === -1 ? html`<section class="oc-setup-detect" aria-busy=${setupState.detecting?"true":"false"}>
        <h2 class="oc-setup-title">${t("setup.detect.title")}</h2>
        ${setupState.detectError?html`<p role="alert">${t("setup.detect.failed")}</p><button class="btn primary" @click=${()=>void init(state,true)}>${t("setup.detect.retry")}</button>`:html`<div role="status"><span class="oc-setup-spinner" aria-hidden="true"></span> ${t("setup.detect.loading")}</div>`}
      </section>` : nothing}
      ${step === 0 ? renderStep0(state, setupState.conflictResult!, (s) => goToStep(s, state)) : nothing}
      ${step === 1 ? renderStep1(state, (s) => goToStep(s, state)) : nothing}
      ${step === 2 ? renderStep2(state, (s) => goToStep(s, state)) : nothing}
      ${step === 3 ? renderStep3(state) : nothing}
    </div>
  `;
}
