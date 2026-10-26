# Assistant system prompt

_Phase 5 deliverable. The full prompt is authored there and mirrored verbatim into
`vapi/assistant.json` (`model.messages[0].content`)._

Placeholders resolved at build time: `{{WORKSHOP_NAME}}`, `{{TRANSFER_PHONE_NUMBER}}`,
`{{AFTER_HOURS_MESSAGE}}`, `{{CANCELLATION_POLICY_TEXT}}`, `{{AGENT_NAME}}`.

Behaviour is summarised in [../docs/call-flow.md](../docs/call-flow.md); the prompt
implements that document and adds no business values of its own.
