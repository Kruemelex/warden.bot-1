# Verification architecture

This directory owns verification configuration, Admin UX, live and preview sessions, rendering, persistence, startup, and autokick behavior. Shared Discord presentation primitives live in `Warden/ux`; verification-specific policy stays here.

## Entry points and flow

- `index.js` is the interaction boundary. It routes preview, live, and Admin UX interactions.
- `startup.js` validates and publishes the initial runtime snapshot, recovers asset stock, and starts guild-owned workers.
- `service.js` is the public application boundary used by commands and Admin UX. It serializes mutations and publishes validated runtime snapshots.
- `admin/controller.js` routes Admin UX components and modals. `challengeEditor.js`, `questionEditor.js`, and `settings.js` own mutations; `questionPanel.js` owns question-panel presentation.
- `runtime/liveFlow.js` and `runtime/previewFlow.js` coordinate sessions. Shared session progression and delivery live in `sessionFlow.js` and `screenDelivery.js`.

```text
Discord interaction
  -> verification/index.js
     -> admin/controller.js -> service.js
     -> runtime/liveFlow.js or runtime/previewFlow.js
        -> runtime/sessionFlow.js -> runtime/screenDelivery.js
           -> presentation/* and assets/screenAssets.js

service.js -> data/verificationStore.js -> focused repositories
           -> runtime/runtimeContext.js
```

## Directory ownership

- `admin/`: ephemeral configuration panels, editor input handling, and Admin UX routing.
- `assets/`: image inventory, render contracts, child-process rendering, and screen-asset assembly.
- `data/`: the public persistence facade plus focused settings, catalog, post, and autokick repositories.
- `domain/`: pure normalization, validation, task descriptors, answer rules, and screen planning. This layer must not depend on Discord interactions or database access.
- `presentation/`: verification-specific documents, legacy embeds, Components v2 content, and answer modals.
- `runtime/`: live/preview orchestration, bounded work admission, asset stock, lifecycle workers, post reconciliation, and autokick execution.
- `Warden/ux/`: feature-neutral Discord documents, layouts, renderers, interactions, sessions, and attachment checks shared with other Warden features.

## Boundaries

- Controllers and UI call `service.js`; they do not write through repositories directly.
- Services use `data/verificationStore.js`, the public verification persistence facade.
- The database catalog is authoritative for challenges, questions, and tasks. Static templates are protected bootstrap/reset input only.
- Legacy tables and transition formats are not runtime fallback authorities.
- Put pure task rules in `domain/questionTasks`, visual construction in `presentation`, image work in `assets`, and stateful Discord execution in `runtime`.
- Prefer extending an existing task descriptor or shared UX primitive over adding a parallel handler family.
