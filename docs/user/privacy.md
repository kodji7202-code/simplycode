# Privacy

**This fork sends no telemetry.**

**Acest fork nu trimite telemetrie.**

SimplyCode ships no product analytics, no ingest endpoint, and no hosted relay.
There is no usage-data collection to turn off: the server never sends product
events, and nothing reports hashed account or device identifiers to anyone.

Local diagnostics — the `server.trace.ndjson` file, the resource monitor, and
the Diagnostics settings page — are written and shown on your machine only.
Traces are not exported to any relay, and there is no environment variable that
turns such an export on.

The only external requests that remain are features you use or configure
yourself:

<!-- network list -->

## Agent activity for mobile notifications

When **Publish agent activity** is enabled on a host, it sends project and
thread titles, model names, activity status, and environment and thread
identifiers to the configured relay for
[mobile notifications and live activities](./mobile-notifications.md).

To stop publishing, turn off **Publish agent activity** under
**Settings > Sharing & access** on the host. Turning off notifications on a
phone controls that phone's alerts, not the host's publishing setting.

## Mobile app diagnostics

When the iOS or Android app crashes or hits an error, it can send a report: the
error message, the stack trace, the app version, and the device model and OS
version. Each launch also sends startup timings, and every report carries a
random ID for the install. Reports go through the configured relay and only
exist when a relay is configured. They do not include your threads, prompts, or
connection details, but an error message can quote a value the app was handling.

To stop sending them, turn off **Send crash reports** in
**Settings > About SimplyCode > Diagnostics**.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > Maintenance > Diagnostics**, select an environment, and enter each
signal's OTLP HTTP endpoint under **OpenTelemetry export** (for example
`http://localhost:4318/v1/traces`). Save, then restart that environment's
server. The receiver must be reachable from the server's machine. **Test**
sends an empty export from the server to check an endpoint before or after you
save it.
