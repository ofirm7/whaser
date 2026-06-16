# Whaser

**A WhatsApp agent creation system driven by AI.**

Whaser lets you design, configure, and deploy AI-powered conversational agents
that operate over WhatsApp — without hand-wiring every flow. Describe what you
want the agent to do, and Whaser handles the messaging plumbing, conversation
state, and AI reasoning behind it.

> 🚧 **Status:** early development. The repository currently contains project
> scaffolding only. APIs and structure are subject to change.

## What it does

- **Agent builder** — create WhatsApp agents from natural-language descriptions
  of their purpose, tone, and capabilities.
- **AI-driven conversations** — agents reason over incoming messages using an
  LLM and respond in context, with memory across a conversation.
- **Tooling / actions** — let agents take actions (look something up, book,
  notify, hand off to a human) via pluggable tools.
- **Multi-agent management** — run and manage multiple distinct agents from one
  system.

## Planned architecture

| Layer            | Responsibility                                              |
| ---------------- | ----------------------------------------------------------- |
| WhatsApp gateway | Send/receive messages (WhatsApp Web protocol or Cloud API). |
| Agent runtime    | Conversation state, routing, and turn handling.             |
| AI core          | LLM-driven reasoning, prompting, and tool/function calling. |
| Builder          | Define and configure agents from high-level specs.          |

## Getting started

```bash
git clone https://github.com/ofirm7/whaser.git
cd whaser
# setup instructions coming soon
```

## Roadmap

- [ ] WhatsApp connection layer
- [ ] Core agent runtime and conversation state
- [ ] AI reasoning + tool-calling integration
- [ ] Agent definition / builder interface
- [ ] Persistence and multi-agent management
- [ ] Deployment tooling

## License

To be determined.
