import {html,nothing} from 'lit';
import type {ChatProps} from './chat.ts';
import {renderCompose,renderGoalBanner,renderGoalForm} from './chat-compose.ts';
import {computeStopButtonVisible} from './chat-stop-button-gate.ts';
import {resolveModelSelectKey} from '../controllers/models.ts';
import {getLocale,t} from '../i18n.ts';
import type {DashboardComposeTarget} from '../dashboard-selection.ts';

export function dashboardMessage(draft:string,boardId:string,title:string,target:DashboardComposeTarget={}):string{
  const selection=target.selection,metadata={title,description:target.description??'',...selection?{selection}:{} };
  return `${draft.trim()||t('dashboard.defaultPrompt')}\n\n[cryoclaw-dashboard-target]\nboardId=${boardId}\n${selection?`cardId=${selection.cardId}\n`:''}Board context (JSON): ${JSON.stringify(metadata)}\nUse cryoclaw_dashboard. Read this board before edits; preserve other cards, local state and layout.${selection?' Use read_card for this card, locate the selected element by its selector and text, and limit changes to the requested target. Do not replace the whole board.':''}\n[/cryoclaw-dashboard-target]`;
}
/** Same composer, model selection, attachments, IME and stop semantics as Chat. */
export function renderDashboardCompose(props:ChatProps,boardId:string,title:string,onOpenChat?:()=>void,target:DashboardComposeTarget={}){
  const activeSession=props.sessions?.sessions?.find(row=>row.key===props.sessionKey),raw=activeSession?.model;
  const {isBusy,showStop}=computeStopButtonVisible(props);
  const send=(draft=props.draft)=>props.onSend(dashboardMessage(draft,boardId,title,target),draft);
  return html`${renderGoalBanner(props)}${renderGoalForm(props)}<div class="dashboard-compose__context"><span>${isBusy?t('dashboard.designing'):title}</span><button type="button" @click=${onOpenChat}>${t('dashboard.openConversation')}</button></div>
    ${target.selection?html`<div class="dashboard-compose__selection" role="status"><div><strong>${t('dashboard.selectionTarget')} · ${target.selection.cardTitle}</strong><span>${target.selection.selector?`${target.selection.tagName} · ${target.selection.text||target.selection.selector}`:t('dashboard.wholeCard')}</span></div><button type="button" aria-label=${t('dashboard.clearSelection')} title=${t('dashboard.clearSelection')} @click=${target.onClearSelection}>×</button></div>`:nothing}
    ${props.error?html`<p class="dashboard-compose__error" role="status">${props.error}</p>`:nothing}
    ${renderCompose({...props,onSend:()=>send(),onGoalCommand:send},{activeSession,composePlaceholder:props.connected?t('dashboard.modelPrompt'):t('chat.placeholder.starting'),modelSelectValue:raw?(resolveModelSelectKey(raw,props.configuredModels??[])??raw):(props.currentModel||null),isBusy,showStop,allowEmptySend:true})}
    <p class="dashboard-compose__hint">${getLocale().startsWith('zh')?'沿用当前对话的模型、附件与权限设置 · 制作结果直接呈现在看板':'Uses this conversation’s model, attachments and permissions · Results appear on the board'}</p>`;
}
