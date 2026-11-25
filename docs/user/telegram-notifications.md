# Telegram notifications

SimplyCode can message you on Telegram when a thread finishes, fails, needs your approval, or asks for input, and when a pipeline or workflow run ends or waits on a decision. The message is sent by the server, so it arrives on any device with Telegram — even while the SimplyCode app is closed — as long as the server is running.

## Set it up

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token it gives you.
2. Open **Settings → Notifications → Telegram** in SimplyCode and turn on **Telegram notifications**.
3. Paste the token into **Bot token**. It is stored as a server secret and is never shown again.
4. In Telegram, send any message to your new bot so it can see your chat.
5. Press **Detect** in SimplyCode and pick the chat from the list, or type its chat ID into **Chat ID**.
6. Press **Send test message**. You should get a Telegram message from your bot.

Below the chat field, choose which events send a message: finished threads, failed threads, approvals, input requests, and pipeline or workflow updates. Each switch works independently of the rest.

The same settings are in the mobile app under **Settings → Notifications → Telegram**.

## What the bot sees

Each notification contains the project and thread titles, a short status line, and a brief detail excerpt. Those titles and summaries leave your machine to Telegram; nothing else is sent. Telegram bots cannot receive messages, so nothing you reply to the bot reaches SimplyCode — approvals and answers still happen in the app.

Agents can also send you a message through the `notify_user` tool when they judge you need one, for example when they are blocked. Those messages go through the same bot and chat.

To stop notifications, turn off **Telegram notifications**. Clearing the bot token removes the stored secret from the server.
