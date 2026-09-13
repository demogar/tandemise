# Security Policy

Tandemise runs AI workers against your repositories, credentials and machine, so
we take security reports seriously.

## Supported versions

Until 1.0, only the latest release gets security fixes.

## Reporting a vulnerability

**Do not open a public issue.** Report it privately with GitHub's
[private vulnerability reporting](https://github.com/demogar/tandemise/security/advisories/new).

Please include:

- what an attacker can do and under which conditions,
- steps or a minimal proof of concept to reproduce it,
- the affected version or commit.

You can expect an acknowledgement within 3 business days and a status update
within 10. Once a fix is released, we will credit you in the advisory unless
you prefer otherwise.

## Scope

Of particular interest: escaping a worker's filesystem or permission scope,
secrets leaking into prompts, logs or artifacts, bypassing approval or policy
gates, and the local daemon API being reachable or abusable from other
processes or origins.
