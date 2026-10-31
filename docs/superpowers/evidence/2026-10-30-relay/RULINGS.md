# Relay build: rulings

Where the plan (`docs/superpowers/plans/2026-10-30-relay.md`) was ambiguous or
disagreed with the spec (`docs/superpowers/specs/2026-10-30-relay-design.md`,
binding), the builder decided from the spec and recorded it here.

- Ruling (Task 1): `RelaySnapshot` also carries `you: { memberId, deviceId, role }`, so a daemon can tell its own claims and its relay role apart without a second request. Additive, within "exact route payloads" left to the builder.
- Ruling (Task 1): a take-over request body is `takeOverRequest { localRef }`, so the taker's daemon can tie the new claim to its own mission. The plan's route list names the route but no body.
