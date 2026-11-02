'use strict';

// Code mode may invoke a discovered local function and wrap its output as untrusted
// text. Native desktop events and DOM effects prove execution; model code is intent.
function browserAgentEvidence(messages, nonce, agentCommands) {
  const rows = Array.isArray(messages) ? messages : [];
  const calls = rows.filter(m => m.role === 'assistant').flatMap(m => Array.isArray(m.content)
    ? m.content.filter(c => ['toolCall', 'tool_use'].includes(c.type)) : []);
  const paired = calls.filter(c => typeof c.id === 'string' && rows.some(m =>
    ['toolResult', 'tool'].includes(m.role) && !m.isError &&
    (m.toolCallId ?? m.tool_call_id) === c.id && m.toolName === c.name));
  const direct = paired.some(c => c.name === 'cryoclaw_browser');
  const codeMode = paired.some(c => c.name === 'exec' || c.name === 'wait');
  const errors = rows.filter(m => m.stopReason === 'error').map(m => m.errorMessage || 'provider error');
  const reply = rows.some(m => m.role === 'assistant' && ['stop', 'end_turn'].includes(m.stopReason) &&
    (typeof m.content === 'string' ? m.content : Array.isArray(m.content)
      ? m.content.filter(c => c.type === 'text').map(c => c.text || '').join('') : '').includes(nonce));
  return { errors, direct, codeMode, reply, agentCommands,
    accepted: !errors.length && (direct || codeMode) && reply && agentCommands >= 3 };
}

module.exports = { browserAgentEvidence };
