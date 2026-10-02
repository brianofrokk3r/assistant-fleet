# Discord app setup

Create one Discord application and bot per isolated tenant. Use a server install;
do not reuse a bot token across tenants.

## 1. Create the application and bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications)
   and choose **New Application**.
2. Open **Bot**, create the bot user, and copy or reset its token. Store the token
   outside the repository.
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**.

The adapter requests these gateway intents:

- Guilds
- Guild Expressions
- Guild Messages
- Message Content
- Direct Messages

Only Message Content is privileged for this adapter. Server Members and Presence
intents are not requested and should remain disabled.

## 2. Generate the server-install URL

Under **OAuth2 → URL Generator**, select these OAuth scopes:

- `bot`
- `applications.commands`

Grant only these bot permissions:

| Permission | Why it is used |
| --- | --- |
| View Channels | Access configured server channels. |
| Send Messages | Reply to mentions and slash commands. |
| Send Messages in Threads | Continue assistant conversations in threads. |
| Create Public Threads | Create the thread used by `/chat`. |
| Read Message History | Build bounded conversational context and resolve replies. |
| Add Reactions | Support smart thread-participation reactions. |
| Attach Files | Return generated artifacts. |

Do not grant Administrator, Manage Server, Manage Channels, Manage Messages,
Manage Roles, Mention Everyone, or other moderation permissions. They are not
required by the adapter.

Open the generated URL, select the intended server, and authorize the install.
Channel-level permission overrides must still allow the permissions above in
every channel where the assistant will operate.

## 3. Collect IDs

Enable **Developer Mode** in Discord, then copy:

- the application ID from the Developer Portal;
- the guild/server ID from Discord;
- optional allowed-user and administrator-user IDs;
- optional free-channel IDs where the bot may respond without an explicit
  mention.

Direct messages are disabled by the assistant's shared-security mode. In server
channels, users invoke it through registered slash commands, explicit mentions,
or configured free channels and assistant-owned threads.

## 4. Configure Assistant Fleet

For a tenant slug such as `acme`, store the token in `.env.console`:

```dotenv
FLEET_SECRET_DISCORD_ACME_BOT_TOKEN=your-discord-bot-token
```

Use this reference in the tenant form:

```text
secret://discord/acme/bot-token
```

Enter the application ID and guild ID. Leave **Register commands on start**
enabled for a new app so the configured slash commands are registered. Never
commit the bot token or place it directly in `deployment.json` or generated
Compose files.

## 5. Verify

Deploy the tenant and confirm that its slash commands appear in the configured
server. Test `/status`, `/ask`, or `/chat` in a channel the bot can view. If the
bot connects but cannot read or reply, check both the install permissions and
the channel's permission overrides.

Useful Discord references:

- [Gateway intents](https://docs.discord.com/developers/events/gateway#gateway-intents)
- [OAuth2 scopes](https://docs.discord.com/developers/topics/oauth2#shared-resources-oauth2-scopes)
- [Permissions](https://docs.discord.com/developers/topics/permissions)
