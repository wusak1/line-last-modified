# Device trust threat model

## Scope and assets

Device trust protects synchronized Line Last Modified event metadata against undetected modification and unknown signing sources. Each enabled device owns an ECDSA P-256 private key in that device's IndexedDB. Only public JWK records, fingerprints, and event signatures enter the Vault.

Protected assets are event integrity, source-key identity, and local trust decisions. Markdown content, metadata confidentiality, Git credentials, and the host operating system are outside this signature layer.

## Attacker model

The design considers a sync peer or storage provider that can read, insert, remove, reorder, or modify synchronized metadata files. It also considers accidental corruption and a newly appearing device key.

It does not protect against:

- compromise of the current browser profile or operating system;
- a trusted device whose private key is stolen;
- deletion or rollback of all synchronized files;
- traffic or Vault metadata analysis;
- malicious Obsidian plugins running with the same application privileges.

## Guarantees

- New events are signed with ECDSA P-256/SHA-256 when the opt-in setting is enabled.
- Verification distinguishes unsigned, invalid, revoked, valid-untrusted, and valid-trusted sources.
- Trust and revocation decisions remain in each device's local Obsidian storage and are never synchronized automatically.
- Pairing requires the user to compare a public-key fingerprint through a separate trusted channel.
- Rotation retains old public keys so historical signatures remain verifiable.
- Rewriting this device's private metadata removes the old signature and re-signs the rewritten event when signing is enabled.
- If IndexedDB cannot create or persist the private key, signing remains unavailable and core history continues unsigned. A failed rotation keeps the previous key active.

## Recovery and revocation

There is no private-key cloud recovery. Losing local IndexedDB creates a new key; other devices must verify and trust its new fingerprint. A user can locally revoke any fingerprint. Revocation does not delete historical events and is intentionally not synchronized, preventing a compromised peer from changing another device's trust policy.

## Confidentiality boundary

Signatures do not encrypt metadata. Optional keyed content hashes use standard HMAC-SHA-256 with a key stored only in local Obsidian storage. Users must transfer the same HMAC key to another device through a separate secure channel.

The plugin does not implement metadata encryption. Designing a new encryption or key-exchange protocol without independent review would create greater risk. Users needing confidentiality should use an audited Vault/sync encryption system such as their sync provider's established encryption layer.
