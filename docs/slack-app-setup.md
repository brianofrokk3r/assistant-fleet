# Slack app setup

Create one Slack app per isolated tenant. The assistant connects through Socket
Mode, so it does not need a public Events API endpoint.

## 1. Create the app

1. Open [Your Apps](https://api.slack.com/apps), choose **Create New App**, and
   select the target workspace.
2. Add a bot user under **App Home**.
3. Enable **Socket Mode**.
4. Create an app-level token with the `connections:write` scope. Save the
   resulting `xapp-...` value outside the repository.

The app-level token opens the Socket Mode connection. It is different from the
bot token used for Web API calls.

## 2. Add bot OAuth scopes

Under **OAuth & Permissions**, add these bot token scopes for the complete
Slack adapter feature set:

| Scope | Why it is used |
| --- | --- |
| `app_mentions:read` | Receive explicit mentions in allowed channels. |
| `chat:write` | Send replies and thread responses. |
| `channels:read` | Verify public-channel identity and membership. |
| `channels:history` | Read bounded public-channel and thread context. |
| `groups:read` | Verify private-channel identity and membership. |
| `groups:history` | Read bounded private-channel and thread context. |
| `im:read` | Verify one-to-one direct-message conversations. |
| `im:history` | Receive and read direct-message context. |
| `files:read` | Download user attachments supplied to the assistant. |
| `files:write` | Upload artifacts produced by the assistant. |

You may omit private-channel scopes (`groups:read`, `groups:history`) if the app
will never join a private channel. You may omit direct-message scopes
(`im:read`, `im:history`) and the `message.im` event if direct messages are not
used. Omit `files:read` or `files:write` only if the corresponding attachment
direction is intentionally disabled.

Do not grant `admin`, workspace-management, user-token, or unrestricted channel
write scopes. The adapter does not need them.

## 3. Subscribe to events

Under **Event Subscriptions**, enable events and subscribe the bot to:

- `app_mention`
- `message.im` when direct messages are enabled

Socket Mode carries these events over the app-level connection. No request URL
is required.

## 4. Install and place the app

1. Install or reinstall the app to the workspace after changing scopes.
2. Save the resulting `xoxb-...` bot token outside the repository.
3. Invite the bot to every configured public or private channel. A channel ID in
   the fleet allowlist does not add the bot to that channel automatically.
4. Copy the workspace, channel, and permitted user IDs from Slack. Slack IDs use
   values such as `T...`, `C...`, and `U...`.

The adapter rejects Slack Connect/shared channels and multi-person direct
messages. It supports allowlisted workspace channels, their threads, and
one-to-one direct messages.

## 5. Configure Assistant Fleet

For a tenant slug such as `acme`, store the tokens in `.env.console`:

```dotenv
FLEET_SECRET_SLACK_ACME_APP_TOKEN=xapp-...
FLEET_SECRET_SLACK_ACME_BOT_TOKEN=xoxb-...
```

Use these references in the tenant form:

```text
App token: secret://slack/acme/app-token
Bot token: secret://slack/acme/bot-token
```

Also enter the Slack team ID, installation namespace, and allowed channel IDs.
Never commit real Slack tokens or paste them into `deployment.json` or generated
Compose files.

## 6. Verify

Deploy the tenant, invite the bot to an allowed channel, and mention it there.
If the connection or API scopes are wrong, inspect the tenant logs from the
console or run:

```bash
docker logs assistant-acme-assistant-1
```

Useful Slack references:

- [Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [OAuth scopes](https://docs.slack.dev/reference/scopes/)
- [Events API event types](https://docs.slack.dev/reference/events/)
