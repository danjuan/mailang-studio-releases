const retiredModule = /(?:\/creation\/(?:geometry|material|sim)\/|\/creation-(?:camera-editing|object-editing|recovery|review|stage-preview|workspace)\.|\/(?:motion-scene3d|motion-three-renderer|native-aurora-bridge|native-aurora-preview-session)\.|\/(?:CreationReviewPanel|CreationWorkspacePanel|Scene3DInspector|Transform3DSection)\.|\/three\/examples\/jsm\/(?:geometries\/TextGeometry|loaders\/(?:GLTFLoader|RGBELoader|FontLoader))\.)/;

const retiredCloudModule = /(?:^|\/)(?:@ffmpeg\/|@huggingface\/transformers\/|@mediapipe\/tasks-vision\/|(?:posthog-js|onnxruntime-web|wrangler)\/|(?:api-proxy|share-service|template-cloud-service|ffmpeg-fallback|whisper-worker|person-segmentation-worker|multicam-analysis-worker)\.)/;
const retiredResource = /(?:^|\/)(?:sw\.js|_headers|_redirects|(?:ort(?:-wasm-|\.bundle\.min-)|whisper-worker-|multicam-analysis-worker-|person-segmentation-worker-)[^/]+)$/i;
const retiredExternalUrl = /https?:\/\/(?:esm\.sh|unpkg\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|(?:[a-z0-9-]+\.)*(?:openreel\.video|posthog\.com|elevenlabs\.io|kie\.ai|freepik\.com|huggingface\.co))(?:[/:?#]|["'\x60]|$)/i;

const standaloneEditorModule = /(?:^|\/)(?:@ffmpeg\/(?:ffmpeg|core|core-mt|util)\/|components\/audio-mixer\/|video\/stabilization\/vidstab-engine\.|video\/(?:parallel-frame-decoder|decode-worker)\.)/;

export function assertShortDramaBundle(surface, moduleIds) {
  const modules = [...new Set(moduleIds.map(id => id.replaceAll("\\", "/")))];
  const retired = modules.filter(id => retiredModule.test(id));
  if (retired.length) {
    throw new Error(`OpenReel ${surface} bundle contains retired 3D modules:\n${retired.join("\n")}`);
  }
  const cloud = modules.filter(id => retiredCloudModule.test(id));
  if (cloud.length) {
    throw new Error(`OpenReel ${surface} bundle contains retired remote modules:\n${cloud.join("\n")}`);
  }
  const standalone = modules.filter(id => standaloneEditorModule.test(id));
  if (standalone.length) {
    throw new Error(`OpenReel ${surface} bundle contains standalone-only editor modules:\n${standalone.join("\n")}`);
  }
}

export function assertOpenReelLocalArtifact(file, source) {
  if (retiredResource.test(file)) throw new Error(`OpenReel bundle contains retired resource: ${file}`);
  const endpoint = retiredExternalUrl.exec(source)?.[0];
  if (endpoint) throw new Error(`OpenReel bundle contains a retired external endpoint in ${file}: ${endpoint}`);
}
