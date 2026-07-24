# Agent edits

OpenBook lets agents — both the built-in AI and external MCP clients (Claude
Desktop, Claude Code, your own agent) — help write your pages. The **agent-edits
policy** decides whether those writes land **immediately** or wait for you as a
**reviewable suggestion**.

## The three modes

| Mode | What an agent write does |
| --- | --- |
| **Suggest** (default) | Every agent change is queued as a suggestion in the review pane. Nothing changes the page until you accept it. A human stays in the loop. |
| **Direct** | Agent writes apply immediately, with no review step. The change is attributed in the page's history. |
| **Library default** (per page only) | The page follows whatever the library-wide default is set to. This is where a page starts. |

Resolution is simple: a page's own **Suggest**/**Direct** always wins; a page set
to **Library default** falls back to the library-wide mode; and if no library
default has ever been set, the safe **Suggest** applies.

Structural actions — creating a page, adding a database row or column — are
non-destructive and always apply immediately, in every mode.

## Where to set it

There are two controls:

1. **The library default — Settings → Agents & AI admin.**
   The mode every page inherits. Only the library owner can change it. Ships as
   **Suggest**.

2. **The per-page override — the page's Customise pane.**
   Open the Customise pane from the page header and pick **Library default**,
   **Suggest edits for review**, or **Edit page directly** for that one page. An
   override takes effect immediately and beats the library default in both
   directions (a page can be more or less permissive than the library).

## The built-in AI

The built-in AI runs under **your own session** — the server cannot tell its
writes apart from yours — so the suggest-vs-direct choice is enforced in the app
as its proposals come back. Under **Direct**, an AI edit applies at once and
leaves no leftover review card; under **Suggest**, its proposals appear as
review cards you accept or reject. The AI honours both the library default and a
per-page override.

## Remote agents (MCP / personal access tokens)

An external MCP client authenticates with a **personal access token (PAT)** you
mint under Settings → Agents & AI admin (the agent API is off by default). A
remote agent's writes are governed the same way, and the **server is the
authoritative backstop**: a direct write to a page that resolves to **Suggest**
is refused at the REST layer no matter what the tool tries, so a bug or a
misbehaving client can never out-privilege the token. A token also cannot change
the agent-edits policy itself (that is owner-only) — it can only write within it.

A page pinned to **Direct** applies a remote MCP write immediately. On a page
that inherits the **Library default**, a remote MCP write currently resolves to a
**suggestion** even when the library default is Direct — set the page itself to
Direct if you want a remote agent to write it directly. (The built-in AI is not
affected by this; only remote MCP tokens.)

## The audit trail

Every agent change is accountable — there is no hidden write path:

- **Direct writes** are recorded in the page's **edit log** and carried in the
  block's authorship. A remote agent's direct write is attributed to its **agent
  token** (shown as an "(agent)" author), never silently credited to you.
- **Suggestions** are visible in the **review pane** until you accept or reject
  them; accepting one replays it through the same editor path a manual edit takes.

Direct mode leaves **no shadow suggestion** behind: the change is applied and its
provisional review row removed, so the edit log and block authorship are the
single source of truth for what an agent changed.
