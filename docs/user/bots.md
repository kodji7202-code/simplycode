# Bots

A **bot** is a saved agent profile: a name, a project, a model, an approval mode and standing instructions, so the same setup can be launched again without retyping it. Bots live under **Bots** in the sidebar; each run starts a conversation listed under the bot.

## Stay in project

A bot's **Stay in project** switch is on by default. With it on, a new conversation refuses the bot's file-editing tools outside the project folder and any extra workspace folders.

What it does not limit:

- **Terminal commands.** A bot can still run commands that write anywhere the agent has permission to. The switch only gates the file-editing tools.
- **Reads.** A confined bot can still read files outside the project.
- **Full access.** A bot whose approval mode is Full can change any file on the computer; "Stay in project" does not apply, and its profile says so instead of showing the switch.

Turning the switch on or off affects new conversations only — a conversation keeps whatever it launched with.

Enforcement depends on the provider: Codex confines writes with its OS sandbox, and Claude and the ACP agents (including Devin) have their file tools refused outside the project. Other providers run unconfined.
