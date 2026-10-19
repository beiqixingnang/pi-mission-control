import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "project_build_probe",
    label: "Project probe",
    description: "Isolated project tool registration regression.",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text" as const, text: "PROJECT_TOOL_AVAILABLE" }],
        details: undefined,
      };
    },
  });
}
