import { useLocation, useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";

import { cn } from "../../lib/utils";
import { useSidebar } from "../ui/sidebar";
import { isBotsSectionPage, useNavigateToMainApp } from "./mainAppLocation";

const SEGMENT =
  "rounded-sm px-2 py-1 transition-colors focus-visible:outline-2 focus-visible:outline-ring";
const ACTIVE = "bg-card text-foreground shadow-xs ring-1 ring-inset ring-brand/45";
const IDLE = "text-muted-foreground hover:text-foreground";

/** Threads | Bots — switches the sidebar between the two main app sections. */
export function SidebarSectionSwitch() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const gt = useGT();
  const onBots = isBotsSectionPage(pathname);
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <div
      role="group"
      aria-label={gt("App section")}
      className="grid grid-cols-2 rounded-md bg-muted/70 p-0.5 text-2xs font-medium"
    >
      <button
        type="button"
        aria-pressed={!onBots}
        onClick={() => {
          closeMobile();
          navigateToMainApp();
        }}
        className={cn(SEGMENT, onBots ? IDLE : ACTIVE)}
      >
        <T>Threads</T>
      </button>
      <button
        type="button"
        aria-pressed={onBots}
        onClick={() => {
          closeMobile();
          void navigate({ to: "/bots" });
        }}
        className={cn(SEGMENT, onBots ? ACTIVE : IDLE)}
      >
        <T>Bots</T>
      </button>
    </div>
  );
}
