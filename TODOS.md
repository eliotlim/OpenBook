# TODOS

Post-v0 follow-ups surfaced during `/office-hours` (2026-05-27) and `/plan-eng-review` (2026-05-27) on the OpenBook v0 design (`~/.gstack/projects/eliotlim-open-book/eliot-main-design-20260527-141226.md`).

## T1 — Swap `new Function()` for QuickJS sandbox

**What:** Replace the v0 expression evaluator (`new Function('store', '...')` in `packages/ui/src/reactive/compile.ts`) with a sandboxed evaluator (likely `quickjs-emscripten`).

**Why:** v0 uses `new Function()` which has full access to globals. Safe for a single-user local app where the only code in expression blocks is code the user wrote themselves. The moment ANY shared doc opens (even read-only sharing, AI-generated expressions, or imported `.openbook` files from elsewhere), `new Function()` is a code-execution vulnerability. This is the load-bearing migration if collab or sharing ever lands.

**Pros:** Sandbox-safe expression eval; enables shared/imported docs without trusting their authors; required for any v1 collab feature.

**Cons:** WASM init is async; value marshalling across the WASM boundary is fiddly; ~1MB added to the bundle.

**Context:** The v0 `compile()` function is already written with an async-friendly signature `(store) => Promise<unknown> | unknown` (see plan-eng-review Issue 1E) specifically so the swap to QuickJS is a one-file change. All ExprBlock effects already `await Promise.resolve(...)` on the result. Eureka logged in office-hours: Signals' dependency tracking cannot cross the WASM boundary, so the QuickJS implementation will need to statically extract cellId references from the source string before eval and pass values in as primitives — not rely on store-call interception inside the sandbox.

**Depends on / blocked by:** Triggered when any of: (a) collab feature lands, (b) `.openbook` artifact import lands, (c) AI-generated expressions become a feature.

---

## T2 — Cell garbage collection sweep

**What:** Add a sweep that drops Signal objects for cellIds no longer referenced by any block in the current document.

**Why:** v0 `deleteCell` deliberately keeps the Signal object alive forever (per plan-eng-review Issue 1D) to avoid subscription leaks under React StrictMode. This is correct for v0 but means Signals accumulate over the life of a document. With hundreds of cells across multi-doc, this becomes real memory.

**Pros:** Bounded memory growth; cleaner snapshot output (no zombie cellIds).

**Cons:** Sweep timing is tricky — must run AFTER all blocks have mounted and registered, not during a transition. Easiest hook is a "document fully loaded" event followed by a `setTimeout(0)` sweep.

**Context:** The bug class to avoid is "sweep runs while a block is unmounted mid-rerender and the cellId looks orphaned." Mitigation: only sweep cellIds with no subscribers AND not present in the EditorJS block list AND no recent activity.

**Depends on / blocked by:** Not blocking; runs whenever it bothers the user. Probably triggered by multi-doc landing (T5).

---

## T3 — Cross-document reactive references (THE long-term wedge)

**What:** Implement `@docName.cellName` (or chosen syntax) syntax in ExprBlock expressions, allowing one document to reference cells in another document in the vault. References resolve through the same lazy-create + Signals subscribe pattern v0 uses for intra-doc.

**Why:** This is the actual moat per cross-model second opinion: *"a personal computational substrate, not a notes app with toys."* Nothing in the OSS notes / notebook landscape ships this. Mainstream block editors can't do it. Observable can't do it across notebooks. Obsidian Dataview is read-only and not reactive.

**Pros:** The differentiator that justifies OpenBook existing at all in v1+. A household dashboard page that imports rent.total from one doc, grocery.weekly from another, kWh.monthly from a third — and recomputes live when any of them change — is a demo nobody else can give.

**Cons:** Requires multi-doc persistence (T5) to be meaningful. Requires designing a stable cross-doc identifier (probably `docId.cellId`, both stable UUIDs, with `docName.cellName` as the display sugar). Cycle detection across documents adds graph complexity.

**Context:** Open Question #5 in the v0 design doc tabled the syntax choice. Office-hours session committed to this as the v1 wedge. Currently OpenQuestion in design doc.

**Depends on / blocked by:** Multi-doc persistence (T5) must land first.

---

## T4 — Full rename UX (source rewrite + cursor-preserving contenteditable)

**What:** When a cell is renamed, automatically update the displayed name in all ExprBlock token spans across all blocks (v0 already does this, see Saturday PM spec) AND preserve cursor position in any ExprBlock the user is currently editing (v0 ships WITHOUT cursor preservation — outside voice finding #1, deferred to v1 per plan review).

**Why:** v0 ships with the cursor-jumps-to-start bug when a rename happens elsewhere mid-edit. Acceptable for personal use where renames are infrequent, but every active collab session would hit this constantly.

**Pros:** Smooth editing UX during collaborative or even busy solo sessions.

**Cons:** Real `contenteditable` plumbing — Range/Selection save+restore around the re-render, IME composition handling, Safari/WKWebView quirks where selection APIs diverge from Chromium. Budget 2 hours alone per outside voice estimate.

**Context:** v0 Saturday PM spec includes the token-rendering pipeline. Adding cursor preservation = wrapping the innerHTML swap in `getSelection().getRangeAt(0)` capture-then-restore with explicit text-node-offset translation. WKWebView is the macOS Tauri target; testing needs to happen there, not just in Chrome dev.

**Depends on / blocked by:** Triggered when collab lands OR when v0 use surfaces the rename pain enough to warrant the fix.

---

## T5 — Multi-document persistence + `.openbook` portable artifact format

**What:** Support more than one document per vault. Each document is a separate `.openbook` file (the portable artifact format suggested by the cold-read second opinion in office-hours). The vault is a directory; the app reads/writes individual files.

**Why:** v0 is single-doc, single-file. The user's actual use case is household management with his wife — that's many notes (rent calc, grocery budget, vacation planning), each potentially with reactive blocks. Multi-doc is required for the vault concept and for cross-doc references (T3).

**Pros:** Enables T3 (the real wedge). Enables sharing individual documents as standalone files (Approach C from the original alternatives). Sets up the architecture for v1 collab.

**Cons:** Document-routing UX (sidebar tree, recent files, file browser inside the app). Cell-scoping question (Open Question #4 in design doc): are cellIds per-document or per-vault? Cross-doc references need vault-scoped IDs.

**Context:** Approach C from the original alternatives — the cold-read second opinion's preferred direction (artifact-as-product). Deferred from v0 to keep the weekend bounded.

**Depends on / blocked by:** v0 ships and is dogfooded for at least 1 week on a real interactive report; only then commit to v1.
