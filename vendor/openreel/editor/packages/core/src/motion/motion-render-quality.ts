export interface MotionRenderQuality {
  readonly shadows: boolean;
  readonly shadowMapSize: number;
  readonly environment: boolean;
  /** Cinematic post-processing (bloom + optional AO/DOF). Off for fast preview. */
  readonly postProcessing?: boolean;
  /** UnrealBloom strength when postProcessing is on. */
  readonly bloomStrength?: number;
  /** Screen-space ambient occlusion (GTAO) — grounds objects with contact shadows. */
  readonly ambientOcclusion?: boolean;
  /** Cinematic depth-of-field (Bokeh): focal plane on the camera target. */
  readonly depthOfField?: boolean;
  /** DOF aperture (blur strength) when depthOfField is on. */
  readonly dofAperture?: number;
  /** MSAA samples for the post-processing pipeline (0 disables; 4 is a good default). */
  readonly antialiasSamples?: number;
  /** View transform / tonemap applied on present. Defaults to AgX (the Blender look). */
  readonly toneMapping?: "agx" | "aces" | "filmic" | "neutral" | "none";
  /** Tonemap exposure multiplier. */
  readonly exposure?: number;
  /** Soft area (softbox) key light for product-grade speculars. */
  readonly softLighting?: boolean;
  /** Image-based-lighting intensity (reflections + ambient fill). */
  readonly environmentIntensity?: number;
}

