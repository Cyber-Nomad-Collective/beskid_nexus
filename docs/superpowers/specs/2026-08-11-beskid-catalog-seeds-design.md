# Beskid Catalog Seeds Design

## Goal

Make the deployed Beskid Nexus instance expose Corelib and Runtime as two
separate repository choices without replacing or overwriting an operator's
persisted catalog.

## Repository mapping

- **Beskid Corelib** → `Cyber-Nomad-Collective/beskid_standard`
- **Beskid Runtime** → `Cyber-Nomad-Collective/beskid_compiler`, scoped by its
  description to the native runtime and host integration.

## Design

Nexus persists catalog state under `GITNEXUS_HOME`, so the entries are seeded
at server boot rather than copied into the immutable container image. The seed
operation compares normalized Git URLs, adds only missing entries, and leaves
existing IDs, descriptions, indexing state, and administrator customizations
untouched. Operators can disable this Beskid-specific bootstrap with
`NEXUS_SEED_BESKID_REPOS=0`.

Seeding registers the repositories but does not automatically clone or index
them. Indexing remains an explicit catalog analyze action, which avoids
unexpected startup network and CPU work.

## Verification

The catalog-store unit test proves first-boot creation and repeat-boot
idempotence. The GitNexus TypeScript build verifies the serve-command wiring.
