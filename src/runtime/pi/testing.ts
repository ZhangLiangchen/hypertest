// Test-only access to the official Pi stream fixtures. Keeping this re-export
// inside the Pi boundary lets tests exercise real SDK events without importing
// the SDK outside src/runtime/pi/**.
export {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
