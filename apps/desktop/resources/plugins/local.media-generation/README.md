# Media Generation for 麦浪 studio

This independent work-panel plugin generates images and videos with MiniMax China.
It requires 麦浪 studio 0.23.0-beta.2 built with the session media attachment
change, or a later host that includes the `session.media` capability. A build
with the media workbench change adds reference frames and the project library.
No server, database, package installation, or container is required by the plugin.

## Build and install

Use Node.js 22.19 or later. From this repository, run:

```sh
npm run check
npm run pack:plugin
```

Install the generated `dist/local.media-generation-<version>.piplug` through
**Plugins → Install Plugin Package**. Open a local session and choose **Media
Generation** in the right work panel.

Set a MiniMax China API key in settings above the workbench. Write a prompt and
choose Image or Video in the composer. The type menu marks the active type
and switching keeps each draft. In the creations feed, scroll down to reveal
**Latest creations** above the composer. It returns to the top without
resetting the draft or the pages already loaded. When space is tight, scroll
the parameter row with a trackpad, the arrow buttons, or Tab. Generate and Set API Key stay
within reach at the end of the row. In the ratio menu, outlines show the shape
of each format and the fixed formats run from wide to tall. Aspect ratio and
output size have separate choices. On video-workflow hosts, the regular
duration picker offers a slider, an exact value and presets from 4 to 15
seconds. The output count picker shows one to four outputs in a single row.
Model choices show their supported output settings. The video reference
menu marks each workflow with an icon that follows the current selection.
An empty session offers sample drafts above the composer. Wide workbenches
leave room for the examples and keep the composer near the bottom.
Window Still Life fills a square 1K image prompt. On video-workflow hosts,
Coastal Lighthouse fills a six-second 16:9, 480P Omni Reference draft with a
bundled, locally previewable image. A sample is available until you edit its
destination draft. Selecting a sample does not start generation or add media
to the project library. On image-workflow hosts, choose H3 Image
or H3 Image Highspeed, a ratio and size (1K, 2K, or 4K), and up to four outputs.
Use the reference tile to attach local JPEG, PNG, or WebP images, or type
`@` to bind an image asset or subject from the project. The plugin can send
up to nine reference images with the prompt through MiniMax image editing.
For multiple outputs, review the image count and confirm one provider request.
MiniMax can charge for each image it generates. Each output is archived
separately with its model, ratio, size, and reference count. When reusing
settings, select references again. Older hosts retain text-to-image with
the original presets.

Video offers Omni Reference for a text prompt or selected media, First and
Last Frames for exact endpoints, with a control between the slots to swap
or move selected images. Click a filled slot to preview its image. Use the
slot's source menu to replace or remove it. Project pickers let you search by name and preview
an image before using it. Video Editing uses a source video, and Recreation
uses a reference template and
replacement material. Type `@` or use the toolbar control to select a source
from the project or from your device. Continue typing after `@` to filter
by asset or subject name. The picker opens above the typed marker with room
for the active line. From the toolbar, it aligns horizontally with the
mention button and opens above the editor so the draft stays visible when
space permits. A replacement picker stays beside its own button. The project picker keeps the same bounds
while loading or filtering. It follows the visible end of a wrapped query
if the marker scrolls out of the editor. Use the same subject categories as the
project library to narrow suggestions. All also shows plain media. Older hosts
offer Character, Scene, and Prop. Image rows show a thumbnail and subject rows
use their cover. With the picker open, Enter selects the first matching reference.
Arrow keys can move focus to another choice. In Omni Reference and Long Video,
**Add reference media** next to the prompt opens the local media picker.
Image, Omni Reference, and Long Video show attached media beside the prompt.
Drop local files onto the input area in these modes to attach them with the
same validation as the file picker. The attachment list scrolls on its own
and keeps Add within reach. Select a
thumbnail to preview it, or use its Replace and Remove controls. A subject
reference can use multiple project images. Select the underlined
mention in the prompt or its attachment card to preview its image, video,
or audio locally. Use Tab and Space to open a visible mention with the
keyboard. Drag a mention to move that occurrence within the prompt.
Undo restores its previous position. You can scroll over a mention and
select text starting from the surrounding prompt. The preview can page
through a subject's selected images and returns focus to its opener when closed.
After reusing a result,
choose media beside a pending named reference. The label stays in the prompt
at every occurrence. Replace an attached reference to keep its label and
use a different source. Backspace or Delete at a mention's edge removes
that occurrence in one edit. Standard undo and redo apply. The media stays
attached so it can be mentioned again. Remove the attachment with its chip's
remove button to drop both the media and all occurrences of that label.
Clicking Generate sends the attached media with the prompt to MiniMax.
The key remains in plugin process
memory for this run.

