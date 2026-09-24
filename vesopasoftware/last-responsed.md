
Thought for 32s
Smaller loss than it sounds. Only two of the seven morph targets genuinely needed a mesh — the window, the braces and the bolt are drawn on a canvas in code, and the wordmark comes from your SVG. So you need three images, not seven models.

The substitute is a matte plus a depth map. I sample the matte for which points exist and the depth map for how far back each one sits, which gives a 2.5D point cloud. Under camera parallax it reads as solid geometry, and honestly for a field of 1.6px additive points nobody could tell the difference from a real mesh sample.

Step 1 — three product images, Nano Banana Pro, 1:1, 2K. Same as R1, R6, R7 in the pack but with one change: replace three-quarter view from slightly above with this, in all three:

straight-on front view with no perspective distortion, orthographic, the object filling 80 percent of the frame
Straight-on matters. A three-quarter view bakes perspective into the silhouette and the shape stops reading when the particles rotate.

Step 2 — two edit commands per image. Attach the approved product image.

Matte:

Convert this image into a pure two-tone mask. Every pixel belonging to the object becomes solid pure white. Everything else becomes solid pure black. No grey, no anti-aliasing beyond one pixel, no shadow, no gradient, no highlight. Keep the object's exact outline, position and scale unchanged.
Depth:

Generate a greyscale depth map of this image. Surfaces nearest the camera are pure white, surfaces furthest away are pure black, with smooth continuous gradients between them. The background is solid pure black. Keep the object's exact outline, position and scale identical to the source image. No colour, no texture, no lighting information, no text.
That's six runs, about a dollar. Name them till_mask.png / till_depth.png, rack_mask.png / rack_depth.png, token_mask.png / token_depth.png.

What I do with them: swap the silhouette() function in the prototype for a matteDepth() sampler that reads both PNGs. Same point count, same morph pipeline, no other change to the build. The procedural till and rack in the current skeleton stay as fallbacks until your files land, so nothing is blocked meanwhile.

Everything else in the command pack is unaffected — all nine video clips, the six story frames, the stills and the tiles stand as written. Skip Groups A and B entirely; use the revised R1, R6, R7 above plus these two edit commands instead.

Worth saying: the site was never going to render your GLBs as lit meshes. They were only ever point-cloud sources. Losing Tripo costs you nothing visible.

