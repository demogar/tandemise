# Daemon retry: acceptance report

Run: 2026-09-26T23:19:00.773Z  ·  CDP 9365  ·  TANDEMISE_HOME under /tmp/tdm-retry

| ID | Scenario | Result |
| --- | --- | --- |
| R1 | launch with no daemon: the window starts one on a real Node, and it connects | PASS |
| R2 | the daemon stops under the window: not-running screen, Retry, Home | PASS |
| R3 | no usable Node: the not-running screen says what is missing and how to fix it | PASS |
| R4 | TANDEMISE_NODE points nowhere: the message names the setting, not a crash | PASS |

## R1: launch with no daemon: the window starts one on a real Node, and it connects

- ok: no daemon was running before launch
- ok: the window connected without the not-running screen
- ok: /v1/system answers
- ok: the launch log names the Node path and version
- ok: it is not Electron's Node
- ok: it meets the Node 22 floor
- ok: Home renders with the new project

## R2: the daemon stops under the window: not-running screen, Retry, Home

- ok: the not-running screen appears
- ok: Retry connects and Home renders
- ok: a new daemon was started
- ok: /v1/system answers from the new daemon
- ok: the retry was logged with its Node path and version
- ok: no database error anywhere in the launch log

## R3: no usable Node: the not-running screen says what is missing and how to fix it

- ok: says Node 22+ is needed and none was found
- ok: says how to fix it
- ok: no stack trace on screen
- ok: no daemon was started
- ok: Retry gives the same plain message
- ok: the launch log records what was tried

## R4: TANDEMISE_NODE points nowhere: the message names the setting, not a crash

- ok: names TANDEMISE_NODE and the path
- ok: no stack trace on screen
- ok: no daemon was started
