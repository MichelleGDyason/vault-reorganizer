# Vault Reorganizer

Vault Reorganizer is an Obsidian plugin for previewing and applying bulk vault cleanup plans. It is designed for vaults that have grown into hundreds of folders and need to be flattened into a smaller, easier-to-maintain structure.

## Recommended structure

For a large vault, a practical target is usually nine folders:

- `Notes` for Markdown notes
- `Images` for image files
- `Videos` for video files
- `Sound` for audio files
- `Attachments` for PDFs, Office files, archives, and other embedded assets
- `Templates` for reusable Markdown templates
- `Canvases` for Obsidian canvas files
- `Bases` for Obsidian Bases `.base` files
- `Files` for miscellaneous non-note files
- `Archive` for material you do not want the plugin to move

If you prefer a very flat vault, use the **Markdown in root** strategy. It moves Markdown notes to the vault root, while attachments and other files still go into their configured folders.

## What the plugin does

- Generates a preview before moving anything
- Moves files with Obsidian's file manager so links can be updated by Obsidian
- Resolves filename conflicts by adding a numeric suffix
- Avoids target names that collide with existing folder-note style folders
- Retries `Folder already exists` rename failures with Obsidian's lower-level vault rename
- Uses a copy/delete fallback for stubborn root moves that both Obsidian rename methods refuse
- Moves image files into a configurable `Images` folder before the general attachments folder
- Moves video files into a configurable `Videos` folder before the general attachments folder
- Moves audio files into a configurable `Sound` folder before the general attachments folder
- Can use OpenAI vision to preview subject-based filenames for generic image names such as `IMG_1234.jpg`, screenshots, pasted images, and hash-like names
- Can use OpenAI vision to preview handwritten-note images as Markdown notes before creating them
- Moves images to `Images` during the image rename preview even when a file already has a human-readable name
- Moves Obsidian Bases `.base` files into a configurable Bases folder
- Lets users rename the destination folders in settings
- Can centralize attachments without moving notes
- Can optionally remove empty folders after files are moved
- Can remove empty folders as a standalone cleanup action after a previous run
- Can optionally remove visible OS metadata files such as `Thumbs.db` and `desktop.ini` before checking whether folders are empty
- Always ignores hidden dotfiles and dot-folders such as `.obsidian`, `.trash`, `.git`, `.DS_Store`, and `.localized`
- Reports hidden dotfiles and dot-folders that are blocking cleanup in normal visible folders so users can review them manually
- Combines Obsidian's indexed folder tree with direct filesystem scanning when finding empty folders
- Excludes `Vault Reorganizer Reports` from reorganization so generated reports stay put
- Reports folders that still contain files or subfolders after cleanup
- Leaves non-empty folders in place during cleanup instead of failing the whole run
- Can copy a run report or create a report note in the vault
- Lets you exclude folders such as `Archive`

## Strategies

### Nine folder vault

Moves files into the configured destinations:

- Markdown notes to `Notes`
- Images to `Images`
- Videos to `Videos`
- Audio to `Sound`
- Other attachments to `Attachments`
- Templates to `Templates`
- Canvas files to `Canvases`
- Bases files to `Bases`
- Other files to `Files`

### Markdown in root

Moves Markdown notes to the vault root. Attachments, templates, canvases, and other files still go to their configured destinations.

### Centralize attachments only

Moves attachment file types into `Attachments` and leaves notes where they are.

## How to use

1. Back up or sync your vault before running a bulk move.
2. Install the plugin in your vault's `.obsidian/plugins/vault-reorganizer` folder.
3. Enable the plugin in Obsidian.
4. Open the command palette and run **Vault Reorganizer: Open vault reorganization planner**.
5. Pick a strategy and click **Generate preview**.
6. Review the planned moves.
7. Click **Apply previewed moves** only when the preview looks right.
8. If anything fails, use **Create report note** to save the exact file and folder paths that need attention.

To clean up folders after a previous run, open the planner and click **Remove empty folders now**, or run **Vault Reorganizer: Remove empty folders** from the command palette.

To rename generic image filenames, add your OpenAI API key in the plugin settings, then open the planner and click **Generate image rename preview**. The preview sends only the generic image files it needs to name to OpenAI, up to the configured limit, and shows the proposed filenames before anything is changed. PNG, JPEG, WebP, and non-animated GIF are enabled by default for AI naming. Other configured image types can still be moved to `Images` without AI naming.

To transform handwritten notes, add your OpenAI API key in the plugin settings, then click **Generate handwriting Markdown preview**. By default, the plugin checks supported images and PDFs in `Images` and `Attachments`, skips files that are not detected as handwritten notes, previews the Markdown output, and creates Markdown notes in `Notes/Handwritten` only after you apply the preview. To target particular files, put one vault path, filename, wikilink, or `obsidian://open` URL per line in **Specific handwriting files**; when that field is set, the plugin checks only those files, treats them as handwritten note sources, and skips the folder-scan detection gate. Very large specifically listed PDFs, including some OneNote exports, can be rendered into temporary page images and converted into one combined Markdown note when **Split oversized handwriting PDFs** is enabled. The split pages are not saved as separate vault files, and handwriting output is restricted to `.md` files in the handwritten notes destination.

## Install from GitHub

### BRAT

If you use the BRAT plugin, add this repository:

```text
MichelleGDyason/vault-reorganizer
```

### Manual release install

Download these files from a GitHub release and place them in `.obsidian/plugins/vault-reorganizer`:

- `main.js`
- `manifest.json`
- `styles.css`

## Installation from this folder

Run:

```bash
npm install
npm run build
```

Then copy these files into `.obsidian/plugins/vault-reorganizer` in the target vault:

- `main.js`
- `manifest.json`
- `styles.css`

## Release process

The GitHub release workflow builds the plugin and attaches the required Obsidian files to a release when a version tag is pushed:

```bash
git tag 0.1.20
git push origin 0.1.20
```

## Notes

The plugin intentionally does not infer semantic categories like projects, areas, or topics. Folder names are often inconsistent in old vaults, so the safest first pass is file-type cleanup. The image rename tool is limited to visible image subjects for filenames. After that, use Obsidian links, tags, properties, search, and Dataview-style queries to build organization that does not depend on deep folder nesting.
