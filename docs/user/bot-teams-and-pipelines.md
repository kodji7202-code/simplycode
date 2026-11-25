# Bot teams and pipelines

A **team** groups bots under a lead: the lead's standing instructions list the members and tell it to delegate with `delegate_to_bot`. A **pipeline** is an ordered list of stages a team's bots run — work stages produce a result, review stages return a pass/fail verdict, and a failed review sends the run back to an earlier work stage with the reviewer's findings.

Manage both under **Bots → Teams and pipelines** in the web or desktop app. On mobile you can see teams and pipelines, start a run, and answer its questions; editing is web-only.

## Pipelines need Workflows

A pipeline run is a run of a built-in workflow, so **Settings → Labs → Workflows** must be on for the server. While it is off, the Teams and pipelines page explains it and offers to turn it on; the pipeline list itself works either way.

## Stages and the review loop

Each stage names a member bot, its kind, and its instructions:

- A **work** stage runs the bot and asks it for a summary, which later stages see as "work from earlier stages".
- A **review** stage asks its bot for a verdict: `pass` moves the run on, `fail` sends it back to the stage named by **If it fails, go back to** — one of the earlier work stages — carrying the findings to fix.

Every stage bot keeps one thread per run, so a stage that runs again after a failed review continues with the context it already had. Stage threads appear under their bot in the bot's **Conversations**, not in the thread sidebar.

## Limits

Two limits bound a run:

- **Max rounds** (1–10, default 3) counts how many times reviews may fail. Past it, the run asks whether to go one more round or stop.
- **Stage timeout** (5–480 minutes, default 60) is each stage's longest run.

If a reviewer repeats the same findings twice, the run asks the same question instead of looping forever. Questions can be answered in place under **Bots → Teams and pipelines**, or on the Workflows page each run links to.

There is no cost cap on pipelines yet — only rounds and time bound a run.
