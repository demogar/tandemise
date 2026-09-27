# Hand work in and back

Real work does not all happen inside Tandemise. You can bring in something
you already have — a spec, a design export, a patch, a pull request — and you
can take a step to another tool and bring back what you did there. Both are
pinned as a permanent, attributed record before anything reads them.

## How do I start a mission from my own work?

1. In **New mission**, under **Start from your own work**, press **Add
   file** or **Add link**.
2. A file is read on the spot; a link is just pasted. Only a GitHub pull
   request link can be read on its own — anything else needs an export
   attached (press **Attach an export**) first. A bare link nothing can read
   is refused the same way here, in feedback and in a hand-back: "Nothing
   here can read that link. Attach an export of it." **At creation, that
   refusal takes the whole mission down with it** — nothing partial is left
   behind for you to fix up — so attach the export before you create.
3. Create the mission as usual (plan now, create and refine, or add to the
   backlog).

Your upload is pinned the moment you create the mission. It is **not**
converted yet — that happens once, automatically, at the first refinement or
at the start of planning, whichever comes first. A mission can sit in the
backlog for days first; nothing is wasted by waiting.

**A file is at most 24 MB, and everything you add to one mission or one note
adds up to at most 24 MB too.** Picking a bigger file stops you with "That
file is larger than 24 MB."; going over the total with "These files add up to
more than 24 MB. Add the rest later as feedback."

## What happens to what I uploaded?

When intake runs, Tandemise turns your upload into the typed document a
mission works from, based on what it is:

| Your upload | Becomes |
|---|---|
| A markdown, text or PDF file with acceptance criteria | A product spec |
| A markdown, text or PDF file without them | A problem brief |
| An image or a design export | A design brief |
| A GitHub pull request link, or a patch/diff file | An implementation plan |

If your upload already covers a stage the plan would otherwise run — a spec
that passes the same Done-when check a product step would have to pass, say —
that stage is skipped. The Plan tab shows it as a muted row, "`<stage>` ·
covered by your upload", instead of a task that runs. **A project's own
workflow never skips a stage this way**; its steps still read your upload the
same way.

If intake cannot read what you uploaded, nothing is lost: your file stays
pinned, and planning goes on as if you had not uploaded it.

Uploads never make a draft ready to plan on their own — you still need at
least one accepted Done-when line for that, exactly as without an upload. See
[Refine a rough request](refine.md).

If you use **Create and refine**, or **Add to backlog** while it waits its
turn, the mission stays a draft, and its **Get it ready** panel lists **Your
uploads**: until intake has run each one says "Read when refining or planning
starts", and afterwards **Read what it became** opens the document it
produced. **Plan mission** (pressed with Done-when filled in) sends the
mission straight into planning — it is never a draft, so this panel never
appears for it. There, look at the **Plan** tab for the covered-stage row,
and the **Artifacts** tab, which lists every artifact the mission has,
including your pinned upload and whatever intake made of it.

## Can I attach a file or link to feedback?

Yes. Wherever you request changes, the composer has an **Attach** control
alongside the note: up to 5 files or links, under the same 24 MB rules. A file
is pinned immediately and read by the agent working the next round; a link is
passed through as text. Nothing is converted the way a mission upload is — the
agent that picks up your note reads it directly.

## How do I take a step to another tool?

A step whose result you can carry elsewhere and bring back — a design, a
change, an implementation plan, a spec — offers **Continue elsewhere** on its
card while it is ready, running or finished, as long as nothing downstream has
already used its output.

1. Press **Continue elsewhere** and say where you're taking it (Figma, your
   editor, a doc — anything, up to 40 characters).
2. Tandemise stops the agent and marks the step as waiting for you. Anything
   that depends on this step's output now waits too, with "Waiting for
   '`<key>`' from `<tool>`." — so nothing downstream can run on a version you
   have since taken away.
3. The card now reads "Waiting for your work in `<tool>`", with a **Hand
   back** button. The **Inbox** lists it the same way, and the **Desk**
   counts it among what needs a person.

Once other work has read a step's output, it can no longer be continued
elsewhere — finish or redo that work first. A `wait` step (one that polls a
command) can never be parked or handed back; it has its own way of finishing.

## How do I hand it back?

1. Press **Hand back** on the parked card.
2. Write a note on what you did, and add exactly one file or link — the one
   piece of work that came back.
3. Press **Hand back**.

This lands as a new, human-authored round: the round number moves forward,
and it replaces the step's previous output, the same way a round from an
agent would. Nothing asks you whether to redo or keep work that depended on
the earlier version — parking already held it, so nothing downstream has read
a version you took away. Everything that follows the mission's own rules
(reviews, gates, the scheduler) then picks up as it would after any other
round.

Handing back a GitHub pull request link reads the branch's head commit and
its diff through `gh`, so downstream review and QA work from that exact
commit. A link nothing can read, with no export attached, is refused —
attach the export and try again.

The card afterward shows who did the work — "by You" for a solo hand-back,
the same attribution every artifact carries (the responsible person is left
out when they did the work themselves, as on every card). Opening the reader
also shows who recorded it, which matters once the two differ: if you're
handing back work someone without a seat on the project did, use **Recording
for** to say so; no account is needed for them.

## What if I cancel the run instead?

If you stop a running step without continuing it elsewhere, the feed shows
"`<role>` stopped" — the run ended, but the step was not taken anywhere and
nothing is waiting on you for it.

## What does "Open workspace ↗" do?

Some handoffs point at a place in your own repository rather than a web
address — a hand-back's file, say. **Open workspace ↗** asks the daemon to
resolve that path against the project's repositories (never outside them) and
reveals it in Finder. An address starting with `http://` or `https://` opens
in your browser as usual.

## Not yet

- Only a GitHub pull request link is read on its own; a Figma link, a doc, or
  anything else needs an export attached.
- Nobody can bring work in on someone else's behalf who is not already a
  member or named through **Recording for** — accounts and invites are not
  built yet.
- There is no feed of comments from outside tools (a PR review, a Figma
  comment); a hand-back is the note and the work, not a conversation.
