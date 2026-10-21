# relata

A quiet, local canvas for world-building through relationships.

No install, no server, no account: open `index.html` in a browser (double-click it).
Everything is saved automatically in that browser. Use **Export** to keep backups or
move your world to another browser/computer.

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
| **Connections** | Double-click a line to label it ("mentor of", "betrayed"). Click it and press Delete to remove it. |
| **Navigate** | Scroll to zoom, drag empty space (or hold Space) to pan. `F` fits everything, `0` centers the first node. |
| **Undo** | Ctrl/⌘ Z, redo with Ctrl/⌘ Shift Z. |
| **Types / delete** | Right-click a node, or use the small ⌄ on its type strip. |

## Types

Types and their colors live in `js/config.js`. Add, rename or recolor them there.
Nodes with a type that isn't in the list still work and show up in grey.

## File format

Export produces plain JSON:

```json
{
  "app": "relata",
  "version": 1,
  "nodes": [
    { "id": "…", "type": "CHARACTER", "title": "Aria Vell", "kind": "text",
      "body": "A cartographer who <b>never</b> finishes her maps.", "image": "", "x": -130, "y": -60 }
  ],
  "edges": [
    { "id": "…", "a": "<node id>", "b": "<node id>", "label": "mentor of" }
  ]
}
```

- `kind` is `"text"` or `"image"`; images are embedded as data URLs (downscaled on import).
- `body` only ever contains `<b>`, `<i>`, `<u>` and `<br>`.
- Connections are undirected.

Import (or drop a `.json` file onto the canvas) replaces the current world; it can be undone.
