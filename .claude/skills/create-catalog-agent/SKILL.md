---
name: create-catalog-agent
description: Author a new prebuilt agent for the Whaser global agents-catalog. Use when the developer wants to add a ready-to-deploy agent that users can pick from the Catalog tab. Interviews the developer, assembles a schema-valid AgentSpec plus catalog metadata, writes apps/web/catalog/<id>.json, and validates it.
---

# Create a catalog agent

You are helping the developer add a curated, **deploy-as-is** agent to the Whaser global
agents-catalog. The result is a single committed seed file at `apps/web/catalog/<id>.json` that the
server loads at startup and shows in the **Catalog** tab. Users deploy it unchanged into their tenant.

## What you produce

One JSON file shaped as a `CatalogEntry` (see `apps/web/src/store.ts`):

```jsonc
{
  "id": "<kebab-case, equals the filename stem, unique>",
  "title": "<short display name>",
  "description": "<one line shown on the catalog card>",
  "category": "<grouping label, e.g. Support, Sales, Hospitality>",
  "icon": "<optional emoji>",
  "spec": { /* a complete AgentSpec — all 17 required fields below */ }
}
```

The `spec` must satisfy `schemas/agent-spec.schema.json`. Use
`packages/agent-builder/test/fixtures.ts` (`validSpec`) as the canonical template to copy and adapt.
`additionalProperties` is `false` everywhere — do **not** add keys that aren't in the schema.

### Required AgentSpec fields
`version` (integer, start at 1), `agent_name`, `brand_persona` {`tone`, `style_notes`}, `goal`,
`in_scope_topics` (array), `out_of_scope_topics` (array, **disjoint** from in-scope), `refusal_policy`,
`escalation_rules` (array of {`when`, `action`}), `tools` (array), `sub_agents` (array),
`workflow` {`mode`: `single`|`router`, `routes`, `on_no_match`: `default`|`handoff`},
`knowledge_sources` (array of {`type`, `label`, `content`}), `default_language` (BCP-47, e.g. `en`),
`greeting`, `fallback_message`,
`model_assignment` (one of `claude-sonnet-4-6` | `claude-opus-4-8` | `claude-haiku-4-5`),
`needs_sandbox` (boolean).

## Steps

1. **List existing entries** with `ls apps/web/catalog/` so you pick a unique `id` and avoid clashes.

2. **Interview the developer.** Ask, in order (one focused question at a time, propose sensible
   defaults so they can just confirm):
   - Purpose / `goal` (the single outcome the agent drives toward) and `agent_name`.
   - `brand_persona`: `tone` (e.g. friendly, formal, terse) and `style_notes`.
   - `in_scope_topics` vs `out_of_scope_topics` — these MUST be disjoint (the loader rejects overlap).
   - `refusal_policy` and `escalation_rules` (when to hand off / collect contact).
   - **Tools**: ⚠️ catalog agents run in `apps/web`, which has **no tool executor wired** — declared
     tools validate fine but will **not execute** at runtime. Prefer a single-mode, knowledge/persona
     driven agent (empty `tools`) unless the developer explicitly accepts tools as descriptive-only.
   - **Workflow**: default `single` (empty `routes`). Only use `router` if the developer wants intent
     routing — then `sub_agents` must be non-empty, `routes` non-empty, and every route `target` must
     equal a `sub_agents[].id`. Each sub-agent's `tool_names` must reference names that exist in `tools`.
   - `knowledge_sources` (FAQs / facts the agent should know), `default_language`, `greeting`,
     `fallback_message`, `model_assignment` (default `claude-sonnet-4-6`), `needs_sandbox` (default `false`).
   - Catalog metadata: `title`, `category`, one-line `description`, optional `icon` emoji, and the
     kebab-case `id`.

3. **Write the file** to `apps/web/catalog/<id>.json` (the filename stem MUST equal `id`). Assemble the
   full `CatalogEntry`. Keep the JSON tidy and human-readable.

4. **Validate.** From `apps/web`, run `npm run catalog:validate`. Fix every reported schema/consistency
   error and re-run until the new file shows `PASS` and the command exits 0. Common failures:
   in/out-of-scope overlap, empty `goal`/`greeting`/`fallback_message`, router with no routes or an
   unknown route target, duplicate tool/sub-agent ids, a model id outside the enum, an `id` that
   doesn't match the filename.

5. **Done.** Tell the developer the entry validated and that it appears in the **Catalog** tab after the
   server is (re)started — `cd apps/web && npm start` — because the catalog is loaded once at startup.
   They can then deploy it from the UI and exercise it in the agent's WhatsApp simulator.
