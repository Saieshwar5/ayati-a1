import { describe, expect, it } from "vitest";
import {
  defaultHyprlandEventSocketPath,
  parseHyprlandActiveWindowAddress,
} from "../../src/ui/workspace-focus-watcher.js";

describe("workspace focus watcher helpers", () => {
  it("parses activewindowv2 focus events by window address", () => {
    expect(parseHyprlandActiveWindowAddress("activewindowv2>>0xabc123\n")).toBe("0xabc123");
    expect(parseHyprlandActiveWindowAddress("activewindowv2>>ABC123")).toBe("0xabc123");
    expect(parseHyprlandActiveWindowAddress("activewindow>>Alacritty,ayati")).toBeNull();
    expect(parseHyprlandActiveWindowAddress("workspace>>3")).toBeNull();
  });

  it("builds the default Hyprland event socket path from environment", () => {
    expect(defaultHyprlandEventSocketPath({
      XDG_RUNTIME_DIR: "/run/user/1000",
      HYPRLAND_INSTANCE_SIGNATURE: "signature",
    })).toBe("/run/user/1000/hypr/signature/.socket2.sock");
    expect(defaultHyprlandEventSocketPath({})).toBeNull();
  });
});
