---
name: redline
description: |
  Visual UI feedback tool — annotate elements in a running web app, then fix them from annotation files.
  Two modes: `/redline setup` guides installation of the Chrome extension or Tauri plugin.
  `/redline <path>` reads an annotation JSON file and fixes all annotated issues in the codebase.
  Use this skill whenever the user mentions: redline, UI annotations, visual feedback, annotate elements,
  fix annotations, paint feedback on UI, mark up the UI, visual code review of a running app,
  or wants to annotate and fix visual issues in their web app.
tools: Read, Glob, Grep, Bash, Edit, Write, Agent, AskUserQuestion
---

# Redline — Visual UI Annotation & Fix

Annotate elements in a running web app, then process those annotations to fix the code.

## Modes

### `/redline setup`

Guide the user to install the Redline annotation overlay for their environment.

#### Step 1: Detect environment

Check the project type:

- If the project has a `src-tauri/` directory → **Tauri app** → recommend the Tauri plugin
- Otherwise → **Web app in browser** → recommend the Chrome extension

Ask the user to confirm if unclear.

#### Step 2a: Chrome Extension (for web apps in Chrome)

Tell the user:

1. Clone or download the extension from: `https://github.com/twiced-technology-gmbh/redline-chrome`
2. Open `chrome://extensions/` in Chrome
3. Enable "Developer mode" (top right)
4. Click "Load unpacked" and select the `redline/` directory
5. The red circle icon appears in the toolbar — click it or press `Cmd+Option+Shift+A` (Mac) / `Ctrl+Alt+Shift+A` (Win/Linux) to toggle

#### Step 2b: Tauri Plugin (for Tauri desktop apps)

Guide the user through these changes:

1. **Add dependency** to `src-tauri/Cargo.toml`:
   ```toml
   tauri-plugin-redline = { git = "https://github.com/twiced-technology-gmbh/tauri-plugin-redline" }
   ```
   Or for a local path (e.g., monorepo):
   ```toml
   tauri-plugin-redline = { path = "../path/to/tauri-plugin-redline" }
   ```

2. **Register the plugin** in `src-tauri/src/lib.rs` — must be on the Builder (before `.setup()`), not inside `setup()`, because the plugin uses `js_init_script`:
   ```rust
   let mut builder = tauri::Builder::default()
       .plugin(tauri_plugin_shell::init());

   if cfg!(debug_assertions) {
       builder = builder.plugin(tauri_plugin_redline::init());
   }

   builder.setup(|app| { /* ... */ })
   ```

3. **Add permission** to `src-tauri/capabilities/default.json`:
   ```json
   "redline:default"
   ```

4. Run `cargo build` to verify compilation.

#### Step 3: Create redline directory

```bash
mkdir -p .claude/redline
```

#### Step 4: Update .gitignore

Add this entry to `.gitignore` if not already present:
```
.claude/redline/
```

#### Step 5: Confirm to the user

Tell the user:
- Setup is complete
- How to use: press `Cmd+Option+Shift+A` (Mac) or `Ctrl+Alt+Shift+A` (Win/Linux) while the app is running
- They'll name the annotation session, click elements and type feedback, then press the hotkey again to finish
- The annotation file downloads automatically — the filename gets copied to clipboard
- Paste it to any coding agent with `/redline <filename>`

---

### `/redline <filename>`

Process an annotation file and fix the issues in the codebase.

#### Step 1: Find and read the annotation file

The argument is a filename (e.g. `home-2026-03-10-1430.json`). Search for it in this order:

1. `~/Downloads/<filename>` (default browser download location on macOS/Windows/Linux)
2. If not found, run: `find ~ -maxdepth 2 -name "<filename>" -type f 2>/dev/null | head -1` to check other common locations
3. If still not found, try the argument as an absolute or relative path

Read the annotation file with the Read tool. The file is safe to read directly — `computedCss` contains only a curated subset of ~40 CSS properties relevant to UI fixes (layout, spacing, colors, typography), not the full 300+ computed properties. Default/empty values are omitted.

The JSON file has this structure:

```json
{
  "view": "/dashboard",
  "url": "http://localhost:1420/dashboard",
  "timestamp": "2026-03-10T14:30:00Z",
  "annotations": [
    {
      "selector": "div.card > h2.title",
      "comment": "too much padding",
      "tagName": "H2",
      "classes": "title text-lg font-bold",
      "text": "Product Name",
      "position": { "x": 340, "y": 210 },
      "html": "<h2 class=\"title text-lg font-bold\" data-testid=\"product-title\">Product Name</h2>",
      "childHints": ["<span class=\"price\">"],
      "computedCss": { "padding-top": "24px", "padding-bottom": "24px", "display": "flex", "color": "rgb(255, 255, 255)" }
    }
  ]
}
```

**`computedCss` is a curated subset** — only properties useful for UI fixes are captured:
- **Layout**: `display`, `position`, `width`, `height`, `min-*`, `max-*`, `padding-*`, `margin-*`, `gap`, `flex-*`, `align-*`, `justify-content`, `grid-*`, `top`/`right`/`bottom`/`left`, `z-index`, `overflow`
- **Visual**: `color`, `background-color`, `background`, `border`, `border-radius`, `box-shadow`, `opacity`
- **Typography**: `font-size`, `font-weight`, `font-family`, `line-height`, `text-align`, `text-decoration`, `letter-spacing`, `white-space`
- **Transform**: `transform`, `transition`

