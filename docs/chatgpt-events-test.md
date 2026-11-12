# Test MCP Events with the real ChatGPT

This test proves one thing. A person writes `@chatgpt reword this` in the viewer. ChatGPT gets the comment as an event, edits the page and replies.

The local test with `host/tools/fake-chatgpt.mjs` already proves the server side. This document covers the part that only the real ChatGPT can prove.

Each quote below is from OpenAI's documentation, read on 2026-11-11. The last section lists what the documentation does not confirm.

## What you need

- A deployed host with migration `0005_event_subscriptions.sql` applied.
- A ChatGPT account that has Work chats and may add a custom MCP server.
- A test page on the host.

OAuth is not necessary. ChatGPT accepts a server with no authentication, and the connector token in the URL path is the only check:

> Authentication options include **OAuth**, **No authentication**, and **OAuth or no authentication**.
> (https://developers.openai.com/api/docs/guides/custom-mcp-server)

OpenAI's own quickstart uses a server that has no authentication and a secret-like path:

> This quickstart uses a public example MCP server at `https://tinymcp.dev/api/moldy-aloof-zettabyte/mcp`. It exposes a read-only `roll_dice` tool and does not require authentication.
> (https://developers.openai.com/plugins/quickstart)

MCP Events works in these places:

> MCP Events is available in Work chats on ChatGPT web, in Work chats in the desktop app with **Cloud** selected, and with dots. Workspace controls for plugins and event-triggered tasks apply.
> (https://developers.openai.com/plugins/build/mcp-events)

## 1. Deploy and make a connector token

1. Apply the migration and deploy the host. Use the commands in the README section "Deploy the host".
2. Publish a test page:
   ```bash
   agent-pages publish page.html --slug test/events
   ```
3. Make a connector token. The command needs the Access service token headers.
   ```bash
   curl -X POST $AGENT_PAGES_URL/api/connector-tokens \
     -H "CF-Access-Client-Id: $AGENT_PAGES_CLIENT_ID" -H "CF-Access-Client-Secret: $AGENT_PAGES_CLIENT_SECRET" \
     -H 'content-type: application/json' -d '{"label":"chatgpt"}'
   ```
   The response has the `mcp_url`. Keep it secret. The label `chatgpt` becomes the author of each reply.
4. Confirm that the connector declares events. This command needs no Access headers.
   ```bash
   curl -X POST <mcp_url> -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'
   curl -X POST <mcp_url> -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":2,"method":"events/list"}'
   ```
   The first answer has `"capabilities":{"tools":{},"events":{}}`. The second answer lists `comment.created`.

## 2. Add the connector to ChatGPT

OpenAI gives these steps:

> 1. Go to [ChatGPT Plugins](https://chatgpt.com/plugins).
> 2. Select the plus button, then **Add custom MCP server**.
> 3. Enter a name and use `https://tinymcp.dev/api/moldy-aloof-zettabyte/mcp` as the **Server URL**. Select **No authentication** for **Authentication**.
> 4. Review the risk warning and select **I understand and want to continue**.
> 5. Select **Create as a plugin**.
> (https://developers.openai.com/plugins/quickstart)

Do the same with these values:

1. Name: `Agent Pages`.
2. **Server URL**: the `mcp_url` from step 1.3.
3. **Authentication**: **No authentication**.

Then install the plugin:

> 1. Go to [your personal plugins](https://chatgpt.com/plugins?view=personal). The plugin you created from the MCP server should appear there.
> 2. Open the plugin and select the plus button to install it.
> (https://developers.openai.com/plugins/quickstart)

Open the plugin page and look for the event `comment.created` next to the five tools:

> Verify that your events appear on your plugin page alongside your tools. Rescan your MCP server whenever you change its tools or events.
> (https://developers.openai.com/plugins/build/mcp-events)

If the event is not there, select **Refresh** on the plugin page and look again.

## 3. Subscribe

OpenAI gives this step:

> Start a Work chat on ChatGPT web, or select **Work** and **Cloud** in the desktop app. Ask ChatGPT to subscribe to one of your events and specify what it should do when an event arrives. You can also test with a dot.
> (https://developers.openai.com/plugins/build/mcp-events)

1. Open https://chatgpt.com and switch the tab from **Chat** to **Work**.
2. Start a new Work chat. Type `@` and select the Agent Pages plugin.
3. Send this message:
   ```text
   Watch the page test/events in Agent Pages for comments that mention @chatgpt, and do what each comment asks.
   Read the page with get_page, change it with edit_page, then answer with reply_to_comment and resolve the thread.
   ```
4. ChatGPT calls `events/subscribe`. The Worker sends a verification challenge to the callback URL of ChatGPT and stores the subscription.

Confirm the subscription on the server:

```bash
cd host
bunx cf d1 query <database id> --sql "SELECT id, arguments, substr(callback_url, 1, 40), verified_at, expires_at, last_delivery_at, last_status FROM event_subscriptions"
```

The query must return one row. `arguments` must be `{"mention":"chatgpt","slug":"test/events"}`, or `{"mention":"chatgpt"}` if ChatGPT left the page out.

Do not print the `secret` column. It is the signing secret of ChatGPT.

To see the subscription in ChatGPT, open **Scheduled**. OpenAI's page on scheduled tasks says:

> Review active, paused, and completed tasks and recent runs in **Scheduled**.
> (https://learn.chatgpt.com/docs/automations)

That page describes event triggers for Gmail, Slack and GitHub. It does not name plugin events. See "Not confirmed" below.

## 4. Fire an event

1. Open `$AGENT_PAGES_URL/p/test/events` in a browser.
2. Select some text and write the comment `@chatgpt reword this`.
3. Run the query from step 3 again. `last_status` must be `delivered`, and `last_delivery_at` must be a few seconds old at most.
4. Wait for ChatGPT. The page gets a new version, the thread gets a reply from `chatgpt`, and the thread becomes resolved.

ChatGPT does the work after it acknowledges the webhook, so the delay in step 4 is the time of the ChatGPT run:

> A `2xx` response acknowledges webhook receipt. ChatGPT processes the event asynchronously.
> (https://developers.openai.com/plugins/build/mcp-events)

ChatGPT can ask for a confirmation before a write tool runs:

> Write actions by default require confirmation.
> (https://developers.openai.com/api/docs/guides/custom-mcp-server)

If the page does not change, open the chat or **Scheduled** and look for a run that waits for an approval.

## 5. Check the filter

1. Write a comment with `@claude` on the same page. `last_delivery_at` must not change.
2. Write a comment with `@chatgpt` on another page. If the subscription has a `slug`, `last_delivery_at` must not change.

OpenAI asks for this check:

> For filtered subscriptions, trigger an event that does not match the filters and confirm it is not delivered to the subscription.
> (https://developers.openai.com/plugins/build/mcp-events)

## 6. Stop

1. Tell ChatGPT in the same chat: `Stop watching Agent Pages.`
2. Run the query from step 3. It must return no row.
3. Write one more `@chatgpt` comment. No reply must come.

To stop from the server side, revoke the connector token with `DELETE /api/connector-tokens/<id>`. `GET /api/connector-tokens` lists the `id` of each token. Delivery stops at once. The row stays until a later `events/subscribe` request removes it, one day after it expires.

## If something fails

| What you see | Likely cause |
|---|---|
| ChatGPT cannot connect to the server | The Access bypass for `<hostname>/s/*` is missing, or the URL has a typing error. |
| The plugin page shows the tools and no event | ChatGPT read the server before the deploy. Select **Refresh**. |
| ChatGPT says that the subscription failed, with the code `-32015` | The Worker could not verify the callback. `data.reason` in the error says why. |
| ChatGPT says that the subscription failed, with the code `-32602` | The arguments, the secret or the callback URL did not pass the checks. The message says which. |
| The row exists and `last_status` is `http_4xx` | ChatGPT refused the delivery. Compare the signature rules in `host/src/events.ts` with the MCP Events page. |
| `last_status` is `delivered` and ChatGPT does nothing | Look in **Scheduled** for a pending event or a run that waits for an approval. |

## Not confirmed

- **Plans.** No page says which plans have MCP Events. The pricing page says that Work is included in the "ChatGPT Free, Go, Plus, Pro, Business, Edu, or Enterprise plan" (https://learn.chatgpt.com/docs/pricing). The scheduled tasks page says "On eligible plans, scheduled tasks can run when a supported Gmail, Slack, or GitHub event occurs" and does not name the plans. Dots are "rolling out gradually to eligible Pro and Business Premium accounts" (https://learn.chatgpt.com/docs/dots).
- **Workspace settings.** In a managed workspace, an administrator controls "the **Allow event-triggered scheduled tasks** permission" (https://learn.chatgpt.com/docs/automations). A personal account has no such setting in the documentation.
- **Where the subscription shows.** The documentation does not say that a plugin event subscription appears in **Scheduled**. The MCP Events page speaks of "the task's batching settings", so a subscription is probably a task there.
- **Confirmations in an event run.** The documentation does not say if a run that an event starts can call `edit_page` and `reply_to_comment` with no confirmation. The three read tools carry `readOnlyHint: true`. `edit_page` and `reply_to_comment` carry `readOnlyHint: false` and `destructiveHint: false`, so ChatGPT treats these two as write actions. No test with the real ChatGPT shows yet if it asks for a confirmation for them.
- **The prompt.** OpenAI gives example requests such as "Watch this document for review comments and implement any requested edits." The exact words in step 3 are ours.
- **Refresh.** The Worker grants 24 hours when ChatGPT sends no `ttlMs`. We did not see whether ChatGPT refreshes the subscription before `refreshBefore`. Leave one subscription for two days and run the query again.
- **The callback address.** A Worker cannot look up the address of a host name. The Worker checks the scheme, addresses written as numbers and local names, and it follows no redirect. It cannot check the address that a public host name resolves to.
