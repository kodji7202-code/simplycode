import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { BotsSidebar } from "./BotsSidebar";

// Before the environment resolves there is no EnvironmentId yet: the sidebar must
// render from its empty-atom fallbacks instead of constructing one.
vi.mock("./useBotsEnvironment", () => ({
  useBotsEnvironment: () => ({ connected: [], environmentId: null }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: undefined, isPending: false, error: null }),
}));
vi.mock("../sidebar/SidebarSectionSwitch", () => ({
  SidebarSectionSwitch: () => <div data-testid="section-switch" />,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useSearch: () => ({}),
  useNavigate: () => () => Promise.resolve(),
}));

describe("BotsSidebar", () => {
  it("renders the empty state when no environment is selected", async () => {
    await using _screen = await render(<BotsSidebar />);
    // The crash this guards against happened during render; a DOM-level text check is
    // enough because the sidebar layout can collapse outside a SidebarProvider.
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("All bots");
      expect(document.body.textContent).toContain("No bots yet");
    });
  });
});