Properties with default/empty values (`none`, `normal`, `auto`, `0px`, transparent) are omitted. This is NOT the full computed style — if you need a property not in this list, use `window.getComputedStyle()` in a browser console.

**Annotation types and accuracy**:
- **`select`** (type: `"select"`): The user clicked a specific DOM element. The `selector`, `html`, `computedCss`, and `childHints` are **exact** — they come directly from the selected element.
- **`arrow`/`circle`/`box`/`freehand`/`text`** (draw annotations): The user drew on the canvas near an element. The `nearSelector`, `html`, `computedCss`, and `childHints` come from the **nearest** element under the annotation point — not an exact selection. Use these as hints to locate the relevant area, but verify against the `comment` and visual context. The nearest element may be a parent or sibling of the actual target.

Key fields for element identification (in priority order):
- **`html`**: The rendered outerHTML of the element. Contains `data-testid`, `id`, `aria-label`, and other attributes that uniquely identify the component. **Read this first.** For draw annotations, this is the nearest element — verify it matches the comment.
- **`selector`** / **`nearSelector`**: The DOM path. `selector` (select type) is exact. `nearSelector` (draw types) is approximate.
- **`childHints`**: Opening tags of direct children — helps confirm you found the right element.
- **`computedCss`**: Curated CSS subset (~40 properties) — useful for understanding current styling when applying visual fixes. For draw annotations, this is from the nearest element and may not be the exact target.
- `classes`, `text`, `tagName`, `position`: Secondary confirmation signals.

**Screenshots** (at end of file):
The JSON includes a `screenshots` object with two base64-encoded images:
- `screenshots.page` — JPEG of the app content (overlay hidden), useful for visual context
- `screenshots.annotations` — PNG of the annotation canvas (transparent background with drawn shapes/labels)

These are large base64 strings at the end of the file. **Ignore them by default** — only read if you need visual context to understand an ambiguous annotation. Use `grep` to extract just the annotation data without loading the screenshots.

#### Step 2: Locate the source component for each annotation

For each annotation, identify the source file using this strict order:

1. **Extract identifiers from `html`** (FASTEST path — always try first):
   - Read the `html` field — it contains the actual rendered outerHTML
   - Look for `data-testid`, `id`, `aria-label`, or other unique attributes
   - If found, grep for that attribute value (e.g., `data-testid="editor-info-toggle"`) — this directly locates the source component
   - If the `html` field uniquely identifies the element, you're done — skip to verification

2. **Trace the selector path** (use when `html` has no unique identifiers):
   - Break the selector into segments (split on ` > `)
   - Walk the path top-down through the component tree: match each segment's classes/tag to the JSX in source files
   - Pay attention to `:nth-child(N)` — count the actual children in the parent component's JSX to identify which child element the selector points to
   - If a segment targets a portal container (e.g., a div with an `id` used by `createPortal`), follow the portal: search for which component renders INTO that portal target
   - The final segment is the annotated element — the component that renders it is your target file

3. **Verify with secondary signals** (confirmation, not identification):
   - `childHints`: confirm the element's children match
   - `text`: confirm the element renders matching text content
   - `position`: x/y coordinates should be consistent with the element's layout position (left/center/right, top/bottom)
   - `tagName`: confirm the HTML tag matches

4. **NEVER do this**:
   - Do NOT grep for a class name from the `classes` field, find a match in some file, and assume that's the target without verifying against `html` or `selector`. Classes can appear in multiple unrelated components.
   - Do NOT ignore contradictions between the selector path and a class-name grep result. If the selector points to component A but your grep points to component B, the selector is right.

Group confirmed annotations by source file. This determines which fixes can be parallelized.

#### Step 3: Apply fixes

For annotations that map to different files, dispatch parallel agents — one per file. Each agent receives the full annotation data and:

1. Reads the source file
2. Locates the element identified in Step 2 by matching the selector path through the JSX tree (not by grepping for classes)
3. Uses the annotation data to understand the element and apply the fix:
   - **`html`**: The actual rendered outerHTML — shows the element's attributes, structure, and content as they appear in the browser
   - **`computedCss`**: The full computed CSS of the element — use this to understand current visual state (padding, margin, colors, font sizes, etc.) when applying visual fixes. Extract only relevant properties for the comment (e.g., for "too much padding", read `padding-*` properties)
   - **`childHints`**: Opening tags of direct children — helps understand the element's inner structure
   - **`comment`**: The user's feedback (e.g., "too much padding" → reduce padding, "wrong color" → check design system or nearby elements for the intended color)
4. Applies the minimal fix

For ambiguous comments (e.g., "fix this", "wrong", "ugly"), flag them in the summary rather than guessing. Include the selector and current styles so the user can clarify.

#### Step 4: Summary

After all fixes are applied, show a summary:

```
Redline: processed <N> annotations from <view>

Fixed:
  - div.card > h2.title: reduced padding from 24px to 12px (src/components/Card.tsx:15)
  - button.submit: changed color from #333 to var(--primary) (src/styles/buttons.css:42)

Skipped (ambiguous):
  - nav > a.active: comment was "fix this" — please clarify what needs to change

Files modified:
  - src/components/Card.tsx
  - src/styles/buttons.css
```
