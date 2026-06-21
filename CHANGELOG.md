# Changelog

## 0.1.20

- Updated source to satisfy Obsidian review checks for settings headings, config-folder handling, network requests, confirmation modals, deletion preferences, active document/window usage, and deprecated browser APIs.
- Replaced the deprecated `builtin-modules` build dependency with Node's `node:module` built-in module list.

## 0.1.19

- PDF splitting now loads PDF.js only while converting an oversized handwritten PDF, instead of registering its worker at plugin startup.
- This avoids interfering with Obsidian's built-in PDF viewer.

## 0.1.18

- Handwriting apply now refuses to create non-Markdown output or files outside the configured handwritten notes folder.
- The final apply confirmation now names the handwriting destination folder when creating Markdown notes.

## 0.1.17

- Specifically listed oversized handwriting PDFs can now be rendered into temporary page images and converted into one combined Markdown note.
- Added settings to enable oversized PDF splitting and limit the number of PDF pages per handwritten note.

## 0.1.16

- Handwriting conversion now reports the actual file size when a file is too large for direct conversion.
- Oversized PDFs now tell you to split, compress, or export smaller page images instead of only saying the file is over 20 MB.

## 0.1.15

- Specific handwriting files now accept `obsidian://open` URLs and extract the target `file` path.

## 0.1.14

- Treat explicitly listed handwriting files as handwritten note sources instead of running the handwriting detector first.
- Improved the handwriting prompt for OneNote/iPad Pencil PDF exports.

## 0.1.13

- Added a Specific handwriting files setting for targeted handwriting conversion.
- Specific handwriting files can be pasted as vault paths, filenames, or wikilinks, one per line.
- Specific files bypass the folder scan order and handwriting preview limit.
- Raised the default handwriting folder scan limit from 10 to 50 files.

## 0.1.12

- Added PDF support to the handwriting-to-Markdown preview.
- Checks `Images` and `Attachments` by default for handwriting sources.
- Allows comma-separated handwriting source folders.

## 0.1.11

- Added an OpenAI-powered handwriting-to-Markdown preview.
- Added settings for handwriting source folder, Markdown note destination, model, supported image formats, preview limit, and detail level.
- Creates Markdown notes only after preview approval and links each created note back to its source image.
- Skips images that are not detected as handwritten notes.

## 0.1.10

- Made image subject naming tolerate per-image OpenAI request failures.
- Retries each image naming request once before falling back to moving the image to `Images` with its current filename.
- Keeps the image rename preview running when one image returns a browser-level `Failed to fetch` error.

## 0.1.9

- Added configurable Videos and Sound destinations.
- Routed video and audio extensions before the general attachments folder.
- Added settings for video and sound extension lists.
- Updated the recommended structure to the Nine folder vault strategy.

## 0.1.8

- Added a configurable Images destination and route image files there before the general attachments folder.
- Added an OpenAI-powered image rename preview for generic image filenames.
- Added settings for the OpenAI API key, image naming model, supported naming formats, preview limit, and detail level.
- Updated planner/report wording to cover file moves and image renames.

## 0.1.7

- Added the Six folder vault strategy label with Bases support.
- Added configurable destination folders for notes, attachments, templates, canvases, Bases, and other files.
- Added cleanup reporting for hidden blockers in visible folders.
- Excluded hidden dot paths and generated Vault Reorganizer reports from reorganization.
- Added rename fallbacks for root-flattening moves that Obsidian refuses.