In Video Editing, attach a source and open **Advanced editing**. Scrub to
the relevant frame and drag a box or use the percentage fields. Apply saves
the mark in the current draft. Replacing the source clears it and preserves
its reference in the prompt, including when you first attached it with `@`.
When you
generate, MiniMax receives the source video and text guidance for the mark.

In Video Recreation, pick a template MP4 from the device or project and
choose Creative Remake, Replace Subject, or Imitate Motion beside the
prompt. Replace Subject and Imitate Motion also need an image or a different
reference video. MiniMax reads the chosen strategy as guidance in the prompt.

Each advanced video workflow keeps its own draft while you work in the current
session. Switching modes restores the prompt, parameters, and media for that
workflow.

The Apple silicon installer includes a local assembler for Multi-Frame and
Long Video. Multi-Frame generates a segment between each consecutive pair
of images. On an advanced-video host without an assembler, two frames can
still generate one segment. A sequence of three or more frames needs the
assembler. Remove the extra frames to use the current installation.
Drop one local image onto the intended Multi-Frame or First and
Last Frames slot to fill it or replace its current image. Use an empty tile
to choose a local image, or choose a project
image from Assets or from one subject's member images. Choosing an image
fills or replaces the selected frame. The picker checks the image's size
and dimensions before applying it. Select a filled tile to preview it, or use
Replace to choose a different image. Drag the thumbnail or its grip to
reorder frames, or use the arrow buttons with the keyboard. The zero-second
connector before the next empty slot is unavailable until an image fills it.
In a narrow panel, the first two frames and their transition fit together.
Use the arrows above an overflowing sequence, a trackpad, or Tab to reach
later frames.
Select the duration between two frames to edit that transition's length and motion description. Escape
returns focus to the duration control. A frame carries its outgoing
transition to the new position. Clear frames asks for confirmation
before removing this draft's images, transitions, and prompt. Reusing a
Multi-Frame result from a compatible host restores the empty frame slots,
transitions, and total duration. Select new images for every slot before
generating. Older records without transition settings start with one empty tile.
Long Video generates sequential clips using the preceding result's final
frame. Its duration control opens a slider,
presets, and numeric entry with a live estimate. Before any multi-request
submission, review the number of MiniMax requests and the total requested
seconds. The Multi-Frame review lists each frame pair with its transition
duration. The Long Video review lists the segment lengths for each output.
An estimate that differs from the submitted draft stops before confirmation.
MiniMax may charge for each generated segment even if local assembly fails.

Completed results can be previewed and exported offline. Visible video cards
show a static frame from the saved local file and open the player on demand.
For project sessions, **Assets & subjects** opens a separate management page
inside the workbench. Import local images or MP4s there, or add a finished
session creation to the project. **Back to creation** returns to the same
draft and its current parameters. Search and filter the catalog by media type
or subject image count, then refine by creation time and sort by date or
name. Older subjects without a creation time appear when no time limit is
active. The Subjects view shows category controls and a New subject tile.
Choose images and a cover for a character, scene, prop, product, style, or
other subject. The last three types require the subject categories capability.
Compatible hosts let you import
local images directly in the form, where they are immediately selected.
The project keeps the imported assets even if you cancel the subject form.
If the `@` picker has no subjects, **Create subject** opens the editor
directly. Cancel returns to the original insertion point. Saving returns to
the reference picker so you can select the new subject. Select a subject
directly in the `@` list or use **From subjects** to browse in the picker.
Choosing one inserts its reference at the original prompt position and
returns to the composer with the current parameters.
Choose a saved subject's image from a video frame slot. Project assets are
independent copies shared by sessions in the same project folder. Deleting
a session preserves its promoted assets.

Pending MiniMax video jobs can be queried again after a restart, within
MiniMax's seven-day query window. Failed video downloads can be retried from
their history entry. Failed image archival can be retried while the plugin
process still holds the image response. A retry clicked as soon as the
failure appears waits for the previous save attempt to finish and uses
the existing video task or retained image. An interrupted submission with
an unknown outcome is kept in history and requires a new explicit submission
to generate again.

The host permits requests to `api.minimax.cn` and video downloads from the
documented `cdn.hailuoai.com` delivery host. Downloading result files does not
send the API key to the delivery host.

To run the additional sandboxed panel test, set `PI_MEDIA_ELECTRON_BIN` to
an Electron executable and run `npm run test:panel`. Tests use fixtures and do
not send paid requests.

## Provider references

- [MiniMax China image generation](https://platform.minimax.cn/docs/api-reference/image-generation-h3-generations)
- [MiniMax China image editing](https://platform.minimax.cn/docs/api-reference/image-generation-h3-edits)
- [MiniMax China video submission](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create)
- [MiniMax China video query](https://platform.minimax.cn/docs/api-reference/video-generation-v2-query)
