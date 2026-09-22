# Using Leglas

Start your dev server, run `npx leglas` from the project directory and
open `http://localhost:4100/leglas`. This page is about what you find
there. Getting more than one thing to compare is in
[Setting up a project](configuration.md).

## The rail and the stage

Directions live in a rail on the left. The stage shows the active one in a
framed viewport at Full, 1440, 834 or 390 wide. Rename, reorder, hide and
tag directions from the rail; open the removed list to restore one, delete
it for good or clear the list. Your layout is saved per project and
survives restarts.

A small tools widget floats over the stage and can be dragged to any
corner. Its popover holds the viewport presets and a few preferences,
including hiding the dev badge your framework paints over the corner of
the app when it lands on the part you are judging.

## Comparing

Flipping shows a difference over time. A split shows it at once, which is
what you want for the last two in contention: press `C`, or hover a
direction and press its compare button, and it becomes the right pane
while the active direction holds the left.

Each side is drawn at the width it had on its own and scaled to fit, so
nothing reflows and flipping and splitting agree about what the design is.
An app given half the room would cross its own breakpoints and draw a
different design. If the narrow rendering is what you want, the tools
popover's "Scale each side to fit" switch is for that.

## Asking for a change

Type what you want into the field under the rail, or press `R`, and Leglas
composes a request naming the direction and the file behind it, copies it
to your clipboard and queues it. The direction it means is the one
highlighted directly above the field. By default the request asks for a
new variant beside that direction; the chip next to the send button
switches it to a change in place, for when a change really is a fix.

Pick an agent once from the picker beside the send button and the card
above the field shows it working: which file it is editing, how long it
has been, how long it has gone quiet if it goes quiet, a stop if you change
your mind and a retry when a run goes wrong.
Every request carries a screenshot of the direction at the width you are
looking at, a crop of anything you pointed at, the other pane when you are
comparing and any image you pasted in as a reference. Leglas runs no model
of its own; your agent already knows your conventions and your taste.

<p align="center">
  <img src="https://raw.githubusercontent.com/FredAmartey/leglas/main/.github/assets/screenshots/field-idle.png" width="290" alt="The change field, empty, with its agent picker reading Choose an agent" />
  <img src="https://raw.githubusercontent.com/FredAmartey/leglas/main/.github/assets/screenshots/field-queued.png" width="290" alt="A card above the change field reading: Change queued, pick who runs your changes" />
  <img src="https://raw.githubusercontent.com/FredAmartey/leglas/main/.github/assets/screenshots/field-pickedup.png" width="290" alt="A card above the change field reading: Codex is on it, editing .leglas/variants/hero/poster.tsx, 56s, with a stop button" />
</p>

<p align="center"><i>Nothing waiting, then a request queued, then an agent that has taken it.</i></p>

Hover any direction to see what it was built from and the change that was
asked for, in the words that were typed.

What happens to a request once it leaves the field, and how to run one
from a terminal instead, is in
[Working with agents](agents.md#running-requests).

## Pointing at the problem

Most of what you would type is the part describing where the problem is,
so point at it instead. Press `A` and the preview becomes a picker:
hovering outlines the element under the pointer, clicking drops a numbered
pin that takes a note, and dragging marks an area and names every element
inside it. Click a pin again to reread it, reword it or drop it. The page
still scrolls, so the thing three screens down is as easy to mark as the
headline.

Annotations are a request on their own, so the field can stay empty: leave
three and send once. Each carries the element's own words, its tag and
classes, a path and the box it filled, and tells your agent which of those
to trust first, because the design moves under them by design. A pin whose
element has since gone turns amber rather than pointing confidently at the
wrong thing.

## Sharing

The rail is local, and the person who most needs to see it often has no
repo. The share control in the rail's header fixes that. It has
[its own page](sharing.md).

## Keys

Arrows move between directions and `1` to `9` jump straight to one. `R`
asks for a change, `A` annotates, `C` compares, `Cmd K` (`Ctrl K`
elsewhere) searches, `T` opens the tools popover and `B` collapses the
rail. Press `?` for the whole keymap.

## Updating

Leglas asks npm once a day whether a newer version exists and says so in
the terminal and beside its name in the interface, where one click installs
it and starts Leglas again. The check reads the registry your npm is
configured for. Set `LEGLAS_NO_UPDATE_CHECK=1` to turn it off; the version
stays in the interface and you can still check by hand from there.
