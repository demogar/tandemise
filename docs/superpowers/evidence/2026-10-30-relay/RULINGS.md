# Relay build: rulings

Where the plan (`docs/superpowers/plans/2026-10-30-relay.md`) was ambiguous or
disagreed with the spec (`docs/superpowers/specs/2026-10-30-relay-design.md`,
binding), the builder decided from the spec and recorded it here.

- Ruling (Task 1): `RelaySnapshot` also carries `you: { memberId, deviceId, role }`, so a daemon can tell its own claims and its relay role apart without a second request. Additive, within "exact route payloads" left to the builder.
- Ruling (Task 2): `takeOverRefusal` also takes `holderMemberId`; without it "This is already yours." can't be decided. The `heldBySentence` check uses `startedAt: '…T10:42:00Z'` because a zone-less ISO string parses as machine-local time and the pinned "10:42" (in UTC) would depend on the test machine's zone.
- Ruling (Task 2): `check-boundaries` judges a subpath import (`@tandemise/api-contract/relay`) as its package, so `coordination` can depend on the zod-only subpath the spec names instead of the package root, which would pull `domain` into the relay at runtime.
- Ruling (Task 2): the `coord_*` tables carry no foreign keys and `coord_devices.token_hash` is nullable, so a daemon's mirror can hold a relay claim whose device it has never seen (it stores the device label without a token).
- Ruling (Task 1): a take-over request body is `takeOverRequest { localRef }`, so the taker's daemon can tie the new claim to its own mission. The plan's route list names the route but no body.
