# relata

A quiet, local canvas for world-building through relationships.

No install, no server, no account: open `index.html` in a browser (double-click it).

## Saving: the `data` folder

On first start relata asks where to keep your worlds. Choose the `data` folder next to
`index.html` (picking the relata folder itself works too). From then on:

- every project is a `.json` file in `data/`, and every change is written to it automatically
  (about half a second after you stop typing);
- the project you last worked on opens by default; the ⌄ next to the project title switches
  between all `.json` projects in the folder or creates a new one;
- editing the project title renames the file to match;
- one snapshot per project per day is kept in `data/backups/` (the last 10 days).

This uses the browser's File System Access API, available in **Chrome, Edge, Brave, Arc**
(Chromium). Browsers may ask you to re-allow folder access once per session: one click.

In Firefox/Safari (or if you choose "Keep in this browser") projects are saved inside the
browser instead — use **Export** for backups there. Import always adds a new project.

## Using it

| | |
|---|---|
| **Write** | Click a node's title or text and type. Select text for **B** / *I* / U (or Ctrl/⌘ B · I · U). |
| **Move** | Press and drag a node. |
| **Relate** | Drag from a node's *edge* (the cursor turns into a crosshair). Drop on another node to connect them, or on empty space to create a new connected node. |
| **Create** | Double-click empty space, or right-click empty space for a node of a specific type. |
| **Focus** | Click a type (on a node or in the top bar) to show only that type. Click empty space to show everything again. |
| **Search** | Type in the search box (or press `/`). Enter fits the results on screen. |
| **Images** | Drop or paste an image onto a node, or right-click › Add image. |
| **Connections** | Double-click a line to label it ("mentor of", "betrayed"). Right-click it for color, thickness and dashed/dotted styles. Click it and press Delete to remove it. |
| **Mentions** | Writing another node's exact title in a text (case doesn't matter) underlines it as a link; click it to jump to that node. While you're writing in that text, Ctrl/⌘-click follows the link. |
| **Navigate** | Scroll to zoom, drag empty space (or hold Space) to pan. `F` fits everything, `0` centers the first node. |
| **Undo** | Ctrl/⌘ Z, redo with Ctrl/⌘ Shift Z. |
| **Types / delete** | Right-click a node, or use the small ⌄ on its type strip. |

## Types

Types and their colors (and the connection colors/thicknesses) live in `js/config.js`. Add, rename or recolor them there.
Nodes with a type that isn't in the list still work and show up in grey.

## File format

Export produces plain JSON:

```json
{
  "app": "relata",
  "version": 1,
  "title": "The Salt Coast",
  "nodes": [
    { "id": "…", "type": "CHARACTER", "title": "Aria Vell", "kind": "text",
      "body": "A cartographer who <b>never</b> finishes her maps.", "image": "", "x": -130, "y": -60 }
  ],
  "edges": [
    { "id": "…", "a": "<node id>", "b": "<node id>", "label": "mentor of",
      "color": "#c0705c", "width": 2.75, "dash": "dashed" }
  ]
}
```

- `kind` is `"text"` or `"image"`; images are embedded as data URLs (downscaled on import).
- `body` only ever contains `<b>`, `<i>`, `<u>` and `<br>`.
- Connections are undirected; `color` is `""` for the default, `dash` is `solid`, `dashed` or `dotted`.
- Mentions are not stored — they're recognised from titles on the fly, so renaming a node updates every link.

Import (or drop a `.json` file onto the canvas) adds the file as a new project.
